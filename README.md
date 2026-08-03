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
| `/playerinfo player:<name>` | Look up a member of any league tracked in this server by (partial) display name — shows points, hourly rate, in-league rank, and global rank if they're in a top-1,000 league. |

You can track **multiple leagues at once**, one per channel — run
`/startmonitoringleague` in as many channels as you like.

Each tracked embed also shows, once an hour of history exists:
- 🎯 **Milestones** — ETA to reach top 100 / top 50 / top 10 (auto-hides ranks already passed)
- ⏱️ **Next Update** — a live Discord relative-timestamp counting down to the
  next 10-minute refresh

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

## Notes & limitations

- Member points come from the league's `PointContributions` — the API notes
  this reflects each member's contribution toward the league's running total,
  not their all-time PS99 stats.
- If the PS99 API can't resolve a member's Roblox display name at snapshot
  time, it falls back to their raw numeric user ID. The bot detects this and
  makes a follow-up call to Roblox's public users API to fill in the real
  name, caching results for 6 hours so it doesn't re-resolve names every poll.
  If that lookup also fails, the numeric ID is shown as a last resort rather
  than blocking the update.
- The graph bundles its own font (`assets/fonts/DejaVuSans*.ttf`) and
  registers it explicitly with Chart.js. This matters because minimal Linux
  containers (like Railway's build image) often ship with **no fonts
  installed at all** — without a bundled font, chart text renders as empty
  boxes. Don't delete the `assets/fonts` folder.
- `/playerinfo` only searches **members of leagues currently tracked in this
  server** — it doesn't call any external "search for a player by name"
  endpoint. An earlier version tried that (a `/leagueplayersearch` command
  hitting a guessed `/v1/players?query=` endpoint) and it turned out to be
  broken — the PS99 API rejected the request rather than returning results.
  Rather than keep guessing at an unverified endpoint, `/playerinfo` was
  rebuilt to only use data the bot already reliably has: the member rosters
  from its own tracked-league polling. This is strictly more reliable (no
  external search dependency at all) at the cost of only covering players in
  leagues someone has actually run `/startmonitoringleague` on in that server.
- `/playerinfo`'s global rank field only covers players in the **top 1,000
  leagues** (refreshed hourly) — it can't show a global rank for players in
  smaller/lower leagues, since the PS99 API has no bulk endpoint for
  individual player stats and pulling every league would take hours per
  rebuild.
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
  the battle ends, plus a countdown. This is anchored to a fixed weekly
  moment — **Saturday 2am AEST** — hardcoded in `src/lib/battleTimer.js`
  rather than pulled from an API, since the API's battle-timing endpoints
  turned out to have real reliability problems (see below). AEST is fixed at
  UTC+10 with no daylight-saving adjustment needed, which keeps the math
  simple and exact.

  Two things this deliberately does NOT try to do, because the underlying
  data isn't reliable enough to back them:
  - **It doesn't know if a battle even exists next week**, or what type
    (clan vs. league) — battle scheduling depends on game updates and isn't
    predictable in advance. The countdown always points to the next
    Saturday-2am-AEST moment regardless.
  - **It doesn't project a full rank forecast** — only points. A true rank
    projection would need every nearby league's own rate projected forward
    too, compounding several independent, fluctuating estimates into one
    number that would look precise but likely wouldn't be. Instead, it does
    one honest, limited sanity check: whether the projected points would
    currently be enough to beat the immediate "ahead" neighbor's points
    *right now* — clearly caveated that they'll likely have grown too by
    battle end.

  Why not pull the end-date from the API instead of hardcoding it: the PS99
  API has a couple of candidates (`v1/clans` battle detail, and a legacy
  `/api/activeClanBattle` endpoint), but the legacy one has documented
  reliability problems (reports of it lagging hours to over a day behind the
  real battle state — see PS99 API docs issue #95), and the exact field
  shape of the newer `v1/clans` battle-detail endpoint was never confirmed
  against a live response. A fixed weekly anchor, confirmed directly, is more
  reliable than either.
