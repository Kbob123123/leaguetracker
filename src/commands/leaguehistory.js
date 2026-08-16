import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import {
  getDailyHistory,
  findDailyLeagueByName,
  getPlayerDailyHistory,
  findPlayerDailyByName,
} from '../lib/db.js';
import { getLeagueDetail } from '../lib/ps99Api.js';
import { renderHistoryChart } from '../lib/graph.js';
import { formatPoints, formatRate } from '../lib/rates.js';

// Charts either a player or a league. `league` is no longer required, because
// player history is the more useful view day to day — but the league mode was
// working and costs nothing to keep, so this takes exactly one of the two
// rather than replacing one with the other.
export const data = new SlashCommandBuilder()
  .setName('leaguehistory')
  .setDescription('Long-term points history for a player or a league, as a daily chart.')
  .addStringOption((opt) =>
    opt.setName('player').setDescription('Roblox username — charts this player over time')
  )
  .addStringOption((opt) =>
    opt.setName('league').setDescription('League name (exact, case-insensitive)')
  )
  .addIntegerOption((opt) =>
    opt
      .setName('days')
      .setDescription('How far back to chart (default 30)')
      .addChoices(
        { name: '7 days', value: 7 },
        { name: '30 days', value: 30 },
        { name: '90 days', value: 90 },
        { name: '180 days', value: 180 }
      )
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const playerQuery = interaction.options.getString('player')?.trim();
  const leagueQuery = interaction.options.getString('league')?.trim();
  const days = interaction.options.getInteger('days') ?? 30;

  if (playerQuery && leagueQuery) {
    await interaction.editReply('❌ Pick one — either `player:` or `league:`, not both.');
    return;
  }
  if (!playerQuery && !leagueQuery) {
    await interaction.editReply(
      '❌ Give me either `player:<roblox username>` or `league:<league name>` to chart.'
    );
    return;
  }

  if (playerQuery) return showPlayerHistory(interaction, playerQuery, days);

  const query = leagueQuery;

  // Resolve by stored name first — that costs no API call and works even if
  // the league has since dropped out of the top 1,000. Fall back to a live
  // lookup so a correctly-spelled league that simply has no history yet gets
  // an accurate message rather than "not found".
  let leagueId = null;
  let leagueName = query;

  const stored = findDailyLeagueByName(query);
  if (stored) {
    leagueId = stored.league_id;
    leagueName = stored.league_name;
  } else {
    const live = await getLeagueDetail(query).catch(() => null);
    if (!live) {
      await interaction.editReply(`❌ No league named **${query}** found.`);
      return;
    }
    leagueId = live.ID;
    leagueName = live.Name;
  }

  const rows = getDailyHistory(leagueId, days);

  if (rows.length < 2) {
    await interaction.editReply(
      `📊 **${leagueName}** doesn't have enough history yet — ${rows.length === 0 ? 'nothing has' : 'only one day has'} been recorded so far.\n\n` +
        '_History builds up one point per day. A chart needs at least two days, ' +
        'so check back tomorrow._'
    );
    return;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const gained = Number(last.points) - Number(first.points);
  const spanDays = Math.max(1, rows.length - 1);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${leagueName} — ${rows.length} days of history`)
    .setColor(0x3987e5)
    .setDescription(
      [
        `**Now:** ${formatPoints(Number(last.points))} pts`,
        `**${spanDays} day${spanDays === 1 ? '' : 's'} ago:** ${formatPoints(Number(first.points))} pts`,
        `**Gained:** ${formatPoints(gained)} (${formatRate(Math.round(gained / spanDays / 24))} average)`,
      ].join('\n')
    )
    .setTimestamp()
    .setFooter({ text: 'One reading per day · recorded hourly, kept for 180 days' });

  const files = [];
  const chart = await renderHistoryChart(leagueName, rows).catch((err) => {
    console.warn('[leaguehistory] Chart render failed:', err.message);
    return null;
  });

  if (chart) {
    files.push(new AttachmentBuilder(chart, { name: 'history.png' }));
    embed.setImage('attachment://history.png');
  }

  await interaction.editReply({ embeds: [embed], files });
}

/**
 * Per-player daily chart.
 *
 * Sourced entirely from player_daily_points, which the hourly rankings job
 * fills. Leagues expose no historical archive the way clan Battles do, so this
 * can only ever reach back as far as the bot itself — the embed says so
 * rather than letting a short chart imply the player only just started.
 */
async function showPlayerHistory(interaction, query, days) {
  if (query.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters of a username.');
    return;
  }

  const matches = findPlayerDailyByName(query);

  if (matches.length === 0) {
    await interaction.editReply(
      `❌ No recorded history for a player matching **${query}**.\n\n` +
        '_Player history only covers members of the top-1,000 leagues, and only from when ' +
        'the bot started recording. If they joined a ranked league recently, check back tomorrow._'
    );
    return;
  }

  if (matches.length > 1) {
    const list = matches.map((m) => `• **${m.username ?? m.user_id}** — ${m.league_name ?? 'unknown league'}`);
    await interaction.editReply(
      `⚠️ **${matches.length}** players match that. Be more specific:\n${list.join('\n')}`
    );
    return;
  }

  const player = matches[0];
  const rows = getPlayerDailyHistory(player.user_id, days);

  if (rows.length < 2) {
    await interaction.editReply(
      `📊 **${player.username ?? player.user_id}** doesn't have enough history yet — ` +
        `${rows.length === 0 ? 'nothing has' : 'only one day has'} been recorded so far.\n\n` +
        '_One reading per day, and a chart needs two. Check back tomorrow._'
    );
    return;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const gained = Number(last.points) - Number(first.points);
  const spanDays = Math.max(1, rows.length - 1);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${player.username ?? player.user_id} — ${rows.length} days of history`)
    .setColor(0x3987e5)
    .setDescription(
      [
        `⭐ **Now:** ${formatPoints(Number(last.points))} pts`,
        `🕒 **${spanDays} day${spanDays === 1 ? '' : 's'} ago:** ${formatPoints(Number(first.points))} pts`,
        `📈 **Gained:** ${formatPoints(gained)} (${formatRate(Math.round(gained / spanDays / 24))} average)`,
        `🛡️ **League:** ${last.league_name ?? 'unknown'}`,
      ].join('\n')
    )
    .setTimestamp()
    .setFooter({
      text: 'Only goes back as far as the bot has been running — leagues expose no historical archive.',
    });

  const files = [];
  const chart = await renderHistoryChart(player.username ?? String(player.user_id), rows).catch((err) => {
    console.warn('[leaguehistory] Player chart render failed:', err.message);
    return null;
  });

  if (chart) {
    files.push(new AttachmentBuilder(chart, { name: 'history.png' }));
    embed.setImage('attachment://history.png');
  }

  await interaction.editReply({ embeds: [embed], files });
}
