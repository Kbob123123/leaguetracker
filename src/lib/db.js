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

-- Long-term per-PLAYER history: one row per player per UTC day.
--
-- player_points_history is pruned at 26 hours because it exists to compute a
-- trailing-hour rate, so before this table there was no way to chart a
-- player's progress over weeks — /leaguehistory could only ever show leagues.
-- Leagues have no Battles archive the way clans do, so our own daily readings
-- are the ONLY possible source of player history, and it can only ever reach
-- back as far as the bot has been running.
CREATE TABLE IF NOT EXISTS player_daily_points (
  user_id     TEXT NOT NULL,
  username    TEXT,
  league_id   TEXT NOT NULL,
  league_name TEXT,
  day         TEXT NOT NULL,
  points      INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_player_daily_user_day ON player_daily_points (user_id, day);

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

-- Roblox account <-> Discord account links, so the bot can DM a league member
-- who has stopped scoring. League contributions identify people only by Roblox
-- UserID; without a link there is no Discord user to message.
--
-- Keyed by roblox_user_id, not by (guild, roblox_user_id): a person's Roblox
-- and Discord identities are the same everywhere, so one link per Roblox
-- account is the honest model. guild_id and linked_by are kept for provenance
-- — who claimed this link and where — not as part of the key.
--
-- discord_user_id is UNIQUE as well: letting one Discord account claim several
-- Roblox accounts would make "who do I DM about this member" ambiguous in the
-- one direction that matters.
CREATE TABLE IF NOT EXISTS player_links (
  roblox_user_id  TEXT PRIMARY KEY,
  roblox_username TEXT NOT NULL,
  discord_user_id TEXT NOT NULL UNIQUE,
  guild_id        TEXT,
  linked_by       TEXT,
  linked_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_player_links_discord ON player_links (discord_user_id);

-- Per-member idle tracking for a monitored league: what we last saw them on,
-- when they stopped moving, and how many nudges we have already sent.
--
-- dms_sent is what stops the reminder becoming harassment. Someone asleep at
-- 3am would otherwise be messaged every ten minutes until morning, so the
-- count is capped and only resets when they actually score again.
CREATE TABLE IF NOT EXISTS member_idle_state (
  channel_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  last_points  INTEGER NOT NULL,
  idle_since   INTEGER,
  dms_sent     INTEGER NOT NULL DEFAULT 0,
  last_dm_at   INTEGER,
  PRIMARY KEY (channel_id, user_id)
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

-- Servers allowed to use the bot, managed by the owner via /ownermenu.
--
-- An EMPTY table means "allow everyone" on purpose. The alternative — empty
-- means deny — would take every server offline the moment this shipped, and
-- the owner would have to whitelist their way back in from a bot that no
-- longer answers them. Enforcement only begins once at least one guild is
-- listed, which makes turning it on a deliberate act.
CREATE TABLE IF NOT EXISTS guild_whitelist (
  guild_id TEXT PRIMARY KEY,
  note     TEXT,
  added_by TEXT,
  added_at INTEGER NOT NULL
);

-- Every command invocation, so the owner can see what each server is doing.
CREATE TABLE IF NOT EXISTS command_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  guild_id   TEXT,
  guild_name TEXT,
  user_id    TEXT NOT NULL,
  username   TEXT,
  command    TEXT NOT NULL,
  options    TEXT,
  outcome    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_command_log_ts ON command_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_command_log_guild ON command_log (guild_id, ts DESC);

-- Small key/value store for owner settings that must outlive a restart,
-- e.g. whether command logging is currently running.
CREATE TABLE IF NOT EXISTS bot_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- League battle history, captured by us because the API keeps none.
--
-- Unlike clans — whose detail response ships a rolling archive of ~30 past
-- battles — the league endpoints expose ONLY current standings. When the
-- Saturday reset lands, the previous battle's points are simply gone. So the
-- only way to have league history is to record it ourselves as it happens.
--
-- battle_key is the date of the reset the battle ends at (see
-- currentBattleKey). Every hourly pass overwrites the row for the current key,
-- so the last write before a reset stands as that battle's final result. This
-- means we never have to catch the reset moment exactly.
--
-- Consequence worth knowing: this starts empty and gains one battle a week,
-- and a week where the bot was down across the reset is lost for good.
CREATE TABLE IF NOT EXISTS league_battle_results (
  battle_key  TEXT NOT NULL,
  league_id   TEXT NOT NULL,
  league_name TEXT NOT NULL,
  place       INTEGER,
  points      INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (battle_key, league_id)
);

CREATE INDEX IF NOT EXISTS idx_lbr_battle ON league_battle_results (battle_key, points DESC);

CREATE TABLE IF NOT EXISTS league_battle_contributions (
  battle_key  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  username    TEXT,
  league_id   TEXT NOT NULL,
  league_name TEXT,
  points      INTEGER NOT NULL,
  PRIMARY KEY (battle_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_lbc_battle ON league_battle_contributions (battle_key, points DESC);
CREATE INDEX IF NOT EXISTS idx_lbc_user ON league_battle_contributions (user_id);
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

/**
 * Record today's points for a batch of players.
 *
 * Same (id, day) primary-key trick as recordDailyPointsBatch: repeated writes
 * during the day overwrite rather than accumulate, so each day ends holding
 * that day's final reading.
 */
export function recordPlayerDailyBatch(rows) {
  const ts = Math.floor(Date.now() / 1000);
  const day = dayKey(ts);
  const insert = db.prepare(`
    INSERT INTO player_daily_points (user_id, username, league_id, league_name, day, points, ts)
    VALUES (@userId, @username, @leagueId, @leagueName, @day, @points, @ts)
    ON CONFLICT(user_id, day) DO UPDATE SET
      points = excluded.points,
      username = excluded.username,
      league_id = excluded.league_id,
      league_name = excluded.league_name,
      ts = excluded.ts
  `);

  db.exec('BEGIN');
  try {
    for (const row of rows) {
      insert.run({
        userId: String(row.userId),
        username: row.username ?? null,
        leagueId: String(row.leagueId),
        leagueName: row.leagueName ?? null,
        day,
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

/** Daily rows for one player over the last N days, oldest first. */
export function getPlayerDailyHistory(userId, days = 30) {
  const cutoff = dayKey(Math.floor(Date.now() / 1000) - days * 86400);
  return db
    .prepare(`SELECT * FROM player_daily_points WHERE user_id = ? AND day >= ? ORDER BY day ASC`)
    .all(String(userId), cutoff);
}

/** Find a player in the daily history by username or display name. */
export function findPlayerDailyByName(query) {
  return db
    .prepare(
      `SELECT user_id, username, league_name, MAX(day) AS latest_day
       FROM player_daily_points
       WHERE LOWER(COALESCE(username, '')) LIKE '%' || LOWER(?) || '%'
       GROUP BY user_id
       ORDER BY latest_day DESC, COUNT(*) DESC
       LIMIT 5`
    )
    .all(query);
}

export function prunePlayerDailyPoints(keepDays = 180) {
  const cutoff = dayKey(Math.floor(Date.now() / 1000) - keepDays * 86400);
  db.prepare(`DELETE FROM player_daily_points WHERE day < ?`).run(cutoff);
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
 * Roblox <-> Discord account links
 * ------------------------------------------------------------------------- */

/**
 * Create or move a link.
 *
 * Both columns are unique, so re-linking either side has to displace whatever
 * held it before — otherwise the insert just fails and the user is told
 * "already linked" with no way forward. Deleting both sides first makes
 * re-linking idempotent, which is what someone re-running the command expects.
 */
export function setPlayerLink({ robloxUserId, robloxUsername, discordUserId, guildId, linkedBy }) {
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM player_links WHERE roblox_user_id = ? OR discord_user_id = ?`).run(
      String(robloxUserId),
      String(discordUserId)
    );
    db.prepare(`
      INSERT INTO player_links
        (roblox_user_id, roblox_username, discord_user_id, guild_id, linked_by, linked_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(robloxUserId),
      robloxUsername,
      String(discordUserId),
      guildId ?? null,
      linkedBy ? String(linkedBy) : null,
      Math.floor(Date.now() / 1000)
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getLinkByRobloxId(robloxUserId) {
  return db.prepare(`SELECT * FROM player_links WHERE roblox_user_id = ?`).get(String(robloxUserId));
}

export function getLinkByDiscordId(discordUserId) {
  return db.prepare(`SELECT * FROM player_links WHERE discord_user_id = ?`).get(String(discordUserId));
}

/** Remove a link by either side. Returns true if a row was actually deleted. */
export function removePlayerLink({ robloxUserId, discordUserId }) {
  const result = db
    .prepare(`DELETE FROM player_links WHERE roblox_user_id = ? OR discord_user_id = ?`)
    .run(robloxUserId ? String(robloxUserId) : null, discordUserId ? String(discordUserId) : null);
  return result.changes > 0;
}

/** Links for a set of Roblox IDs, as a Map of robloxUserId -> row. */
export function getLinksForRobloxIds(robloxUserIds) {
  if (robloxUserIds.length === 0) return new Map();

  const found = new Map();
  const CHUNK = 500; // SQLite caps host parameters per statement
  for (let i = 0; i < robloxUserIds.length; i += CHUNK) {
    const chunk = robloxUserIds.slice(i, i + CHUNK).map(String);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM player_links WHERE roblox_user_id IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) found.set(row.roblox_user_id, row);
  }
  return found;
}

export function getAllPlayerLinks() {
  return db.prepare(`SELECT * FROM player_links ORDER BY linked_at DESC`).all();
}

/* ---------------------------------------------------------------------------
 * Idle-member tracking
 * ------------------------------------------------------------------------- */

export function getIdleState(channelId, userId) {
  return db
    .prepare(`SELECT * FROM member_idle_state WHERE channel_id = ? AND user_id = ?`)
    .get(String(channelId), String(userId));
}

export function upsertIdleState({ channelId, userId, lastPoints, idleSince, dmsSent, lastDmAt }) {
  db.prepare(`
    INSERT INTO member_idle_state (channel_id, user_id, last_points, idle_since, dms_sent, last_dm_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET
      last_points = excluded.last_points,
      idle_since  = excluded.idle_since,
      dms_sent    = excluded.dms_sent,
      last_dm_at  = excluded.last_dm_at
  `).run(
    String(channelId),
    String(userId),
    lastPoints ?? 0,
    idleSince ?? null,
    dmsSent ?? 0,
    lastDmAt ?? null
  );
}

/** Drop idle rows for a channel that is no longer tracked. */
export function clearIdleStateForChannel(channelId) {
  db.prepare(`DELETE FROM member_idle_state WHERE channel_id = ?`).run(String(channelId));
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

/* ---------------------------------------------------------------------------
 * Guild whitelist and command log (owner tooling)
 * ------------------------------------------------------------------------- */

export function addWhitelistedGuild({ guildId, note, addedBy }) {
  db.prepare(`
    INSERT INTO guild_whitelist (guild_id, note, added_by, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET note = excluded.note
  `).run(String(guildId), note ?? null, addedBy ? String(addedBy) : null, Math.floor(Date.now() / 1000));
}

/** Returns true if a row was actually removed. */
export function removeWhitelistedGuild(guildId) {
  return db.prepare(`DELETE FROM guild_whitelist WHERE guild_id = ?`).run(String(guildId)).changes > 0;
}

export function getWhitelistedGuilds() {
  return db.prepare(`SELECT * FROM guild_whitelist ORDER BY added_at ASC`).all();
}

export function countWhitelistedGuilds() {
  return db.prepare(`SELECT COUNT(*) AS n FROM guild_whitelist`).get().n;
}

export function isGuildWhitelisted(guildId) {
  if (!guildId) return false;
  return !!db.prepare(`SELECT 1 FROM guild_whitelist WHERE guild_id = ?`).get(String(guildId));
}

const COMMAND_LOG_MAX_ROWS = 20000;

/**
 * Whether command logging is currently running.
 *
 * Defaults to ON when unset: the owner asked for this to monitor servers, and
 * a monitor that silently starts disabled would look broken rather than idle.
 * The menu's stop button writes 'off' explicitly.
 */
export function isCommandLoggingEnabled() {
  return getMeta('command_logging') !== 'off';
}

export function setCommandLoggingEnabled(on) {
  setMeta('command_logging', on ? 'on' : 'off');
}

export function logCommand({ guildId, guildName, userId, username, command, options, outcome }) {
  if (!isCommandLoggingEnabled()) return;

  db.prepare(`
    INSERT INTO command_log (ts, guild_id, guild_name, user_id, username, command, options, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Math.floor(Date.now() / 1000),
    guildId ? String(guildId) : null,
    guildName ?? null,
    String(userId),
    username ?? null,
    command,
    options ?? null,
    outcome
  );

  // Trim opportunistically rather than on a timer — cheap, and keeps the table
  // bounded without another scheduled job to forget about.
  if (Math.random() < 0.01) {
    db.prepare(`
      DELETE FROM command_log WHERE id <= (
        SELECT MAX(id) - ? FROM command_log
      )
    `).run(COMMAND_LOG_MAX_ROWS);
  }
}

/** Recent command log entries, newest first, optionally filtered to one guild. */
export function getCommandLog({ guildId = null, limit = 25 } = {}) {
  if (guildId) {
    return db
      .prepare(`SELECT * FROM command_log WHERE guild_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(String(guildId), limit);
  }
  return db.prepare(`SELECT * FROM command_log ORDER BY ts DESC LIMIT ?`).all(limit);
}

/** Per-guild usage totals, busiest first. */
export function getCommandLogSummary(limit = 20) {
  return db
    .prepare(
      `SELECT guild_id, guild_name, COUNT(*) AS uses, MAX(ts) AS last_used
       FROM command_log GROUP BY guild_id ORDER BY uses DESC LIMIT ?`
    )
    .all(limit);
}

/* ---------------------------------------------------------------------------
 * Owner settings
 * ------------------------------------------------------------------------- */

export function getMeta(key) {
  return db.prepare(`SELECT value FROM bot_meta WHERE key = ?`).get(key)?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare(
    `INSERT INTO bot_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

/**
 * Latest and ~an-hour-ago points for every league we hold history for.
 *
 * Feeds the exact placement projection: with a points reading and a rate for
 * each of the top-N leagues, every one of them can be projected to battle end
 * and the finishing order simply counted, instead of being bucketed into
 * "top 50 / top 100" by a handful of milestone thresholds.
 */
export function getAllLeagueRateInputs(windowSeconds = 2 * 3600) {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  const rows = db
    .prepare(
      `SELECT league_id, league_name, points, ts FROM league_points_history
       WHERE ts >= ? ORDER BY league_id ASC, ts ASC`
    )
    .all(cutoff);

  const byLeague = new Map();
  for (const row of rows) {
    let entry = byLeague.get(row.league_id);
    if (!entry) {
      entry = { leagueId: row.league_id, leagueName: row.league_name, first: row, last: row };
      byLeague.set(row.league_id, entry);
    }
    entry.last = row;
    entry.leagueName = row.league_name;
  }

  return [...byLeague.values()].map((e) => {
    const elapsedHours = (e.last.ts - e.first.ts) / 3600;
    // Under ~10 minutes of separation the difference is mostly noise, so the
    // league is treated as stationary rather than given a wild extrapolated rate.
    const rate = elapsedHours >= 0.16 ? (e.last.points - e.first.points) / elapsedHours : 0;
    return { leagueId: e.leagueId, leagueName: e.leagueName, points: e.last.points, rate };
  });
}

/* ---------------------------------------------------------------------------
 * League battle history (captured by us — the API keeps none)
 * ------------------------------------------------------------------------- */

/** Overwrite the current battle's standings for a batch of leagues. */
export function recordLeagueBattleResults(battleKey, rows) {
  const stmt = db.prepare(`
    INSERT INTO league_battle_results (battle_key, league_id, league_name, place, points, updated_at)
    VALUES (@battleKey, @leagueId, @leagueName, @place, @points, @ts)
    ON CONFLICT(battle_key, league_id) DO UPDATE SET
      league_name = excluded.league_name, place = excluded.place,
      points = excluded.points, updated_at = excluded.updated_at
  `);
  const ts = Math.floor(Date.now() / 1000);

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run({
        battleKey,
        leagueId: String(r.leagueId),
        leagueName: r.leagueName,
        place: Number.isFinite(r.place) ? r.place : null,
        points: r.points ?? 0,
        ts,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Overwrite the current battle's per-player contributions. */
export function recordLeagueBattleContributions(battleKey, rows) {
  const stmt = db.prepare(`
    INSERT INTO league_battle_contributions (battle_key, user_id, username, league_id, league_name, points)
    VALUES (@battleKey, @userId, @username, @leagueId, @leagueName, @points)
    ON CONFLICT(battle_key, user_id) DO UPDATE SET
      points = excluded.points, username = excluded.username,
      league_id = excluded.league_id, league_name = excluded.league_name
  `);

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run({
        battleKey,
        userId: String(r.userId),
        username: r.username ?? null,
        leagueId: String(r.leagueId),
        leagueName: r.leagueName ?? null,
        points: r.points ?? 0,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * One player's result in every league battle we captured, newest first.
 *
 * The CURRENT battle is excluded by the caller when it wants finished ones
 * only — an in-progress battle's numbers are not a result yet.
 */
export function getPlayerLeagueBattles(userId) {
  return db
    .prepare(
      `SELECT c.battle_key, c.points, c.league_id, c.league_name,
              r.place AS league_place, r.points AS league_points
       FROM league_battle_contributions c
       LEFT JOIN league_battle_results r
         ON r.battle_key = c.battle_key AND r.league_id = c.league_id
       WHERE c.user_id = ?
       ORDER BY c.battle_key DESC`
    )
    .all(String(userId));
}

/** Where a score ranks among everyone recorded for that league battle. */
export function getLeagueBattlePercentile(battleKey, points) {
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM league_battle_contributions WHERE battle_key = ?`)
    .get(battleKey);
  if (!total) return null;

  const { below } = db
    .prepare(`SELECT COUNT(*) AS below FROM league_battle_contributions WHERE battle_key = ? AND points < ?`)
    .get(battleKey, points);
  const { above } = db
    .prepare(`SELECT COUNT(*) AS above FROM league_battle_contributions WHERE battle_key = ? AND points > ?`)
    .get(battleKey, points);

  return { fraction: below / total, below, total, rank: above + 1 };
}

/** Find a player in the league battle archive by username or display name. */
export function findLeagueBattlePlayersByName(query, limit = 5) {
  return db
    .prepare(
      `SELECT c.user_id, c.username, COUNT(*) AS battles, MAX(c.points) AS best_points
       FROM league_battle_contributions c
       WHERE LOWER(COALESCE(c.username, '')) LIKE '%' || LOWER(?) || '%'
       GROUP BY c.user_id
       ORDER BY best_points DESC
       LIMIT ?`
    )
    .all(query, limit);
}
