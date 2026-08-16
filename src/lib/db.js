import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/ps99.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tracked_channels (
  channel_id   TEXT PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  league_name  TEXT NOT NULL,
  message_id   TEXT,
  started_at   INTEGER NOT NULL,
  last_hourly_at INTEGER
);

CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  league_name  TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  points       INTEGER NOT NULL,
  members_json TEXT NOT NULL,
  neighbors_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_channel_ts
  ON snapshots (channel_id, ts);

CREATE TABLE IF NOT EXISTS player_rankings (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  username     TEXT,
  points       INTEGER NOT NULL,
  league_id    TEXT NOT NULL,
  league_name  TEXT NOT NULL,
  league_rank  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_player_rankings_points
  ON player_rankings (points DESC);

CREATE TABLE IF NOT EXISTS rankings_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Long-term history: one row per league per UTC day.
--
-- league_points_history above is pruned at 26 hours because it exists to
-- compute a trailing-hour rate, and keeping hourly readings for every
-- top-1,000 league forever would grow without bound. This table is the
-- long-term record: a single points reading per day, which is ~365 rows per
-- league per year — small enough to keep for months and enough resolution to
-- show a real trend.
--
-- The day column is a UTC date string (YYYY-MM-DD) rather than an epoch so the
-- primary key collapses repeated writes on the same day automatically:
-- whichever reading lands last that day wins, giving an end-of-day value.
CREATE TABLE IF NOT EXISTS daily_points (
  league_id   TEXT NOT NULL,
  league_name TEXT NOT NULL,
  day         TEXT NOT NULL,
  points      INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (league_id, day)
);

CREATE INDEX IF NOT EXISTS idx_daily_points_league_day ON daily_points (league_id, day);

-- Channels showing an auto-updating top-10 leaderboard. message_id is what
-- makes the post edit itself in place every cycle instead of adding a new
-- message each time — one channel holds one leaderboard, forever.
CREATE TABLE IF NOT EXISTS top10_channels (
  channel_id TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL
);

-- One row per (league_id, ts) each time the hourly rankings job runs. This is
-- what lets the bot compute a real hourly rate for ANY of the top-N leagues,
-- not just the one being actively tracked in a channel — e.g. so a milestone
-- ETA ("time to reach top 10") can account for the fact that the top-10
-- league is also gaining points, instead of treating it as standing still.
CREATE TABLE IF NOT EXISTS league_points_history (
  league_id   TEXT NOT NULL,
  league_name TEXT NOT NULL,
  points      INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (league_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_league_points_history_league_ts
  ON league_points_history (league_id, ts);

-- One row per (user_id, league_id, ts) each hourly rankings pass. Lets the
-- bot compute a real hourly rate for any individual member of any top-1,000
-- league (not just members of the one channel-tracked league), which powers
-- the standalone /leagueinfo lookup and per-member rate in /leagueplayer.
CREATE TABLE IF NOT EXISTS player_points_history (
  user_id      TEXT NOT NULL,
  display_name TEXT NOT NULL,
  username     TEXT,
  league_id    TEXT NOT NULL,
  points       INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  PRIMARY KEY (user_id, league_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_player_points_history_user_ts
  ON player_points_history (user_id, ts);

-- Roblox username/display-name cache, persisted rather than in-memory.
--
-- The hourly rankings job needs a name for every player in the top-1,000
-- leagues — thousands of lookups. Held only in memory, that cache died with
-- the process, so every restart re-asked Roblox for all of them at once and
-- got HTTP 429 for most; those players were then stored under their numeric
-- ID and could not be found by any name search, which is exactly why
-- /leagueplayer could not find a member of a rank-70 league. On disk the
-- second pass asks for almost nothing, which is what keeps us under the limit.
CREATE TABLE IF NOT EXISTS roblox_names (
  user_id      TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  display_name TEXT,
  fetched_at   INTEGER NOT NULL
);

-- Legacy table from an earlier "locked target" design that has since been
-- replaced with always-live target calculation (see embed.js / poller.js).
-- Left here harmlessly for backward compatibility with existing deployments;
-- nothing reads from or writes to it anymore.
CREATE TABLE IF NOT EXISTS locked_targets (
  channel_id     TEXT NOT NULL,
  target_key     TEXT NOT NULL,
  target_league_id   TEXT,
  target_league_name TEXT,
  target_points  INTEGER NOT NULL,
  locked_at      INTEGER NOT NULL,
  PRIMARY KEY (channel_id, target_key)
);
`);

/**
 * Add a column to an existing table if it isn't there yet.
 *
 * The CREATE TABLE statements above only run on a fresh database — SQLite
 * ignores them entirely once the table exists, so a bot that's already been
 * deployed (e.g. on a Railway volume) would never gain a newly added column
 * and every query naming it would throw. This backfills those columns in
 * place, which is why `username` is nullable: existing rows have no value for
 * it until the next hourly rankings pass overwrites them.
 */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] Migrated: added ${table}.${column}`);
}

addColumnIfMissing('player_rankings', 'username', 'TEXT');
addColumnIfMissing('player_points_history', 'username', 'TEXT');

/** Insert a new tracked channel. Throws if channel_id already exists (caller should check first). */
export function addTrackedChannel({ channelId, guildId, leagueName }) {
  const stmt = db.prepare(`
    INSERT INTO tracked_channels (channel_id, guild_id, league_name, started_at)
    VALUES (@channelId, @guildId, @leagueName, @startedAt)
  `);
  stmt.run({ channelId, guildId, leagueName, startedAt: Math.floor(Date.now() / 1000) });
}

export function removeTrackedChannel(channelId) {
  db.prepare(`DELETE FROM tracked_channels WHERE channel_id = ?`).run(channelId);
  db.prepare(`DELETE FROM snapshots WHERE channel_id = ?`).run(channelId);
}

export function getTrackedChannel(channelId) {
  return db.prepare(`SELECT * FROM tracked_channels WHERE channel_id = ?`).get(channelId);
}

export function getAllTrackedChannels() {
  return db.prepare(`SELECT * FROM tracked_channels`).all();
}

export function setMessageId(channelId, messageId) {
  db.prepare(`UPDATE tracked_channels SET message_id = ? WHERE channel_id = ?`).run(messageId, channelId);
}

export function setLastHourlyAt(channelId, ts) {
  db.prepare(`UPDATE tracked_channels SET last_hourly_at = ? WHERE channel_id = ?`).run(ts, channelId);
}

export function updateTrackedLeagueName(channelId, leagueName) {
  db.prepare(`UPDATE tracked_channels SET league_name = ? WHERE channel_id = ?`).run(leagueName, channelId);
}

/** Insert a snapshot row. members: [{userId, displayName, points}]. neighbors: {ahead, behind} or null. */
export function addSnapshot({ channelId, leagueName, points, members, neighbors }) {
  const stmt = db.prepare(`
    INSERT INTO snapshots (channel_id, league_name, ts, points, members_json, neighbors_json)
    VALUES (@channelId, @leagueName, @ts, @points, @membersJson, @neighborsJson)
  `);
  stmt.run({
    channelId,
    leagueName,
    ts: Math.floor(Date.now() / 1000),
    points,
    membersJson: JSON.stringify(members),
    neighborsJson: neighbors ? JSON.stringify(neighbors) : null,
  });
}

/** Most recent snapshot for a channel. */
export function getLatestSnapshot(channelId) {
  return db.prepare(`
    SELECT * FROM snapshots WHERE channel_id = ? ORDER BY ts DESC LIMIT 1
  `).get(channelId);
}

/**
 * Find the snapshot closest to (now - targetSeconds), preferring the closest
 * one that is AT LEAST that old (so "hourly rate" never looks over a window
 * shorter than an hour). Falls back to the oldest available snapshot if none
 * is old enough yet.
 */
export function getSnapshotNear(channelId, targetSecondsAgo) {
  const cutoff = Math.floor(Date.now() / 1000) - targetSecondsAgo;
  const atOrBefore = db.prepare(`
    SELECT * FROM snapshots
    WHERE channel_id = ? AND ts <= ?
    ORDER BY ts DESC LIMIT 1
  `).get(channelId, cutoff);
  if (atOrBefore) return atOrBefore;

  // Not enough history yet — no snapshot old enough.
  return null;
}

/** All snapshots within the last N seconds, oldest first (for graphing). */
export function getRecentSnapshots(channelId, windowSeconds) {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE channel_id = ? AND ts >= ?
    ORDER BY ts ASC
  `).all(channelId, cutoff);
}

/** Oldest snapshot on record for a channel (used to know when tracking truly began). */
export function getFirstSnapshot(channelId) {
  return db.prepare(`
    SELECT * FROM snapshots WHERE channel_id = ? ORDER BY ts ASC LIMIT 1
  `).get(channelId);
}

/** Prune snapshots older than N seconds to keep the DB small (default: keep 26h). */
export function pruneOldSnapshots(channelId, keepSeconds = 26 * 3600) {
  const cutoff = Math.floor(Date.now() / 1000) - keepSeconds;
  db.prepare(`DELETE FROM snapshots WHERE channel_id = ? AND ts < ?`).run(channelId, cutoff);
}

/**
 * Replace the entire player_rankings table with a fresh set of rows in one
 * transaction. Used by the hourly top-N-leagues ranking rebuild — the table
 * always reflects the single most recent full pass, not an accumulating history.
 */
/**
 * A display name that is always bindable and never null.
 *
 * League contributions do carry a DisplayName, but it is very often just the
 * numeric UserID, and when Roblox rate-limits the rankings job the entry comes
 * back unresolved. `undefined` cannot bind to a SQLite parameter — the insert
 * throws and takes the whole rebuild with it. Falling back to the numeric ID
 * keeps the NOT NULL column satisfied and degrades one name rather than the
 * entire pass. (The clan bot hit exactly this and its rankings job crashed
 * every hour; same guard lives in its db.js.)
 */
function bindableDisplayName(row) {
  return row.displayName ?? row.username ?? String(row.userId);
}

export function replacePlayerRankings(rows) {
  const deleteAll = db.prepare(`DELETE FROM player_rankings`);
  const insert = db.prepare(`
    INSERT INTO player_rankings (user_id, display_name, username, points, league_id, league_name, league_rank)
    VALUES (@userId, @displayName, @username, @points, @leagueId, @leagueName, @leagueRank)
  `);

  db.exec('BEGIN');
  try {
    deleteAll.run();
    for (const row of rows) {
      insert.run({
        userId: String(row.userId),
        displayName: bindableDisplayName(row),
        username: row.username ?? null,
        points: row.points ?? 0,
        leagueId: String(row.leagueId),
        leagueName: row.leagueName,
        leagueRank: row.leagueRank,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Look up a player's global rank (within the tracked top-N leagues) by Roblox user ID. */
export function getPlayerRanking(userId) {
  const row = db.prepare(`SELECT * FROM player_rankings WHERE user_id = ?`).get(String(userId));
  if (!row) return null;

  const { count } = db.prepare(`SELECT COUNT(*) as count FROM player_rankings WHERE points > ?`).get(row.points);
  return { ...row, globalRank: count + 1 };
}

/** Total number of players currently in the rankings table. */
export function getPlayerRankingsCount() {
  const { count } = db.prepare(`SELECT COUNT(*) as count FROM player_rankings`).get();
  return count;
}

/**
 * Search player_rankings by username OR display name substring
 * (case-insensitive), up to `limit` results, best points first.
 *
 * Matching both is the point: a player is known to their friends by their
 * @username but shows up in-game under a display name, and either is a
 * reasonable thing to type into /leagueplayer.
 */
export function getPlayerRankingByName(query, limit = 10) {
  return db.prepare(`
    SELECT * FROM player_rankings
    WHERE LOWER(display_name) LIKE '%' || LOWER(?) || '%'
       OR LOWER(COALESCE(username, '')) LIKE '%' || LOWER(?) || '%'
    ORDER BY points DESC
    LIMIT ?
  `).all(query, query, limit);
}

/**
 * Record a batch of (league, points) readings at the current time, one
 * transaction. Called once per hourly rankings job run for every top-N
 * league. Safe to call even if a league was already recorded this run
 * (won't happen in practice since ts is the same for a whole batch, but the
 * composite primary key protects against accidental double-writes).
 */
export function recordLeaguePointsBatch(rows) {
  const insert = db.prepare(`
    INSERT INTO league_points_history (league_id, league_name, points, ts)
    VALUES (@leagueId, @leagueName, @points, @ts)
    ON CONFLICT(league_id, ts) DO UPDATE SET points = excluded.points, league_name = excluded.league_name
  `);
  const ts = Math.floor(Date.now() / 1000);

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      insert.run({ leagueId: row.leagueId, leagueName: row.leagueName, points: row.points, ts });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Get the points reading for a league closest to (but not more recent than)
 * `targetSecondsAgo` seconds ago. Used to compute that league's own hourly
 * rate the same way we compute it for the actively tracked league. Returns
 * null if there's no reading old enough yet (e.g. rankings job hasn't run
 * twice yet since the bot started).
 */
export function getLeaguePointsNear(leagueId, targetSecondsAgo) {
  const cutoff = Math.floor(Date.now() / 1000) - targetSecondsAgo;
  return db.prepare(`
    SELECT * FROM league_points_history
    WHERE league_id = ? AND ts <= ?
    ORDER BY ts DESC LIMIT 1
  `).get(leagueId, cutoff);
}

/** Most recent points reading for a league, if any. */
export function getLatestLeaguePoints(leagueId) {
  return db.prepare(`
    SELECT * FROM league_points_history WHERE league_id = ? ORDER BY ts DESC LIMIT 1
  `).get(leagueId);
}

/** Prune history older than N seconds across all leagues (default: keep 26h, mirrors snapshot pruning). */
export function pruneOldLeaguePointsHistory(keepSeconds = 26 * 3600) {
  const cutoff = Math.floor(Date.now() / 1000) - keepSeconds;
  db.prepare(`DELETE FROM league_points_history WHERE ts < ?`).run(cutoff);
}

/**
 * Distinct league IDs whose rank (as of the last hourly rankings job run)
 * falls within [minRank, maxRank] inclusive. Used to build a "neighborhood"
 * of leagues around a milestone rank, so a rate estimate can be smoothed
 * across several leagues instead of relying on one league's potentially
 * noisy single-hour reading (e.g. a quiet hour for the exact rank-100 league
 * shouldn't make "time to reach top 100" look artificially fast).
 */
export function getLeagueIdsNearRank(minRank, maxRank) {
  return db.prepare(`
    SELECT DISTINCT league_id, league_name, league_rank FROM player_rankings
    WHERE league_rank BETWEEN ? AND ?
    ORDER BY league_rank ASC
  `).all(minRank, maxRank);
}

/**
 * Record a batch of (player, league, points) readings at the current time,
 * one transaction. Called once per hourly rankings job run for every member
 * of every top-N league — reuses PointContributions data already fetched for
 * player_rankings, so this costs no extra API calls.
 */
export function recordPlayerPointsBatch(rows) {
  const insert = db.prepare(`
    INSERT INTO player_points_history (user_id, display_name, username, league_id, points, ts)
    VALUES (@userId, @displayName, @username, @leagueId, @points, @ts)
    ON CONFLICT(user_id, league_id, ts) DO UPDATE SET
      points = excluded.points,
      display_name = excluded.display_name,
      username = excluded.username
  `);
  const ts = Math.floor(Date.now() / 1000);

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      insert.run({
        userId: String(row.userId),
        displayName: bindableDisplayName(row),
        username: row.username ?? null,
        leagueId: String(row.leagueId),
        points: row.points ?? 0,
        ts,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Points reading for a player within a specific league, closest to (but not more recent than) targetSecondsAgo. */
export function getPlayerPointsNear(userId, leagueId, targetSecondsAgo) {
  const cutoff = Math.floor(Date.now() / 1000) - targetSecondsAgo;
  return db.prepare(`
    SELECT * FROM player_points_history
    WHERE user_id = ? AND league_id = ? AND ts <= ?
    ORDER BY ts DESC LIMIT 1
  `).get(userId, leagueId, cutoff);
}

/** All current (most recent ts) member rows for a given league, one per player. */
export function getLatestPlayerPointsForLeague(leagueId) {
  return db.prepare(`
    SELECT p.* FROM player_points_history p
    INNER JOIN (
      SELECT user_id, MAX(ts) as max_ts FROM player_points_history WHERE league_id = ? GROUP BY user_id
    ) latest ON p.user_id = latest.user_id AND p.ts = latest.max_ts
    WHERE p.league_id = ?
  `).all(leagueId, leagueId);
}

/** Prune player points history older than N seconds (default: keep 26h). */
export function pruneOldPlayerPointsHistory(keepSeconds = 26 * 3600) {
  const cutoff = Math.floor(Date.now() / 1000) - keepSeconds;
  db.prepare(`DELETE FROM player_points_history WHERE ts < ?`).run(cutoff);
}

/** All history rows for a player within a league over the last N seconds, oldest first. */
export function getPlayerPointsHistory(userId, leagueId, windowSeconds) {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  return db.prepare(`
    SELECT * FROM player_points_history
    WHERE user_id = ? AND league_id = ? AND ts >= ?
    ORDER BY ts ASC
  `).all(userId, leagueId, cutoff);
}

/* ---------------------------------------------------------------------------
 * Long-term daily history
 * ------------------------------------------------------------------------- */

/** UTC date key (YYYY-MM-DD) for an epoch-seconds timestamp. */
export function dayKey(ts = Math.floor(Date.now() / 1000)) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Record today's points for a batch of leagues.
 *
 * Safe to call repeatedly throughout the day — the (league_id, day) primary
 * key means later writes overwrite earlier ones rather than accumulating, so
 * each day ends up holding that day's final reading.
 */
export function recordDailyPointsBatch(rows) {
  const ts = Math.floor(Date.now() / 1000);
  const day = dayKey(ts);
  const insert = db.prepare(`
    INSERT INTO daily_points (league_id, league_name, day, points, ts)
    VALUES (@leagueId, @leagueName, @day, @points, @ts)
    ON CONFLICT(league_id, day) DO UPDATE SET
      points = excluded.points,
      league_name = excluded.league_name,
      ts = excluded.ts
  `);

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      insert.run({ leagueId: row.leagueId, leagueName: row.leagueName, day, points: row.points, ts });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Daily rows for a league over the last N days, oldest first. */
export function getDailyHistory(leagueId, days = 30) {
  const cutoff = dayKey(Math.floor(Date.now() / 1000) - days * 86400);
  return db.prepare(`
    SELECT * FROM daily_points WHERE league_id = ? AND day >= ? ORDER BY day ASC
  `).all(leagueId, cutoff);
}

/** Find a league's stored id by name (case-insensitive), for history lookups. */
export function findDailyLeagueByName(name) {
  return db.prepare(`
    SELECT league_id, league_name, MAX(day) AS latest_day FROM daily_points
    WHERE LOWER(league_name) = LOWER(?)
    GROUP BY league_id, league_name
    ORDER BY latest_day DESC LIMIT 1
  `).get(name);
}

export function pruneDailyPoints(keepDays = 180) {
  const cutoff = dayKey(Math.floor(Date.now() / 1000) - keepDays * 86400);
  db.prepare(`DELETE FROM daily_points WHERE day < ?`).run(cutoff);
}

/* ---------------------------------------------------------------------------
 * Auto-updating top-10 leaderboard channels
 * ------------------------------------------------------------------------- */

export function addTop10Channel({ channelId, guildId }) {
  db.prepare(`
    INSERT INTO top10_channels (channel_id, guild_id, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET guild_id = excluded.guild_id
  `).run(channelId, guildId, Math.floor(Date.now() / 1000));
}

export function removeTop10Channel(channelId) {
  db.prepare(`DELETE FROM top10_channels WHERE channel_id = ?`).run(channelId);
}

export function getAllTop10Channels() {
  return db.prepare(`SELECT * FROM top10_channels`).all();
}

export function getTop10Channel(channelId) {
  return db.prepare(`SELECT * FROM top10_channels WHERE channel_id = ?`).get(channelId);
}

export function setTop10MessageId(channelId, messageId) {
  db.prepare(`UPDATE top10_channels SET message_id = ? WHERE channel_id = ?`).run(messageId, channelId);
}

/* ---------------------------------------------------------------------------
 * Roblox name cache
 * ------------------------------------------------------------------------- */

/**
 * Cached names for the given user IDs, as a Map of userId -> {username,
 * displayName}. Entries older than maxAgeSeconds are treated as absent.
 */
export function getCachedRobloxNames(userIds, maxAgeSeconds) {
  if (userIds.length === 0) return new Map();

  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  const found = new Map();

  // Chunked because SQLite caps host parameters per statement (999 by
  // default) and a rankings pass asks about far more players than that.
  const CHUNK = 500;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK).map(String);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT user_id, username, display_name FROM roblox_names
         WHERE fetched_at >= ? AND user_id IN (${placeholders})`
      )
      .all(cutoff, ...chunk);

    for (const row of rows) {
      found.set(row.user_id, { username: row.username, displayName: row.display_name ?? row.username });
    }
  }

  return found;
}

/** Upsert resolved names. entries: [[userId, {username, displayName}], ...]. */
export function putCachedRobloxNames(entries) {
  if (entries.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO roblox_names (user_id, username, display_name, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      fetched_at = excluded.fetched_at
  `);
  const now = Math.floor(Date.now() / 1000);

  db.exec('BEGIN');
  try {
    for (const [userId, names] of entries) {
      insert.run(String(userId), names.username, names.displayName ?? null, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function setRankingsMeta(key, value) {
  db.prepare(`INSERT INTO rankings_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    key,
    String(value)
  );
}

export function getRankingsMeta(key) {
  const row = db.prepare(`SELECT value FROM rankings_meta WHERE key = ?`).get(key);
  return row ? row.value : null;
}
