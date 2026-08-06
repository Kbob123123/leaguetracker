import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors } from '../lib/ps99Api.js';
import { addTrackedChannel, getTrackedChannel, addSnapshot } from '../lib/db.js';
import { buildMemberPointsList, pollOneChannel } from '../lib/poller.js';
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

  // Post the real, live tracked embed IMMEDIATELY rather than waiting for the
  // next 10-minute poll tick to pick this channel up — this reuses the exact
  // same code path the recurring poller uses, so the very first message is
  // identical in shape/behavior to every update after it.
  const trackedRow = getTrackedChannel(targetChannel.id);
  try {
    await pollOneChannel(interaction.client, trackedRow);
    await interaction.editReply(
      `✅ Now tracking **${league.Name}** in <#${targetChannel.id}> — the live update just posted there.`
    );
  } catch (err) {
    console.error(`[startmonitoringleague] Immediate first update failed for ${targetChannel.id}:`, err);
    await interaction.editReply(
      `✅ Now tracking **${league.Name}** in <#${targetChannel.id}>, but the first live update failed to post ` +
        `immediately (it'll post on the next 10-minute cycle instead). Error: ${err.message}`
    );
  }
}
