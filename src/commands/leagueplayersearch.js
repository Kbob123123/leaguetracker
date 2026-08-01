import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { searchPlayers } from '../lib/ps99Api.js';
import { getAllTrackedChannels, getLatestSnapshot, getPlayerRanking, getPlayerRankingsCount, getRankingsMeta } from '../lib/db.js';
import { formatPoints } from '../lib/rates.js';
import { TOP_LEAGUES_COUNT } from '../lib/rankingsJob.js';

export const data = new SlashCommandBuilder()
  .setName('leagueplayersearch')
  .setDescription('Find a player: see their global top-league rank and whether they\'re in a league you track.')
  .addStringOption((opt) =>
    opt.setName('player').setDescription('Username or display name (min 2 characters)').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('player', true);

  let matches;
  try {
    matches = await searchPlayers(query, 10);
  } catch (err) {
    await interaction.editReply(`❌ Player search failed: ${err.message}`);
    return;
  }

  if (matches.length === 0) {
    await interaction.editReply(
      `❌ No players found matching **${query}**. Double check the spelling — this searches by ` +
        `Roblox username/display name and needs at least 2 characters.`
    );
    return;
  }

  // Only check leagues tracked in *this* server — we only have roster data for those.
  const trackedInGuild = getAllTrackedChannels().filter((t) => t.guild_id === interaction.guildId);
  const totalRanked = getPlayerRankingsCount();
  const lastRebuiltAt = getRankingsMeta('last_rebuilt_at');

  const embed = new EmbedBuilder()
    .setTitle(`🔎 Player Search — "${query}"`)
    .setColor(0x5865f2)
    .setTimestamp();

  const lines = [];

  for (const player of matches.slice(0, 5)) {
    const name = player.displayName || player.username;
    const parts = [`**${name}** (@${player.username})`];

    // Global rank within the top-N-leagues player pool (N = TOP_LEAGUES_COUNT).
    const ranking = getPlayerRanking(player.robloxUserId);
    if (ranking) {
      parts.push(
        `└ 🌍 **#${ranking.globalRank.toLocaleString()}** of ${totalRanked.toLocaleString()} tracked top-league players ` +
          `— ${formatPoints(ranking.points)} pts, in **${ranking.league_name}** (league rank #${ranking.league_rank})`
      );
    } else if (totalRanked > 0) {
      parts.push(`└ 🌍 Not currently in a top-${TOP_LEAGUES_COUNT} league (or hasn't contributed points there).`);
    }

    // Whether they're in a league this specific Discord server is tracking.
    let foundIn = null;
    for (const tracked of trackedInGuild) {
      const snapshot = getLatestSnapshot(tracked.channel_id);
      if (!snapshot) continue;
      const members = JSON.parse(snapshot.members_json);
      const member = members.find((m) => String(m.userId) === String(player.robloxUserId));
      if (member) {
        foundIn = { leagueName: tracked.league_name, channelId: tracked.channel_id, points: member.points };
        break;
      }
    }

    if (foundIn) {
      parts.push(`└ 📍 In tracked league **${foundIn.leagueName}** (<#${foundIn.channelId}>) — ${formatPoints(foundIn.points)} pts`);
    }

    lines.push(parts.join('\n'));
  }

  embed.setDescription(lines.join('\n\n'));

  const footerParts = [];
  if (matches.length > 5) {
    footerParts.push(`Showing 5 of ${matches.length} matches`);
  }
  if (totalRanked > 0 && lastRebuiltAt) {
    const minutesAgo = Math.round((Date.now() / 1000 - Number(lastRebuiltAt)) / 60);
    const ageText = minutesAgo < 60 ? `${minutesAgo}m ago` : `${Math.round(minutesAgo / 60)}h ago`;
    footerParts.push(`Global ranking covers top ${TOP_LEAGUES_COUNT} leagues, last refreshed ${ageText}`);
  } else {
    footerParts.push('Global ranking is still building — check back in a bit');
  }
  embed.setFooter({ text: footerParts.join(' • ') });

  await interaction.editReply({ embeds: [embed] });
}
