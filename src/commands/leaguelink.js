import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveUsernameToId } from '../lib/robloxNames.js';
import {
  setPlayerLink,
  getLinksByDiscordId,
  countLinksByDiscordId,
  getLinkByRobloxId,
  removePlayerLink,
  removeAllPlayerLinks,
} from '../lib/db.js';

/**
 * How many Roblox accounts one Discord user may link.
 *
 * A cap exists because nothing stops someone claiming hundreds of accounts
 * they do not own — linking verifies that an account EXISTS, never that it
 * belongs to the caller. Ten covers a real player with alts comfortably
 * while keeping that abuse bounded.
 */
const MAX_LINKS_PER_USER = 10;

// Links a Roblox account to a Discord account so the bot has somebody to DM
// when a monitored league member stops scoring. League contributions identify
// people only by numeric Roblox UserID, so without a link there is no Discord
// user to reach.
export const data = new SlashCommandBuilder()
  .setName('leaguelink')
  .setDescription('Link your Roblox accounts so the bot can DM you if you stop scoring.')
  .addStringOption((opt) =>
    opt.setName('roblox').setDescription('Your exact Roblox username. Omit to list your linked accounts.')
  )
  .addBooleanOption((opt) =>
    opt.setName('unlink').setDescription('Remove a link. With roblox: removes that one, alone removes all.')
  );

export async function execute(interaction) {
  // Ephemeral throughout: a link is a small piece of identity information and
  // there is no reason to broadcast it to the channel.
  await interaction.deferReply({ ephemeral: true });

  const robloxName = interaction.options.getString('roblox')?.trim();
  const unlink = interaction.options.getBoolean('unlink') ?? false;
  const discordUserId = interaction.user.id;

  if (unlink) {
    // With a username: remove just that account. Without one: remove them all.
    // The distinction matters now that people hold several — "unlink" used to
    // be unambiguous and no longer is.
    if (robloxName) {
      const mine = getLinksByDiscordId(discordUserId);
      const match = mine.find(
        (l) => l.roblox_username.toLowerCase() === robloxName.toLowerCase()
      );

      if (!match) {
        await interaction.editReply(
          `❌ **${robloxName}** is not one of your linked accounts.\n` +
            (mine.length > 0
              ? `_You have: ${mine.map((l) => l.roblox_username).join(', ')}_`
              : '_You have no linked accounts._')
        );
        return;
      }

      removePlayerLink({ robloxUserId: match.roblox_user_id });
      await interaction.editReply(
        `✅ Unlinked **${match.roblox_username}**. ` +
          `You still have **${countLinksByDiscordId(discordUserId)}** account(s) linked.`
      );
      return;
    }

    const removed = removeAllPlayerLinks(discordUserId);
    await interaction.editReply(
      removed > 0
        ? `✅ Unlinked **${removed}** account(s). You will no longer get idle DMs about a league.`
        : "You don't have any linked Roblox accounts, so there was nothing to remove."
    );
    return;
  }

  // No username given — report the current state rather than guessing.
  if (!robloxName) {
    const mine = getLinksByDiscordId(discordUserId);
    if (mine.length === 0) {
      await interaction.editReply(
        'You have no linked Roblox accounts.\n' +
          'Link one with `/leaguelink roblox:<your username>` — it has to be your exact username, not your display name.\n' +
          `_You can link up to **${MAX_LINKS_PER_USER}** accounts._`
      );
      return;
    }

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🔗 Your linked accounts (${mine.length}/${MAX_LINKS_PER_USER})`)
          .setColor(0x2ee6c5)
          .setDescription(
            mine
              .map(
                (l, i) =>
                  `\`${i + 1}.\` **${l.roblox_username}** — \`${l.roblox_user_id}\`\n` +
                  `└ linked <t:${l.linked_at}:R>`
              )
              .join('\n')
          )
          .setFooter({
            text: 'Add another with roblox:<username>. Remove one with roblox:<username> unlink:true, or all with unlink:true alone.',
          }),
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

  // Re-linking an account you already hold is a no-op, not a new slot — so
  // the cap is only checked when this would actually add one. Without that,
  // running the command twice on the same alt would eventually lock you out.
  const alreadyMine = takenBySomeoneElse?.discord_user_id === discordUserId;
  if (!alreadyMine && countLinksByDiscordId(discordUserId) >= MAX_LINKS_PER_USER) {
    await interaction.editReply(
      `❌ You already have **${MAX_LINKS_PER_USER}** accounts linked, which is the limit.\n` +
        'Remove one first with `/leaguelink roblox:<username> unlink:true`.'
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

  const total = countLinksByDiscordId(discordUserId);

  await interaction.editReply(
    `✅ Linked **${account.username}**` +
      (account.displayName && account.displayName !== account.username ? ` (${account.displayName})` : '') +
      `.\n\nYou now have **${total}** account(s) linked` +
      (total < MAX_LINKS_PER_USER ? ` — you can add ${MAX_LINKS_PER_USER - total} more.` : ' (the limit).') +
      "\n\nIf any of them is in a league this server monitors and stops scoring, I'll DM you. " +
      "Make sure your DMs are open to server members, or the reminder can't reach you. " +
      'Remove one with `roblox:<username> unlink:true`, or all with `unlink:true`.'
  );
}
