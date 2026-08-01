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
  getLockedTarget,
  setLockedTarget,
} from './db.js';
import { buildLeagueEmbed } from './embed.js';
import { renderMemberGraph } from './graph.js';
import { resolveDisplayNames } from './robloxNames.js';

const HOUR_SECONDS = 3600;
const GRAPH_WINDOW_SECONDS = 24 * HOUR_SECONDS;
export const MILESTONE_RANKS = [100, 50, 10];

/**
 * Same locking principle as resolveLockedTarget, but inverted: here it's the
 * league BEHIND us whose points are chasing a fixed threshold — specifically
 * our own points value at the moment of locking. If the behind league (or
 * whoever is behind us) reaches/passes that locked points value, we
 * re-lock a fresh threshold using our current points and note who's now behind.
 */
export function resolveBehindTarget(channelId, currentPoints, liveBehindLeague) {
  const targetKey = 'behind';
  const existing = getLockedTarget(channelId, targetKey);

  const behindPoints = liveBehindLeague?.Points ?? null;
  const alreadyBeaten = existing && behindPoints != null && behindPoints >= existing.target_points;

  if (!existing || alreadyBeaten) {
    if (!liveBehindLeague) return null; // last place, nothing behind to track
    setLockedTarget(channelId, targetKey, {
      leagueId: liveBehindLeague.ID,
      leagueName: liveBehindLeague.Name,
      points: currentPoints, // the threshold THEY need to reach is OUR points now
    });
    return {
      target_league_id: liveBehindLeague.ID,
      target_league_name: liveBehindLeague.Name,
      target_points: currentPoints,
      chaserPoints: behindPoints,
      justLocked: true,
      wasJustBeaten: !!alreadyBeaten,
    };
  }

  return { ...existing, chaserPoints: behindPoints, justLocked: false, wasJustBeaten: false };
}

/**
 * Resolve the target a tracked league should be measured against for a given
 * target_key ('ahead', 'top100', 'top50', 'top10'), keeping the points
 * threshold FIXED once locked so ETAs only move because of the tracked
 * league's own rate — not because some other league shuffled positions.
 *
 * - If no target is locked yet, or the tracked league has already reached/
 *   passed the previously locked points value, a fresh target is locked from
 *   `liveCandidate` (whoever currently holds that position) and returned.
 * - Otherwise the existing locked target is returned unchanged.
 * - Returns null if there's no live candidate to lock against (e.g. already
 *   rank 1, so there's no "ahead"; or already past top 10).
 */
export function resolveLockedTarget(channelId, targetKey, currentPoints, liveCandidate) {
  const existing = getLockedTarget(channelId, targetKey);

  const alreadyBeaten = existing && currentPoints >= existing.target_points;

  if (!existing || alreadyBeaten) {
    if (!liveCandidate) {
      // Nothing to lock onto right now (e.g. rank 1, or already past top 10) —
      // clear any stale locked target so we don't show a beaten one forever.
      return null;
    }
    setLockedTarget(channelId, targetKey, {
      leagueId: liveCandidate.ID,
      leagueName: liveCandidate.Name,
      points: liveCandidate.Points,
    });
    return {
      target_league_id: liveCandidate.ID,
      target_league_name: liveCandidate.Name,
      target_points: liveCandidate.Points,
      justLocked: true,
      wasJustBeaten: !!alreadyBeaten,
    };
  }

  return { ...existing, justLocked: false, wasJustBeaten: false };
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

async function pollOneChannel(client, trackedRow) {
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
  const milestoneCandidates = await fetchMilestones(neighbors);

  // Resolve locked targets: the points threshold only moves when WE beat it,
  // never because the league that used to hold that spot got overtaken by
  // someone else. This is what keeps ETAs stable poll-to-poll.
  const aheadTarget = resolveLockedTarget(channelId, 'ahead', league.Points, neighbors.ahead);
  // "behind" is inverted: we lock how many points THEY need to reach OUR
  // current points at lock time, so it doesn't reset just because someone
  // else briefly overtakes them or they get overtaken by a third league.
  const behindTarget = neighbors.behind
    ? resolveBehindTarget(channelId, league.Points, neighbors.behind)
    : null;
  const lockedMilestones = {};
  for (const rank of MILESTONE_RANKS) {
    const key = `top${rank}`;
    const candidate = milestoneCandidates[rank] || null;
    // If we've already passed this rank (no candidate fetched), don't lock/show it.
    if (!candidate && (neighbors.rank == null || neighbors.rank > rank)) continue;
    const resolved = resolveLockedTarget(channelId, key, league.Points, candidate);
    if (resolved) lockedMilestones[rank] = resolved;
  }

  const currentMembers = await resolveDisplayNames(buildMemberPointsList(league));

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
    neighbors,
    aheadTarget,
    behindTarget,
    lockedMilestones,
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
