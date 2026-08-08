import fetch from 'node-fetch';

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
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — names rarely change
const BATCH_SIZE = 100; // Roblox's documented max per request

const cache = new Map(); // userId (string) -> { username, displayName, expiresAt }

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
  const uniqueIds = [...new Set(idsToFetch.map((id) => String(id)))];

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);
    try {
      const rows = await fetchUsersBatch(batch);
      for (const [userId, names] of rows) {
        resolved.set(userId, names);
        cache.set(userId, { ...names, expiresAt: now + CACHE_TTL_MS });
      }
    } catch (err) {
      // Roblox hiccup — leave these entries as-is for this pass and try again
      // next time rather than failing the whole update.
      console.warn('[roblox] Failed to resolve a batch of names:', err.message);
    }
  }

  return entries.map((e) => {
    const names = resolved.get(String(e.userId));
    if (!names) return e;
    return { ...e, username: names.username, displayName: names.displayName || e.displayName };
  });
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

async function fetchUsersBatch(userIds) {
  const res = await fetch(ROBLOX_USERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds: userIds.map(Number), excludeBannedUsers: false }),
  });

  if (!res.ok) {
    throw new Error(`Roblox users API returned HTTP ${res.status}`);
  }

  const body = await res.json();
  const rows = body?.data || [];

  // `name` is the unique @username; `displayName` is the chosen label. Keep
  // both — see the header comment for why collapsing them was a bug.
  return rows
    .filter((r) => r?.id != null && r?.name)
    .map((r) => [String(r.id), { username: r.name, displayName: r.displayName || r.name }]);
}
