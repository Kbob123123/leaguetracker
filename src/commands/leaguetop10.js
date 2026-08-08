import { SlashCommandBuilder } from 'discord.js';
import { buildTop10Embed } from '../lib/top10.js';

export const data = new SlashCommandBuilder()
  .setName('leaguetop10')
  .setDescription('Show the current top 10 leagues by points, with hourly rates.');

export async function execute(interaction) {
  await interaction.deferReply();
  const embed = await buildTop10Embed();
  await interaction.editReply({ embeds: [embed] });
}
