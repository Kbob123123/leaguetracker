import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import {
  getAllTrackedChannels,
  getLatestSnapshot,
  getSnapshotNear,
  getPlayerRankingByName,
  getPlayerPointsNear,
} from '../lib/db.js';
import { hourlyRate, formatPoints, formatRate } from '../lib/rates.js';
import { formatName, matchesName } from '../lib/robloxNames.js';

const HOUR_SECONDS = 3600;

// Named /leagueplayer rather than /playerinfo so it can't be confused with the
// clan bot's /clansearch when both bots are in the same server — Discord scopes
// command names per application, so two identical /playerinfo entries would
// otherwise sit side by side in the picker distinguished only by a tiny avatar.
export const data = new SlashCommandBuilder()
  .setName('leagueplayer')
  .setDescription('Look up a player by Roblox username or display name.')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Roblox username or display name').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const rawQuery = interaction.options.getString('name', true).trim();
  const query = rawQuery.toLowerCase();
  if (query.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  // Tier 1: leagues actively tracked in THIS server — live data from our own
  // 10-minute polling, so rates are current rather than up to an hour old.
  const trackedMatches = searchTrackedChannels(interaction.guildId, query);

  // Tier 2: anyone in the top-1,000 leagues the hourly rankings job covers,
  // even if nobody in this server is tracking their league.
  const rankingMatches = trackedMatches.length === 0 ? getPlayerRankingByName(query) : [];

  if (trackedMatches.length === 0 && rankingMatches.length === 0) {
    // There is deliberately no third tier here. An earlier version fell back to
    // a direct PS99 profile lookup at /v1/players/{username}, but that endpoint
    // returns 404 — it does not exist. The PS99 API exposes no per-player
    // route at all, so league/clan contribution data is the only possible
    // source of player stats and there is nothing further to try.
    await interaction.editReply(
      `❌ No player matching **${rawQuery}** was found in any league tracked in this server, or in the ` +
        `top-1,000 league rankings.\n\n` +
        `_Only players in the top 1,000 leagues can be looked up — the PS99 API has no endpoint for ` +
        `individual players, so anyone outside those leagues can't be searched._`
    );
    return;
  }

  const embed = buildEmbed(rawQuery, trackedMatches, rankingMatches);
  await interaction.editReply({ embeds: [embed] });
}

/** Search every league tracked in this guild for a member matching username or display name. */
function searchTrackedChannels(guildId, query) {
  const trackedInGuild = getAllTrackedChannels().filter((t) => t.guild_id === guildId);
  const matches = [];

  for (const tracked of trackedInGuild) {
    const latest = getLatestSnapshot(tracked.channel_id);
    if (!latest) continue;

    const members = JSON.parse(latest.members_json);
    const found = members.filter((m) => matchesName(m, query));
    if (found.length === 0) continue;

    const hourAgo = getSnapshotNear(tracked.channel_id, HOUR_SECONDS);
    const validHourAgo = hourAgo && hourAgo.id !== latest.id ? hourAgo : null;
    const hourAgoMembers = validHourAgo ? JSON.parse(validHourAgo.members_json) : null;

    for (const member of found) {
      let rate = null;
      if (hourAgoMembers) {
        const prev = hourAgoMembers.find((p) => p.userId === member.userId);
        if (prev) rate = hourlyRate(prev.points, validHourAgo.ts, member.points, latest.ts);
      }
      matches.push({
        username: member.username,
        displayName: member.displayName,
        userId: member.userId,
        points: member.points,
        rate,
        leagueName: tracked.league_name,
        channelId: tracked.channel_id,
      });
    }
  }

  return matches;
}

function buildEmbed(rawQuery, trackedMatches, rankingMatches) {
  const embed = new EmbedBuilder()
    .setTitle(`🔎 Player Lookup — "${rawQuery}"`)
    .setColor(0x5865f2)
    .setTimestamp();

  const lines = [];

  for (const m of trackedMatches.slice(0, 5)) {
    lines.push(
      `**${formatName(m)}** — <#${m.channelId}> (${m.leagueName})\n` +
        `└ 📍 Tracked live — ${formatPoints(m.points)} pts, ${formatRate(m.rate)}`
    );
  }

  for (const m of rankingMatches.slice(0, 5)) {
    // Rate comes from the hourly job's own per-player history, so it's only as
    // fresh as the last pass — labelled accordingly below.
    const hourAgo = getPlayerPointsNear(m.user_id, m.league_id, HOUR_SECONDS);
    const rate = hourAgo
      ? hourlyRate(hourAgo.points, hourAgo.ts, m.points, Math.floor(Date.now() / 1000))
      : null;

    const who = formatName({ username: m.username, displayName: m.display_name, userId: m.user_id });
    lines.push(
      `**${who}** — ${m.league_name} (top-1,000 league, rank #${m.league_rank})\n` +
        `└ 🌍 From hourly scan — ${formatPoints(m.points)} pts, ${formatRate(rate)}`
    );
  }

  embed.setDescription(lines.join('\n\n'));

  const totalMatches = trackedMatches.length + rankingMatches.length;
  embed.setFooter({
    text:
      totalMatches > 5
        ? `Showing 5 of ${totalMatches} matches — try a more specific name.`
        : trackedMatches.length > 0
          ? "Live data from this server's tracked leagues."
          : 'From the hourly top-1,000 league scan — not live-updating.',
  });

  return embed;
}
