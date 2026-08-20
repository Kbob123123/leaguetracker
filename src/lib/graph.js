import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatName } from './robloxNames.js';
import {
  HOUSE,
  SERIES_COLORS,
  fillFor,
  fullNumber,
  loadWatermark,
  backdropPlugin,
  watermarkPlugin,
  titlePlugin,
  legendBoxPlugin,
  statStripPlugin,
  footnotePlugin,
  processTimeNote,
  houseScales,
  housePadding,
  flatSafeBounds,
} from './chartTheme.js';
import { resolveThumbnail } from './thumbnails.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');

const width = 960;
const height = 540;

/**
 * Chart rendering is loaded LAZILY and never at module scope.
 *
 * chartjs-node-canvas pulls in `canvas`, a native module that dlopen()s the
 * cairo/pango stack at require() time. On a host missing any of those shared
 * libraries (the classic one is `libuuid.so.1`), a top-level import throws
 * while the module is still being evaluated — which takes down every command
 * that imports this file, and every command that imports something that
 * imports this file.
 *
 * Charts are decoration; the numbers are the product. Deferring the import to
 * first use means a missing system library costs a chart image, not a command.
 *
 * `chartTheme.js` follows the same rule — its watermark loader dynamic-imports
 * `canvas` rather than importing it at the top.
 */
let canvasPromise = null;

function getCanvas() {
  if (canvasPromise) return canvasPromise;

  canvasPromise = (async () => {
    const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

    const canvas = new ChartJSNodeCanvas({
      width,
      height,
      backgroundColour: HOUSE.SURFACE,
      // Minimal Linux containers often ship with no fonts installed at all,
      // which renders chart text as empty boxes. Bundling a font and
      // registering it here makes output independent of the host.
      chartCallback: (ChartJS) => {
        ChartJS.defaults.font.family = HOUSE.FONT;
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

// A league holds four members, so every one of them is always plotted — unlike
// the clan bot, which has to rank and truncate at 75.
const MAX_GRAPHED_MEMBERS = 4;

/** Clock labels for a timestamp series. */
function clockLabels(rows, key = 'ts') {
  return rows.map((r) =>
    new Date(Number(r[key]) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
}

/**
 * Build a house-styled line chart.
 *
 * Kept structurally identical to the clan bot's copy so the two stay easy to
 * diff. The style itself lives in chartTheme.js, which IS byte-identical
 * across the three bots.
 *
 * @param {object} p
 * @param {string}   p.title        bold, centred, above the plot
 * @param {string}   [p.subtitle]
 * @param {string[]} p.labels
 * @param {Array}    p.datasets     [{ label, values, color, fill }]
 * @param {object}   [p.watermark]  loaded Image, or null
 * @param {Array}    [p.stats]      [{ label, value }] strip under the title
 * @param {string}   [p.footnote]   right-hand footnote; left is process time
 * @param {boolean}  [p.legend]     force the legend box on/off
 */
async function houseLineChart({
  title,
  subtitle,
  labels,
  datasets,
  watermark = null,
  stats = null,
  footnote = null,
  legend = null,
  yFormat = fullNumber,
  xTickLimit = 8,
  startedAt = Date.now(),
}) {
  // Guard every chart against the collapsed-axis look a flat series causes.
  const yBounds = flatSafeBounds(datasets.flatMap((d) => d.values ?? []));

  // A single series is named by the title, so a one-row legend box would be
  // pure noise. Two or more need naming.
  const showLegend = legend ?? datasets.length > 1;

  return render({
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d, i) => {
        const color = d.color ?? SERIES_COLORS[i % SERIES_COLORS.length];
        return {
          label: d.label,
          data: d.values,
          borderColor: color,
          backgroundColor: d.fill ? fillFor(color) : color,
          borderWidth: 2,
          pointRadius: d.pointRadius ?? (labels.length > 45 ? 0 : 2),
          pointHoverRadius: 0,
          tension: 0.35,
          fill: Boolean(d.fill),
          spanGaps: true,
        };
      }),
    },
    options: {
      responsive: false,
      animation: false,
      layout: {
        padding: housePadding({
          hasSubtitle: Boolean(subtitle),
          hasFootnote: true,
          hasStats: Boolean(stats && stats.length),
        }),
      },
      // Both are drawn by house plugins instead, so Chart.js's own must be off
      // or they would draw twice, in the wrong style and the wrong place.
      plugins: { legend: { display: false }, title: { display: false } },
      scales: houseScales({ yFormat, xTickLimit, yBounds }),
    },
    plugins: [
      backdropPlugin(),
      watermarkPlugin(watermark),
      titlePlugin({ title, subtitle }),
      ...(stats && stats.length ? [statStripPlugin(stats, { y: subtitle ? 82 : 68 })] : []),
      ...(showLegend
        ? [
            legendBoxPlugin(
              datasets.map((d, i) => ({
                label: d.label,
                color: d.color ?? SERIES_COLORS[i % SERIES_COLORS.length],
              }))
            ),
          ]
        : []),
      footnotePlugin({ left: processTimeNote(startedAt), right: footnote }),
    ],
  });
}

/**
 * Long-term points history for one league: one point per day.
 *
 * Single series, so no legend box — the title names what's plotted.
 */
export async function renderHistoryChart(leagueName, rows, { leagueIcon } = {}) {
  if (!rows || rows.length < 2) return null;
  const startedAt = Date.now();

  const watermark = await loadWatermark(await resolveThumbnail(leagueIcon));

  return houseLineChart({
    title: leagueName,
    subtitle: 'Points over time',
    labels: rows.map((r) => r.day.slice(5)), // MM-DD; the year is noise here
    datasets: [
      {
        label: 'Total Points',
        values: rows.map((r) => Number(r.points)),
        color: SERIES_COLORS[0],
        fill: true,
        pointRadius: rows.length > 45 ? 0 : 3,
      },
    ],
    watermark,
    footnote: `${rows.length} days`,
    xTickLimit: 10,
    startedAt,
  });
}

/**
 * Same as renderMemberGraph, but takes pre-shaped { ts, members: [{userId,
 * displayName, points}] } objects directly instead of DB snapshot rows with
 * a members_json string column. Used by /leagueinfo, which sources
 * history from player_points_history (a different table/shape) rather than
 * the channel-tracking snapshots table.
 */
export async function renderMemberGraphFromPoints(pointsHistory, leagueName, opts = {}) {
  if (!pointsHistory.length) return null;
  return renderMemberGraph(
    pointsHistory.map((p) => ({ ts: p.ts, members_json: JSON.stringify(p.members) })),
    leagueName,
    opts
  );
}

/**
 * Build a PNG buffer plotting each member's points over the retained snapshot
 * history. `snapshots` is an array of DB rows (oldest first), each with a
 * parsed members_json of [{userId, displayName, points}].
 */
export async function renderMemberGraph(snapshots, leagueName, { leagueIcon } = {}) {
  if (!snapshots.length) return null;
  const startedAt = Date.now();

  const parsed = snapshots.map((s) => ({
    ts: s.ts,
    members: JSON.parse(s.members_json),
  }));

  // Union of members seen across the window (handles roster changes mid-window).
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

  const plotted = namesInOrder.slice(0, MAX_GRAPHED_MEMBERS);
  const watermark = await loadWatermark(await resolveThumbnail(leagueIcon));

  return houseLineChart({
    title: leagueName,
    subtitle: 'Member points',
    labels: clockLabels(parsed),
    datasets: plotted.map((who, i) => ({
      // Username only — a chart legend has no room for "user (Display Name)".
      label: formatName(who, { withDisplayName: false }),
      values: parsed.map((snap) => {
        const m = snap.members.find((x) => x.userId === who.userId);
        return m ? m.points : null;
      }),
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    })),
    watermark,
    footnote: `${parsed.length} snapshots`,
    startedAt,
  });
}
