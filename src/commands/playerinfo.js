import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getAllTrackedChannels, getLatestSnapshot, getSnapshotNear, getPlayerRanking, getPlayerRankingsCount, getRankingsMeta } from '../lib/db.js';
import { hourlyRate, formatPoints, formatRate } from '../lib/rates.js';
import { TOP_LEAGUES_COUNT } from '../lib/rankingsJob.js';

const HOUR_SECONDS = 3600;

// Strip anything that isn't a letter or digit before comparing, so "Kbob_2021",
// "kbob 2021", and "KBOB2021" are all treated as the same query. Roblox
// display names commonly differ from what a player types by underscores,
// spacing, or casing alone — a strict substring match on the raw query missed
// real matches for exactly this reason.
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const data = new SlashCommandBuilder()
  .setName('playerinfo')
  .setDescription("Look up a member's points, hourly rate, and global rank across leagues tracked in this server.")
  .addStringOption((opt) =>
    opt.setName('player').setDescription('Display name (or part of it) as shown in the league').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const rawQuery = interaction.options.getString('player', true).trim();
  const query = normalize(rawQuery);
  if (query.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  const trackedInGuild = getAllTrackedChannels().filter((t) => t.guild_id === interaction.guildId);

  if (trackedInGuild.length === 0) {
    await interaction.editReply(
      '❌ No leagues are currently being tracked in this server. Use `/startmonitoringleague` first — ' +
        'this command only searches members of leagues the bot is already tracking.'
    );
    return;
  }

  // Search every tracked channel's latest snapshot for a member whose display
  // name contains the query. Collects ALL matches (a name could appear in
  // more than one tracked league) rather than stopping at the first hit.
  // Also builds a flat list of every known member name across tracked
  // leagues, so a "no match" reply can show what's actually on file instead
  // of a dead-end error — useful for spotting name mismatches at a glance.
  const matches = [];
  const allKnownMembers = [];

  for (const tracked of trackedInGuild) {
    const latest = getLatestSnapshot(tracked.channel_id);
    if (!latest) continue;

    const members = JSON.parse(latest.members_json);
    const sortedByPoints = [...members].sort((a, b) => b.points - a.points);

    for (const member of members) {
      allKnownMembers.push({ displayName: member.displayName, leagueName: tracked.league_name });

      if (!normalize(member.displayName).includes(query)) continue;

      const hourAgo = getSnapshotNear(tracked.channel_id, HOUR_SECONDS);
      const validHourAgo = hourAgo && hourAgo.id !== latest.id ? hourAgo : null;

      let rate = null;
      if (validHourAgo) {
        const prevMembers = JSON.parse(validHourAgo.members_json);
        const prev = prevMembers.find((p) => p.userId === member.userId);
        if (prev) rate = hourlyRate(prev.points, validHourAgo.ts, member.points, latest.ts);
      }

      const leagueRank = sortedByPoints.findIndex((m) => m.userId === member.userId) + 1;

      // Global rank comes from the same hourly top-N-leagues job that powers
      // milestone/ahead/behind rate math — reliable, no external search needed,
      // since it's keyed by the userId we already have from our own snapshot.
      const globalRanking = getPlayerRanking(member.userId);

      matches.push({
        userId: member.userId,
        displayName: member.displayName,
        points: member.points,
        rate,
        leagueName: tracked.league_name,
        channelId: tracked.channel_id,
        leagueRank,
        leagueSize: members.length,
        globalRanking,
      });
    }
  }

  if (matches.length === 0) {
    const rosterPreview = allKnownMembers
      .slice(0, 25)
      .map((m) => `${m.displayName} (${m.leagueName})`)
      .join(', ');
    const rosterNote = allKnownMembers.length
      ? `\n\nMembers on file: ${rosterPreview}${allKnownMembers.length > 25 ? ', ...' : ''}`
      : '';
    await interaction.editReply(
      `❌ No member matching **${rawQuery}** found in any league currently tracked in this server.` + rosterNote
    );
    return;
  }

  const totalRanked = getPlayerRankingsCount();
  const lastRebuiltAt = getRankingsMeta('last_rebuilt_at');

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Player Lookup — "${query}"`)
    .setColor(0x5865f2)
    .setTimestamp();

  const lines = matches.slice(0, 10).map((m) => {
    const parts = [
      `**${m.displayName}** — in **${m.leagueName}** (<#${m.channelId}>)`,
      `└ ${formatPoints(m.points)} pts • ${formatRate(m.rate)} • #${m.leagueRank} of ${m.leagueSize} in that league`,
    ];
    if (m.globalRanking) {
      parts.push(
        `└ 🌍 **#${m.globalRanking.globalRank.toLocaleString()}** of ${totalRanked.toLocaleString()} tracked top-league players`
      );
    }
    return parts.join('\n');
  });

  embed.setDescription(lines.join('\n\n'));

  const footerParts = [];
  if (matches.length > 10) {
    footerParts.push(`Showing 10 of ${matches.length} matches`);
  }
  if (totalRanked > 0 && lastRebuiltAt) {
    const minutesAgo = Math.round((Date.now() / 1000 - Number(lastRebuiltAt)) / 60);
    const ageText = minutesAgo < 60 ? `${minutesAgo}m ago` : `${Math.round(minutesAgo / 60)}h ago`;
    footerParts.push(`Global rank covers top ${TOP_LEAGUES_COUNT} leagues, refreshed ${ageText}`);
  }
  footerParts.push('Only searches members of leagues tracked in this server');
  embed.setFooter({ text: footerParts.join(' • ') });

  await interaction.editReply({ embeds: [embed] });
}
