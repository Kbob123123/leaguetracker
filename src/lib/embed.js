import { EmbedBuilder } from 'discord.js';
import { hourlyRate, timeToOvertake, formatDuration, formatRate, formatPoints } from './rates.js';

const COLOR_GAINING = 0x57f287; // green — closing the gap on the league ahead
const COLOR_NEUTRAL = 0x5865f2; // discord blurple — steady / no clear trend yet
const COLOR_LOSING = 0xed4245; // red — falling behind the league ahead

/**
 * Build the status embed for a tracked league.
 *
 * @param {object} params
 * @param {object} params.league       Current /v1/leagues/:name detail (Name, Points, Members, Owner, ...)
 * @param {object|null} params.hourAgoSnapshot  Snapshot row from ~1h ago, or null if not enough history yet
 * @param {object} params.latestSnapshot        The snapshot we just took (for member points now)
 * @param {object} params.neighbors    { rank, total, ahead, behind } from findLeagueNeighbors (current points)
 * @param {Date} params.trackingStartedAt
 */
export function buildLeagueEmbed({ league, hourAgoSnapshot, latestSnapshot, neighbors, trackingStartedAt }) {
  const now = latestSnapshot.ts;
  const currentPoints = league.Points;

  const leagueRate = hourAgoSnapshot
    ? hourlyRate(hourAgoSnapshot.points, hourAgoSnapshot.ts, currentPoints, now)
    : null;

  // Neighbor rates come from the ahead/behind league's points recorded in our
  // own snapshot history (see poller.js), diffed the same way as our own rate.
  let hourAgoNeighbors = null;
  if (hourAgoSnapshot?.neighbors_json) {
    try {
      hourAgoNeighbors = JSON.parse(hourAgoSnapshot.neighbors_json);
    } catch {
      hourAgoNeighbors = null;
    }
  }

  const aheadRate =
    neighbors.ahead && hourAgoNeighbors?.ahead && hourAgoNeighbors.ahead.ID === neighbors.ahead.ID
      ? hourlyRate(hourAgoNeighbors.ahead.Points, hourAgoSnapshot.ts, neighbors.ahead.Points, now)
      : null;

  const behindRate =
    neighbors.behind && hourAgoNeighbors?.behind && hourAgoNeighbors.behind.ID === neighbors.behind.ID
      ? hourlyRate(hourAgoNeighbors.behind.Points, hourAgoSnapshot.ts, neighbors.behind.Points, now)
      : null;

  const aheadResult = neighbors.ahead
    ? timeToOvertake({ chaserPoints: currentPoints, chaserRate: leagueRate, targetPoints: neighbors.ahead.Points, targetRate: aheadRate })
    : null;

  const embed = new EmbedBuilder()
    .setTitle(`${rankBadge(neighbors.rank)} ${league.Name}`)
    .setColor(pickColor(neighbors, aheadResult))
    .setDescription(buildSummaryLine({ league, neighbors, leagueRate, aheadResult }))
    .setTimestamp(new Date(now * 1000));

  if (league.Icon) {
    const iconId = league.Icon.replace('rbxassetid://', '');
    embed.setThumbnail(`https://www.roblox.com/asset-thumbnail/image?assetId=${iconId}&width=150&height=150&format=png`);
  }

  embed.addFields(
    { name: '🏆 Points', value: `**${formatPoints(currentPoints)}**`, inline: true },
    { name: '⚡ Hourly Rate', value: formatRate(leagueRate), inline: true },
    {
      name: '📈 Rank',
      value: neighbors.rank ? `**#${neighbors.rank}** / ${neighbors.total.toLocaleString()}` : 'N/A',
      inline: true,
    }
  );

  // --- League ahead: time to overtake ---
  if (neighbors.ahead) {
    embed.addFields({
      name: `⬆️ Ahead — ${neighbors.ahead.Name}`,
      value: buildOvertakeLine({
        chaserPoints: currentPoints,
        chaserRate: leagueRate,
        targetPoints: neighbors.ahead.Points,
        targetRate: aheadRate,
        directionLabel: 'catch up',
      }),
      inline: true,
    });
  } else {
    embed.addFields({ name: '⬆️ Ahead', value: '🥇 Already #1!', inline: true });
  }

  // --- League behind: time until they overtake us ---
  if (neighbors.behind) {
    embed.addFields({
      name: `⬇️ Behind — ${neighbors.behind.Name}`,
      value: buildOvertakeLine({
        chaserPoints: neighbors.behind.Points,
        chaserRate: behindRate,
        targetPoints: currentPoints,
        targetRate: leagueRate,
        directionLabel: 'catch up to you',
      }),
      inline: true,
    });
  } else {
    embed.addFields({ name: '⬇️ Behind', value: '🔚 Last place — no one behind.', inline: true });
  }

  embed.addFields({ name: '\u200b', value: '\u200b', inline: false }); // full-width spacer before members

  // --- Members ---
  const members = JSON.parse(latestSnapshot.members_json);
  const memberRates = members.map((m) => {
    let rate = null;
    if (hourAgoSnapshot) {
      const prevMembers = JSON.parse(hourAgoSnapshot.members_json);
      const prev = prevMembers.find((p) => p.userId === m.userId);
      if (prev) rate = hourlyRate(prev.points, hourAgoSnapshot.ts, m.points, now);
    }
    return { ...m, rate };
  });
  memberRates.sort((a, b) => b.points - a.points);

  const medals = ['🥇', '🥈', '🥉', '🏅'];
  const memberLines = memberRates
    .map((m, i) => `${medals[i] ?? '▫️'} **${m.displayName}** — ${formatPoints(m.points)} pts  ${trendArrow(m.rate)} ${formatRate(m.rate)}`)
    .join('\n');

  embed.addFields({
    name: `👥 Members (${members.length}/${league.MemberCapacity ?? 4})`,
    value: memberLines || 'No member data yet.',
    inline: false,
  });

  embed.setFooter({
    text: hourAgoSnapshot
      ? 'Updates every 10 minutes'
      : 'Tracking started — hourly rates appear once an hour of data has been collected',
  });

  return embed;
}

function rankBadge(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return '📊';
}

function trendArrow(rate) {
  if (rate == null) return '';
  if (rate > 0) return '🟢';
  if (rate < 0) return '🔴';
  return '⚪';
}

/** Pick an accent color based on whether the tracked league is gaining or losing ground on the one ahead. */
function pickColor(neighbors, aheadResult) {
  if (!neighbors.ahead) return COLOR_GAINING; // #1, nothing but good news
  if (!aheadResult) return COLOR_NEUTRAL; // still collecting data
  if (typeof aheadResult === 'object' && aheadResult.fallingBehind) return COLOR_LOSING;
  return COLOR_GAINING; // closing the gap (finite ETA or already ahead)
}

function buildSummaryLine({ league, neighbors, leagueRate, aheadResult }) {
  if (leagueRate == null) {
    return '🕒 Collecting data — the first hourly rate will appear once an hour has passed.';
  }
  if (!neighbors.ahead) {
    return `🥇 Sitting at **#1** with ${formatRate(leagueRate)}. Nothing but clear road ahead.`;
  }
  if (aheadResult && typeof aheadResult === 'object' && aheadResult.fallingBehind) {
    return `📉 Losing ground to **${neighbors.ahead.Name}** — the gap is widening.`;
  }
  if (typeof aheadResult === 'number') {
    return `📈 Gaining on **${neighbors.ahead.Name}** — ETA to overtake: **${formatDuration(aheadResult)}**.`;
  }
  return `Currently rank **#${neighbors.rank}**, tracking at ${formatRate(leagueRate)}.`;
}

function buildOvertakeLine({ chaserPoints, chaserRate, targetPoints, targetRate, directionLabel }) {
  if (chaserRate == null || targetRate == null) {
    return 'Collecting data — check back once an hour of history is available.';
  }

  const gap = Math.abs(targetPoints - chaserPoints);
  const result = timeToOvertake({ chaserPoints, chaserRate, targetPoints, targetRate });

  if (result === null) {
    return `Already ahead by **${formatPoints(chaserPoints - targetPoints)}** pts.`;
  }

  if (typeof result === 'object' && result.fallingBehind) {
    return `Gap: **${formatPoints(gap)}** pts\n📉 falling behind (+${Math.round(result.gapGrowthPerHour).toLocaleString()}/hr wider)`;
  }

  return `Gap: **${formatPoints(gap)}** pts\nETA to ${directionLabel}: **${formatDuration(result)}**`;
}
