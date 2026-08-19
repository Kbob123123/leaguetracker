// League/clan battles reliably end Saturday 2am AEST — confirmed by the user,
// who is in Queensland (AEST year-round, no daylight saving to worry about).
// AEST is a fixed UTC+10 offset with no DST complexity as long as we anchor
// to "AEST" specifically rather than "Sydney/Melbourne time" (which drifts to
// AEDT/UTC+11 for roughly half the year). See README for what's NOT known:
// the bot only knows the recurring weekly end-of-battle moment, not whether
// the next battle after this one is guaranteed to exist, or what type it is.

const AEST_OFFSET_HOURS = 10; // fixed, no DST
const BATTLE_END_DAY_UTC_HOUR = { day: 6, hour: 2 - AEST_OFFSET_HOURS }; // Saturday 2am AEST -> Fri 4pm UTC

/**
 * Returns the next occurrence of "Saturday 2am AEST" at or after `fromDate`,
 * as a JS Date. If `fromDate` is exactly on that moment, returns `fromDate`
 * itself (not the following week) — callers wanting "time remaining" should
 * treat a 0-or-negative diff as "battle ending now."
 */
export function nextBattleEnd(fromDate = new Date()) {
  // Work entirely in UTC to avoid the host machine's local timezone leaking in.
  // Saturday 2am AEST = Friday 16:00 UTC (2 - 10 = -8, +24 = 16, day rolls back one).
  const targetUtcDay = 5; // Friday in UTC (0 = Sunday ... 6 = Saturday)
  const targetUtcHour = 16;

  const d = new Date(
    Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate(),
      targetUtcHour,
      0,
      0,
      0
    )
  );

  // Walk forward day-by-day (max 7 iterations) until we hit target UTC weekday
  // at-or-after fromDate. Simple and unambiguous — no modular-arithmetic
  // edge cases to get subtly wrong across month/year boundaries.
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(d.getTime() + i * 24 * 3600 * 1000);
    if (candidate.getUTCDay() === targetUtcDay && candidate.getTime() >= fromDate.getTime()) {
      return candidate;
    }
  }
  // Should be unreachable, but never return undefined.
  return new Date(fromDate.getTime() + 7 * 24 * 3600 * 1000);
}

/** Hours remaining until the next battle end, from `fromDate` (default now). Never negative. */
export function hoursUntilBattleEnd(fromDate = new Date()) {
  const end = nextBattleEnd(fromDate);
  return Math.max(0, (end.getTime() - fromDate.getTime()) / 3600000);
}

/** Unix seconds timestamp of the next battle end — for Discord's native <t:...:R> countdown markup. */
export function nextBattleEndUnix(fromDate = new Date()) {
  return Math.floor(nextBattleEnd(fromDate).getTime() / 1000);
}

/**
 * Project a league's points at battle end, assuming its current hourly rate
 * holds constant. Returns null if rate is unknown. This is explicitly a
 * "what if nothing changes" projection, not a guarantee — rates fluctuate,
 * and this doesn't know anything about other leagues' behavior.
 */
export function projectPointsAtBattleEnd(currentPoints, hourlyRateValue, fromDate = new Date()) {
  if (hourlyRateValue == null) return null;
  const hoursLeft = hoursUntilBattleEnd(fromDate);
  return currentPoints + hourlyRateValue * hoursLeft;
}

/**
 * Rough projected placement BRACKET at battle end, using the same milestone
 * leagues (top 100/50/10) the bot already tracks rates for. Deliberately a
 * bracket ("looks like top 50-100") rather than a fake-precise single rank
 * number — a true single-rank forecast would need every nearby league's own
 * rate projected too, compounding several independent, fluctuating estimates
 * into a number that would look exact but likely wouldn't be. This only
 * projects the handful of milestone leagues we already have real rates for,
 * so the uncertainty stays bounded and honest.
 *
 * @param {number} projectedPoints  this league's own projected points at battle end
 * @param {object} milestones  { [rank]: { Points, Rate } } as used elsewhere in embed.js
 * @param {Date} fromDate
 * @returns {string|null} a short bracket label, or null if no milestone data to compare against
 */
export function projectPlacementBracket(projectedPoints, milestones, fromDate = new Date()) {
  if (projectedPoints == null || !milestones) return null;

  const hoursLeft = hoursUntilBattleEnd(fromDate);
  const projectedMilestones = {}; // rank -> projected points for that milestone league

  for (const [rank, target] of Object.entries(milestones)) {
    if (!target) continue;
    const rate = target.Rate ?? 0; // if we don't know their rate, assume stationary (conservative-ish)
    projectedMilestones[rank] = target.Points + rate * hoursLeft;
  }

  const ranks = Object.keys(projectedMilestones)
    .map(Number)
    .sort((a, b) => a - b); // [10, 50, 100]

  if (ranks.length === 0) return null;

  // Find where projectedPoints falls relative to the projected milestone thresholds.
  // ranks is ascending by rank number (10, 50, 100), and points DESCEND as rank
  // number increases (rank 10 needs more points than rank 100).
  for (const rank of ranks) {
    if (projectedPoints >= projectedMilestones[rank]) {
      return rank === ranks[0] ? `top ${rank} or better` : `top ${rank}`;
    }
  }

  const loosest = ranks[ranks.length - 1];
  return `outside top ${loosest}`;
}

/**
 * Exact projected finishing rank, rather than a "top 50 / top 100" bucket.
 *
 * Projects EVERY league we hold a rate for to battle end and counts how many
 * finish above us. The bracket version could only ever place us relative to
 * three or four milestone thresholds, so "outside top 100" covered ranks 101
 * and 900 identically.
 *
 * Returns { rank, of, confident } or null when there isn't enough history yet.
 * `confident` is false when our own projection lands outside the set of
 * leagues we track, where the true rank could be anywhere below.
 */
export function projectExactPlacement(projectedPoints, leagueRateInputs, ownLeagueId, fromDate = new Date()) {
  if (projectedPoints == null || !Array.isArray(leagueRateInputs) || leagueRateInputs.length === 0) {
    return null;
  }

  const hoursLeft = hoursUntilBattleEnd(fromDate);

  let above = 0;
  for (const league of leagueRateInputs) {
    // Skip ourselves — being counted as ahead of our own projection would
    // silently add one to every result.
    if (ownLeagueId && league.leagueId === ownLeagueId) continue;
    const projected = league.points + (league.rate ?? 0) * hoursLeft;
    if (projected > projectedPoints) above += 1;
  }

  const tracked = leagueRateInputs.length;
  return { rank: above + 1, of: tracked, confident: above + 1 <= tracked };
}
