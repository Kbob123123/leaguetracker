import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { resolveUsernameToId } from '../lib/robloxNames.js';
import {
  setPlayerLink,
  getLinkByRobloxId,
  removePlayerLink,
  removeAllPlayerLinks,
  getLinksByDiscordId,
  countLinksByDiscordId,
  getAllPlayerLinks,
} from '../lib/db.js';
import { capToFieldLimit, DESCRIPTION_LIMIT } from '../lib/embed.js';

// The admin counterpart to /leaguelink: link somebody else, fix a link that
// was claimed by the wrong person, or see every link in one place.
export const data = new SlashCommandBuilder()
  .setName('forceleaguelink')
  .setDescription("Link, relink, or unlink another member's Roblox account.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addUserOption((opt) =>
    opt.setName('user').setDescription('The Discord member to link. Omit to list every link.')
  )
  .addStringOption((opt) =>
    opt.setName('roblox').setDescription('Their exact Roblox username')
  )
  .addBooleanOption((opt) =>
    opt.setName('unlink').setDescription("Remove a link. With roblox: removes that one, alone removes all.")
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser('user');
  const robloxName = interaction.options.getString('roblox')?.trim();
  const unlink = interaction.options.getBoolean('unlink') ?? false;

  // No user given — show every link. Handy for spotting a wrong one before
  // reassigning it, which is the main reason this command exists.
  if (!target) {
    const links = getAllPlayerLinks();
    if (links.length === 0) {
      await interaction.editReply('No accounts are linked in this server yet.');
      return;
    }

    const lines = links.map(
      (l) => `• **${l.roblox_username}** → <@${l.discord_user_id}> · linked <t:${l.linked_at}:R>`
    );

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🔗 Linked accounts (${links.length})`)
          .setColor(0x3987e5)
          .setDescription(capToFieldLimit(lines, '_None._', DESCRIPTION_LIMIT))
          .setFooter({ text: 'Reassign with /forceleaguelink user: roblox:, or remove with unlink:true.' })
          .setTimestamp(),
      ],
    });
    return;
  }

  if (unlink) {
    // Same rule as the self-service path: naming an account removes that one,
    // omitting it removes all of them. An admin wiping every alt by accident
    // is a worse outcome than one extra option.
    if (robloxName) {
      const theirs = getLinksByDiscordId(target.id);
      const match = theirs.find((l) => l.roblox_username.toLowerCase() === robloxName.toLowerCase());

      if (!match) {
        await interaction.editReply(
          `❌ **${robloxName}** is not linked to <@${target.id}>.\n` +
            (theirs.length > 0
              ? `_They have: ${theirs.map((l) => l.roblox_username).join(', ')}_`
              : '_They have no linked accounts._')
        );
        return;
      }

      removePlayerLink({ robloxUserId: match.roblox_user_id });
      await interaction.editReply(
        `✅ Unlinked **${match.roblox_username}** from <@${target.id}>. ` +
          `They have **${countLinksByDiscordId(target.id)}** left.`
      );
      return;
    }

    const removed = removeAllPlayerLinks(target.id);
    await interaction.editReply(
      removed > 0
        ? `✅ Unlinked all **${removed}** account(s) from <@${target.id}>.`
        : `<@${target.id}> had no linked Roblox accounts.`
    );
    return;
  }

  if (!robloxName) {
    // With no username and no unlink flag, show what they already have —
    // more useful than an error, and it is the question an admin usually has.
    const theirs = getLinksByDiscordId(target.id);
    await interaction.editReply(
      theirs.length === 0
        ? `<@${target.id}> has no linked accounts.\n_Add one with \`roblox:<username>\`._`
        : `<@${target.id}> has **${theirs.length}** linked:\n` +
            theirs.map((l) => `• **${l.roblox_username}** — \`${l.roblox_user_id}\``).join('\n')
    );
    return;
  }

  let account;
  try {
    account = await resolveUsernameToId(robloxName);
  } catch (err) {
    await interaction.editReply(
      `⚠️ Couldn't reach Roblox to verify that username (${err.message}). Try again in a moment.`
    );
    return;
  }

  if (!account) {
    await interaction.editReply(
      `❌ Roblox has no account with the username **${robloxName}**.\n` +
        '_Must be the exact @username, not the display name._'
    );
    return;
  }

  // Unlike /leaguelink, this deliberately does NOT refuse when the Roblox
  // account is already claimed — reassigning a wrong link is the whole point.
  // It does say what it displaced, so the change is never silent.
  const previous = getLinkByRobloxId(account.userId);

  setPlayerLink({
    robloxUserId: account.userId,
    robloxUsername: account.username,
    discordUserId: target.id,
    guildId: interaction.guildId,
    linkedBy: interaction.user.id,
  });

  const moved =
    previous && previous.discord_user_id !== target.id
      ? `\n_Reassigned from <@${previous.discord_user_id}>._`
      : '';

  await interaction.editReply(
    `✅ Linked **${account.username}** to <@${target.id}>.${moved}\n` +
      "_They'll get idle DMs if they stop scoring in a monitored league, provided their DMs are open._"
  );
}
