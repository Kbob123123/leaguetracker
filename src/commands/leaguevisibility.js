import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLeaguesPage, getLeagueDetail, getPlayerVisibility } from '../lib/ps99Api.js';
import { resolveNames, formatName } from '../lib/robloxNames.js';
import { capToFieldLimit, DESCRIPTION_LIMIT } from '../lib/embed.js';

// The league counterpart to the clan bot's /checkvisibility, scanning across
// the top leagues instead of one group.
//
// Every player costs one API call and leagues hold four members, so "top 100
// leagues" is 400 sequential requests. The default is deliberately smaller,
// and the reply is edited as it goes so a long scan doesn't look frozen.
const REQUEST_DELAY_MS = 120;
const PROGRESS_EVERY = 40;

export const data = new SlashCommandBuilder()
  .setName('leaguevisibility')
  .setDescription('Scan the top leagues for members with a public PS99 profile.')
  .addIntegerOption((opt) =>
    opt
      .setName('leagues')
      .setDescription('How many top leagues to scan (default 25, max 100)')
      .setMinValue(1)
      .setMaxValue(100)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const leagueCount = interaction.options.getInteger('leagues') ?? 25;

  const page = await getLeaguesPage(1, 100).catch(() => null);
  if (!page?.leagues?.length) {
    await interaction.editReply('❌ Could not fetch the league leaderboard just now. Try again shortly.');
    return;
  }

  const targets = page.leagues.slice(0, leagueCount);

  // Gather members first — cheap relative to the per-player visibility calls,
  // and it lets us show an accurate total before the slow part starts.
  const members = [];
  for (const league of targets) {
    const detail = await getLeagueDetail(league.Name).catch(() => null);
    if (!detail) continue;
    for (const c of detail.PointContributions || []) {
      members.push({ userId: String(c.UserID), displayName: c.DisplayName, leagueName: detail.Name });
    }
  }

  if (members.length === 0) {
    await interaction.editReply('❌ No league members found to scan.');
    return;
  }

  await interaction.editReply(
    `🔍 Scanning **${members.length}** members across the top **${targets.length}** leagues…\n` +
      '_This takes a while — one lookup per player. I\'ll update this message as I go._'
  );

  const resolved = await resolveNames(members);

  const publicPlayers = [];
  let checked = 0;
  let unknown = 0;

  for (const member of resolved) {
    // Look up by numeric ID rather than username: it is the value the league
    // data actually gives us, and it cannot be stale the way a cached name can.
    const result = await getPlayerVisibility(member.userId);
    checked += 1;

    if (result.public === true) {
      const open = Object.entries(result.publicViews ?? {})
        .filter(([, on]) => on)
        .map(([k]) => k);
      publicPlayers.push({ ...member, open, username: result.username ?? member.username });
    } else if (result.public === null) {
      // Neither public nor confirmed private — an outage or rate limit. Counted
      // separately so the summary never presents an error as an all-clear.
      unknown += 1;
    }

    if (checked % PROGRESS_EVERY === 0) {
      await interaction
        .editReply(
          `🔍 Scanned **${checked}/${resolved.length}** members… ` +
            `found **${publicPlayers.length}** public so far.`
        )
        .catch(() => {});
    }

    await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
  }

  const embed = new EmbedBuilder()
    .setTitle('Public profiles in the top leagues')
    .setColor(publicPlayers.length > 0 ? 0xc98500 : 0x57f287)
    .setTimestamp();

  // The three counts as fields. This was prose plus a list, so the numbers a
  // reader wants first had nowhere fixed to sit. Unknowns get their own field
  // rather than being folded into "private" — an outage is not an all-clear.
  embed.addFields(
    { name: '👁️ Public', value: `**${publicPlayers.length}**`, inline: true },
    { name: '🔎 Scanned', value: `**${checked}**`, inline: true },
    { name: '⚠️ Unchecked', value: unknown > 0 ? `**${unknown}**` : '—', inline: true }
  );

  if (publicPlayers.length === 0) {
    embed.setDescription(
      `Scanned **${checked}** members across the top **${targets.length}** leagues.\n\n` +
        '✅ **Nobody has a public profile.**' +
        (unknown > 0 ? `\n\n⚠️ ${unknown} lookup(s) failed, so those are unknown rather than private.` : '')
    );
  } else {
    const lines = publicPlayers.map(
      (p) =>
        `• **${formatName(p, { withDisplayName: false })}** — ${p.leagueName}\n` +
        `└ 👁️ ${p.open.length ? p.open.join(', ') : 'public, nothing specific exposed'}`
    );

    embed.setDescription(
      `Scanned **${checked}** members across the top **${targets.length}** leagues.\n` +
        `**${publicPlayers.length}** have a public profile:\n\n` +
        capToFieldLimit(lines, '_None._', DESCRIPTION_LIMIT - 200)
    );

    if (unknown > 0) {
      embed.addFields({
        name: '⚠️ Incomplete',
        value: `${unknown} lookup(s) failed. Those players are unknown, not confirmed private.`,
      });
    }
  }

  embed.setFooter({
    text: 'A "not public" result can also mean the API simply has no record of that player.',
  });

  await interaction.editReply({ content: '', embeds: [embed] });
}
