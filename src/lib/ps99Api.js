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

export { Ps99ApiError };
