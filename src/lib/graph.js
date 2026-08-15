import { formatName } from './robloxNames.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const width = 900;
const height = 500;

/**
 * Chart rendering is loaded LAZILY and never at module scope.
 *
 * chartjs-node-canvas pulls in `canvas`, a native module that dlopen()s the
 * cairo/pango stack at require() time. On a host missing any of those shared
 * libraries (the classic one is `libuuid.so.1`), a top-level import throws
 * while the module is still being evaluated — which takes down every command
 * that imports this file, and every command that imports something that
 * imports this file. That cost us /claninfo and /leagueinfo, neither of which
 * draws a chart at all.
 *
 * Charts are decoration; the numbers are the product. Deferring the import to
 * first use means a missing system library costs a chart image, not a command.
 */
let canvasPromise = null;

function getCanvas() {
  if (canvasPromise) return canvasPromise;

  canvasPromise = (async () => {
    const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

    const canvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: '#2b2d31', // Discord dark theme background
      // Minimal Linux containers often ship with no fonts installed at all,
      // which renders chart text as empty boxes. Bundling a font and
      // registering it here makes output independent of the host.
      chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = 'DejaVu Sans';
      },
    });

    canvas.registerFont(path.join(FONT_DIR, 'DejaVuSans.ttf'), { family: 'DejaVu Sans', weight: 'normal' });
    canvas.registerFont(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'), { family: 'DejaVu Sans', weight: 'bold' });

    return canvas;
  })().catch((err) => {
    console.warn(
      `[graph] Chart rendering unavailable (${err.message}). ` +
        'Embeds will post without images; everything else works normally.'
    );
    return null; // cached, so the warning appears once rather than per render
  });

  return canvasPromise;
}

/** Render a chart config, or null if this host can't render charts. */
async function render(config) {
  const canvas = await getCanvas();
  if (!canvas) return null;
  try {
    return await canvas.renderToBuffer(config);
  } catch (err) {
    console.warn('[graph] Render failed:', err.message);
    return null;
  }
}

const MEMBER_COLORS = ['#5865F2', '#57F287', '#FEE75C', '#ED4245', '#EB459E'];

// Ink tokens for the long-term history chart. Text never wears the series
// colour — the coloured line carries identity, labels stay neutral.
const INK = '#e8e8e6';
const INK_MUTED = '#a8a8a4';
const GRID = 'rgba(255,255,255,0.07)';
// Validated against the #2b2d31 surface (contrast >= 3:1); single series, so
// no adjacent-pair separation is required.
const HISTORY_COLOR = '#3987e5';

/**
 * Long-term points history for one league: one point per day.
 *
 * Single series, so there is no legend — the title names what's plotted.
 */
export async function renderHistoryChart(leagueName, rows) {
  if (!rows || rows.length < 2) return null;

  const buffer = await render({
    type: 'line',
    data: {
      labels: rows.map((r) => r.day.slice(5)), // MM-DD; the year is noise here
      datasets: [
        {
          data: rows.map((r) => Number(r.points)),
          borderColor: HISTORY_COLOR,
          backgroundColor: 'rgba(57,135,229,0.14)',
          borderWidth: 2,
          pointRadius: rows.length > 45 ? 0 : 3,
          tension: 0.35,
          fill: true,
        },
      ],
    },
    options: {
      responsive: false,
      layout: { padding: { top: 10, right: 16, bottom: 6, left: 8 } },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `${leagueName} — points over time`,
          color: INK,
          font: { size: 16, weight: 'bold' },
          padding: { bottom: 10 },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { color: GRID },
          ticks: { color: INK_MUTED, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
        },
        y: {
          grid: { color: GRID, drawTicks: false },
          border: { display: false },
          ticks: {
            color: INK_MUTED,
            font: { size: 11 },
            maxTicksLimit: 6,
            callback: (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${(v / 1e3).toFixed(0)}K`),
          },
        },
      },
    },
  });

  return buffer;
}

/**
 * Same as renderMemberGraph, but takes pre-shaped { ts, members: [{userId,
 * displayName, points}] } objects directly instead of DB snapshot rows with
 * a members_json string column. Used by /leaguesnapshot, which sources
 * history from player_points_history (a different table/shape) rather than
 * the channel-tracking snapshots table.
 */
export async function renderMemberGraphFromPoints(pointsHistory, leagueName) {
  if (!pointsHistory.length) return null;
  return renderMemberGraph(
    pointsHistory.map((p) => ({ ts: p.ts, members_json: JSON.stringify(p.members) })),
    leagueName
  );
}

/**
 * Build a PNG buffer plotting each member's points over the retained snapshot
 * history. `snapshots` is an array of DB rows (oldest first), each with a
 * parsed members_json of [{userId, displayName, points}].
 */
export async function renderMemberGraph(snapshots, leagueName) {
  if (!snapshots.length) return null;

  const parsed = snapshots.map((s) => ({
    ts: s.ts,
    members: JSON.parse(s.members_json),
  }));

  // Union of member display names seen across the window (handles roster changes).
  const namesInOrder = [];
  const seen = new Set();
  for (const snap of parsed) {
    for (const m of snap.members) {
      if (!seen.has(m.userId)) {
        seen.add(m.userId);
        namesInOrder.push({ userId: m.userId, username: m.username, displayName: m.displayName });
      }
    }
  }

  const labels = parsed.map((s) =>
    new Date(s.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );

  const datasets = namesInOrder.slice(0, 4).map((who, i) => ({
    // Username only — a chart legend has no room for "user (Display Name)".
    label: formatName(who, { withDisplayName: false }),
    data: parsed.map((snap) => {
      const m = snap.members.find((x) => x.userId === who.userId);
      return m ? m.points : null;
    }),
    borderColor: MEMBER_COLORS[i % MEMBER_COLORS.length],
    backgroundColor: MEMBER_COLORS[i % MEMBER_COLORS.length],
    spanGaps: true,
    tension: 0.35,
    pointRadius: 2,
    borderWidth: 2,
  }));

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: {
        title: {
          display: true,
          text: `${leagueName} — Member Points`,
          color: '#f2f3f5',
          font: { size: 18, family: 'DejaVu Sans' },
        },
        legend: {
          labels: { color: '#f2f3f5', font: { family: 'DejaVu Sans' } },
        },
      },
      scales: {
        x: {
          ticks: { color: '#b5bac1', font: { family: 'DejaVu Sans' } },
          grid: { color: '#3f4147' },
        },
        y: {
          ticks: {
            color: '#b5bac1',
            font: { family: 'DejaVu Sans' },
            callback: (value) => Number(value).toLocaleString(),
          },
          grid: { color: '#3f4147' },
        },
      },
    },
  };

  return render(config);
}
