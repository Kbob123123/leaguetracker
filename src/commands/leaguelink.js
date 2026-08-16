import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveUsernameToId } from '../lib/robloxNames.js';
import { setPlayerLink, getLinkByDiscordId, getLinkByRobloxId, removePlayerLink } from '../lib/db.js';

// Links a Roblox account to a Discord account so the bot has somebody to DM
// when a monitored league member stops scoring. League contributions identify
// people only by numeric Roblox UserID, so without a link there is no Discord
// user to reach.
export const data = new SlashCommandBuilder()
  .setName('leaguelink')
  .setDescription('Link your Roblox account so the bot can DM you if you stop scoring.')
  .addStringOption((opt) =>
    opt.setName('roblox').setDescription('Your exact Roblox username. Omit to see your current link.')
  )
  .addBooleanOption((opt) =>
    opt.setName('unlink').setDescription('Remove your link instead of creating one')
  );

export async function execute(interaction) {
  // Ephemeral throughout: a link is a small piece of identity information and
  // there is no reason to broadcast it to the channel.
  await interaction.deferReply({ ephemeral: true });

  const robloxName = interaction.options.getString('roblox')?.trim();
  const unlink = interaction.options.getBoolean('unlink') ?? false;
  const discordUserId = interaction.user.id;

  if (unlink) {
    const removed = removePlayerLink({ discordUserId });
    await interaction.editReply(
      removed
        ? '✅ Unlinked. You will no longer get idle DMs about a league.'
        : "You don't have a linked Roblox account, so there was nothing to remove."
    );
    return;
  }

  // No username given — report the current state rather than guessing.
  if (!robloxName) {
    const existing = getLinkByDiscordId(discordUserId);
    if (!existing) {
      await interaction.editReply(
        'You have no linked Roblox account.\n' +
          'Link one with `/leaguelink roblox:<your username>` — it has to be your exact username, not your display name.'
      );
      return;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔗 Your linked account')
          .setColor(0x3987e5)
          .setDescription(
            `**Roblox:** ${existing.roblox_username} (\`${existing.roblox_user_id}\`)\n` +
              `**Linked:** <t:${existing.linked_at}:R>`
          )
          .setFooter({ text: 'Change it by running /leaguelink again, or remove it with unlink:true.' }),
      ],
    });
    return;
  }

  let account;
  try {
    account = await resolveUsernameToId(robloxName);
  } catch (err) {
    // Roblox being unreachable is not the user's fault and not a "wrong name".
    await interaction.editReply(
      `⚠️ Couldn't reach Roblox to verify that username (${err.message}). Try again in a moment.`
    );
    return;
  }

  if (!account) {
    await interaction.editReply(
      `❌ Roblox has no account with the username **${robloxName}**.\n` +
        '_This must be the exact @username, not the display name — they are often different._'
    );
    return;
  }

  // Linking is deliberately exact and unverified: we confirm the account
  // EXISTS, not that it belongs to the caller. Anyone could claim anyone.
  // That is acceptable for "who should I DM about idle points" and would not
  // be for anything that granted permissions — worth remembering if this link
  // is ever reused for something with teeth.
  const takenBySomeoneElse = getLinkByRobloxId(account.userId);
  if (takenBySomeoneElse && takenBySomeoneElse.discord_user_id !== discordUserId) {
    await interaction.editReply(
      `❌ **${account.username}** is already linked to <@${takenBySomeoneElse.discord_user_id}>.\n` +
        '_If that is wrong, an admin can reassign it with `/forceleaguelink`._'
    );
    return;
  }

  setPlayerLink({
    robloxUserId: account.userId,
    robloxUsername: account.username,
    discordUserId,
    guildId: interaction.guildId,
    linkedBy: discordUserId,
  });

  await interaction.editReply(
    `✅ Linked to **${account.username}**` +
      (account.displayName && account.displayName !== account.username ? ` (${account.displayName})` : '') +
      `.\n\nIf you're in a league this server monitors and you stop scoring, I'll DM you. ` +
      'Make sure your DMs are open to server members, or the reminder can\'t reach you. ' +
      'Turn it off any time with `/leaguelink unlink:true`.'
  );
}
