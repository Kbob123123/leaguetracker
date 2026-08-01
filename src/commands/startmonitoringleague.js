import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors } from '../lib/ps99Api.js';
import { addTrackedChannel, getTrackedChannel, addSnapshot } from '../lib/db.js';
import { buildMemberPointsList } from '../lib/poller.js';
import { resolveDisplayNames } from '../lib/robloxNames.js';

export const data = new SlashCommandBuilder()
  .setName('startmonitoringleague')
  .setDescription('Start tracking a PS99 league in a channel, with updates every 10 minutes.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt.setName('league').setDescription('Exact league name (case-insensitive)').setRequired(true)
  )
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to post updates in (defaults to this channel)')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const leagueName = interaction.options.getString('league', true);
  const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

  const existing = getTrackedChannel(targetChannel.id);
  if (existing) {
    await interaction.editReply(
      `⚠️ <#${targetChannel.id}> is already tracking **${existing.league_name}**. ` +
        `Use \`/stopmonitoringleague\` there first if you want to switch leagues.`
    );
    return;
  }

  const league = await getLeagueDetail(leagueName);
  if (!league) {
    await interaction.editReply(`❌ Couldn't find a league named **${leagueName}**. Check the spelling and try again.`);
    return;
  }

  // Take the first snapshot immediately so the graph/history has a starting point,
  // and confirm the neighbor lookup works before we commit to tracking.
  const neighbors = await findLeagueNeighbors(league);

  const members = await resolveDisplayNames(buildMemberPointsList(league));

  addTrackedChannel({
    channelId: targetChannel.id,
    guildId: interaction.guildId,
    leagueName: league.Name,
  });

  addSnapshot({
    channelId: targetChannel.id,
    leagueName: league.Name,
    points: league.Points,
    members,
    neighbors: {
      ahead: neighbors.ahead
        ? { ID: neighbors.ahead.ID, Points: neighbors.ahead.Points, Name: neighbors.ahead.Name }
        : null,
      behind: neighbors.behind
        ? { ID: neighbors.behind.ID, Points: neighbors.behind.Points, Name: neighbors.behind.Name }
        : null,
    },
  });

  const confirmEmbed = new EmbedBuilder()
    .setTitle(`✅ Now tracking ${league.Name}`)
    .setColor(0x57f287)
    .setDescription(`Posting live updates in <#${targetChannel.id}> every 10 minutes.`)
    .addFields(
      { name: 'Points', value: league.Points.toLocaleString(), inline: true },
      {
        name: 'Rank',
        value: neighbors.rank ? `#${neighbors.rank} of ${neighbors.total.toLocaleString()}` : 'N/A',
        inline: true,
      }
    )
    .setFooter({ text: 'Hourly rates will appear once an hour of data has been collected.' })
    .setTimestamp();

  if (league.Icon) {
    const iconId = league.Icon.replace('rbxassetid://', '');
    confirmEmbed.setThumbnail(`https://www.roblox.com/asset-thumbnail/image?assetId=${iconId}&width=150&height=150&format=png`);
  }

  await interaction.editReply({ embeds: [confirmEmbed] });
}
