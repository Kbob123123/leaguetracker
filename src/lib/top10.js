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

/** Short number for a fixed-width column: 1647600 -> "1.65M". */
function compact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Clip a name so one long league can't shove every column out of alignment. */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

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

  // A leaderboard is tabular data, so it's rendered as an actual table in a
  // code block. Discord uses a monospace font there, which is the only way to
  // get columns that line up — the previous format put each league on two
  // lines with a "└" continuation, turning ten leagues into twenty ragged rows
  // that were genuinely hard to scan.
  const nameWidth = Math.min(14, Math.max(6, ...rows.map((r) => r.league.Name.length)));

  const table = [
    `${'#'.padEnd(3)}${'LEAGUE'.padEnd(nameWidth)} ${'POINTS'.padStart(9)} ${'RATE/H'.padStart(9)} ${'BEHIND'.padStart(9)}`,
    '─'.repeat(3 + nameWidth + 30),
    ...rows.map(({ rank, league, rate }, i) => {
      const above = rows[i - 1];
      const gap = above ? above.league.Points - league.Points : null;
      return (
        `${String(rank).padEnd(3)}` +
        `${truncate(league.Name, nameWidth).padEnd(nameWidth)} ` +
        `${compact(league.Points).padStart(9)} ` +
        `${(rate == null ? '—' : `+${compact(rate)}`).padStart(9)} ` +
        `${(gap == null ? '—' : compact(gap)).padStart(9)}`
      );
    }),
  ].join('\n');

  // Overtake ETAs go BELOW the table rather than inside it: they only exist
  // for some rows, and a mostly-empty column is worse than no column.
  const races = [];
  for (let i = 1; i < rows.length; i++) {
    const { league, rate } = rows[i];
    const above = rows[i - 1];
    if (rate == null || above.rate == null) continue;

    const result = timeToOvertake({
      chaserPoints: league.Points,
      chaserRate: rate,
      targetPoints: above.league.Points,
      targetRate: above.rate,
    });

    if (typeof result === 'number' && Number.isFinite(result) && result > 0) {
      races.push(`**${league.Name}** overtakes **${above.league.Name}** in ${formatDuration(result)}`);
    }
  }

  embed.setDescription(
    `\`\`\`\n${table}\n\`\`\`` + (races.length ? `\n${races.slice(0, 5).join('\n')}` : '')
  );

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
