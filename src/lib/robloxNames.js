import fetch from 'node-fetch';
import { getCachedRobloxNames, putCachedRobloxNames } from './db.js';

// Roblox identity resolution.
//
// Two separate problems this module solves:
//
// 1. The PS99 API is not a reliable name source. For leagues it returns a
//    `DisplayName` field that is very often just the numeric UserID as a
//    string (confirmed against live responses — e.g. /v1/leagues/UN0YA comes
//    back with DisplayName "33492395" for user 33492395). For clans it
//    returns no name at all: /api/clan/:name's PointContributions entries are
//    only {UserID, Points}. So Roblox's own users API is the ONLY dependable
//    source of names for both bots.
//
// 2. Roblox has two distinct names per account and they are not the same
//    thing: `name` is the unique @username, `displayName` is the freely
//    chosen (and non-unique) label. An earlier version of this file did
//    `r.displayName || r.name`, which threw the username away entirely — so
//    player lookup could never match on a username, and every embed showed
//    the display name only. Both names are now kept, and callers decide
//    which to show via formatName() below.

const ROBLOX_USERS_ENDPOINT = 'https://users.roblox.com/v1/users';
// Spelled out rather than derived from the line above: deriving it with
// .replace('/users', '') matched the "users" in the HOSTNAME first and
// produced https://.roblox.com/..., which fails DNS rather than erroring
// anywhere near the mistake.
const ROBLOX_USERNAMES_ENDPOINT = 'https://users.roblox.com/v1/usernames/users';
// Names rarely change, and a stale one costs far less than a rate-limited pass
// that loses thousands of them, so the on-disk copy is kept for a week.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours in memory
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days on disk
const BATCH_SIZE = 100; // Roblox's documented max per request

// Roblox rate-limits this endpoint, and an hourly rankings pass asks it for
// thousands of names. Firing every batch back-to-back got HTTP 429 on more
// than 30 of ~40 batches in a single live run: those players were then stored
// with username NULL and display_name set to their numeric ID, which made them
// invisible to every name search in the bot. Hence a gap between batches and a
// real retry, rather than logging the failure and moving on.
// Measured against the live API: 300ms between batches still 429'd roughly one
// batch in five. The throttle alone cannot carry a 4,000-name pass, which is
// why the persistent cache below matters more than these numbers do.
const BATCH_DELAY_MS = 700;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 2000;

const cache = new Map(); // userId (string) -> { username, displayName, expiresAt }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True if the name we already hold is unusable and needs a real lookup.
 * Covers both the missing case (clans send no name) and the PS99 fallback
 * case (display name is literally the numeric ID).
 */
function needsLookup(entry) {
  if (entry.username) return false; // already resolved
  if (!entry.displayName) return true;
  return String(entry.displayName) === String(entry.userId);
}

/**
 * Given [{userId, displayName?, ...}], return a new list where each entry has
 * both `username` and `displayName` filled in wherever Roblox could resolve
 * them. Extra fields (points, leagueId, …) are preserved untouched.
 *
 * Never throws — on any API failure the affected entries come back unchanged,
 * so a Roblox outage degrades names rather than breaking a whole poll.
 */
export async function resolveNames(entries) {
  const pending = entries.filter(needsLookup);
  if (pending.length === 0) return entries;

  const resolved = new Map(); // userId -> { username, displayName }
  const idsToFetch = [];
  const now = Date.now();

  for (const e of pending) {
    const key = String(e.userId);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      resolved.set(key, { username: cached.username, displayName: cached.displayName });
    } else {
      idsToFetch.push(e.userId);
    }
  }

  // De-duplicate before hitting the network — the same player can legitimately
  // appear more than once in a batch (e.g. clan owner also listed as a member).
  let uniqueIds = [...new Set(idsToFetch.map((id) => String(id)))];

  // Second chance before the network: the on-disk cache, which unlike the
  // in-memory one survives a restart. This is what keeps a rankings pass from
  // re-asking Roblox for thousands of names it already knows.
  if (uniqueIds.length > 0) {
    let persisted;
    try {
      persisted = getCachedRobloxNames(uniqueIds, CACHE_TTL_SECONDS);
    } catch (err) {
      // A cache miss must never be fatal — fall through to the network.
      console.warn('[roblox] Name cache read failed, falling back to the API:', err.message);
      persisted = new Map();
    }

    for (const [userId, names] of persisted) {
      resolved.set(userId, names);
      cache.set(userId, { ...names, expiresAt: now + CACHE_TTL_MS });
    }
    uniqueIds = uniqueIds.filter((id) => !persisted.has(id));
  }

  let fetchedCount = 0;
  let failedBatches = 0;
  let failedIds = 0;
  let lastError = null;

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);
    try {
      const rows = await fetchUsersBatchWithRetry(batch);
      for (const [userId, names] of rows) {
        resolved.set(userId, names);
        cache.set(userId, { ...names, expiresAt: now + CACHE_TTL_MS });
      }

      // Flush to disk per batch, not once at the end. A full clan pass takes
      // over ten minutes on a cold cache, and every deploy restarts the
      // process mid-pass — batching the write to the end meant a restart threw
      // away everything resolved so far, so the cache could never warm up and
      // each pass hit the rate limit exactly like the last one.
      try {
        putCachedRobloxNames(rows);
        fetchedCount += rows.length;
      } catch (err) {
        console.warn('[roblox] Name cache write failed (names still resolved for this pass):', err.message);
      }
    } catch (err) {
      // Roblox is still refusing after every retry — leave these entries as-is
      // for this pass rather than failing the whole update. Counted, not
      // logged per batch: the old per-batch warning produced 30+ identical
      // lines that buried the fact that most of a run had failed.
      failedBatches += 1;
      failedIds += batch.length;
      lastError = err;
    }

    // Space the batches out. Not needed for a single batch (a poll of one
    // clan/league), which is the common case and stays as fast as before.
    if (i + BATCH_SIZE < uniqueIds.length) await sleep(BATCH_DELAY_MS);
  }

  if (fetchedCount > 0) {
    console.log(`[roblox] Resolved and cached ${fetchedCount} name(s) from the API.`);
  }

  if (failedBatches > 0) {
    console.warn(
      `[roblox] ${failedIds} of ${uniqueIds.length} names unresolved after retries ` +
        `(${failedBatches} batch(es) failed). Last error: ${lastError?.message}. ` +
        'Those players keep their numeric ID as a name and will not match name searches.'
    );
  }

  return entries.map((e) => {
    const names = resolved.get(String(e.userId));
    if (!names) return e;
    return { ...e, username: names.username, displayName: names.displayName || e.displayName };
  });
}

/**
 * One batch, retrying on 429 with exponential backoff.
 *
 * Honours Retry-After when Roblox sends it, since guessing shorter than the
 * server's own stated wait just burns another attempt.
 */
async function fetchUsersBatchWithRetry(batch) {
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchUsersBatch(batch);
    } catch (err) {
      const retryable = err.status === 429 || (err.status >= 500 && err.status < 600);
      if (!retryable || attempt >= MAX_RETRIES) throw err;

      await sleep(err.retryAfterMs ?? backoff);
      backoff *= 2;
    }
  }
}

/**
 * How a player is rendered everywhere in both bots.
 *
 * The username is the identity people actually search and share, so it leads.
 * The display name is appended only when it differs and adds information —
 * showing "Kbobs (Kbobs)" would just be noise.
 *
 * Falls back through display name to the bare numeric ID, so a failed
 * resolution still renders something rather than "undefined".
 */
export function formatName(entry, { withDisplayName = true } = {}) {
  const username = entry?.username;
  const display = entry?.displayName;

  if (!username) {
    // Never resolved — avoid showing the raw ID as if it were a name.
    if (display && String(display) !== String(entry?.userId)) return String(display);
    return `Unknown (${entry?.userId ?? '?'})`;
  }

  if (withDisplayName && display && display !== username) {
    return `${username} (${display})`;
  }
  return username;
}

/** True if `query` (already lowercased) matches either of an entry's names. */
export function matchesName(entry, query) {
  const username = entry?.username?.toLowerCase() ?? '';
  const display = entry?.displayName?.toLowerCase() ?? '';
  return username.includes(query) || display.includes(query);
}

/**
 * The reverse direction: an exact @username -> {userId, username, displayName},
 * or null if Roblox doesn't know it.
 *
 * Used by the link commands, where someone types their own username and we
 * need the numeric ID that league contributions are actually keyed by. This is
 * an EXACT match by design — a fuzzy link would happily attach the wrong
 * account to a Discord user, and the whole point of linking is that it's right.
 */
export async function resolveUsernameToId(username) {
  const query = String(username).trim().replace(/^@/, '');
  if (!query) return null;

  const res = await fetch(ROBLOX_USERNAMES_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [query], excludeBannedUsers: false }),
  });

  if (!res.ok) {
    const err = new Error(`Roblox username lookup returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const row = (await res.json())?.data?.[0];
  if (!row?.id) return null;

  return {
    userId: String(row.id),
    username: row.name,
    displayName: row.displayName || row.name,
  };
}

async function fetchUsersBatch(userIds) {
  const res = await fetch(ROBLOX_USERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds: userIds.map(Number), excludeBannedUsers: false }),
  });

  if (!res.ok) {
    // Attach the status so the caller can tell "back off and retry" (429, 5xx)
    // apart from "this request is wrong and always will be" (4xx).
    const err = new Error(`Roblox users API returned HTTP ${res.status}`);
    err.status = res.status;

    // Retry-After is in seconds per the HTTP spec; Roblox does not always send
    // it, in which case the caller falls back to its own backoff.
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;

    throw err;
  }

  const body = await res.json();
  const rows = body?.data || [];

  // `name` is the unique @username; `displayName` is the chosen label. Keep
  // both — see the header comment for why collapsing them was a bug.
  return rows
    .filter((r) => r?.id != null && r?.name)
    .map((r) => [String(r.id), { username: r.name, displayName: r.displayName || r.name }]);
}
