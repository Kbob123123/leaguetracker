import 'dotenv/config';

// node:sqlite is experimental on Node < 26 and prints a one-line warning on
// startup. It's fully functional for our use here; this just keeps logs clean.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning);
});

import { Client, GatewayIntentBits, Collection, Events, ActivityType } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pollAllTrackedChannels } from './lib/poller.js';
import { rebuildPlayerRankings } from './lib/rankingsJob.js';
import { updateAllTop10Channels } from './lib/top10.js';
import { checkAccess, describeInvocation } from './lib/owner.js';
import { logCommand, isGuildWhitelisted } from './lib/db.js';
import { postCommandLog, postLeaveNotice, postGuildJoinLog } from './lib/commandLog.js';
import { announceUpdates } from './lib/botUpdates.js';
import {
  COMPONENT_PREFIX as OWNERMENU_PREFIX,
  handleComponent as handleOwnerMenuComponent,
} from './commands/ownermenu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();

const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  try {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    if (mod.data && mod.execute) {
      client.commands.set(mod.data.name, mod);
    } else {
      console.warn(`[commands] Skipping ${file}: missing data/execute export.`);
    }
  } catch (err) {
    // A command file can throw at IMPORT time, not just at runtime — e.g.
    // SlashCommandBuilder validates description length (Discord's 100-char
    // limit) the instant .setDescription() is called, which happens at
    // module-evaluation time for our top-level `export const data = ...`
    // pattern. Without this try/catch, one oversized description crashes
    // the entire bot process on every single startup (this happened once —
    // see git history). Skip the broken command and keep the rest running.
    console.error(`[commands] FAILED to load ${file} — this command will be unavailable:`, err.message);
  }
}

if (client.commands.size === 0) {
  console.error('[commands] No commands loaded successfully — check the errors above.');
}

/**
 * Refuse to stay in a server that isn't approved.
 *
 * Gating commands is not enough on its own: anyone with the invite link can
 * add the bot anywhere, and it would then sit there indefinitely, appear in
 * the member list, and show its commands in the picker. Leaving immediately is
 * what makes the whitelist mean "where this bot runs" rather than just "where
 * its commands succeed".
 */
async function enforceGuildWhitelist(guild, { onStartup = false } = {}) {
  if (isGuildWhitelisted(guild.id)) return false;

  const how = onStartup ? 'Found' : 'Added to';
  console.warn('[whitelist] ' + how + ' unapproved server "' + guild.name + '" (' + guild.id + ') — leaving.');

  await postGuildJoinLog(client, guild, { approved: false, onStartup }).catch(() => {});

  await postLeaveNotice(guild, {
    reason:
      "🔒 **This bot is invite-only.** This server hasn't been approved, so it can't stay.",
  }).catch(() => {});

  await guild.leave().catch((err) => {
    console.error('[whitelist] Could not leave ' + guild.id + ':', err.message);
  });

  return true;
}

client.on('guildCreate', async (guild) => {
  try {
    const left = await enforceGuildWhitelist(guild);
    // Approved joins are logged too, so the owner gets an invite link for
    // every server the bot is in, not only the ones it turned away.
    if (!left) await postGuildJoinLog(client, guild, { approved: true });
  } catch (err) {
    console.error('[whitelist] guildCreate handling failed:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  // Buttons and modals from the owner menu. Routed by custom_id prefix so the
  // menu owns its own component logic instead of this file growing a switch.
  if (interaction.isButton() || interaction.isModalSubmit()) {
    if (!interaction.customId?.startsWith(OWNERMENU_PREFIX)) return;
    try {
      await handleOwnerMenuComponent(interaction);
    } catch (err) {
      console.error('[ownermenu] Component failed:', err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  const logBase = {
    guildId: interaction.guildId,
    guildName: interaction.guild?.name ?? null,
    userId: interaction.user.id,
    username: interaction.user.username,
    command: interaction.commandName,
    options: describeInvocation(interaction),
    avatarUrl: interaction.user.displayAvatarURL(),
  };

  // Whitelist check before anything runs. Logged either way — a blocked
  // attempt is exactly the kind of thing the owner wants to see.
  const access = checkAccess({
    commandName: interaction.commandName,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });

  if (!access.allowed) {
    safeLog(client, { ...logBase, outcome: 'blocked' });
    await interaction.reply({ content: access.reason, ephemeral: true }).catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
    safeLog(client, { ...logBase, outcome: 'ok' });
  } catch (err) {
    console.error(`[interaction] Error running /${interaction.commandName}:`, err);
    safeLog(client, { ...logBase, outcome: `error: ${err.message}`.slice(0, 200) });
    const errorMessage = { content: '❌ Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorMessage).catch(() => {});
    } else {
      await interaction.reply(errorMessage).catch(() => {});
    }
  }
});

/** Logging must never be the reason a command fails. */
function safeLog(client, entry) {
  try {
    logCommand(entry);
  } catch (err) {
    console.warn('[log] Could not record command use:', err.message);
  }

  postCommandLog(client, entry).catch(() => {});
}

const POLL_INTERVAL_MS = (Number(process.env.POLL_INTERVAL_MINUTES) || 10) * 60 * 1000;
let pollInFlight = false;

async function runPollTick() {
  if (pollInFlight) {
    console.warn('[poller] Previous poll still running; skipping this tick.');
    return;
  }
  pollInFlight = true;
  try {
    await pollAllTrackedChannels(client);
  } catch (err) {
    console.error('[poller] Unexpected top-level error:', err);
  }
  try {
    // Separate try/catch: a failure updating leaderboard channels must not
    // stop tracked-channel polling from having run, and vice versa.
    await updateAllTop10Channels(client);
  } catch (err) {
    console.error('[top10] Unexpected top-level error:', err);
  } finally {
    pollInFlight = false;
  }
}

const RANKINGS_INTERVAL_MS = 60 * 60 * 1000; // fixed hourly cadence, independent of POLL_INTERVAL_MINUTES
let rankingsInFlight = false;

async function runRankingsTick() {
  if (rankingsInFlight) {
    console.warn('[rankings] Previous rebuild still running; skipping this tick.');
    return;
  }
  rankingsInFlight = true;
  try {
    await rebuildPlayerRankings();
  } catch (err) {
    console.error('[rankings] Unexpected top-level error:', err);
  } finally {
    rankingsInFlight = false;
  }
}

// Events.ClientReady, not the 'ready' string. discord.js renamed this to
// distinguish it from the gateway READY event; 'ready' still fires in v14 but
// logs a deprecation warning on every boot and stops firing entirely in v15.
client.once(Events.ClientReady, async () => {
  // Sweep servers joined while the bot was offline, or before the whitelist
  // existed. Without this the whitelist only ever applies to future invites
  // and everything already joined stays forever.
  let left = 0;
  for (const guild of [...client.guilds.cache.values()]) {
    try {
      if (await enforceGuildWhitelist(guild, { onStartup: true })) left += 1;
    } catch (err) {
      console.error('[whitelist] Startup sweep failed for ' + guild.id + ':', err.message);
    }
  }
  console.log('[whitelist] ' + client.guilds.cache.size + ' approved server(s) remain' + (left > 0 ? '; left ' + left + ' unapproved.' : '.'));

  console.log(`Logged in as ${client.user.tag}.`);

  // The activity line under the bot's name in the member list. Purely
  // cosmetic, so a failure is swallowed — presence is never worth a crash.
  try {
    client.user.setPresence({
      status: 'online',
      activities: [{ name: 'PS99 league battles', type: ActivityType.Watching }],
    });
  } catch (err) {
    console.warn('[presence] Could not set activity:', err.message);
  }

  // Announce any release that shipped since the last one we announced. Wrapped
  // because the changelog must never be the reason the bot fails to start —
  // same rule as logging, DMs and history everywhere else in this codebase.
  try {
    await announceUpdates(client);
  } catch (err) {
    console.error('[updates] Announcement pass failed:', err);
  }

  console.log(`Polling every ${POLL_INTERVAL_MS / 60000} minute(s).`);
  setInterval(runPollTick, POLL_INTERVAL_MS);
  // Run one tick shortly after startup too, so restarts don't wait a full interval.
  setTimeout(runPollTick, 15_000);

  console.log(`Rebuilding player rankings every ${RANKINGS_INTERVAL_MS / 3600000} hour(s).`);
  setInterval(runRankingsTick, RANKINGS_INTERVAL_MS);
  // Stagger the first rankings pass a bit after startup so it doesn't collide
  // with the first tracked-league poll tick above.
  setTimeout(runRankingsTick, 60_000);
});

// Check the token's shape before handing it to discord.js. Without this, a
// missing or malformed token surfaces as a DiscordjsError [TokenInvalid] stack
// trace, and because the restart policy retries, the logs fill with ten copies
// of it — which reads like a code fault when it's really a config one.
const token = process.env.DISCORD_TOKEN?.trim();

if (!token) {
  console.error(
    '[startup] DISCORD_TOKEN is not set.\n' +
      '  Railway: Variables tab -> add DISCORD_TOKEN.\n' +
      '  Locally: copy .env.example to .env and fill it in.'
  );
  process.exit(1);
}

// A bot token is three dot-separated segments. The most common mistakes are
// pasting the Application ID (digits only, no dots) or leaving quotes around
// the value, and both are caught here.
if (token.split('.').length !== 3) {
  console.error(
    '[startup] DISCORD_TOKEN does not look like a bot token.\n' +
      '  Expected three dot-separated parts.\n' +
      (/^\d+$/.test(token)
        ? '  That value is all digits — it looks like the Application ID, not the token.\n'
        : '') +
      (/^["']|["']$/.test(token) ? '  Remove the surrounding quotes.\n' : '') +
      '  Get a fresh one from the Developer Portal: your app -> Bot -> Reset Token.'
  );
  process.exit(1);
}

client.login(token).catch((err) => {
  if (err.code === 'TokenInvalid') {
    console.error(
      '[startup] Discord rejected this token.\n' +
        '  It is usually stale — resetting a token in the Developer Portal\n' +
        "  immediately invalidates the old one, so Railway's copy must be updated too."
    );
    process.exit(1);
  }
  throw err;
});
