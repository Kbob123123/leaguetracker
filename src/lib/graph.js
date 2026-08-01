import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

const width = 900;
const height = 500;

const chartCanvas = new ChartJSNodeCanvas({
  width,
  height,
  backgroundColour: '#2b2d31', // Discord dark theme background
});

const MEMBER_COLORS = ['#5865F2', '#57F287', '#FEE75C', '#ED4245', '#EB459E'];

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
        namesInOrder.push({ userId: m.userId, displayName: m.displayName });
      }
    }
  }

  const labels = parsed.map((s) =>
    new Date(s.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );

  const datasets = namesInOrder.slice(0, 4).map((who, i) => ({
    label: who.displayName,
    data: parsed.map((snap) => {
      const m = snap.members.find((x) => x.userId === who.userId);
      return m ? m.points : null;
    }),
    borderColor: MEMBER_COLORS[i % MEMBER_COLORS.length],
    backgroundColor: MEMBER_COLORS[i % MEMBER_COLORS.length],
    spanGaps: true,
    tension: 0.25,
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
          font: { size: 18 },
        },
        legend: {
          labels: { color: '#f2f3f5' },
        },
      },
      scales: {
        x: {
          ticks: { color: '#b5bac1' },
          grid: { color: '#3f4147' },
        },
        y: {
          ticks: {
            color: '#b5bac1',
            callback: (value) => Number(value).toLocaleString(),
          },
          grid: { color: '#3f4147' },
        },
      },
    },
  };

  return chartCanvas.renderToBuffer(config);
}
