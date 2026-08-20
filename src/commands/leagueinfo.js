import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors } from '../lib/ps99Api.js';
import {
  getLatestPlayerPointsForLeague,
  getPlayerPointsNear,
  getPlayerPointsHistory,
  getRankingsMeta,
} from '../lib/db.js';
import { hourlyRate, formatPoints, formatRate } from '../lib/rates.js';
import { renderMemberGraphFromPoints } from '../lib/graph.js';
import { resolveThumbnail } from '../lib/thumbnails.js';
import { resolveNames, formatName } from '../lib/robloxNames.js';

const HOUR_SECONDS = 3600;

// This used to be two commands: /leagueinfo (bare standing) and
// /leaguesnapshot (the same thing plus owner, rates and a graph). Nobody
// wanted the thinner one, so the snapshot IS the league lookup now.
export const data = new SlashCommandBuilder()
  .setName('leagueinfo')
  .setDescription('Look up a PS99 league: standing, contributions, rates and a 24h graph.')
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
    const [resolvedOwner] = await resolveNames([
      { userId: league.Owner.UserID, displayName: ownerName },
    ]);
    ownerName = formatName(resolvedOwner);
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

  // Prose, then a grid. The old header was a stacked column of
  // emoji + bold label + value — the same pattern that made the player card
  // read as a copy of another bot, so it is not reintroduced here.
  const summary = [
    // The points figure has its own field below; repeating it here would
    // just be the same number twice in the reader's first two lines.
    neighbors.rank
      ? `Ranked **#${neighbors.rank}** of ${neighbors.total.toLocaleString()} leagues.`
      : 'Not currently on the ranked leaderboard.',
    ownerName ? `Run by **${ownerName}**.` : null,
  ]
    .filter(Boolean)
    .join(' ');

  const embed = new EmbedBuilder()
    .setTitle(league.Name)
    .setColor(0x2ee6c5)
    .setDescription(summary)
    .setTimestamp();

  embed.addFields(
    { name: '⭐ Points', value: `**${formatPoints(league.Points)}**`, inline: true },
    { name: '📈 Rate', value: formatRate(leagueRate), inline: true },
    {
      name: '🌍 Global rank',
      value: neighbors.rank ? `**#${neighbors.rank}**\nof ${neighbors.total.toLocaleString()}` : '—',
      inline: true,
    },
    { name: '👥 Members', value: `**${memberCount}**/${league.MemberCapacity ?? 4}`, inline: true },
    { name: '🏅 Level', value: league.Level != null ? `**${league.Level}**` : '—', inline: true },
    { name: '🕒 Stats from', value: snapshotAge, inline: true }
  );

  // The old www.roblox.com/asset-thumbnail URL template 404s for every asset,
  // and fails inside an <img> tag, so Discord showed no thumbnail and nothing
  // logged an error. Resolved through the thumbnail service instead.
  const iconUrl = await resolveThumbnail(league.Icon).catch(() => null);
  if (iconUrl) embed.setThumbnail(iconUrl);

  // Kept from the old thin /leagueinfo: neighbours are the one thing the
  // snapshot view never showed, and they're already fetched for the rank.
  embed.addFields(
    {
      name: '⬆️ Ahead',
      value: neighbors.ahead
        ? `**${neighbors.ahead.Name}** — ${formatPoints(neighbors.ahead.Points)} pts`
        : '🏆 Already #1!',
      inline: true,
    },
    {
      name: '⬇️ Behind',
      value: neighbors.behind
        ? `**${neighbors.behind.Name}** — ${formatPoints(neighbors.behind.Points)} pts`
        : 'Last place',
      inline: true,
    },
    { name: '\u200b', value: '\u200b', inline: true } // spacer so the row stays 3-wide
  );

  // --- Contributions: numbered list, current totals + rate from our history ---
  const rawContributions = contributions.map((c) => ({ userId: c.UserID, displayName: c.DisplayName, points: c.Points }));
  const resolvedContributions = await resolveNames(rawContributions);

  const withRates = resolvedContributions
    .map((c) => {
      const hourAgo = getPlayerPointsNear(String(c.userId), league.ID, HOUR_SECONDS);
      const rate = hourAgo ? hourlyRate(hourAgo.points, hourAgo.ts, c.points, Math.floor(Date.now() / 1000)) : null;
      return { username: c.username, displayName: c.displayName, points: c.points, rate };
    })
    .sort((a, b) => b.points - a.points);

  // A league holds 4 members, so the whole list always fits inside Discord's
  // 1024-character field cap — no trimming needed here, unlike the clan bot.
  const medals = ['🥇', '🥈', '🥉'];
  const contributionLines = withRates
    .map((m, i) => `${medals[i] ?? `\`#${i + 1}\``} **${formatName(m)}** · ⭐ ${formatPoints(m.points)} · 📈 ${formatRate(m.rate)}`)
    .join('\n');

  embed.addFields({
    name: '🏅 Contributions',
    value: contributionLines || 'No contribution data available.',
    inline: false,
  });

  embed.setFooter({
    text: 'Point-in-time lookup. Use /leaguemonitor league action:start for live 10-minute updates.',
  });

  const files = [];
  if (latestMembers.length >= 1) {
    const historyByTs = new Map();
    for (const m of latestMembers) {
      const rows = getPlayerPointsHistory(m.user_id, league.ID, 24 * HOUR_SECONDS);
      for (const row of rows) {
        if (!historyByTs.has(row.ts)) historyByTs.set(row.ts, []);
        historyByTs.get(row.ts).push({
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name,
          points: row.points,
        });
      }
    }
    const pointsHistory = Array.from(historyByTs.entries())
      .map(([ts, members]) => ({ ts: Number(ts), members }))
      .sort((a, b) => a.ts - b.ts);

    if (pointsHistory.length >= 2) {
      const buffer = await renderMemberGraphFromPoints(pointsHistory, league.Name, {
        leagueIcon: league.Icon,
      });
      if (buffer) {
        const attachment = new AttachmentBuilder(buffer, { name: 'league-graph.png' });
        embed.setImage('attachment://league-graph.png');
        files.push(attachment);
      }
    }
  }

  await interaction.editReply({ embeds: [embed], files });
}
