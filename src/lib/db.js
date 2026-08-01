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
