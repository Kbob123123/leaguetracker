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
| `/leagueplayersearch player:<name>` | Search for a player by username/display name. Shows their global rank among the top-500-leagues player pool (if they're in one), and whether they're in a league currently tracked in this server. |

You can track **multiple leagues at once**, one per channel — run
`/startmonitoringleague` in as many channels as you like.

Each tracked embed also shows, once an hour of history exists:
- 🎯 **Milestones** — ETA to reach top 100 / top 50 / top 10 (only shown for
  ranks the league hasn't already passed)
- ⏱️ **Next Update** — a live Discord relative-timestamp counting down to the
  next 10-minute refresh

## Global player rankings

Separately from the 10-minute tracked-league poller, a background job runs
**once an hour** and rebuilds a leaderboard of individual players across the
**top 500 leagues** (by league Points). This powers the global-rank portion
of `/leagueplayersearch`.

Why top 500 and not every league: the PS99 API only returns individual member
contributions from the *per-league detail endpoint* — there's no bulk
endpoint for it. Pulling all ~90,000+ leagues would mean tens of thousands of
API calls and multiple hours per rebuild. Restricting to the top 500 keeps a
full rebuild to about 500 calls (a couple of minutes, with a small delay
between requests to stay easy on the PS99 API), at the cost of only covering
players in genuinely competitive leagues — if someone's league is outside the
top 500, they won't show up in the global-rank lookup.

The rankings table is fully replaced on each rebuild (not accumulated), so it
always reflects a single consistent snapshot rather than a mix of old and new
data.

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
- `/leagueplayersearch`'s global rank only covers players in the **top 500
  leagues** (refreshed hourly) — it can't tell you a rank for players in
  smaller/lower leagues, since the PS99 API has no bulk endpoint for
  individual player stats and pulling every league would take hours per
  rebuild. The server-specific "is this player in a league we're tracking"
  check has no such limit and works for any tracked league regardless of rank.
- The graph keeps the last 24 hours of snapshots per channel; older rows are
  pruned automatically on each poll to keep the database small.
- If a tracked league is renamed, disbanded, or otherwise disappears from the
  API, the bot posts a one-time warning in that channel and automatically
  stops tracking it (rather than erroring every 10 minutes forever).
- Overtake ETAs assume both leagues keep their current trailing-hour rate
  constant — they're an estimate, not a guarantee, since rates naturally
  fluctuate.
