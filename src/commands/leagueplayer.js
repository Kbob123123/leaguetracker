import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import {
  getAllTrackedChannels,
  getLatestSnapshot,
  getSnapshotNear,
  getPlayerRankingByName,
  getPlayerPointsNear,
  getPlayerPointsHistory,
  getPlayerRanking,
  getPlayerRankingsCount,
  getPlayerPercentile,
  getPlayerLeagueBattles,
} from '../lib/db.js';
import { hourlyRate, formatPoints, formatRate } from '../lib/rates.js';
import { formatName, matchesName } from '../lib/robloxNames.js';
import { getLeagueDetail } from '../lib/ps99Api.js';
import { resolveThumbnail } from '../lib/thumbnails.js';
import { resolveAvatarUrl } from '../lib/robloxAvatars.js';
import { renderPlayerTotalCard } from '../lib/graph.js';
import { hoursUntilBattleEnd, nextBattleEndUnix } from '../lib/battleTimer.js';

const HOUR_SECONDS = 3600;

// Named /leagueplayer rather than /playerinfo so it can't be confused with the
// clan bot's /clansearch when both bots are in the same server — Discord scopes
// command names per application, so two identical /playerinfo entries would
// otherwise sit side by side in the picker distinguished only by a tiny avatar.
export const data = new SlashCommandBuilder()
  .setName('leagueplayer')
  .setDescription('Look up a player by Roblox username or display name.')
  .addStringOption((opt) =>
    opt.setName('name').setDescription('Roblox username or display name').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const rawQuery = interaction.options.getString('name', true).trim();
  const query = rawQuery.toLowerCase();
  if (query.length < 2) {
    await interaction.editReply('❌ Enter at least 2 characters to search for.');
    return;
  }

  // Tier 1: leagues actively tracked in THIS server — live data from our own
  // 10-minute polling, so rates are current rather than up to an hour old.
  const trackedMatches = searchTrackedChannels(interaction.guildId, query);

  // Tier 2: anyone in the top-1,000 leagues the hourly rankings job covers,
  // even if nobody in this server is tracking their league.
  const rankingMatches = trackedMatches.length === 0 ? getPlayerRankingByName(query) : [];

  if (trackedMatches.length === 0 && rankingMatches.length === 0) {
    // There is deliberately no third tier here. An earlier version fell back to
    // a direct PS99 profile lookup at /v1/players/{username}, but that endpoint
    // returns 404 — it does not exist. The PS99 API exposes no per-player
    // route at all, so league/clan contribution data is the only possible
    // source of player stats and there is nothing further to try.
    await interaction.editReply(
      `❌ No player matching **${rawQuery}** was found in any league tracked in this server, or in the ` +
        `top-1,000 league rankings.\n\n` +
        `_Only players in the top 1,000 leagues can be looked up — the PS99 API has no endpoint for ` +
        `individual players, so anyone outside those leagues can't be searched._`
    );
    return;
  }

  // A single match gets the full card; several get the compact list, so the
  // detail view is never ambiguous about who it is describing. Same rule as
  // the clan bot's /clansearch.
  const only =
    trackedMatches.length === 1 && rankingMatches.length === 0
      ? trackedMatches[0]
      : rankingMatches.length === 1 && trackedMatches.length === 0
        ? rankingMatches[0]
        : null;

  if (only) {
    const { embeds, files } = await buildDetailedEmbed(only);
    await interaction.editReply({ embeds, files });
    return;
  }

  const embed = buildEmbed(rawQuery, trackedMatches, rankingMatches);
  await interaction.editReply({ embeds: [embed] });
}

/**
 * The full player card, built to the same design as the clan bot's.
 *
 * The two bots are siblings and should read that way — player as the title,
 * league on the author line with its icon, avatar as the thumbnail,
 * provenance as prose, and a grid of inline fields rather than a stacked
 * emoji-label-value column.
 *
 * The asymmetry with the clan side is real and the copy does not hide it: a
 * league holds four members against a clan's seventy-five, and the league
 * battle archive only starts from the first Saturday reset after 2026-08-19,
 * so "Battles" will read as empty for a while.
 */
async function buildDetailedEmbed(match) {
  const isRanking = match.user_id !== undefined;
  const userId = isRanking ? match.user_id : match.userId;
  const points = Number(match.points);
  const leagueName = isRanking ? match.league_name : match.leagueName;
  const leagueId = isRanking ? match.league_id : null;
  const who = isRanking
    ? formatName({ username: match.username, displayName: match.display_name, userId })
    : formatName(match);

  const now = Math.floor(Date.now() / 1000);

  let rate = isRanking ? null : match.rate;
  if (rate == null) {
    const hourAgo = getPlayerPointsNear(userId, leagueId, HOUR_SECONDS);
    if (hourAgo) rate = hourlyRate(hourAgo.points, hourAgo.ts, points, now);
  }

  const global = getPlayerRanking(userId);
  const scanned = getPlayerRankingsCount();
  const pct = getPlayerPercentile(points);

  // Position within the league. Leagues cap at four members, so unlike the
  // clan side this is cheap and always complete.
  let leaguePosition = null;
  let leagueSize = null;
  let leagueIconUrl = null;
  try {
    const league = await getLeagueDetail(leagueName);
    if (league) {
      leagueIconUrl = await resolveThumbnail(league.Icon).catch(() => null);
      const contributions = league.PointContributions ?? [];
      if (contributions.length > 0) {
        const ranked = [...contributions].sort((a, b) => b.Points - a.Points);
        const index = ranked.findIndex((c) => String(c.UserID) === String(userId));
        if (index >= 0) leaguePosition = index + 1;
        leagueSize = league.MemberCapacity ?? contributions.length;
      }
    }
  } catch {
    // Enrichment only — a failure just drops those two fields.
  }

  const battles = safeLeagueBattles(userId);
  const best = battles.reduce((b, h) => (b == null || h.points > b.points ? h : b), null);

  const embed = new EmbedBuilder()
    .setTitle(who)
    .setColor(0x2ee6c5)
    .setTimestamp()
    .setAuthor(leagueIconUrl ? { name: leagueName, iconURL: leagueIconUrl } : { name: leagueName });

  const headshot = await resolveAvatarUrl(userId);
  if (headshot) embed.setThumbnail(headshot);

  embed.setDescription(buildProvenance({ isRanking, match, pct, now }));

  embed.addFields(
    { name: 'Points', value: `**${formatPoints(points)}**`, inline: true },
    {
      name: 'In league',
      value: leaguePosition ? `**${leaguePosition}** of ${leagueSize ?? 4}` : '—',
      inline: true,
    },
    {
      name: 'Global',
      value: global ? `**#${global.globalRank.toLocaleString()}**\nof ${scanned.toLocaleString()}` : '—',
      inline: true,
    },
    { name: 'Rate', value: formatRate(rate), inline: true },
    {
      name: 'Best battle',
      value: best ? `**${formatPoints(best.points)}**\n${best.battle_key}` : '—',
      inline: true,
    },
    {
      name: 'Battles',
      value:
        battles.length > 0
          ? `**${battles.length}** on record`
          : '_none yet_',
      inline: true,
    }
  );

  const files = [];
  const series = getPlayerPointsHistory(userId, leagueId, 24 * HOUR_SECONDS).map((r) => ({
    ts: r.ts,
    points: r.points,
  }));

  if (series.length >= 2) {
    const buffer = await renderPlayerTotalCard({
      playerName: who,
      subtitle: leagueName,
      series,
      userId,
      note: `${series.length} samples · hourly scan`,
    }).catch(() => null);

    if (buffer) {
      files.push(new AttachmentBuilder(buffer, { name: 'player.png' }));
      embed.setImage('attachment://player.png');
    }
  } else {
    embed.addFields({
      name: 'Chart',
      value:
        'Not enough history yet — a chart needs at least two readings from the hourly scan.',
    });
  }

  embed.setFooter({
    text:
      battles.length === 0
        ? 'Battle history starts from the first Saturday reset we observed and fills one battle a week.'
        : 'Percentile is measured against the hourly top-1,000 league scan.',
  });

  return { embeds: [embed], files };
}

/**
 * The opening paragraph: provenance first, then how this player compares.
 *
 * Prose rather than a labelled metric row, matching the clan card. Leagues
 * reset weekly, so the countdown is part of the context rather than a
 * separate field.
 */
function buildProvenance({ isRanking, match, pct, now }) {
  const parts = [];

  parts.push(
    isRanking
      ? 'Figures come from the hourly scan of the top 1,000 leagues, so they can be up to an hour old.'
      : `Read live from a league this server tracks${match.channelId ? ` in <#${match.channelId}>` : ''}.`
  );

  const hoursLeft = hoursUntilBattleEnd(new Date(now * 1000));
  if (hoursLeft > 0) {
    parts.push(`This battle resets <t:${nextBattleEndUnix(new Date(now * 1000))}:R>, when standings zero out.`);
  }

  if (pct) {
    const better = (pct.fraction * 100).toFixed(1);
    parts.push(
      `Sits ahead of **${better}%** of the ${pct.total.toLocaleString()} players we have scanned.`
    );
  }

  return parts.join('\n');
}

/** Battle history, or an empty list — history must never break a lookup. */
function safeLeagueBattles(userId) {
  try {
    return getPlayerLeagueBattles(userId) ?? [];
  } catch (err) {
    console.warn('[leagueplayer] Battle history lookup failed:', err.message);
    return [];
  }
}

/** Search every league tracked in this guild for a member matching username or display name. */
function searchTrackedChannels(guildId, query) {
  const trackedInGuild = getAllTrackedChannels().filter((t) => t.guild_id === guildId);
  const matches = [];

  for (const tracked of trackedInGuild) {
    const latest = getLatestSnapshot(tracked.channel_id);
    if (!latest) continue;

    const members = JSON.parse(latest.members_json);
    const found = members.filter((m) => matchesName(m, query));
    if (found.length === 0) continue;

    const hourAgo = getSnapshotNear(tracked.channel_id, HOUR_SECONDS);
    const validHourAgo = hourAgo && hourAgo.id !== latest.id ? hourAgo : null;
    const hourAgoMembers = validHourAgo ? JSON.parse(validHourAgo.members_json) : null;

    for (const member of found) {
      let rate = null;
      if (hourAgoMembers) {
        const prev = hourAgoMembers.find((p) => p.userId === member.userId);
        if (prev) rate = hourlyRate(prev.points, validHourAgo.ts, member.points, latest.ts);
      }
      matches.push({
        username: member.username,
        displayName: member.displayName,
        userId: member.userId,
        points: member.points,
        rate,
        leagueName: tracked.league_name,
        channelId: tracked.channel_id,
      });
    }
  }

  return matches;
}

function buildEmbed(rawQuery, trackedMatches, rankingMatches) {
  const embed = new EmbedBuilder()
    .setTitle(`🔎 Player Lookup — "${rawQuery}"`)
    .setColor(0x5865f2)
    .setTimestamp();

  const lines = [];

  for (const m of trackedMatches.slice(0, 5)) {
    lines.push(
      `**${formatName(m)}** — <#${m.channelId}> (${m.leagueName})\n` +
        `└ 📍 Tracked live — ${formatPoints(m.points)} pts, ${formatRate(m.rate)}`
    );
  }

  for (const m of rankingMatches.slice(0, 5)) {
    // Rate comes from the hourly job's own per-player history, so it's only as
    // fresh as the last pass — labelled accordingly below.
    const hourAgo = getPlayerPointsNear(m.user_id, m.league_id, HOUR_SECONDS);
    const rate = hourAgo
      ? hourlyRate(hourAgo.points, hourAgo.ts, m.points, Math.floor(Date.now() / 1000))
      : null;

    const who = formatName({ username: m.username, displayName: m.display_name, userId: m.user_id });
    lines.push(
      `**${who}** — ${m.league_name} (top-1,000 league, rank #${m.league_rank})\n` +
        `└ 🌍 From hourly scan — ${formatPoints(m.points)} pts, ${formatRate(rate)}`
    );
  }

  embed.setDescription(lines.join('\n\n'));

  const totalMatches = trackedMatches.length + rankingMatches.length;
  embed.setFooter({
    text:
      totalMatches > 5
        ? `Showing 5 of ${totalMatches} matches — try a more specific name.`
        : trackedMatches.length > 0
          ? "Live data from this server's tracked leagues."
          : 'From the hourly top-1,000 league scan — not live-updating.',
  });

  return embed;
}
