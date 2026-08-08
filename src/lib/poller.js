import { AttachmentBuilder } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors, getLeagueAtRank } from './ps99Api.js';
import {
  getAllTrackedChannels,
  addSnapshot,
  getSnapshotNear,
  getLatestSnapshot,
  getRecentSnapshots,
  removeTrackedChannel,
  pruneOldSnapshots,
  setMessageId,
  getLeaguePointsNear,
  getLatestLeaguePoints,
  getLeagueIdsNearRank,
  recordDailyPointsBatch,
} from './db.js';
import { buildLeagueEmbed } from './embed.js';
import { renderMemberGraph } from './graph.js';
import { resolveNames, formatName } from './robloxNames.js';
import { hourlyRate } from './rates.js';

const HOUR_SECONDS = 3600;
const GRAPH_WINDOW_SECONDS = 24 * HOUR_SECONDS;
export const MILESTONE_RANKS = [250, 100, 50, 10];

/**
 * Look up a league's own hourly rate from league_points_history (populated
 * by the hourly rankings job for every top-N league — see rankingsJob.js).
 * Returns null if we don't have two readings roughly an hour apart yet for
 * this specific league (e.g. it only entered the top-N recently, or the
 * rankings job hasn't run twice since the bot started).
 */
function getLeagueRate(leagueId) {
  if (!leagueId) return null;
  const latest = getLatestLeaguePoints(leagueId);
  const hourAgo = getLeaguePointsNear(leagueId, HOUR_SECONDS);
  if (!latest || !hourAgo || latest.ts === hourAgo.ts) return null;
  return hourlyRate(hourAgo.points, hourAgo.ts, latest.points, latest.ts);
}

/** Attach a `Rate` field (points/hour, or null if unavailable) to a league object from findLeagueNeighbors/getLeagueAtRank. */
function withRate(leagueObj) {
  if (!leagueObj) return null;
  return { ...leagueObj, Rate: getLeagueRate(leagueObj.ID) };
}

// How many leagues on each side of a milestone rank to average when
// estimating "the pace needed to hold this rank". E.g. for rank 100 with a
// window of 10, this averages leagues ranked 90-110 (21 leagues total).
const MILESTONE_RATE_WINDOW = 10;

/**
 * Estimate the hourly rate needed to reach/hold a given rank, by averaging
 * the hourly rate of several leagues clustered around that rank rather than
 * relying on a single league's own last-hour reading.
 *
 * This exists because any one league's hour-to-hour rate is noisy — a league
 * can have a quiet hour (members offline, nobody grinding) that makes them
 * look temporarily slow, which would make "time to reach top 100" look
 * artificially fast if that one league happened to be the exact rank-100
 * league at poll time. Averaging across ~20 nearby leagues means one or two
 * quiet leagues get smoothed out by the rest of the cluster, giving a
 * rate that better reflects the real, sustained pace of that rank tier.
 *
 * Returns null if fewer than 2 leagues in the window have a computable rate
 * (not enough data to average yet — e.g. early after bot startup).
 */
function getNeighborhoodRate(centerRank) {
  const minRank = Math.max(1, centerRank - MILESTONE_RATE_WINDOW);
  const maxRank = centerRank + MILESTONE_RATE_WINDOW;
  const nearbyLeagues = getLeagueIdsNearRank(minRank, maxRank);

  const rates = [];
  for (const league of nearbyLeagues) {
    const rate = getLeagueRate(league.league_id);
    if (rate != null) rates.push(rate);
  }

  if (rates.length < 2) return null;
  return rates.reduce((sum, r) => sum + r, 0) / rates.length;
}

/** Like withRate, but for milestone targets: uses a neighborhood-averaged rate instead of the single target league's own noisy hourly rate. */
function withNeighborhoodRate(leagueObj, rank) {
  if (!leagueObj) return null;
  return { ...leagueObj, Rate: getNeighborhoodRate(rank) };
}

export async function pollAllTrackedChannels(client) {
  const tracked = getAllTrackedChannels();

  for (const row of tracked) {
    try {
      await pollOneChannel(client, row);
    } catch (err) {
      console.error(`[poller] Failed to update channel ${row.channel_id} (league "${row.league_name}"):`, err);
    }
  }
}

export async function pollOneChannel(client, trackedRow) {
  const { channel_id: channelId, league_name: leagueName, started_at: startedAt } = trackedRow;

  const league = await getLeagueDetail(leagueName);
  if (!league) {
    // League vanished or was renamed/disbanded — notify and stop tracking rather
    // than spamming errors every 10 minutes forever.
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased()) {
      await channel
        .send(`⚠️ League **${leagueName}** could no longer be found. Stopping tracking in this channel.`)
        .catch(() => {});
    }
    removeTrackedChannel(channelId);
    return;
  }

  const neighbors = await findLeagueNeighbors(league);

  // Only fetch milestones the league hasn't already passed — no point checking
  // "distance to top 100" for a league that's already rank 5.
  const milestones = await fetchMilestones(neighbors);

  // Attach each target's own hourly rate (from league_points_history, built by
  // the hourly rankings job) so ETA math accounts for the target ALSO gaining
  // points, instead of treating them as standing still. Falls back to null
  // (rate unknown) for targets outside the top-N leagues tracked by that job.
  const neighborsWithRates = {
    ...neighbors,
    ahead: withRate(neighbors.ahead),
    behind: withRate(neighbors.behind),
  };
  const milestonesWithRates = {};
  for (const [rank, target] of Object.entries(milestones)) {
    milestonesWithRates[rank] = withNeighborhoodRate(target, Number(rank));
  }

  const currentMembers = await resolveNames(buildMemberPointsList(league));

  addSnapshot({
    channelId,
    leagueName: league.Name, // use canonical casing from the API
    points: league.Points,
    members: currentMembers,
    neighbors: {
      ahead: neighbors.ahead ? { ID: neighbors.ahead.ID, Points: neighbors.ahead.Points, Name: neighbors.ahead.Name } : null,
      behind: neighbors.behind ? { ID: neighbors.behind.ID, Points: neighbors.behind.Points, Name: neighbors.behind.Name } : null,
    },
  });

  pruneOldSnapshots(channelId);

  // Record daily history for the tracked league here as well as in the
  // rankings job. The job only covers the top 1,000, so without this a league
  // someone is actively tracking from further down the board would have no
  // long-term history at all — which is exactly the league they care about.
  recordDailyPointsBatch([{ leagueId: league.ID, leagueName: league.Name, points: league.Points }]);

  const latestSnapshot = getLatestSnapshot(channelId);
  const hourAgoSnapshot = getSnapshotNear(channelId, HOUR_SECONDS);
  // Guard: getSnapshotNear looks for ts <= cutoff, so if the only row is the one
  // we just inserted (elapsed 0), hourAgoSnapshot will correctly come back null
  // until an hour of real history exists.
  const validHourAgo = hourAgoSnapshot && hourAgoSnapshot.id !== latestSnapshot.id ? hourAgoSnapshot : null;

  const embed = buildLeagueEmbed({
    league,
    hourAgoSnapshot: validHourAgo,
    latestSnapshot,
    neighbors: neighborsWithRates,
    milestones: milestonesWithRates,
    trackingStartedAt: new Date(startedAt * 1000),
  });

  const files = [];
  const recentSnapshots = getRecentSnapshots(channelId, GRAPH_WINDOW_SECONDS);
  if (recentSnapshots.length >= 2) {
    const buffer = await renderMemberGraph(recentSnapshots, league.Name);
    if (buffer) {
      const attachment = new AttachmentBuilder(buffer, { name: 'league-graph.png' });
      embed.setImage('attachment://league-graph.png');
      files.push(attachment);
    }
  }

  await postOrEditMessage(client, trackedRow, embed, files);
}

export async function fetchMilestones(neighbors) {
  const milestones = {};
  for (const rank of MILESTONE_RANKS) {
    if (neighbors.rank != null && neighbors.rank <= rank) continue;
    try {
      const milestoneLeague = await getLeagueAtRank(rank);
      if (milestoneLeague) {
        milestones[rank] = { ID: milestoneLeague.ID, Points: milestoneLeague.Points, Name: milestoneLeague.Name };
      }
    } catch (err) {
      console.warn(`[poller] Failed to fetch milestone rank ${rank}:`, err.message);
    }
  }
  return milestones;
}

export function buildMemberPointsList(league) {
  // PointContributions has the actual points-earned-toward-league figures;
  // fall back to Members (roster) with 0 points if contributions are empty.
  const contributions = league.PointContributions || [];
  if (contributions.length > 0) {
    return contributions.map((c) => ({
      userId: c.UserID,
      displayName: c.DisplayName,
      points: c.Points,
    }));
  }

  const roster = [
    ...(league.Owner?.UserID ? [{ userId: league.Owner.UserID, displayName: league.Owner.DisplayName, points: 0 }] : []),
    ...(league.Members || []).map((m) => ({ userId: m.UserID, displayName: m.DisplayName, points: 0 })),
  ];
  return roster;
}

async function postOrEditMessage(client, trackedRow, embed, files) {
  const channel = await client.channels.fetch(trackedRow.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[poller] Channel ${trackedRow.channel_id} not found or not text-based; removing tracking.`);
    removeTrackedChannel(trackedRow.channel_id);
    return;
  }

  const payload = { embeds: [embed], files };

  if (trackedRow.message_id) {
    const existing = await channel.messages.fetch(trackedRow.message_id).catch(() => null);
    if (existing) {
      await existing.edit(payload);
      return;
    }
  }

  // No message yet, or it was deleted — post a fresh one and remember its ID.
  const sent = await channel.send(payload);
  setMessageId(trackedRow.channel_id, sent.id);
}
