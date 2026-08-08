import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { addTop10Channel, removeTop10Channel, getTop10Channel } from '../lib/db.js';
import { buildTop10Embed } from '../lib/top10.js';
import { setTop10MessageId } from '../lib/db.js';

export const data = new SlashCommandBuilder()
  .setName('setleaguetop10')
  .setDescription('Set (or clear) a channel that shows a self-updating top 10 leagues board.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Channel for the leaderboard. Omit to stop updating the current one.')
      .addChannelTypes(ChannelType.GuildText)
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.options.getChannel('channel');

  // No channel given = turn it off for wherever the command was run.
  if (!channel) {
    const existing = getTop10Channel(interaction.channelId);
    if (!existing) {
      await interaction.editReply(
        'This channel does not have a top-10 board. Pass a `channel` to set one up.'
      );
      return;
    }
    removeTop10Channel(interaction.channelId);
    await interaction.editReply(
      '✅ Stopped updating the top-10 board here. The existing message was left in place — delete it manually if you want it gone.'
    );
    return;
  }

  addTop10Channel({ channelId: channel.id, guildId: interaction.guildId });

  // Post the first board immediately so there's something to see right away,
  // rather than waiting for the next poll tick.
  try {
    const embed = await buildTop10Embed();
    const sent = await channel.send({ embeds: [embed] });
    setTop10MessageId(channel.id, sent.id);
    await interaction.editReply(
      `✅ ${channel} will now show a top-10 leagues board, updating itself in place every poll.`
    );
  } catch (err) {
    // Registration already succeeded, so the next poll will retry — the most
    // likely cause is missing Send Messages / Embed Links in that channel.
    await interaction.editReply(
      `⚠️ Registered ${channel}, but couldn't post the first board: ${err.message}\n` +
        `Check that I have **Send Messages** and **Embed Links** there. It will retry on the next update.`
    );
  }
}
