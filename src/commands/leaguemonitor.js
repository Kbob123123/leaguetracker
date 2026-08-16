import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { getLeagueDetail, findLeagueNeighbors } from '../lib/ps99Api.js';
import {
  addTrackedChannel,
  getTrackedChannel,
  getAllTrackedChannels,
  removeTrackedChannel,
  addSnapshot,
} from '../lib/db.js';
import { buildMemberPointsList, pollOneChannel } from '../lib/poller.js';
import { capToFieldLimit, DESCRIPTION_LIMIT } from '../lib/embed.js';
import { resolveNames } from '../lib/robloxNames.js';

// One command for everything that gets watched over time, mirroring the clan
// bot's /monitor. Replaces /startmonitoringleague, /stopmonitoringleague and
// /listmonitoredleagues — three picker entries for one concept with a target
// and a direction.
//
// Named /leaguemonitor rather than plain /monitor for the same reason
// /leagueplayer isn't /playerinfo: Discord scopes command names per
// application, so if this bot and the clan bot both registered /monitor, a
// server running both would show two identical entries in the picker
// separated only by a small avatar.
//
// The clan bot's version also has a `player` subcommand; leagues have no
// per-player monitoring, so this one is league and list only.
//
// ManageGuild covers the whole command, including `list`. The list used to be
// open to everyone; folding it in trades that for one coherent permission,
// which is the right way round given the other two change server state.
export const data = new SlashCommandBuilder()
  .setName('leaguemonitor')
  .setDescription('Start, stop, or review live monitoring of leagues.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('league')
      .setDescription('Start or stop tracking a league in a channel, updated every 10 minutes.')
      .addStringOption((opt) =>
        opt.setName('name').setDescription('Exact league name (case-insensitive)').setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName('action')
          .setDescription('Begin tracking, or stop it')
          .setRequired(true)
          .addChoices({ name: 'start', value: 'start' }, { name: 'stop', value: 'stop' })
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to post updates in (defaults to this channel)')
          .addChannelTypes(ChannelType.GuildText)
      )
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show every league being monitored in this server.')
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') return listMonitored(interaction);

  const action = interaction.options.getString('action', true);
  return action === 'start' ? startLeague(interaction) : stopLeague(interaction);
}

async function startLeague(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const leagueName = interaction.options.getString('name', true);
  const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

  const existing = getTrackedChannel(targetChannel.id);
  if (existing) {
    await interaction.editReply(
      `⚠️ <#${targetChannel.id}> is already tracking **${existing.league_name}**. ` +
        `Run \`/leaguemonitor league name:${existing.league_name} action:stop\` there first if you want to switch leagues.`
    );
    return;
  }

  const league = await getLeagueDetail(leagueName);
  if (!league) {
    await interaction.editReply(`❌ Couldn't find a league named **${leagueName}**. Check the spelling and try again.`);
    return;
  }

  const neighbors = await findLeagueNeighbors(league);
  const members = await resolveNames(buildMemberPointsList(league));

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
    console.error(`[monitor league] Immediate first update failed for ${targetChannel.id}:`, err);
    await interaction.editReply(
      `✅ Now tracking **${league.Name}** in <#${targetChannel.id}>, but the first live update failed to post ` +
        `immediately (it'll post on the next 10-minute cycle instead). Error: ${err.message}`
    );
  }
}

async function stopLeague(interaction) {
  const leagueName = interaction.options.getString('name', true);
  const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

  const existing = getTrackedChannel(targetChannel.id);
  if (!existing) {
    await interaction.reply({
      content: `<#${targetChannel.id}> isn't currently tracking any league.`,
      ephemeral: true,
    });
    return;
  }

  // `name` is required by the subcommand shape, so use it as a confirmation
  // rather than ignoring it — stopping the wrong channel's tracking clears its
  // history, and that isn't recoverable.
  if (existing.league_name.toLowerCase() !== leagueName.trim().toLowerCase()) {
    await interaction.reply({
      content:
        `⚠️ <#${targetChannel.id}> is tracking **${existing.league_name}**, not **${leagueName}**. ` +
        `Re-run with \`name:${existing.league_name}\` if that's the one you meant to stop.`,
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

async function listMonitored(interaction) {
  const tracked = getAllTrackedChannels().filter((t) => t.guild_id === interaction.guildId);

  if (tracked.length === 0) {
    await interaction.reply({
      content: 'No leagues are being monitored in this server yet. Start with `/leaguemonitor league action:start`.',
      ephemeral: true,
    });
    return;
  }

  // Capped by CHARACTERS, not by entry count — a server can track arbitrarily
  // many channels, and capping by count is what has overflowed before.
  const lines = tracked.map((t) => `• **${t.league_name}** — <#${t.channel_id}>`);

  const embed = new EmbedBuilder()
    .setTitle(`👁️ Monitored leagues (${tracked.length})`)
    .setColor(0x3987e5)
    .setDescription(capToFieldLimit(lines, '_None._', DESCRIPTION_LIMIT))
    .setFooter({ text: 'Stop any of these with /leaguemonitor league action:stop.' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
