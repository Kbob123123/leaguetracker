import { EmbedBuilder } from 'discord.js';
import { hourlyRate, formatDuration, formatRate, formatPoints } from './rates.js';

const COLOR_GAINING = 0x57f287; // green — closing the gap on the locked target ahead
const COLOR_NEUTRAL = 0x5865f2; // discord blurple — steady / no clear trend yet
const COLOR_LOSING = 0xed4245; // red — falling behind the locked target ahead

const MILESTONE_ORDER = [100, 50, 10];

/**
 * Build the status embed for a tracked league.
 *
 * Targets (the league ahead, the league behind, and milestones) are all
 * "locked" — their points threshold is fixed at the moment they're first
 * seen (or re-locked after being beaten) and does NOT move just because some
 * other league shuffles position underneath it. Only the tracked league's own
 * point rate moves the ETA. See poller.js's resolveLockedTarget /
 * resolveBehindTarget for where locking happens.
 *
 * @param {object} params
 * @param {object} params.league       Current /v1/leagues/:name detail (Name, Points, Members, Owner, ...)
 * @param {object|null} params.hourAgoSnapshot  Snapshot row from ~1h ago, or null if not enough history yet
 * @param {object} params.latestSnapshot        The snapshot we just took (for member points now)
 * @param {object} params.neighbors    { rank, total } from findLeagueNeighbors (rank/total are always live)
 * @param {object|null} params.aheadTarget   Locked target row for 'ahead', or null if rank 1
 * @param {object|null} params.behindTarget  Locked target row for 'behind', or null if last place
 * @param {object} params.lockedMilestones   { [rank]: lockedTargetRow } for ranks not yet passed
 * @param {Date} params.trackingStartedAt
 */
export function buildLeagueEmbed({
  league,
  hourAgoSnapshot,
  latestSnapshot,
  neighbors,
  aheadTarget,
  behindTarget,
  lockedMilestones,
  trackingStartedAt,
}) {
  const now = latestSnapshot.ts;
  const currentPoints = league.Points;

  const leagueRate = hourAgoSnapshot
    ? hourlyRate(hourAgoSnapshot.points, hourAgoSnapshot.ts, currentPoints, now)
    : null;

  const aheadEta = aheadTarget ? etaToFixedTarget(currentPoints, leagueRate, aheadTarget.target_points) : null;

  const embed = new EmbedBuilder()
    .setTitle(`${rankBadge(neighbors.rank)} ${league.Name}`)
    .setColor(pickColor(aheadTarget, leagueRate, aheadEta))
    .setDescription(buildSummaryLine({ neighbors, leagueRate, aheadTarget, aheadEta }))
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

  // --- Locked target ahead: fixed-threshold ETA to overtake ---
  if (aheadTarget) {
    embed.addFields({
      name: `⬆️ Target — ${aheadTarget.target_league_name}${aheadTarget.justLocked ? ' 🔒' : ''}`,
      value: buildFixedTargetLine({ currentPoints, leagueRate, targetPoints: aheadTarget.target_points, directionLabel: 'catch up' }),
      inline: true,
    });
  } else {
    embed.addFields({ name: '⬆️ Ahead', value: '🥇 Already #1!', inline: true });
  }

  // --- Locked target behind: static gap only — we don't track other leagues'
  // own point rates, so an ETA for them would be a guess. Showing the honest
  // gap instead of a fabricated countdown. ---
  if (behindTarget) {
    const gap = behindTarget.target_points - (behindTarget.chaserPoints ?? 0);
    const gapText = gap > 0 ? `${formatPoints(gap)} pts to catch you (as of lock)` : 'Very close — may have caught up';
    embed.addFields({
      name: `⬇️ Behind — ${behindTarget.target_league_name}${behindTarget.justLocked ? ' 🔒' : ''}`,
      value: `Needs **${formatPoints(behindTarget.target_points)}** pts to catch the mark you locked at.\n${gapText}`,
      inline: true,
    });
  } else {
    embed.addFields({ name: '⬇️ Behind', value: '🔚 Last place — no one behind.', inline: true });
  }

  // --- Milestones: distance to top 100 / 50 / 10, each a locked fixed target ---
  if (lockedMilestones && Object.keys(lockedMilestones).length > 0) {
    const milestoneLines = MILESTONE_ORDER.filter((rank) => lockedMilestones[rank]).map((rank) => {
      const target = lockedMilestones[rank];
      const line = buildFixedTargetLine({
        currentPoints,
        leagueRate,
        targetPoints: target.target_points,
        directionLabel: `reach top ${rank}`,
      });
      const lockNote = target.justLocked ? ' 🔒' : '';
      return `**Top ${rank}** (${target.target_league_name}${lockNote}): ${line.replace('\n', ' — ')}`;
    });

    if (milestoneLines.length > 0) {
      embed.addFields({
        name: '🎯 Milestones',
        value: milestoneLines.join('\n'),
        inline: false,
      });
    }
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

  const pollIntervalMinutes = Number(process.env.POLL_INTERVAL_MINUTES) || 10;
  const nextUpdateUnix = now + pollIntervalMinutes * 60;

  embed.addFields({
    name: '⏱️ Next Update',
    value: `<t:${nextUpdateUnix}:R>`,
    inline: true,
  });

  embed.setFooter({
    text: hourAgoSnapshot
      ? `Updates every ${pollIntervalMinutes} minutes • 🔒 = target just locked in`
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

/** Pick an accent color based on whether the tracked league is gaining on its locked ahead-target. */
function pickColor(aheadTarget, leagueRate, aheadEta) {
  if (!aheadTarget) return COLOR_GAINING; // #1, nothing but good news
  if (leagueRate == null) return COLOR_NEUTRAL; // still collecting data, no rate known yet
  if (aheadEta === Infinity) return COLOR_LOSING; // rate is zero/negative, never reaching a fixed target
  return COLOR_GAINING; // finite ETA, or target already beaten — both good news
}

function buildSummaryLine({ neighbors, leagueRate, aheadTarget, aheadEta }) {
  if (leagueRate == null) {
    return '🕒 Collecting data — the first hourly rate will appear once an hour has passed.';
  }
  if (!aheadTarget) {
    return `🥇 Sitting at **#1** with ${formatRate(leagueRate)}. Nothing but clear road ahead.`;
  }
  if (aheadEta === Infinity) {
    return `📉 Not currently gaining on the locked target **${aheadTarget.target_league_name}** at this rate.`;
  }
  if (typeof aheadEta === 'number') {
    return `📈 Chasing locked target **${aheadTarget.target_league_name}** — ETA: **${formatDuration(aheadEta)}**.`;
  }
  return `Currently rank **#${neighbors.rank}**, tracking at ${formatRate(leagueRate)}.`;
}

/**
 * ETA to close a FIXED gap at a constant rate — simpler than the old
 * two-mover math since the target no longer has its own rate to account for.
 * Returns hours (number), Infinity if rate <= 0 and gap > 0, or null if
 * already at/past the target or rate unknown.
 */
function etaToFixedTarget(currentPoints, rate, targetPoints) {
  if (rate == null) return null;
  const gap = targetPoints - currentPoints;
  if (gap <= 0) return null; // already there
  if (rate <= 0) return Infinity;
  return gap / rate;
}

function buildFixedTargetLine({ currentPoints, leagueRate, targetPoints, directionLabel }) {
  if (leagueRate == null) {
    return 'Collecting data — check back once an hour of history is available.';
  }

  const gap = targetPoints - currentPoints;
  if (gap <= 0) {
    return `✅ Target reached! (${formatPoints(currentPoints - targetPoints)} pts past)`;
  }

  const eta = etaToFixedTarget(currentPoints, leagueRate, targetPoints);
  if (eta === Infinity) {
    return `Gap: **${formatPoints(gap)}** pts\n📉 not gaining at current rate`;
  }

  return `Gap: **${formatPoints(gap)}** pts\nETA to ${directionLabel}: **${formatDuration(eta)}**`;
}
