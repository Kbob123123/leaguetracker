/**
 * All rate math lives here. Everything is derived from two point-in-time
 * snapshots: "now" and "the snapshot closest to (now - 1h) without going
 * under an hour old". That trailing-hour window is what "hourly rate" means
 * throughout the bot — it's a rolling last-60-minutes rate, recomputed every
 * poll, not a fixed per-clock-hour bucket.
 */

const HOUR = 3600;

/**
 * Given two snapshots of the same thing (a league total, or a single member),
 * compute points/hour. Returns null if we don't have an hour of history yet.
 */
export function hourlyRate(oldPoints, oldTs, newPoints, newTs) {
  if (oldPoints == null || oldTs == null) return null;
  const elapsedHours = (newTs - oldTs) / HOUR;
  if (elapsedHours <= 0) return null;
  return (newPoints - oldPoints) / elapsedHours;
}

/**
 * Time (in hours) for `chaser` to overtake `target`, given both are moving at
 * a constant hourly rate. Returns:
 *   - a positive number of hours if the chaser is gaining and will overtake
 *   - Infinity if the chaser is exactly tied on rate and still behind (never catches up)
 *   - null if the chaser is AHEAD already (no "overtake" needed)
 *   - { fallingBehind: true, gapGrowthPerHour } if the chaser's rate is lower
 *     than the target's, meaning the gap is growing instead of shrinking
 */
export function timeToOvertake({ chaserPoints, chaserRate, targetPoints, targetRate }) {
  if (chaserRate == null || targetRate == null) return null; // insufficient data
  if (chaserPoints >= targetPoints) return null; // already ahead/tied, nothing to overtake

  const gap = targetPoints - chaserPoints;
  const closingRate = chaserRate - targetRate; // positive = chaser catching up

  if (closingRate <= 0) {
    return { fallingBehind: true, gapGrowthPerHour: Math.abs(closingRate) };
  }

  return gap / closingRate; // hours
}

/** Format a hours-float as "Xh Ym" (or "Ym" if under an hour). */
export function formatDuration(hours) {
  if (hours === Infinity) return 'Never at current rates';
  if (hours == null) return 'N/A';
  if (hours < 0) return 'N/A';

  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;

  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Format a rate (points/hour) with a +/- sign and thousands separators. */
export function formatRate(rate) {
  if (rate == null) return 'N/A (collecting data...)';
  const sign = rate >= 0 ? '+' : '-';
  return `${sign}${Math.round(Math.abs(rate)).toLocaleString()}/hr`;
}

export function formatPoints(points) {
  if (points == null) return 'N/A';
  return Math.round(points).toLocaleString();
}
