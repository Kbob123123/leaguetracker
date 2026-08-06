import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors } from '../lib/ps99Api.js';
import { getLatestPlayerPointsForLeague, getPlayerPointsNear, getPlayerPointsHistory, getRankingsMeta } from '../lib/db.js';
import { hourlyRate, formatPoints, formatRate } from '../lib/rates.js';
import { renderMemberGraphFromPoints } from '../lib/graph.js';
import { resolveDisplayNames } from '../lib/robloxNames.js';

const HOUR_SECONDS = 3600;

export const data = new SlashCommandBuilder()
  .setName('leaguesnapshot')
  .setDescription('Snapshot of any top-1,000 league from the last hourly scan (not live-updating).')
  .addStringOption((opt) =>
    opt.setName('league').setDescription('Exact league name (case-insensitive)').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const leagueName = interaction.options.getString('league', true);
  const league = await getLeagueDetail(leagueName);

  if (!league) {
    await interaction.editReply(`❌ Couldn't find a league named **${leagueName}**.`);
    return;
  }

  const neighbors = await findLeagueNeighbors(league);
  const latestMembers = getLatestPlayerPointsForLeague(league.ID);
  const lastRebuiltAt = getRankingsMeta('last_rebuilt_at');

  let ownerName = league.Owner?.DisplayName || null;
  if (league.Owner?.UserID && (!ownerName || ownerName === String(league.Owner.UserID))) {
    const [resolvedOwner] = await resolveDisplayNames([
      { userId: league.Owner.UserID, displayName: ownerName },
    ]);
    ownerName = resolvedOwner.displayName;
  }

  // League-level rate: sum of member rates, since we don't store a separate
  // league-total snapshot for this command and this is exact.
  let leagueRate = null;
  if (latestMembers.length > 0) {
    let totalRate = 0;
    let anyRateKnown = false;
    for (const m of latestMembers) {
      const hourAgo = getPlayerPointsNear(m.user_id, league.ID, HOUR_SECONDS);
      if (hourAgo && hourAgo.ts !== m.ts) {
        totalRate += hourlyRate(hourAgo.points, hourAgo.ts, m.points, m.ts);
        anyRateKnown = true;
      }
    }
    if (anyRateKnown) leagueRate = totalRate;
  }

  const contributions = league.PointContributions || [];
  const memberCount = contributions.length || latestMembers.length;

  let snapshotAge = 'N/A';
  if (lastRebuiltAt) {
    const minutesAgo = Math.round((Date.now() / 1000 - Number(lastRebuiltAt)) / 60);
    snapshotAge = minutesAgo < 60 ? `${minutesAgo}m ago` : `${Math.round(minutesAgo / 60)}h ago`;
  }

  // Compact stacked header, styled after a clean stat-card look rather than
  // a scattered grid of small inline fields.
  const headerLines = [
    `**Points:** ${formatPoints(league.Points)} (${formatRate(leagueRate)})`,
    `**Global Rank:** ${neighbors.rank ? `#${neighbors.rank} of ${neighbors.total.toLocaleString()}` : 'N/A'}`,
    `**Members:** ${memberCount}/${league.MemberCapacity ?? 4}`,
  ];
  if (ownerName) headerLines.push(`**Owner:** ${ownerName}`);
  headerLines.push(`**Stats Snapshot:** ${snapshotAge}`);

  const embed = new EmbedBuilder()
    .setTitle(league.Name)
    .setColor(0x5865f2)
    .setDescription(headerLines.join('\n'))
    .setTimestamp();

  if (league.Icon) {
    const iconId = league.Icon.replace('rbxassetid://', '');
    embed.setThumbnail(`https://www.roblox.com/asset-thumbnail/image?assetId=${iconId}&width=150&height=150&format=png`);
  }

  // --- Contributions: numbered list, current totals + rate from our history ---
  const rawContributions = contributions.map((c) => ({ userId: c.UserID, displayName: c.DisplayName, points: c.Points }));
  const resolvedContributions = await resolveDisplayNames(rawContributions);

  const withRates = resolvedContributions
    .map((c) => {
      const hourAgo = getPlayerPointsNear(String(c.userId), league.ID, HOUR_SECONDS);
      const rate = hourAgo ? hourlyRate(hourAgo.points, hourAgo.ts, c.points, Math.floor(Date.now() / 1000)) : null;
      return { displayName: c.displayName, points: c.points, rate };
    })
    .sort((a, b) => b.points - a.points);

  const contributionLines = withRates
    .map((m, i) => `**#${i + 1}** ${m.displayName} · ${formatPoints(m.points)} pts · ${formatRate(m.rate)}`)
    .join('\n');

  embed.addFields({
    name: 'Contributions',
    value: contributionLines || 'No contribution data available.',
    inline: false,
  });

  embed.setFooter({
    text: 'Snapshot only — not live-updating. Use /startmonitoringleague for live 10-minute updates.',
  });

  const files = [];
  if (latestMembers.length >= 1) {
    const historyByTs = new Map();
    for (const m of latestMembers) {
      const rows = getPlayerPointsHistory(m.user_id, league.ID, 24 * HOUR_SECONDS);
      for (const row of rows) {
        if (!historyByTs.has(row.ts)) historyByTs.set(row.ts, []);
        historyByTs.get(row.ts).push({ userId: row.user_id, displayName: row.display_name, points: row.points });
      }
    }
    const pointsHistory = Array.from(historyByTs.entries())
      .map(([ts, members]) => ({ ts: Number(ts), members }))
      .sort((a, b) => a.ts - b.ts);

    if (pointsHistory.length >= 2) {
      const buffer = await renderMemberGraphFromPoints(pointsHistory, league.Name);
      if (buffer) {
        const attachment = new AttachmentBuilder(buffer, { name: 'league-graph.png' });
        embed.setImage('attachment://league-graph.png');
        files.push(attachment);
      }
    }
  }

  await interaction.editReply({ embeds: [embed], files });
}
