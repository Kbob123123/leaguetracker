import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { getDailyHistory, findDailyLeagueByName } from '../lib/db.js';
import { getLeagueDetail } from '../lib/ps99Api.js';
import { renderHistoryChart } from '../lib/graph.js';
import { formatPoints, formatRate } from '../lib/rates.js';

export const data = new SlashCommandBuilder()
  .setName('leaguehistory')
  .setDescription("Long-term points history for a league, as a daily chart.")
  .addStringOption((opt) =>
    opt.setName('league').setDescription('League name (exact, case-insensitive)').setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('days')
      .setDescription('How far back to chart (default 30)')
      .addChoices(
        { name: '7 days', value: 7 },
        { name: '30 days', value: 30 },
        { name: '90 days', value: 90 },
        { name: '180 days', value: 180 }
      )
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString('league', true).trim();
  const days = interaction.options.getInteger('days') ?? 30;

  // Resolve by stored name first — that costs no API call and works even if
  // the league has since dropped out of the top 1,000. Fall back to a live
  // lookup so a correctly-spelled league that simply has no history yet gets
  // an accurate message rather than "not found".
  let leagueId = null;
  let leagueName = query;

  const stored = findDailyLeagueByName(query);
  if (stored) {
    leagueId = stored.league_id;
    leagueName = stored.league_name;
  } else {
    const live = await getLeagueDetail(query).catch(() => null);
    if (!live) {
      await interaction.editReply(`❌ No league named **${query}** found.`);
      return;
    }
    leagueId = live.ID;
    leagueName = live.Name;
  }

  const rows = getDailyHistory(leagueId, days);

  if (rows.length < 2) {
    await interaction.editReply(
      `📊 **${leagueName}** doesn't have enough history yet — ${rows.length === 0 ? 'nothing has' : 'only one day has'} been recorded so far.\n\n` +
        '_History builds up one point per day. A chart needs at least two days, ' +
        'so check back tomorrow._'
    );
    return;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const gained = Number(last.points) - Number(first.points);
  const spanDays = Math.max(1, rows.length - 1);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${leagueName} — ${rows.length} days of history`)
    .setColor(0x3987e5)
    .setDescription(
      [
        `**Now:** ${formatPoints(Number(last.points))} pts`,
        `**${spanDays} day${spanDays === 1 ? '' : 's'} ago:** ${formatPoints(Number(first.points))} pts`,
        `**Gained:** ${formatPoints(gained)} (${formatRate(Math.round(gained / spanDays / 24))} average)`,
      ].join('\n')
    )
    .setTimestamp()
    .setFooter({ text: 'One reading per day · recorded hourly, kept for 180 days' });

  const files = [];
  const chart = await renderHistoryChart(leagueName, rows).catch((err) => {
    console.warn('[leaguehistory] Chart render failed:', err.message);
    return null;
  });

  if (chart) {
    files.push(new AttachmentBuilder(chart, { name: 'history.png' }));
    embed.setImage('attachment://history.png');
  }

  await interaction.editReply({ embeds: [embed], files });
}
