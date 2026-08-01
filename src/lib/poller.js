import { AttachmentBuilder } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors } from './ps99Api.js';
import {
  getAllTrackedChannels,
  addSnapshot,
  getSnapshotNear,
  getLatestSnapshot,
  getRecentSnapshots,
  removeTrackedChannel,
  pruneOldSnapshots,
  setMessageId,
} from './db.js';
import { buildLeagueEmbed } from './embed.js';
import { renderMemberGraph } from './graph.js';
import { resolveDisplayNames } from './robloxNames.js';

const HOUR_SECONDS = 3600;
const GRAPH_WINDOW_SECONDS = 24 * HOUR_SECONDS;

/**
 * Poll every tracked channel once. Safe to call on an interval; each channel's
 * failure is isolated so one broken/deleted league doesn't stop the others.
 */
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
