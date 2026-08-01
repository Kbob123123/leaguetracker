import fetch from 'node-fetch';

// The PS99 API resolves display names in bulk and falls back to the raw
// numeric UserID string if Roblox's own name service is slow/unavailable at
// snapshot time. This module patches those gaps by hitting Roblox's public
// users-by-id endpoint directly, with a cache so repeated 10-minute polls
// don't re-resolve names we already know.

const ROBLOX_USERS_ENDPOINT = 'https://users.roblox.com/v1/users';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — display names rarely change
const BATCH_SIZE = 100; // Roblox's documented max per request

const cache = new Map(); // userId -> { name, expiresAt }

/** True if a display name is just the numeric ID as a string (the PS99 API's fallback form). */
function looksLikeUnresolvedId(userId, displayName) {
  if (!displayName) return true;
  return String(displayName) === String(userId);
}

/**
 * Given a list of {userId, displayName} pairs, return a new list with any
 * numeric-fallback names replaced by a real Roblox display name where
 * possible. Never throws — on any failure, entries are returned unchanged.
 */
export async function resolveDisplayNames(entries) {
  const needsResolution = entries.filter((e) => looksLikeUnresolvedId(e.userId, e.displayName));
  if (needsResolution.length === 0) return entries;

  const idsToFetch = [];
  const resolved = new Map(); // userId -> name

  const now = Date.now();
  for (const e of needsResolution) {
    const cached = cache.get(e.userId);
    if (cached && cached.expiresAt > now) {
      resolved.set(e.userId, cached.name);
    } else {
      idsToFetch.push(e.userId);
    }
  }

  for (let i = 0; i < idsToFetch.length; i += BATCH_SIZE) {
    const batch = idsToFetch.slice(i, i + BATCH_SIZE);
    try {
      const names = await fetchUsernamesBatch(batch);
      for (const [userId, name] of names) {
        resolved.set(userId, name);
        cache.set(userId, { name, expiresAt: now + CACHE_TTL_MS });
      }
    } catch (err) {
      // Roblox API hiccup — leave these entries as numeric IDs for this poll,
      // we'll try again next time rather than failing the whole update.
      console.warn('[roblox] Failed to resolve a batch of display names:', err.message);
    }
  }

  return entries.map((e) => {
    const name = resolved.get(e.userId);
    return name ? { ...e, displayName: name } : e;
  });
}

async function fetchUsernamesBatch(userIds) {
  const res = await fetch(ROBLOX_USERS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds, excludeBannedUsers: false }),
  });

  if (!res.ok) {
    throw new Error(`Roblox users API returned HTTP ${res.status}`);
  }

  const body = await res.json();
  const rows = body?.data || [];

  // Prefer displayName (what shows in-game); fall back to the account username.
  return rows.map((r) => [r.id, r.displayName || r.name]).filter(([, name]) => !!name);
}
