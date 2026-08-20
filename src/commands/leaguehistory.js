import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { renderBattleBars } from '../lib/graph.js';
import { resolveAvatarUrl } from '../lib/robloxAvatars.js';
import {
  getPlayerLeagueBattles,
  getLeagueBattlePercentile,
  findLeagueBattlePlayersByName,
} from '../lib/db.js';
import { currentBattleKey } from '../lib/battleTimer.js';
import { capToFieldLimit, DESCRIPTION_LIMIT } from '../lib/embed.js';
import { formatPoints } from '../lib/rates.js';

// Player-only, by design (for now).
//
// History here means PAST BATTLES, not past days. Unlike clans — whose API
// ships a rolling archive of ~30 battles — the league endpoints expose only
// current standings, so every row behind this command is one the bot captured
// itself at a Saturday reset. That has a hard consequence the embed states
// plainly: there is nothing here for battles that finished before the bot
// started recording, and nothing can backfill them.
export const data = new SlashCommandBuilder()
  .setName('leaguehistory')
  .setDescription('A player’s results in past league battles, with percentiles.')
  .addStringOption((opt) =>
    opt.setName('player').setDescription('Roblox username').setRequired(true)
  );

function placeLabel(place) {
  if (place == null) return '—';
  if (place === 1) return '🥇 1st';
  if (place === 2) return '🥈 2nd';
  if (place === 3) return '🥉 3rd';
  return `#${place.toLocaleString()}`;
}

/**
 * "2026-08-21" -> "Sat 22 Aug 2026", the date people actually experienced.
 *
 * The key is the UTC date of the reset INSTANT, and a Saturday 2am AEST reset
 * falls on Friday afternoon UTC — so labelling the raw key showed every battle
 * ending on a Friday, which is not the day anyone played it. Shifting a day
 * converts to the Australian date the reset belongs to, and holds under AEDT
 * too, since that only moves the instant an hour earlier in UTC.
 */
function battleLabel(key) {
  const d = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return key;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export async function execute(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('player', true).trim();
  if (query.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters of a username.');
    return;
  }

  const matches = findLeagueBattlePlayersByName(query);

  if (matches.length === 0) {
    await interaction.editReply(
      `❌ No league battle history for a player matching **${query}**.\n\n` +
        '_League battles are recorded by this bot as they happen — the PS99 API keeps no ' +
        'archive of them. Only players in the top-1,000 leagues are scanned, and only ' +
        'battles fought since the bot started recording exist at all._'
    );
    return;
  }

  if (matches.length > 1) {
    const list = matches.map(
      (m) => `• **${m.username ?? m.user_id}** — ${m.battles} battle(s), best ⭐ ${formatPoints(m.best_points)}`
    );
    await interaction.editReply(
      `⚠️ **${matches.length}** players match that. Be more specific:\n${list.join('\n')}`
    );
    return;
  }

  const player = matches[0];
  const all = getPlayerLeagueBattles(player.user_id);

  // The battle in progress is not a result yet, so it is shown separately
  // rather than mixed in with finished ones and counted as history.
  const liveKey = currentBattleKey();
  const finished = all.filter((b) => b.battle_key !== liveKey);
  const inProgress = all.find((b) => b.battle_key === liveKey);

  if (finished.length === 0) {
    const soFar = inProgress
      ? `\n\nRight now in the battle ending **${battleLabel(liveKey)}** they have ` +
        `⭐ **${formatPoints(inProgress.points)}** for ${inProgress.league_name ?? 'their league'}.`
      : '';

    await interaction.editReply(
      `📜 **${player.username ?? player.user_id}** has no finished league battles recorded yet.${soFar}\n\n` +
        '_The first result appears after the next Saturday reset (2am AEST). ' +
        'The API keeps no league battle history, so this archive only grows forwards._'
    );
    return;
  }

  const lines = finished.map((b) => {
    const pct = getLeagueBattlePercentile(b.battle_key, b.points);
    const standing = pct
      ? `beat **${(pct.fraction * 100).toFixed(2)}%** · #${pct.rank.toLocaleString()} of ${pct.total.toLocaleString()}`
      : '_no comparison data_';
    return (
      `**${battleLabel(b.battle_key)}** — ⭐ ${formatPoints(b.points)}\n` +
      `└ 🏅 ${standing}\n` +
      `└ 🛡️ ${b.league_name ?? '?'} finished ${placeLabel(b.league_place)}`
    );
  });

  const best = finished.reduce((a, b) => (b.points > a.points ? b : a), finished[0]);
  const bestPct = getLeagueBattlePercentile(best.battle_key, best.points);

  const embed = new EmbedBuilder()
    .setTitle(`📜 ${player.username ?? player.user_id} — past league battles`)
    .setColor(0x3987e5)
    .setDescription(capToFieldLimit(lines, '_None._', DESCRIPTION_LIMIT))
    .addFields(
      { name: '📦 Battles', value: String(finished.length), inline: true },
      { name: '⭐ Best score', value: formatPoints(best.points), inline: true },
      {
        name: '🏅 Best percentile',
        value: bestPct ? `${(bestPct.fraction * 100).toFixed(2)}%` : '—',
        inline: true,
      }
    )
    .setTimestamp();

  if (inProgress) {
    embed.addFields({
      name: `⏳ In progress — ends ${battleLabel(liveKey)}`,
      value: `⭐ ${formatPoints(inProgress.points)} for ${inProgress.league_name ?? 'their league'}`,
      inline: false,
    });
  }

  embed.setFooter({
    text: 'Recorded by this bot at each Saturday reset — the PS99 API keeps no league battle archive.',
  });

  // From the matched player, not from a history row: getPlayerLeagueBattles
  // selects battle columns only and carries no user_id.
  const files = [];
  const headshot = await resolveAvatarUrl(player.user_id).catch(() => null);
  if (headshot) embed.setThumbnail(headshot);

  const chart = await renderBattleBars({
    title: player.username ?? String(player.user_id),
    subtitle: 'Points per league battle',
    // Oldest first, so the chart reads left to right as time passing. The
    // list above is ordered newest-first, which is right for a list and wrong
    // for a timeline.
    items: [...finished].reverse().map((b) => ({ label: battleLabel(b.battle_key), value: b.points })),
    artUrl: headshot,
    note: `${finished.length} battles`,
  }).catch(() => null);

  if (chart) {
    files.push(new AttachmentBuilder(chart, { name: 'battles.png' }));
    embed.setImage('attachment://battles.png');
  }

  await interaction.editReply({ embeds: [embed], files });
}
