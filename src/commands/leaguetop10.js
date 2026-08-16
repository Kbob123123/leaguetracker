import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { addTop10Channel, removeTop10Channel, getTop10Channel, setTop10MessageId } from '../lib/db.js';
import { buildTop10Embed } from '../lib/top10.js';

// Previously two commands: /leaguetop10 showed the board once, /setleaguetop10
// installed a self-updating copy. They render the identical embed, so the only
// real difference is where it lands and whether it keeps refreshing — which is
// an argument, not a second command.
//
// No permission gate on the command itself: showing the board is harmless and
// should stay open to everyone. Installing or removing a self-updating board
// checks ManageGuild at runtime instead, since that's the part that writes.
export const data = new SlashCommandBuilder()
  .setName('leaguetop10')
  .setDescription('Show the top 10 leagues by points — once, or as a self-updating board in a channel.')
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Install a self-updating board here instead of replying once (needs Manage Server)')
      .addChannelTypes(ChannelType.GuildText)
  )
  .addBooleanOption((opt) =>
    opt
      .setName('stop')
      .setDescription('Stop updating the board in that channel (or this one) instead of installing it')
  );

export async function execute(interaction) {
  const channel = interaction.options.getChannel('channel');
  const stop = interaction.options.getBoolean('stop') ?? false;

  // Plain lookup: no channel, no stop. Public reply, same as it always was.
  if (!channel && !stop) {
    await interaction.deferReply();
    const embed = await buildTop10Embed();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply(
      '❌ Setting up or removing a self-updating board needs the **Manage Server** permission. ' +
        'Run `/leaguetop10` with no options to just see the current board.'
    );
    return;
  }

  if (stop) {
    const targetId = channel?.id ?? interaction.channelId;
    const existing = getTop10Channel(targetId);
    if (!existing) {
      await interaction.editReply(`<#${targetId}> does not have a self-updating top-10 board.`);
      return;
    }
    removeTop10Channel(targetId);
    await interaction.editReply(
      `✅ Stopped updating the top-10 board in <#${targetId}>. The existing message was left in place — ` +
        'delete it manually if you want it gone.'
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
      `✅ ${channel} will now show a top-10 leagues board, updating itself in place every poll. ` +
        `Run \`/leaguetop10 stop:true channel:${channel.name}\` to stop.`
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
