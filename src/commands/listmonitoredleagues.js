import { SlashCommandBuilder } from 'discord.js';
import { getAllTrackedChannels } from '../lib/db.js';

export const data = new SlashCommandBuilder()
  .setName('listmonitoredleagues')
  .setDescription('List all leagues currently being tracked in this server.');

export async function execute(interaction) {
  const tracked = getAllTrackedChannels().filter((t) => t.guild_id === interaction.guildId);

  if (tracked.length === 0) {
    await interaction.reply({ content: 'No leagues are currently being tracked in this server.', ephemeral: true });
    return;
  }

  const lines = tracked.map((t) => `• **${t.league_name}** — <#${t.channel_id}>`);
  await interaction.reply({
    content: `**Tracked leagues:**\n${lines.join('\n')}`,
    ephemeral: true,
  });
}
