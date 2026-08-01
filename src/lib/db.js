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

-- One row per (channel, target_key). target_key is 'ahead', 'top100', 'top50',
-- or 'top10'. target_points is snapshotted ONCE when the target is (re)locked
-- and never changes until beaten — this is what makes ETAs stable even when
-- the league that originally held that points value moves around or gets
-- overtaken by someone else in the meantime. Only the tracked league's own
-- rate affects the ETA against a locked target.
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
  db.prepare(`DELETE FROM locked_targets WHERE channel_id = ?`).run(channelId);
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

/** Get the currently locked target for a channel/key ('ahead', 'top100', 'top50', 'top10'), or null if never locked. */
export function getLockedTarget(channelId, targetKey) {
  return db.prepare(`SELECT * FROM locked_targets WHERE channel_id = ? AND target_key = ?`).get(channelId, targetKey);
}

export function getAllLockedTargets(channelId) {
  return db.prepare(`SELECT * FROM locked_targets WHERE channel_id = ?`).all(channelId);
}

/**
 * Lock (or re-lock, after being beaten) a target's points threshold. This is
 * the only place target_points is written — every poll after this reads it
 * back unchanged until the tracked league's points reach/exceed it.
 */
export function setLockedTarget(channelId, targetKey, { leagueId, leagueName, points }) {
  db.prepare(`
    INSERT INTO locked_targets (channel_id, target_key, target_league_id, target_league_name, target_points, locked_at)
    VALUES (@channelId, @targetKey, @leagueId, @leagueName, @points, @lockedAt)
    ON CONFLICT(channel_id, target_key) DO UPDATE SET
      target_league_id = excluded.target_league_id,
      target_league_name = excluded.target_league_name,
      target_points = excluded.target_points,
      locked_at = excluded.locked_at
  `).run({
    channelId,
    targetKey,
    leagueId: leagueId ?? null,
    leagueName: leagueName ?? null,
    points,
    lockedAt: Math.floor(Date.now() / 1000),
  });
}
