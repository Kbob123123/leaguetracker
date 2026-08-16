import fetch from 'node-fetch';

const BASE = 'https://ps99.biggamesapi.io';

class Ps99ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'Ps99ApiError';
    this.status = status;
    this.code = code;
  }
}

async function get(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    headers: { 'User-Agent': 'ps99-league-discord-bot/1.0' },
  });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Ps99ApiError(`PS99 API returned non-JSON response (HTTP ${res.status})`, { status: res.status });
  }

  if (body.status !== 'ok') {
    const msg = body?.error?.message || `PS99 API error (HTTP ${res.status})`;
    throw new Ps99ApiError(msg, { status: res.status, code: res.status });
  }

  return body.data;
}

/**
 * Fetch full detail for a single league by name (case-insensitive).
 * Returns null if not found (rather than throwing) so callers can show a friendly message.
 */
export async function getLeagueDetail(name) {
  try {
    return await get(`/v1/leagues/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Fetch a page of the league leaderboard, sorted by Points desc (the default),
 * so we can find the league immediately above/below a given rank.
 * pageSize max is 100 per the API.
 */
export async function getLeaguesPage(page = 1, pageSize = 100) {
  return get(`/v1/leagues?page=${page}&pageSize=${pageSize}&sort=Points&sortOrder=desc`);
}

/**
 * Find the league's overall rank on the Points leaderboard, plus the league
 * immediately ahead of and behind it. Returns { rank, total, ahead, behind }.
 * `ahead`/`behind` are league leaderboard entries or null (e.g. rank 1 has no one ahead).
 *
 * Strategy: leagues endpoint is exact-paginated by Points desc. We binary-search-ish
 * by paging until we find our league's ID, using pageSize=100 to keep calls low.
 */
export async function findLeagueNeighbors(league) {
  const pageSize = 100;
  let page = 1;
  let total = Infinity;
  let foundIndex = -1;
  let pageItems = [];

  while (true) {
    const data = await getLeaguesPage(page, pageSize);
    total = data.total;
    pageItems = data.leagues;

    foundIndex = pageItems.findIndex((l) => l.ID === league.ID);
    if (foundIndex !== -1) break;

    const seenSoFar = page * pageSize;
    if (seenSoFar >= total) {
      // Exhausted the leaderboard without finding it (shouldn't normally happen).
      return { rank: null, total, ahead: null, behind: null };
    }
    page += 1;
  }

  const rank = (page - 1) * pageSize + foundIndex + 1;

  let ahead = null;
  if (foundIndex > 0) {
    ahead = pageItems[foundIndex - 1];
  } else if (page > 1) {
    // The league ahead is the last item of the previous page.
    const prevPage = await getLeaguesPage(page - 1, pageSize);
    ahead = prevPage.leagues[prevPage.leagues.length - 1] ?? null;
  }

  let behind = null;
  if (foundIndex < pageItems.length - 1) {
    behind = pageItems[foundIndex + 1];
  } else if (rank < total) {
    // The league behind is the first item of the next page.
    const nextPage = await getLeaguesPage(page + 1, pageSize);
    behind = nextPage.leagues[0] ?? null;
  }

  return { rank, total, ahead, behind };
}

/**
 * Fetch the league currently occupying an exact rank (1-based) on the Points
 * leaderboard. Used for "distance to rank 100/50/10" milestone tracking.
 * Returns null if the rank doesn't exist (e.g. asking for rank 10 when only
 * 5 leagues exist).
 */
export async function getLeagueAtRank(rank) {
  if (rank < 1) return null;
  const pageSize = 100;
  const page = Math.ceil(rank / pageSize);
  const data = await getLeaguesPage(page, pageSize);
  const indexOnPage = rank - (page - 1) * pageSize - 1;
  return data.leagues[indexOnPage] ?? null;
}

// REMOVED: getPlayerProfile(username), which called /v1/players/{username}.
//
// That endpoint does not exist. It returns HTTP 404 for every username,
// including known-valid ones — verified directly against the live API. It was
// written from a docs quickstart example that evidently no longer reflects the
// deployed API, and because the old /playerinfo only reached it as a last
// resort after two other tiers had already missed, it always looked like an
// ordinary "player not found" rather than a broken route.
//
// The practical consequence: the PS99 API offers NO per-player endpoint of any
// kind. Player stats can only be derived from league/clan PointContributions,
// which is why player lookup is limited to the top-1,000 scanned leagues/clans.
// Don't re-add a direct profile lookup without testing the route first.


/**
 * Whether a player has made their PS99 profile public, and which parts.
 *
 * Path is /v1/players/... with NO /api prefix — the prefixed form answers 401
 * "Endpoint not valid", which is a different failure and easy to mistake for
 * the route being gone. It is not gone; it answers a structured
 * { code: 'player_not_found' } 404 for anyone who is not public.
 *
 * That 404 is genuinely ambiguous: it means "not public" OR "no such player",
 * and the API gives us no way to tell them apart. Anything that is not a 404
 * (rate limit, outage) returns public: null so a scan can report "unknown"
 * rather than a false all-clear.
 */
export async function getPlayerVisibility(usernameOrId) {
  try {
    const data = await get(`/v1/players/${encodeURIComponent(usernameOrId)}`);
    const account = data?.account ?? {};
    return {
      public: true,
      robloxUserId: account.robloxUserId ?? String(usernameOrId),
      username: account.username ?? null,
      displayName: account.displayName ?? null,
      publicViews: account.publicViews ?? {},
    };
  } catch (err) {
    if (err.status === 404) return { public: false };
    return { public: null, error: err.message };
  }
}

export { Ps99ApiError };
