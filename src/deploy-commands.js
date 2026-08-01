import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsDir = path.join(__dirname, 'commands');

const commands = [];
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
  if (mod.data) commands.push(mod.data.toJSON());
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

try {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (guildId) {
    console.log(`Registering ${commands.length} commands to guild ${guildId} (instant)...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    console.log(`Registering ${commands.length} commands globally (may take up to 1 hour to propagate)...`);
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
  }

  console.log('Done.');
} catch (err) {
  console.error('Failed to register commands:', err);
  process.exit(1);
}
