import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.join(__dirname, 'commands');

const commands = [];
let hadFailures = false;
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  try {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    if (mod.data) commands.push(mod.data.toJSON());
  } catch (err) {
    // SlashCommandBuilder validates at call time (e.g. Discord's 100-char
    // description limit), which fires during module import for our
    // `export const data = new SlashCommandBuilder()...` pattern. Report
    // clearly which file and why, instead of a bare stack trace with no
    // indication of which command is actually broken.
    hadFailures = true;
    console.error(`FAILED to build command from ${file}:`, err.message);
  }
}

if (hadFailures) {
  console.error(`\n${commands.length} command(s) loaded successfully; the rest failed and were skipped (see above).`);
  console.error('Fix the failing command file(s) and re-run before deploying, so Discord has the full, correct set.\n');
  process.exit(1);
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

try {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  // Global registration, always — this bot serves servers beyond the owner's,
  // and access is controlled by the /ownermenu whitelist at runtime rather
  // than by which guilds the commands happen to be registered in.
  //
  // An earlier version registered to DISCORD_GUILD_ID and wiped the global
  // set, which removed the commands from every other server. Guild scope is
  // still supported for fast iteration, but it now ADDS a guild copy on top
  // of the global set rather than replacing it.
  console.log(`Registering ${commands.length} commands globally (may take up to 1 hour to propagate)...`);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });

  if (guildId) {
    // A guild copy appears instantly, so the owner's own server does not have
    // to wait an hour. Discord shows both sets, so this is duplicated on
    // purpose and only in the one guild.
    console.log(`Also registering to guild ${guildId} for instant availability...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  }

  console.log('Done.');
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}
