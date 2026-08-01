import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { getTrackedChannel, removeTrackedChannel } from '../lib/db.js';

export const data = new SlashCommandBuilder()
  .setName('stopmonitoringleague')
  .setDescription('Stop tracking a PS99 league in a channel.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel to stop tracking in (defaults to this channel)')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false)
  );

export async function execute(interaction) {
  const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

  const existing = getTrackedChannel(targetChannel.id);
  if (!existing) {
    await interaction.reply({
      content: `<#${targetChannel.id}> isn't currently tracking any league.`,
      ephemeral: true,
    });
    return;
  }

  removeTrackedChannel(targetChannel.id);

  await interaction.reply({
    content: `🛑 Stopped tracking **${existing.league_name}** in <#${targetChannel.id}>. History has been cleared.`,
    ephemeral: true,
  });
}
