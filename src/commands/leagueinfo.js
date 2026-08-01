import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors } from '../lib/ps99Api.js';
import { formatPoints } from '../lib/rates.js';
import { resolveDisplayNames } from '../lib/robloxNames.js';

export const data = new SlashCommandBuilder()
  .setName('leagueinfo')
  .setDescription('Look up a PS99 league\'s current standing (no tracking started).')
  .addStringOption((opt) =>
    opt.setName('league').setDescription('Exact league name (case-insensitive)').setRequired(true)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const leagueName = interaction.options.getString('league', true);
  const league = await getLeagueDetail(leagueName);

  if (!league) {
    await interaction.editReply(`❌ Couldn't find a league named **${leagueName}**.`);
    return;
  }

  const neighbors = await findLeagueNeighbors(league);

  const rawMembers = (league.PointContributions || []).map((m) => ({
    userId: m.UserID,
    displayName: m.DisplayName,
    points: m.Points,
  }));
  const members = await resolveDisplayNames(rawMembers);
  members.sort((a, b) => b.points - a.points);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${league.Name}`)
    .setColor(0x5865f2)
    .setTimestamp();

  if (league.Icon) {
    const iconId = league.Icon.replace('rbxassetid://', '');
    embed.setThumbnail(`https://www.roblox.com/asset-thumbnail/image?assetId=${iconId}&width=150&height=150&format=png`);
  }

  embed.addFields(
    { name: 'Total Points', value: formatPoints(league.Points), inline: true },
    {
      name: 'Rank',
      value: neighbors.rank ? `#${neighbors.rank} of ${neighbors.total.toLocaleString()}` : 'N/A',
      inline: true,
    },
    { name: '\u200b', value: '\u200b', inline: true } // spacer so the row stays 3-wide
  );

  embed.addFields({
    name: '⬆️ Ahead',
    value: neighbors.ahead ? `**${neighbors.ahead.Name}** — ${formatPoints(neighbors.ahead.Points)} pts` : '🏆 Already #1!',
    inline: true,
  });

  embed.addFields({
    name: '⬇️ Behind',
    value: neighbors.behind ? `**${neighbors.behind.Name}** — ${formatPoints(neighbors.behind.Points)} pts` : 'Last place',
    inline: true,
  });

  embed.addFields({ name: '\u200b', value: '\u200b', inline: true });

  const memberLines = members.map((m) => `**${m.displayName}** — ${formatPoints(m.points)} pts`).join('\n');
  embed.addFields({
    name: `Members (${members.length}/${league.MemberCapacity ?? 4})`,
    value: memberLines || 'No contribution data.',
    inline: false,
  });

  embed.setFooter({ text: 'Use /startmonitoringleague to track this league with live hourly rates and a graph.' });

  await interaction.editReply({ embeds: [embed] });
}
