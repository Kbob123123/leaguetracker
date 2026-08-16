import { getLinksForRobloxIds, getIdleState, upsertIdleState } from './db.js';
import { formatName } from './robloxNames.js';
import { formatPoints } from './rates.js';

// How many consecutive nudges one person gets before the bot goes quiet about
// them. 0 means no limit, which is the default: the owner wants to be pinged
// until they get back in, and a ceiling defeats that.
//
// Worth knowing if this is ever revisited: it applies to EVERY linked member,
// not just the person who set it up. An unlimited stream of DMs to someone
// else's account is how a bot gets blocked or reported, so IDLE_MAX_DMS is
// kept as an escape hatch — set it to 6 and the old behaviour comes back.
const MAX_CONSECUTIVE_DMS = Number(process.env.IDLE_MAX_DMS ?? 0);
const CAP_ENABLED = MAX_CONSECUTIVE_DMS > 0;

/**
 * Compare this poll's member points against the last one and DM anyone linked
 * who hasn't moved.
 *
 * Deliberately tolerant: a member with no Discord link is tracked but never
 * messaged, and a failed DM (closed DMs, blocked bot) is counted as sent so a
 * permanently unreachable person doesn't get retried forever.
 *
 * @param {import('discord.js').Client} client
 * @param {object} params
 * @param {string} params.channelId    Channel the league is tracked in
 * @param {string} params.leagueName
 * @param {Array}  params.members      [{userId, username, displayName, points}]
 */
export async function checkIdleMembers(client, { channelId, leagueName, members }) {
  if (members.length === 0) return { dmsSent: 0, idle: 0 };

  const links = getLinksForRobloxIds(members.map((m) => String(m.userId)));
  const now = Math.floor(Date.now() / 1000);

  let dmsSent = 0;

  // Collected rather than just counted, so the tracked embed can show WHO is
  // idle. The embed builds after this runs, which is what makes the list
  // current rather than a poll behind.
  const idleMembers = [];

  for (const member of members) {
    const userId = String(member.userId);
    const points = Number(member.points) || 0;
    const previous = getIdleState(channelId, userId);

    // First sighting — record a baseline and say nothing. Without this every
    // member would look "idle" on the very first poll after tracking starts.
    if (!previous) {
      upsertIdleState({ channelId, userId, lastPoints: points, idleSince: null, dmsSent: 0 });
      continue;
    }

    const gained = points - previous.last_points;

    if (gained > 0) {
      // Moving again: clear the streak so the next stall starts from zero.
      upsertIdleState({ channelId, userId, lastPoints: points, idleSince: null, dmsSent: 0 });
      continue;
    }

    const idleSince = previous.idle_since ?? now;
    const alreadySent = previous.dms_sent ?? 0;
    const link = links.get(userId);

    idleMembers.push({
      userId,
      username: member.username,
      displayName: member.displayName,
      points,
      idleSince,
      linked: Boolean(link),
    });

    // No link, or a cap is set and reached — keep tracking, stay quiet.
    if (!link || (CAP_ENABLED && alreadySent >= MAX_CONSECUTIVE_DMS)) {
      upsertIdleState({
        channelId,
        userId,
        lastPoints: points,
        idleSince,
        dmsSent: alreadySent,
        lastDmAt: previous.last_dm_at,
      });
      continue;
    }

    const attempt = alreadySent + 1;
    const remaining = MAX_CONSECUTIVE_DMS - attempt;
    const who = formatName(member, { withDisplayName: false });

    const tail = !CAP_ENABLED
      ? `_Reminder #${attempt} — I'll keep going every 10 minutes until you score again._`
      : remaining > 0
        ? `_Reminder ${attempt} of ${MAX_CONSECUTIVE_DMS}. I'll stop after that until you score again._`
        : "_That's my last reminder until you score again._";

    const message =
      `⏰ **${who}** — you haven't gained any league points for **${leagueName}** ` +
      `since <t:${idleSince}:R>.\n` +
      `You're sitting on **${formatPoints(points)}** points. Time to get back in there!\n\n` +
      tail +
      '\n_Turn these off any time with `/leaguelink unlink:true`._';

    let delivered = true;
    try {
      const user = await client.users.fetch(link.discord_user_id);
      await user.send(message);
      dmsSent += 1;
    } catch (err) {
      // Closed DMs are the common case and not worth a stack trace every poll.
      delivered = false;
      console.warn(`[idle] Could not DM ${link.discord_user_id} (${who}): ${err.message}`);
    }

    // Counted whether or not it landed: retrying an unreachable user every
    // poll forever would just be noise in the logs.
    upsertIdleState({
      channelId,
      userId,
      lastPoints: points,
      idleSince,
      dmsSent: attempt,
      lastDmAt: delivered ? now : previous.last_dm_at,
    });
  }

  // Longest-idle first: the person who stopped earliest is the one worth
  // chasing, and a list ordered by who is most stuck reads better than one
  // ordered by whatever the API happened to return.
  idleMembers.sort((a, b) => a.idleSince - b.idleSince);

  return { dmsSent, idle: idleMembers.length, idleMembers };
}
