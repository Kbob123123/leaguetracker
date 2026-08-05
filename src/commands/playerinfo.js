import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getAllTrackedChannels, getLatestSnapshot, getSnapshotNear, getPlayerRankingByName, getPlayerPointsNear } from '../lib/db.js';
import { getPlayerProfile } from '../lib/ps99Api.js';
import { hourlyRate, formatPoints, formatRate } from '../lib/rates.js';

const HOUR_SECONDS = 3600;

export const data = new SlashCommandBuilder()
  .setName('playerinfo')
  .setDescription('Look up a player by username or display name.')
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

  // Tier 1: leagues actively tracked in THIS server — most detailed data
  // (hourly rate from our own polling, graph available via /startmonitoringleague's embed).
  const trackedMatches = searchTrackedChannels(interaction.guildId, query);

  // Tier 2: anyone in the top-1,000 leagues the hourly rankings job covers,
  // even if nobody's actively tracking their league in this server.
  const rankingMatches = trackedMatches.length === 0 ? getPlayerRankingByName(query) : [];

  if (trackedMatches.length > 0 || rankingMatches.length > 0) {
    const embed = buildLocalDataEmbed(rawQuery, trackedMatches, rankingMatches);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // Tier 3: fall back to a direct PS99 profile lookup by exact username. This
  // only works for an EXACT username match (not partial/display name), and
  // only if that player has made their profile public — but it works for any
  // player in the game, not just ones in a top-1,000 league.
  try {
    const profile = await getPlayerProfile(rawQuery);

    if (profile === null) {
      await interaction.editReply(
        `❌ No player found matching **${rawQuery}**. This wasn't found in any tracked league, the top-1,000 ` +
          `league rankings, or as an exact username on PS99.`
      );
      return;
    }

    if (profile.available === false) {
      await interaction.editReply(
        `🔒 **${rawQuery}** exists on PS99, but hasn't made their profile public, so no stats are available.`
      );
      return;
    }

    const embed = buildProfileEmbed(rawQuery, profile);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply(
      `❌ Couldn't find **${rawQuery}** in any tracked league or the top-1,000 rankings, and the direct profile ` +
        `lookup failed (${err.message}). This player might not exist, or the name needs to be an exact username.`
    );
  }
}

/** Search every league tracked in this guild for a member matching the query (display name substring match). */
function searchTrackedChannels(guildId, query) {
  const trackedInGuild = getAllTrackedChannels().filter((t) => t.guild_id === guildId);
  const matches = [];

  for (const tracked of trackedInGuild) {
    const latest = getLatestSnapshot(tracked.channel_id);
    if (!latest) continue;

    const members = JSON.parse(latest.members_json);
    const found = members.filter((m) => m.displayName?.toLowerCase().includes(query));
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
        source: 'tracked',
        displayName: member.displayName,
        points: member.points,
        rate,
        leagueName: tracked.league_name,
        channelId: tracked.channel_id,
      });
    }
  }

  return matches;
}

function buildLocalDataEmbed(rawQuery, trackedMatches, rankingMatches) {
  const embed = new EmbedBuilder()
    .setTitle(`🔎 Player Lookup — "${rawQuery}"`)
    .setColor(0x5865f2)
    .setTimestamp();

  const lines = [];

  for (const m of trackedMatches.slice(0, 5)) {
    const parts = [`**${m.displayName}** — <#${m.channelId}> (${m.leagueName})`];
    parts.push(`└ 📍 Tracked live — ${formatPoints(m.points)} pts, ${formatRate(m.rate)}`);
    lines.push(parts.join('\n'));
  }

  for (const m of rankingMatches.slice(0, 5)) {
    const rate = getPlayerPointsNear(m.user_id, m.league_id, HOUR_SECONDS);
    const parts = [`**${m.display_name}** — ${m.league_name} (top-1,000 league, rank #${m.league_rank})`];
    parts.push(`└ 🌍 From hourly scan — ${formatPoints(m.points)} pts`);
    lines.push(parts.join('\n'));
  }

  embed.setDescription(lines.join('\n\n'));

  const totalMatches = trackedMatches.length + rankingMatches.length;
  embed.setFooter({
    text:
      totalMatches > 5
        ? `Showing 5 of ${totalMatches} matches — try a more specific name.`
        : trackedMatches.length > 0
          ? 'Live data from this server\'s tracked leagues.'
          : 'From the hourly top-1,000 league scan — not live-updating.',
  });

  return embed;
}

function buildProfileEmbed(rawQuery, profile) {
  const embed = new EmbedBuilder()
    .setTitle(`🔎 ${rawQuery}`)
    .setColor(0x5865f2)
    .setTimestamp()
    .setFooter({ text: 'Public PS99 profile data — not affiliated with any tracked league.' });

  // We don't have a confirmed field list for the profile view, so display
  // whatever fields are actually present rather than assuming specific names
  // (safer than guessing wrong field names and showing blank/undefined).
  const displayFields = Object.entries(profile)
    .filter(([key]) => key !== 'available')
    .filter(([, value]) => value != null && typeof value !== 'object');

  if (displayFields.length === 0) {
    embed.setDescription('Profile is public, but no displayable stat fields were returned.');
  } else {
    embed.setDescription(displayFields.map(([key, value]) => `**${key}**: ${value}`).join('\n'));
  }

  return embed;
}
