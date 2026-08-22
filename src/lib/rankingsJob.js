import { getLeaguesPage, getLeagueDetail } from './ps99Api.js';
import {
  replacePlayerRankings,
  setRankingsMeta,
  recordLeaguePointsBatch,
  pruneOldLeaguePointsHistory,
  recordPlayerPointsBatch,
  pruneOldPlayerPointsHistory,
  recordDailyPointsBatch,
  pruneDailyPoints,
  recordPlayerDailyBatch,
  prunePlayerDailyPoints,
  recordLeagueBattleResults,
  recordLeagueBattleContributions,
} from './db.js';
import { resolveNames, formatName } from './robloxNames.js';
import { currentBattleKey } from './battleTimer.js';

// How many top leagues (by Points) to pull individual player contributions
// from. This is a deliberate tradeoff: going wider (e.g. all ~90k+ leagues)
// would mean tens of thousands of API calls and hours per pass. Restricting
// to the top N keeps a full rebuild to a couple hundred calls and a few
// minutes, at the cost of only covering players in genuinely competitive
// leagues rather than the entire playerbase.
export const TOP_LEAGUES_COUNT = 1000;
const LEAGUE_PAGE_SIZE = 100;

// Small delay between detail calls so we don't hammer the PS99 API with a
// burst of ~1000 requests all at once.
const REQUEST_DELAY_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rebuild the player_rankings table from the top TOP_LEAGUES_COUNT leagues.
 * Safe to run on a schedule — replaces the whole table atomically at the end
 * rather than incrementally, so a partial failure never leaves stale-mixed data.
 *
 * Returns { playersIndexed, leaguesScanned, durationMs, failedLeagues }.
 */
export async function rebuildPlayerRankings() {
  const startedAt = Date.now();
  const pagesNeeded = Math.ceil(TOP_LEAGUES_COUNT / LEAGUE_PAGE_SIZE);

  // Step 1: collect the top N league summaries (name + rank) via the cheap list endpoint.
  const leagueSummaries = [];
  for (let page = 1; page <= pagesNeeded; page++) {
    const data = await getLeaguesPage(page, LEAGUE_PAGE_SIZE);
    leagueSummaries.push(...data.leagues);
    if (leagueSummaries.length >= TOP_LEAGUES_COUNT || leagueSummaries.length >= data.total) break;
  }
  const targets = leagueSummaries.slice(0, TOP_LEAGUES_COUNT);

  // Record a points reading for every top-N league right away, from the cheap
  // list data we already have — this is what lets ANY of these leagues get a
  // real hourly rate later (not just the one actively being tracked), without
  // needing any extra API calls beyond what we're already making.
  const pointRows = targets.map((t) => ({ leagueId: t.ID, leagueName: t.Name, points: t.Points }));
  recordLeaguePointsBatch(pointRows);
  pruneOldLeaguePointsHistory();

  // Same data, second destination: the hourly table is pruned at 26h for rate
  // math, so it's also rolled up into one row per day for long-term history.
  // Costs no extra API calls.
  recordDailyPointsBatch(pointRows);
  pruneDailyPoints();

  // Step 2: fetch full detail (with PointContributions) for each, one at a
  // time with a small delay — this is the expensive part.
  const allPlayers = [];
  const failedLeagues = [];

  for (let i = 0; i < targets.length; i++) {
    const summary = targets[i];
    try {
      const detail = await getLeagueDetail(summary.Name);
      if (!detail) continue;

      const contributions = detail.PointContributions || [];
      for (const c of contributions) {
        allPlayers.push({
          userId: String(c.UserID),
          displayName: c.DisplayName,
          points: c.Points,
          leagueId: detail.ID,
          leagueName: detail.Name,
          leagueRank: i + 1,
        });
      }
    } catch (err) {
      failedLeagues.push({ name: summary.Name, error: err.message });
    }

    if (i < targets.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  // Step 3: resolve any numeric-fallback display names in bulk before storing,
  // same as the tracked-league poller does.
  const resolved = await resolveNames(allPlayers);

  // Record per-member history too (for /leagueinfo and per-member rates
  // in /leagueplayer) — reuses the same data fetched above, no extra API calls.
  recordPlayerPointsBatch(
    resolved.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      username: p.username,
      leagueId: p.leagueId,
      points: p.points,
    }))
  );
  pruneOldPlayerPointsHistory();

  // Same readings, rolled up to one row per player per day. The hourly table
  // above is pruned at 26h for rate math, so this is the only thing that makes
  // long-term player history possible at all — leagues have no Battles archive
  // to fall back on the way clans do. Costs no extra API calls.
  recordPlayerDailyBatch(
    resolved.map((p) => ({
      userId: p.userId,
      username: p.username,
      leagueId: p.leagueId,
      leagueName: p.leagueName,
      points: p.points,
    }))
  );
  prunePlayerDailyPoints();

  // Snapshot the battle currently being fought.
  //
  // The league API keeps no history at all — when Saturday's reset lands, the
  // previous battle's points are gone. Overwriting the same battle_key every
  // pass means the last write before a reset becomes that battle's permanent
  // result, without needing to catch the reset moment.
  try {
    const battleKey = currentBattleKey();

    recordLeagueBattleResults(
      battleKey,
      targets.map((t, i) => ({
        leagueId: t.ID,
        leagueName: t.Name,
        place: i + 1,
        points: t.Points,
      }))
    );

    recordLeagueBattleContributions(
      battleKey,
      resolved.map((p) => ({
        userId: p.userId,
        username: p.username,
        leagueId: p.leagueId,
        leagueName: p.leagueName,
        points: p.points,
      }))
    );

    console.log(`[rankings] Battle snapshot stored for ${battleKey}.`);
  } catch (err) {
    // History is a bonus; never let it break the rankings rebuild.
    console.warn('[rankings] Could not store the league battle snapshot:', err.message);
  }

  // A player could theoretically appear more than once if they're in a
  // league's contributions under edge-case data quirks — keep the higher-points entry.
  const byUserId = new Map();
  for (const p of resolved) {
    const existing = byUserId.get(p.userId);
    if (!existing || p.points > existing.points) byUserId.set(p.userId, p);
  }

  // Players on zero are NOT ranked and do not belong in a rankings table.
  // League contributions zero at the Saturday reset, so without this the whole
  // table becomes zeroes every week and the "of N" denominator counts people
  // who have not scored. History tables above still record them; this only
  // decides who has a RANK.
  const rows = Array.from(byUserId.values())
    .filter((p) => (Number(p.points) || 0) > 0)
    .map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      username: p.username ?? null,
      points: p.points,
      leagueId: p.leagueId,
      leagueName: p.leagueName,
      leagueRank: p.leagueRank,
    }));

  replacePlayerRankings(rows);
  setRankingsMeta('last_rebuilt_at', Math.floor(Date.now() / 1000));
  setRankingsMeta('leagues_scanned', targets.length - failedLeagues.length);

  const durationMs = Date.now() - startedAt;
  console.log(
    `[rankings] Rebuilt: ${rows.length} players across ${targets.length - failedLeagues.length}/${targets.length} leagues in ${Math.round(durationMs / 1000)}s` +
      (failedLeagues.length ? ` (${failedLeagues.length} leagues failed)` : '')
  );

  return { playersIndexed: rows.length, leaguesScanned: targets.length - failedLeagues.length, durationMs, failedLeagues };
}
