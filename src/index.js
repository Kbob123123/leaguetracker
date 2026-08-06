import 'dotenv/config';

// node:sqlite is experimental on Node < 26 and prints a one-line warning on
// startup. It's fully functional for our use here; this just keeps logs clean.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning);
});

import { Client, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pollAllTrackedChannels } from './lib/poller.js';
import { rebuildPlayerRankings } from './lib/rankingsJob.js';

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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[interaction] Error running /${interaction.commandName}:`, err);
    const errorMessage = { content: '❌ Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorMessage).catch(() => {});
    } else {
      await interaction.reply(errorMessage).catch(() => {});
    }
  }
});

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

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}.`);
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

client.login(process.env.DISCORD_TOKEN);
