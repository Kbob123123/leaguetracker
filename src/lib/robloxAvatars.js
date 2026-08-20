import fetch from 'node-fetch';
import { getCachedAvatarUrls, putCachedAvatarUrls } from './db.js';

/**
 * Roblox avatar headshots, for the artwork watermarked behind player charts.
 *
 * WHY THIS FILE EXISTS AT ALL — read before "simplifying" it back to a URL
 * template. The obvious approach, and the one this project used until it was
 * checked against the live service, is to build a direct image URL:
 *
 *   https://www.roblox.com/headshot-thumbnail/image?userId=X&width=150&...
 *
 * That endpoint is DEAD. It returns HTTP 404 with an HTML body for every user
 * ID, including userId=1 — verified live, so it is the route that is gone, not
 * the users. Because it 404s into an <img> tag rather than into code, Discord
 * simply renders no thumbnail and nothing anywhere logs an error, which is how
 * it survived unnoticed. Do not reintroduce it.
 *
 * The working route is Roblox's thumbnails service, which is a real API: it
 * returns JSON pointing at a CDN image, it batches, and it rate-limits. That
 * last part is the cost of the fix, and it is why this module is built like
 * robloxNames.js — batched, throttled, retried, and backed by a table on disk
 * — rather than being a one-line fetch.
 */

const THUMBNAIL_ENDPOINT = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';

// Roblox's documented max per request for this endpoint.
const BATCH_SIZE = 100;

// Held for a week on disk. Must stay well under 30 days: the CDN links come
// back 30DAY-prefixed and expire, so a longer TTL would serve dead URLs.
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

// "No art" is cached far more briefly than a hit, because a Pending thumbnail
// becomes available once Roblox finishes rendering it. A day is long enough to
// stop a chart re-asking every render, short enough that new art shows up.
const NEGATIVE_TTL_SECONDS = 24 * 60 * 60;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // in-memory layer, ahead of the disk one

// Far gentler than the name resolver's needs: a chart asks for ONE avatar,
// not four thousand names. The throttle only matters if something ever batches
// avatars for a whole roster, and it costs nothing in the common single case.
const BATCH_DELAY_MS = 400;
const MAX_RETRIES = 4;
const INITIAL_BACKOFF_MS = 1500;

const REQUEST_TIMEOUT_MS = 8000;

// Size is fixed rather than a parameter: every extra size is a separate cache
// key and a separate render on Roblox's side, and 420 is large enough to
// watermark a 960px chart without looking soft.
const SIZE = '420x420';

const memory = new Map(); // userId -> { url: string|null, expiresAt }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve one user's headshot URL, or null.
 *
 * Never throws — a chart with no watermark is fine, a command that fails
 * because Roblox rate-limited an image lookup is not.
 */
export async function resolveAvatarUrl(userId) {
  if (userId === null || userId === undefined) return null;
  const map = await resolveAvatarUrls([userId]);
  return map.get(String(userId)) ?? null;
}

/**
 * Resolve many users' headshot URLs at once, as a Map of userId -> string|null.
 *
 * Batched so that a caller wanting a whole roster's art costs one request per
 * hundred players rather than one per player.
 */
export async function resolveAvatarUrls(userIds) {
  const out = new Map();
  const unique = [...new Set(userIds.filter((id) => id !== null && id !== undefined).map(String))];
  if (unique.length === 0) return out;

  const now = Date.now();
  let pending = [];

  for (const id of unique) {
    const hit = memory.get(id);
    if (hit && hit.expiresAt > now) out.set(id, hit.url);
    else pending.push(id);
  }

  // Second chance before the network: the on-disk cache, which survives the
  // restarts that a deploy causes several times a day.
  if (pending.length > 0) {
    let persisted;
    try {
      persisted = getCachedAvatarUrls(pending, CACHE_TTL_SECONDS, NEGATIVE_TTL_SECONDS);
    } catch (err) {
      console.warn('[avatars] Cache read failed, falling back to the API:', err.message);
      persisted = new Map();
    }

    for (const [id, url] of persisted) {
      out.set(id, url);
      memory.set(id, { url, expiresAt: now + CACHE_TTL_MS });
    }
    pending = pending.filter((id) => !persisted.has(id));
  }

  if (pending.length === 0) return out;

  let failedIds = 0;
  let lastError = null;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      const rows = await fetchBatchWithRetry(batch);

      // Every ID in the batch gets an entry, including the ones Roblox had no
      // art for: writing only the hits would leave the misses uncached and
      // re-asked on every single render.
      const toPersist = batch.map((id) => [id, rows.get(id) ?? null]);
      for (const [id, url] of toPersist) {
        out.set(id, url);
        memory.set(id, { url, expiresAt: now + CACHE_TTL_MS });
      }

      try {
        putCachedAvatarUrls(toPersist);
      } catch (err) {
        console.warn('[avatars] Cache write failed (URLs still usable this pass):', err.message);
      }
    } catch (err) {
      // Leave these unresolved for this pass and, importantly, do NOT cache
      // the failure — a 429 says nothing about whether the user has art.
      failedIds += batch.length;
      lastError = err;
      for (const id of batch) out.set(id, null);
    }

    if (i + BATCH_SIZE < pending.length) await sleep(BATCH_DELAY_MS);
  }

  if (failedIds > 0) {
    console.warn(
      `[avatars] ${failedIds} of ${pending.length} headshot(s) unresolved after retries ` +
        `(${lastError?.message}). Those charts render without a watermark.`
    );
  }

  return out;
}

/** One batch, retrying on 429 and 5xx with exponential backoff. */
async function fetchBatchWithRetry(batch) {
  let backoff = INITIAL_BACKOFF_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchBatch(batch);
    } catch (err) {
      const retryable = err.status === 429 || (err.status >= 500 && err.status < 600);
      if (!retryable || attempt >= MAX_RETRIES) throw err;

      // Honour Retry-After when Roblox sends it; guessing shorter than the
      // server's own stated wait just burns another attempt.
      await sleep(err.retryAfterMs ?? backoff);
      backoff *= 2;
    }
  }
}

/** One batch. Returns Map of userId -> url, omitting users with no art. */
async function fetchBatch(batch) {
  const url =
    `${THUMBNAIL_ENDPOINT}?userIds=${batch.join(',')}` +
    `&size=${SIZE}&format=Png&isCircular=false`;

  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  if (!res.ok) {
    const err = new Error(`Roblox thumbnails API returned ${res.status}`);
    err.status = res.status;
    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }

  const body = await res.json();
  const found = new Map();

  for (const row of body?.data ?? []) {
    // "Completed" is the only state with a usable image. Pending means Roblox
    // has not rendered it yet; Blocked means it is moderated. Both are treated
    // as no art, and both are worth re-checking after the negative TTL.
    if (row?.state === 'Completed' && row.imageUrl) {
      found.set(String(row.targetId), row.imageUrl);
    }
  }

  return found;
}
