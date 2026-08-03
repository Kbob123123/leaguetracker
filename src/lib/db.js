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
export function replacePlayerRankings(rows) {
  const deleteAll = db.prepare(`DELETE FROM player_rankings`);
  const insert = db.prepare(`
    INSERT INTO player_rankings (user_id, display_name, points, league_id, league_name, league_rank)
    VALUES (@userId, @displayName, @points, @leagueId, @leagueName, @leagueRank)
  `);

  db.exec('BEGIN');
  try {
    deleteAll.run();
    for (const row of rows) {
      insert.run(row);
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
