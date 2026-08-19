import { EmbedBuilder } from 'discord.js';
import { hourlyRate, timeToOvertake, formatDuration, formatRate, formatPoints } from './rates.js';
import {
  nextBattleEndUnix,
  projectPointsAtBattleEnd,
  projectPlacementBracket,
  projectExactPlacement,
} from './battleTimer.js';
import { getPlayerRanking } from './db.js';
import { formatName } from './robloxNames.js';

const COLOR_GAINING = 0x57f287; // green — closing the gap on the league ahead
const COLOR_NEUTRAL = 0x5865f2; // discord blurple — steady / no clear trend yet
const COLOR_LOSING = 0xed4245; // red — falling behind the league ahead

const MILESTONE_ORDER = [250, 100, 50, 10];

// Discord rejects an embed whose field value exceeds 1024 characters (4096 for
// a description), and it rejects the WHOLE message, not just that one field.
export const FIELD_LIMIT = 1024;
export const DESCRIPTION_LIMIT = 4096;

/**
 * Join lines into an embed value, dropping the tail that wouldn't fit and
 * noting how many were dropped. Mirrors the clan bot's helper of the same
 * name — the two bots deliberately keep separate copies of lib code.
 *
 * Capping by entry count instead of characters is the recurring bug across
 * both bots: a list measures fine on typical names, then a few long display
 * names push it past the limit and the entire reply is refused. This measures.
 *
 * @param {string[]} lines
 * @param {string} emptyText Value to use when there are no lines at all.
 * @param {number} limit Character budget; defaults to the field limit.
 */
export function capToFieldLimit(lines, emptyText = '_None._', limit = FIELD_LIMIT) {
  if (lines.length === 0) return emptyText;

  const kept = [];
  let used = 0;
  for (const line of lines) {
    // Budget for the "…and N more." tail as if it were needed, so adding it
    // afterwards can never be what pushes the value over the limit.
    const suffix = `\n_…and ${lines.length - kept.length} more._`;
    if (used + line.length + 1 + suffix.length > limit) break;
    kept.push(line);
    used += line.length + 1;
  }

  // Nothing fit at all: one pathologically long line (a very long name) would
  // otherwise return a value that is only the "…and N more." tail. Show a
  // truncated first line instead, so the value still says something.
  if (kept.length === 0) return lines[0].slice(0, limit - 1) + '…';

  const remaining = lines.length - kept.length;
  return kept.join('\n') + (remaining > 0 ? `\n_…and ${remaining} more._` : '');
}

/**
 * Build the status embed for a tracked league.
 *
 * Ahead/behind/milestone targets are always LIVE — whoever currently holds
 * that rank/position, read fresh every poll, with no locking or re-lock delay.
 *
 * ETA math is two-body when possible: both the tracked league's rate AND the
 * target's own rate are used (target.Rate, populated in poller.js from the
 * hourly top-N rankings job — see rankingsJob.js / league_points_history).
 * This matters because a target that's ALSO gaining points isn't standing
 * still — treating it as static would understate how long it actually takes
 * to catch up, or wrongly claim you're catching up when the target is
 * pulling away faster than you're gaining. If a target's rate isn't
 * available (outside the top-N leagues the rankings job covers), the bot
 * falls back to a one-sided estimate and says so explicitly, rather than
 * quietly guessing.
 *
 * @param {object} params
 * @param {object} params.league       Current /v1/leagues/:name detail (Name, Points, Members, Owner, ...)
 * @param {object|null} params.hourAgoSnapshot  Snapshot row from ~1h ago, or null if not enough history yet
 * @param {object} params.latestSnapshot        The snapshot we just took (for member points now)
 * @param {object} params.neighbors    { rank, total, ahead, behind } from findLeagueNeighbors, each with an added .Rate
 * @param {object} params.milestones   { [rank]: { ID, Points, Name, Rate } } for milestone ranks not yet passed
 * @param {Date} params.trackingStartedAt
 */
export function buildLeagueEmbed({ league, hourAgoSnapshot, latestSnapshot, neighbors, milestones, trackingStartedAt, idleMembers = [], leagueRateInputs = [], iconUrl = null }) {
  const now = latestSnapshot.ts;
  const currentPoints = league.Points;

  const leagueRate = hourAgoSnapshot
    ? hourlyRate(hourAgoSnapshot.points, hourAgoSnapshot.ts, currentPoints, now)
    : null;

  const aheadResult = neighbors.ahead
    ? computeOvertake(currentPoints, leagueRate, neighbors.ahead.Points, neighbors.ahead.Rate)
    : null;

  const embed = new EmbedBuilder()
    .setTitle(`${rankBadge(neighbors.rank)} ${league.Name}`)
    .setColor(pickColor(neighbors.ahead, leagueRate, aheadResult))
    .setDescription(buildSummaryLine({ neighbors, leagueRate, aheadResult }))
    .setTimestamp(new Date(now * 1000));

  // Resolved by the caller and passed in, never built from a URL template:
  // the old www.roblox.com/asset-thumbnail route returns 404 for every asset,
  // and because it fails inside an <img> tag Discord just showed no thumbnail
  // and nothing logged an error.
  if (iconUrl) embed.setThumbnail(iconUrl);

  embed.addFields(
    { name: '🏆 Points', value: `**${formatPoints(currentPoints)}**`, inline: true },
    { name: '⚡ Hourly Rate', value: formatRate(leagueRate), inline: true },
    {
      name: '📈 Rank',
      value: neighbors.rank ? `**#${neighbors.rank}** / ${neighbors.total.toLocaleString()}` : 'N/A',
      inline: true,
    }
  );

  // --- League ahead: two-body ETA when we know their rate, one-sided fallback otherwise ---
  if (neighbors.ahead) {
    embed.addFields({
      name: `⬆️ Ahead — ${neighbors.ahead.Name}`,
      value: buildTargetLine({
        currentPoints,
        leagueRate,
        targetPoints: neighbors.ahead.Points,
        targetRate: neighbors.ahead.Rate,
        directionLabel: 'Catch up',
        nowUnix: now,
      }),
      inline: true,
    });
  } else {
    embed.addFields({ name: '⬆️ Ahead', value: '🥇 Already #1!', inline: true });
  }

  // --- League behind: same two-body treatment, just inverted (they're the chaser) ---
  if (neighbors.behind) {
    embed.addFields({
      name: `⬇️ Behind — ${neighbors.behind.Name}`,
      value: buildTargetLine({
        currentPoints: neighbors.behind.Points,
        leagueRate: neighbors.behind.Rate,
        targetPoints: currentPoints,
        targetRate: leagueRate,
        directionLabel: 'Catches up to you',
        nowUnix: now,
      }),
      inline: true,
    });
  } else {
    embed.addFields({ name: '⬇️ Behind', value: '🔚 Last place — no one behind.', inline: true });
  }

  // --- Milestones: distance to top 100 / 50 / 10, two-body when possible ---
  if (milestones && Object.keys(milestones).length > 0) {
    const milestoneLines = MILESTONE_ORDER.filter((rank) => milestones[rank]).map((rank) => {
      const target = milestones[rank];
      const line = buildTargetLine({
        currentPoints,
        leagueRate,
        targetPoints: target.Points,
        targetRate: target.Rate,
        directionLabel: `Reach top ${rank}`,
        nowUnix: now,
      });
      return `**Top ${rank}** (${target.Name}): ${line.replace('\n', ' — ')}`;
    });

    if (milestoneLines.length > 0) {
      embed.addFields({
        name: '🎯 Milestones',
        value: milestoneLines.join('\n'),
        inline: false,
      });
    }
  }

  // --- Battle end projection: where your points would land if your current
  // rate holds until Saturday 2am AEST. Clearly labeled as a projection, not
  // a promise — rates fluctuate and this can't account for other leagues
  // changing their own pace between now and then. Includes a rough placement
  // BRACKET (not a fake-precise single rank) derived from the same milestone
  // leagues already tracked, each projected forward the same way. Countdown
  // uses Discord's native <t:...:R> markup so it live-updates in the client
  // with no polling needed on our end. ---
  if (leagueRate != null) {
    const battleEndUnix = nextBattleEndUnix(new Date(now * 1000));
    const projectedPoints = projectPointsAtBattleEnd(currentPoints, leagueRate, new Date(now * 1000));
    // Exact rank when we have enough league history to compute one; the old
    // milestone bracket is only a fallback now, because it could not tell
    // rank 101 from rank 900 — both were just "outside top 100".
    const exact = projectExactPlacement(projectedPoints, leagueRateInputs, league.ID, new Date(now * 1000));
    const placementBracket = exact ? null : projectPlacementBracket(projectedPoints, milestones, new Date(now * 1000));

    const lines = [
      `~${formatPoints(projectedPoints)} pts if this rate holds`,
    ];

    if (exact) {
      lines.push(
        `Projected finish: **#${exact.rank.toLocaleString()}**` +
          (exact.confident
            ? ` of ${exact.of.toLocaleString()} tracked leagues`
            : ` or lower — beyond the ${exact.of.toLocaleString()} leagues we track`)
      );
    } else if (placementBracket) {
      lines.push(`Projected placement: **${placementBracket}**`);
    }

    lines.push(`Battle ends <t:${battleEndUnix}:R> (Sat 2am AEST)`);

    if (neighbors.ahead) {
      const wouldPass = projectedPoints >= neighbors.ahead.Points;
      lines.push(
        wouldPass
          ? `✅ Enough to currently be ahead of **${neighbors.ahead.Name}** (${formatPoints(neighbors.ahead.Points)} pts now — they'll likely have more by then)`
          : `Still short of **${neighbors.ahead.Name}**'s current ${formatPoints(neighbors.ahead.Points)} pts`
      );
    }

    embed.addFields({
      name: '🏁 Projected at Battle End',
      value: lines.join('\n'),
      inline: false,
    });
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
    .map((m, i) => {
      const globalRank = getPlayerRanking(m.userId);
      const rankTag = globalRank ? ` \`#${globalRank.globalRank}\`` : '';
      return `${medals[i] ?? '▫️'} **${formatName(m)}**${rankTag} — ${formatPoints(m.points)} pts  ${trendArrow(m.rate)} ${formatRate(m.rate)}`;
    })
    .join('\n');

  embed.addFields({
    name: `👥 Members (${members.length}/${league.MemberCapacity ?? 4})`,
    value: memberLines || 'No member data yet.',
    inline: false,
  });

  // Who has stopped scoring, as its own section.
  //
  // The members list above shows running totals, and a total cannot answer
  // "who has gone quiet" — somebody who contributed heavily this morning and
  // nothing since still sits near the top of it. This is measured against the
  // PREVIOUS POLL, so it follows POLL_INTERVAL_MINUTES: at the default it means
  // "gained nothing in the last 10 minutes".
  const pollMinutes = Number(process.env.POLL_INTERVAL_MINUTES) || 10;

  if (idleMembers.length > 0) {
    const idleLines = idleMembers.map((m) => {
      const bell = m.linked ? '🔔' : '🔕';
      return `${bell} **${formatName(m, { withDisplayName: false })}** — idle since <t:${m.idleSince}:R> · ${formatPoints(m.points)} pts`;
    });

    embed.addFields({
      name: `😴 Inactive (${idleMembers.length}) — no points in the last ${pollMinutes}m`,
      value: capToFieldLimit(idleLines, '_None._'),
      inline: false,
    });
  } else if (members.length > 0) {
    // Say so explicitly. A missing section is ambiguous — it could mean
    // "everyone is active" or "the check didn't run".
    embed.addFields({
      name: '😴 Inactive (0)',
      value: `✅ Everyone scored in the last ${pollMinutes} minutes.`,
      inline: false,
    });
  }

  const pollIntervalMinutes = Number(process.env.POLL_INTERVAL_MINUTES) || 10;
  const nextUpdateUnix = now + pollIntervalMinutes * 60;

  embed.addFields({
    name: '⏱️ Next Update',
    value: `<t:${nextUpdateUnix}:R>`,
    inline: true,
  });

  embed.setFooter({
    text: hourAgoSnapshot
      ? `Updates every ${pollIntervalMinutes} minutes • ETAs account for the target's own pace when it's in the top-1,000 leagues`
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

/** Pick an accent color based on whether the tracked league is gaining on the live league ahead. */
function pickColor(aheadLeague, leagueRate, aheadResult) {
  if (!aheadLeague) return COLOR_GAINING; // #1, nothing but good news
  if (leagueRate == null || aheadResult == null) return COLOR_NEUTRAL; // still collecting data
  if (typeof aheadResult === 'object' && aheadResult.fallingBehind) return COLOR_LOSING;
  return COLOR_GAINING; // finite ETA — actively closing the gap (or one-sided-positive)
}

function buildSummaryLine({ neighbors, leagueRate, aheadResult }) {
  if (leagueRate == null) {
    return '🕒 Collecting data — the first hourly rate will appear once an hour has passed.';
  }
  if (!neighbors.ahead) {
    return `🥇 Sitting at **#1** with ${formatRate(leagueRate)}. Nothing but clear road ahead.`;
  }
  if (aheadResult && typeof aheadResult === 'object' && aheadResult.fallingBehind) {
    return `📉 **${neighbors.ahead.Name}** is pulling away faster than you're gaining — the gap is growing.`;
  }
  if (aheadResult && typeof aheadResult.eta === 'number') {
    return `📈 Chasing **${neighbors.ahead.Name}** — ETA: **${formatDuration(aheadResult.eta)}**${aheadResult.oneSided ? ' (estimate)' : ''}.`;
  }
  return `Currently rank **#${neighbors.rank}**, tracking at ${formatRate(leagueRate)}.`;
}

/**
 * Compute the overtake result between a chaser and a target. Uses real
 * two-body math (timeToOvertake, accounting for BOTH rates) whenever the
 * target's own rate is known; falls back to treating the target as
 * stationary only when we genuinely don't have their rate, and flags that
 * fallback explicitly via `oneSided` so the UI can say so.
 *
 * Note: for milestones, `targetRate` here isn't necessarily one specific
 * league's own rate — poller.js computes it as an average across several
 * leagues clustered around that rank, specifically to avoid one league's
 * noisy single-hour reading (e.g. a quiet hour) producing a misleadingly
 * fast or slow ETA. This function doesn't need to know that distinction; it
 * just uses whatever rate it's given.
 *
 * Returns:
 *   - null if the chaser's own rate is unknown (still collecting data)
 *   - null if the chaser is already at/past the target
 *   - { fallingBehind: true, gapGrowthPerHour } if the target is pulling away
 *   - { eta: hours, oneSided: boolean } otherwise
 */
function computeOvertake(chaserPoints, chaserRate, targetPoints, targetRate) {
  if (chaserRate == null) return null;
  if (chaserPoints >= targetPoints) return null;

  if (targetRate != null) {
    const result = timeToOvertake({ chaserPoints, chaserRate, targetPoints, targetRate });
    if (result === null) return null;
    if (typeof result === 'object' && result.fallingBehind) return result;
    return { eta: result, oneSided: false };
  }

  // Target's rate unknown (outside top-1,000 leagues, or rankings job hasn't
  // run twice yet) — fall back to a one-sided estimate treating them as
  // stationary, clearly flagged so the UI doesn't present it as exact.
  const gap = targetPoints - chaserPoints;
  if (chaserRate <= 0) return { fallingBehind: true, gapGrowthPerHour: 0 };
  return { eta: gap / chaserRate, oneSided: true };
}

function buildTargetLine({ currentPoints, leagueRate, targetPoints, targetRate, directionLabel, nowUnix }) {
  if (leagueRate == null) {
    return 'Collecting data — check back once an hour of history is available.';
  }

  const gap = Math.abs(targetPoints - currentPoints);

  if (currentPoints >= targetPoints) {
    return `✅ Already past this mark! (${formatPoints(currentPoints - targetPoints)} pts ahead)`;
  }

  const result = computeOvertake(currentPoints, leagueRate, targetPoints, targetRate);

  if (result && typeof result === 'object' && result.fallingBehind) {
    const growth = result.gapGrowthPerHour
      ? `+${Math.round(result.gapGrowthPerHour).toLocaleString()}/hr wider`
      : 'not gaining at current rate';
    return `Gap: **${formatPoints(gap)}** pts\n📉 ${growth}`;
  }

  if (result && typeof result.eta === 'number') {
    const suffix = result.oneSided ? ' (estimate — target rate unknown)' : '';
    // Live-updating countdown via Discord's native timestamp markup, rather
    // than a static "48m" string that's only accurate the instant it's posted.
    const etaUnix = Math.round(nowUnix + result.eta * 3600);
    return `Gap: **${formatPoints(gap)}** pts\n${directionLabel}: <t:${etaUnix}:R>${suffix}`;
  }

  return `Gap: **${formatPoints(gap)}** pts`;
}
