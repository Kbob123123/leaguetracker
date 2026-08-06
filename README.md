# PS99 League Tracker Discord Bot

Tracks a Pet Simulator 99 league in a Discord channel, posting an updating
embed every 10 minutes with:

- The league's rolling **hourly points rate**
- **Time to overtake** the league ranked directly above (or, if you're losing
  ground, the gap growing per hour)
- **Time until the league behind you overtakes you**
- Each of the 4 members' points and their individual hourly rate
- A line graph comparing all members' points over the last 24 hours

Data source: the official [PS99 public API](https://github.com/BIG-Games-LLC/ps99-public-api-docs)
(`/v1/leagues`) — no API key needed.

## How the hourly rate works

Rates are a **rolling trailing-hour** calculation, not a fixed clock hour.
If you start tracking at 7:00, the bot takes a snapshot immediately, then
every 10 minutes after. At 8:00 (once a full hour of snapshots exists), the
hourly rate is computed by diffing against the snapshot from ~60 minutes
earlier. From then on, every 10-minute update recomputes the rate the same
way, using whatever snapshot is closest to (now − 1h). Until that first hour
has passed, the bot shows "collecting data" instead of a rate.

## Commands

| Command | Description |
|---|---|
| `/startmonitoringleague league:<name> [channel:#channel]` | Start tracking a league. Defaults to the current channel. Requires "Manage Server" permission. |
| `/stopmonitoringleague [channel:#channel]` | Stop tracking and clear that channel's history. Requires "Manage Server" permission. |
| `/listmonitoredleagues` | List every league currently tracked in the server. |
| `/leagueinfo league:<name>` | One-off lookup — current rank, points, and members, no tracking started. |
| `/leaguesnapshot league:<name>` | Snapshot of any of the top 1,000 leagues (not just ones actively tracked), pulled from the last hourly scan. Shows points, rate, rank, contributions, and a graph — same style as the tracked embed, but a point-in-time snapshot rather than a live-updating message. |
| `/playerinfo name:<username or display name>` | Look up a player by username or display name. Checks, in order: leagues tracked in this server (live data), the top-1,000 league rankings (hourly snapshot), then falls back to a direct PS99 profile lookup by exact username for anyone else. |

You can track **multiple leagues at once**, one per channel — run
`/startmonitoringleague` in as many channels as you like. The first tracked
embed posts **immediately** when you run the command (it reuses the same
code path as the recurring 10-minute poller), not on a delay waiting for the
next scheduled poll tick.

Each tracked embed also shows, once an hour of history exists:
- 🎯 **Milestones** — ETA to reach top 250 / top 100 / top 50 / top 10 (auto-hides ranks already passed)
- 🏁 **Projected at Battle End** — an estimate of where your league would land if its current rate holds until the battle ends (Saturday 2am AEST, when battles reliably reset), including a rough placement bracket (e.g. "top 50") derived the same way as the milestone ETAs. This is explicitly a projection assuming steady rates, not a guarantee.
- ⏱️ **Next Update** — a live Discord relative-timestamp counting down to the
  next 10-minute refresh

Each member in the list also shows a small `#1234` tag next to their name if
they're currently in the top-1,000 league rankings (the same data source
`/playerinfo` uses) — this is their overall rank among tracked top-league
players, not their rank within the 4-person league. It only appears once the
hourly rankings job has scanned at least once and found that specific
player; members outside the top 1,000 leagues just won't have a tag, which is
expected rather than a bug.

### How targets stay live without any recalculation delay

The league ahead of you, the league behind you, and each milestone (top
100/50/10) always target **whoever currently holds that position** — read
fresh on every single poll, with no locking and no waiting period when the
leaderboard reshuffles. If a different league ends up at rank 100 between one
poll and the next, the ETA updates immediately to reflect the new gap.

### ETAs account for the target's own pace, not just yours

Every ETA is two-body when possible: it uses **both** your hourly rate and
the target's hourly rate, not just yours. This matters — a league sitting at
rank 10 is also earning points, often faster than a league further down the
board. Treating them as standing still would either understate how long
catching up actually takes, or — worse — show a finite ETA when you're
genuinely not gaining on them at all, because they're pulling away faster
than you're climbing. If the numbers say you're falling behind, the bot shows
the growing gap instead of a fake countdown.

This is powered by the same hourly rankings job that builds the global player
leaderboard (see below) — every top-1,000 league gets its own points reading
recorded once an hour, which is enough to compute a rate for them too, the
same way the bot computes yours.

Two honest limitations worth knowing:
- **Target rates need the rankings job to have run at least twice** (so, up
  to ~2 hours after the bot first starts) before two-body math is available.
  Until then — or for any target outside the top 1,000 leagues — the bot
  falls back to a one-sided estimate that treats the target as stationary,
  and labels it clearly as `(estimate — target rate unknown)` rather than
  presenting a guess as a precise number.
- This only ever affects the *ETA number*. Your own tracked league's hourly
  rate always needs its own one-time hour of warm-up per channel, same as
  before — that part hasn't changed.

### Milestone rates are averaged across nearby leagues, not just the one at that exact rank

For the "league directly ahead of you" target, the rate really is that one
specific league's own rate — you're racing that exact league, so its own
pace is the correct number to use.

Milestones (top 250/100/50/10) are different: they're not racing one
specific league, they're asking "how fast do I need to grow to *hold* this
rank tier." Using only the exact league sitting at, say, rank 100 right now
caused a real problem — any single league's hour-to-hour rate is noisy (one
quiet hour with members offline can make a league look like it's barely
moving), so if that happened to be the exact rank-100 league at poll time,
the bot would show a falsely fast ETA that didn't account for the dozens of
other leagues clustered around that rank still climbing normally.

The fix: milestone rates are now averaged across the ~20 leagues ranked
closest to that milestone (±10 ranks), using data the hourly rankings job
already collects — no extra API calls. One or two leagues having a quiet
hour gets smoothed out by the rest of the cluster, so the rate reflects the
real, sustained pace needed to hold that tier rather than one league's
momentary blip. Needs at least 2 leagues in that window with a computable
rate; falls back to the same "estimate — target rate unknown" wording if not
enough data is available yet.

## Global player rankings & league-rate tracking

Separately from the 10-minute tracked-league poller, a background job runs
**once an hour** and rebuilds a leaderboard of individual players across the
**top 1,000 leagues** (by league Points). This powers the global-rank portion
of `/playerinfo`.

The same hourly pass also records each of those 1,000 leagues' current points
into a small history table — at no extra API cost, since it reuses data the
job already fetches — which is what lets the bot compute a real hourly rate
for any of those leagues, not just the one actively being tracked. That
league-rate data is what powers the two-body ETA math described above.

It also records **each individual member's** points the same way, which is
what `/leaguesnapshot` and the per-member rates in `/playerinfo` are built
on — again no extra API cost, since `PointContributions` is already being
fetched for the player-rankings pass.

Why top 1,000 and not every league: the PS99 API only returns individual member
contributions from the *per-league detail endpoint* — there's no bulk
endpoint for it. Pulling all ~90,000+ leagues would mean tens of thousands of
API calls and multiple hours per rebuild. Restricting to the top 1,000 keeps a
full rebuild to about 1,000 calls (several minutes, with a small delay
between requests to stay easy on the PS99 API), at the cost of only covering
players (and league rates) in genuinely competitive leagues — if someone's
league is outside the top 1,000, they won't show up in the global-rank
lookup, and ETAs involving them fall back to the one-sided estimate.

The rankings table is fully replaced on each rebuild (not accumulated), so it
always reflects a single consistent snapshot rather than a mix of old and new
data. League points history is append-only but pruned to the last 26 hours.


## Local setup

**Requires Node.js 22.5.0 or newer** (this project uses Node's built-in
`node:sqlite` module — no native compilation, no build tools needed). Check
your version with `node -v`; if it's older, grab an LTS release from
[nodejs.org](https://nodejs.org).

```bash
npm install
cp .env.example .env
# fill in DISCORD_TOKEN and DISCORD_CLIENT_ID in .env
npm run deploy-commands   # registers the slash commands with Discord
npm start
```

`npm run deploy-commands` automatically runs a check first
(`npm run lint-commands`) that catches command/option descriptions over
Discord's 100-character limit before anything gets sent to Discord or
deployed. This exists because of a real incident: an oversized description
once crashed the bot on every single startup on Railway, since
`SlashCommandBuilder` validates description length the instant it's called —
during module loading, before any of the bot's own error handling can catch
it. If you ever add a new command, run `npm run lint-commands` (or just
`npm run deploy-commands`, which includes it) before deploying.

### Getting a bot token

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Under **Bot**, click **Reset Token** to get `DISCORD_TOKEN`. Enable no
   privileged intents — this bot only needs the default `Guilds` intent.
3. Your **Application ID** (top of the General Information page) is
   `DISCORD_CLIENT_ID`.
4. Under **OAuth2 → URL Generator**, check `bot` and `applications.commands`
   scopes, and under bot permissions check `Send Messages`, `Embed Links`,
   and `Attach Files`. Use the generated URL to invite the bot to your server.
5. (Optional, for instant command updates while testing) set
   `DISCORD_GUILD_ID` to your test server's ID — global command registration
   can take up to an hour to show up.

## Deploying to Railway

1. Push this project to a GitHub repo, then in Railway: **New Project → Deploy from GitHub repo**.
2. Add a **Volume** to the service (Railway dashboard → your service →
   **Volumes** tab) mounted at `/data`. This is what makes hourly history and
   tracked-channel config survive redeploys/restarts.
3. Set environment variables on the service:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DB_PATH=/data/ps99.db` (matches the volume mount path)
   - `POLL_INTERVAL_MINUTES=10` (optional, defaults to 10)
4. Deploy. Railway will run `npm install` automatically (Nixpacks), then
   `node src/index.js` per `railway.json`.
5. Register slash commands once, either:
   - Locally: run `npm run deploy-commands` from your machine with the same
     `.env` values, or
   - On Railway: open a **Shell** on the deployed service and run
     `npm run deploy-commands`.

**Important:** the volume is what gives you persistence across restarts. If
you deploy without one, Railway's filesystem is ephemeral and the SQLite file
(along with all snapshot history) resets on every redeploy — tracking would
still work, it would just "forget" history and need another hour to build up
hourly rates again after each restart.

**Do not delete `nixpacks.toml`.** It installs system libraries (cairo,
pango, fontconfig, and others) that the `canvas` package needs at runtime to
render the member-comparison graph. Without it, Railway's default build image
is missing shared libraries that crash the bot on startup with
`ERR_DLOPEN_FAILED` — even though `npm install` itself succeeds fine, since
the crash only happens when the graph-rendering code actually loads. This was
hit and fixed directly against real Railway deploy logs; see the comments in
that file for the specific error messages if it ever needs revisiting.

## Notes & limitations

- Member points come from the league's `PointContributions` — the API notes
  this reflects each member's contribution toward the league's running total,
  not their all-time PS99 stats.
- If the PS99 API can't resolve a member's Roblox display name at snapshot
  time, it falls back to their raw numeric user ID. The bot detects this and
  makes a follow-up call to Roblox's public users API to fill in the real
  name, caching results for 6 hours so it doesn't re-resolve names every poll.
  If that lookup also fails, the numeric ID is shown as a last resort rather
  than blocking the update. This resolution step has to be applied everywhere
  `PointContributions`/`Owner` data from the PS99 API is displayed — it was
  originally only wired into the tracked-channel poller and got missed in
  `/leaguesnapshot` for a while, which is why an early version of that
  command showed raw numeric IDs instead of names. Worth double-checking if
  a future command ever displays league member/owner data directly.
- The graph bundles its own font (`assets/fonts/DejaVuSans*.ttf`) and
  registers it explicitly with Chart.js. This matters because minimal Linux
  containers (like Railway's build image) often ship with **no fonts
  installed at all** — without a bundled font, chart text renders as empty
  boxes. Don't delete the `assets/fonts` folder.
- `/playerinfo` checks three sources in order, falling through only if the
  previous one finds nothing: (1) leagues actively tracked in that server —
  the most reliable, live data; (2) the hourly top-1,000 league rankings scan
  — not live, but covers any player in a genuinely competitive league even if
  nobody's tracking it; (3) a direct PS99 profile lookup by exact username.
  Tiers 1 and 2 match on username **or** display name, partial or full,
  case-insensitive. Tier 3 needs an **exact** username (not display name, not
  partial) and only returns data if that player has made their profile
  public — the bot can't search by display name at that tier since there's no
  confirmed PS99 search endpoint for it (an earlier attempt at a `/leagueplayersearch`
  command guessed at one and it turned out to be broken; the API rejected the
  request rather than returning results). Tier 3 itself is a best-effort
  implementation of a pattern confirmed directly from the official API's
  quickstart docs (`/v1/players/{username}?include=profile`), but the exact
  field names returned inside a public profile haven't been confirmed against
  a live response, so `/playerinfo` displays whatever fields actually come
  back rather than assuming specific ones — if a lookup succeeds but shows
  unexpected or missing fields, that's the part to sanity-check first.
- `/playerinfo`'s tier-2 global rank only covers players in the **top 1,000
  leagues** (refreshed hourly) — it can't show a rank for players in
  smaller/lower leagues, since the PS99 API has no bulk endpoint for
  individual player stats and pulling every league would take hours per
  rebuild.
- `/leaguesnapshot` shows data from the **last hourly rankings scan**, not a
  live poll — the header stats (points, rank) come from a fresh API call when
  you run the command, but member rates and the graph come from stored
  history, so they're only as fresh as the most recent hourly job run. If the
  bot has been running less than ~2 hours, rates and the graph may be
  unavailable or sparse; that's expected, not a bug.
- The graph keeps the last 24 hours of snapshots per channel; older rows are
  pruned automatically on each poll to keep the database small.
- If a tracked league is renamed, disbanded, or otherwise disappears from the
  API, the bot posts a one-time warning in that channel and automatically
  stops tracking it (rather than erroring every 10 minutes forever).
- Overtake ETAs assume both leagues keep their current trailing-hour rate
  constant — they're an estimate, not a guarantee, since rates naturally
  fluctuate.
- **Battle end projection (🏁 Projected at Battle End).** Every tracked embed
  shows the league's projected points if its current hourly rate holds until
  the battle ends, a rough **placement bracket**, and a live countdown. This
  is anchored to a fixed weekly moment — **Saturday 2am AEST** — hardcoded in
  `src/lib/battleTimer.js` rather than pulled from an API, since the API's
  battle-timing endpoints turned out to have real reliability problems (see
  below). AEST is fixed at UTC+10 with no daylight-saving adjustment needed,
  which keeps the math simple and exact.

  All countdowns in the embed (ahead/behind/milestone ETAs and the battle-end
  timer) use Discord's native `<t:...:R>` timestamp markup, which counts down
  live in the client with no extra work from the bot — the number you see is
  always accurate to the second, not just accurate at the moment it was posted.

  The **placement bracket** ("top 50", "outside top 100", etc.) is
  deliberately a bracket, not a fake-precise single rank number like "#47."
  It's built by projecting the same milestone leagues (top 100/50/10) forward
  the same way, using their own real hourly rates from the top-1,000 rankings
  job, then checking which bracket the tracked league's own projection falls
  into. A true single-rank forecast would need every nearby league's rate
  projected too, compounding many independent, fluctuating estimates into a
  number that would look exact but likely wouldn't be — the bracket keeps the
  uncertainty bounded to just the few leagues already reliably tracked.

  One thing this deliberately does NOT try to do: **it doesn't know if a
  battle even exists next week**, or what type (clan vs. league) — battle
  scheduling depends on game updates and isn't predictable in advance. The
  countdown always points to the next Saturday-2am-AEST moment regardless.

  Why not pull the end-date from the API instead of hardcoding it: the PS99
  API has a couple of candidates (`v1/clans` battle detail, and a legacy
  `/api/activeClanBattle` endpoint), but the legacy one has documented
  reliability problems (reports of it lagging hours to over a day behind the
  real battle state — see PS99 API docs issue #95), and the exact field
  shape of the newer `v1/clans` battle-detail endpoint was never confirmed
  against a live response. A fixed weekly anchor, confirmed directly, is more
  reliable than either.
