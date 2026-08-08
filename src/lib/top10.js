import { EmbedBuilder } from 'discord.js';
import { getLeaguesPage } from './ps99Api.js';
import {
  getAllTop10Channels,
  setTop10MessageId,
  removeTop10Channel,
  getLeaguePointsNear,
  getLatestLeaguePoints,
} from './db.js';
import { hourlyRate, formatPoints, formatRate, timeToOvertake, formatDuration } from './rates.js';

const HOUR_SECONDS = 3600;
const TOP_N = 10;

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * Build the top-10 leaderboard embed.
 *
 * Rates come from league_points_history, which the hourly rankings job fills
 * in for every top-1,000 league — so this needs no extra API calls beyond the
 * single leaderboard page fetched here, and shows "collecting data" until that
 * job has run at least twice.
 */
export async function buildTop10Embed() {
  const page = await getLeaguesPage(1, TOP_N);
  const leagues = (page.leagues || []).slice(0, TOP_N);

  const embed = new EmbedBuilder()
    .setTitle('🏆 Top 10 Leagues')
    .setColor(0xfee75c)
    .setTimestamp();

  if (leagues.length === 0) {
    embed.setDescription('Could not load the leaderboard right now — the PS99 API may be temporarily unavailable.');
    return embed;
  }

  const now = Math.floor(Date.now() / 1000);
  const rows = leagues.map((league, i) => {
    const hourAgo = getLeaguePointsNear(league.ID, HOUR_SECONDS);
    const latest = getLatestLeaguePoints(league.ID);
    // Prefer the live points from this call over the stored reading, but the
    // rate still needs a stored point an hour back to measure against.
    const rate =
      hourAgo && latest && hourAgo.ts !== latest.ts
        ? hourlyRate(hourAgo.points, hourAgo.ts, league.Points, now)
        : null;
    return { rank: i + 1, league, rate };
  });

  const lines = rows.map(({ rank, league, rate }, i) => {
    const medal = MEDALS[i] ?? `\`#${rank}\``;
    const parts = [`${medal} **${league.Name}** — ${formatPoints(league.Points)} pts · ${formatRate(rate)}`];

    // Gap to the league directly above, plus an ETA when we know both rates
    // and the chaser is actually closing (two-body, same as the tracked embed).
    const above = rows[i - 1];
    if (above) {
      const gap = above.league.Points - league.Points;
      let detail = `└ ${formatPoints(gap)} behind ${above.league.Name}`;
      if (rate != null && above.rate != null) {
        // Returns either a number of hours, or {fallingBehind, gapGrowthPerHour}
        // when the target is pulling away faster than the chaser is closing.
        const result = timeToOvertake({
          chaserPoints: league.Points,
          chaserRate: rate,
          targetPoints: above.league.Points,
          targetRate: above.rate,
        });
        if (typeof result === 'number' && Number.isFinite(result) && result > 0) {
          detail += ` · overtakes in ${formatDuration(result)}`;
        } else if (result?.fallingBehind) {
          detail += ` · losing ${formatPoints(Math.round(result.gapGrowthPerHour))}/h`;
        }
      }
      parts.push(detail);
    }

    return parts.join('\n');
  });

  embed.setDescription(lines.join('\n'));

  const anyRate = rows.some((r) => r.rate != null);
  embed.setFooter({
    text: anyRate
      ? 'Rates are a trailing hour from the hourly rankings scan.'
      : 'Collecting data — rates appear once the hourly scan has run twice.',
  });

  return embed;
}

/**
 * Refresh every configured top-10 channel.
 *
 * The whole point of storing message_id is that this EDITS its existing post
 * rather than sending a new one each cycle, so a channel keeps exactly one
 * leaderboard message that quietly updates in place. If that message has been
 * deleted, fetching it fails and we post a fresh one and remember the new id.
 */
export async function updateAllTop10Channels(client) {
  const channels = getAllTop10Channels();
  if (channels.length === 0) return;

  let embed;
  try {
    embed = await buildTop10Embed();
  } catch (err) {
    console.error('[top10] Could not build the leaderboard embed:', err.message);
    return;
  }

  for (const row of channels) {
    try {
      const channel = await client.channels.fetch(row.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        console.warn(`[top10] Channel ${row.channel_id} is gone or not text-based; unregistering.`);
        removeTop10Channel(row.channel_id);
        continue;
      }

      if (row.message_id) {
        const existing = await channel.messages.fetch(row.message_id).catch(() => null);
        if (existing) {
          await existing.edit({ embeds: [embed] });
          continue;
        }
        // Message was deleted — fall through and post a replacement.
      }

      const sent = await channel.send({ embeds: [embed] });
      setTop10MessageId(row.channel_id, sent.id);
    } catch (err) {
      console.error(`[top10] Failed to update channel ${row.channel_id}:`, err.message);
    }
  }
}
