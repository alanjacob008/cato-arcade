import { THEME } from "../lib/shareModel";

const GAP = 2;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Orange intensity buckets by tx count for a day (GitHub-style). */
function color(count: number): string {
  if (count <= 0) return "#1b1b1f";
  if (count <= 2) return "rgba(255,138,0,0.28)";
  if (count <= 5) return "rgba(255,138,0,0.5)";
  if (count <= 10) return "rgba(255,138,0,0.72)";
  return THEME.accent;
}

function utcKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One year: weeks as columns (responsive 1fr so the whole year fits the width), days as rows. */
function YearGrid({ year, txByDay, todayMs }: { year: number; txByDay: Record<string, number>; todayMs: number }) {
  const jan1 = Date.UTC(year, 0, 1);
  const startDow = new Date(jan1).getUTCDay();
  const end = Math.min(Date.UTC(year, 11, 31), todayMs); // only place cells up to today…

  // …but size every year to the full 53-week width so cells are uniform across years
  // (future days in the current year just render as empty space).
  const fullOffset = Math.round((Date.UTC(year, 11, 31) - jan1) / DAY_MS);
  const weeks = Math.floor((fullOffset + startDow) / 7) + 1;

  const cells: Array<{ col: number; row: number; key: string; count: number }> = [];
  for (let ms = jan1; ms <= end; ms += DAY_MS) {
    const offset = Math.round((ms - jan1) / DAY_MS);
    const col = Math.floor((offset + startDow) / 7);
    const row = (offset + startDow) % 7;
    cells.push({ col, row, key: utcKey(ms), count: txByDay[utcKey(ms)] ?? 0 });
  }

  // Month labels positioned at the week-column where each month begins (all 12 months).
  const months: Array<{ name: string; col: number; span: number }> = [];
  for (let m = 0; m < 12; m++) {
    const offset = Math.round((Date.UTC(year, m, 1) - jan1) / DAY_MS);
    months.push({ name: MONTHS[m]!, col: Math.floor((offset + startDow) / 7), span: 1 });
  }
  months.forEach((mo, i) => {
    mo.span = Math.max(1, (months[i + 1]?.col ?? weeks) - mo.col);
  });

  const total = Object.entries(txByDay)
    .filter(([k]) => k.startsWith(`${year}-`))
    .reduce((n, [, c]) => n + c, 0);

  const cols = `repeat(${weeks}, 1fr)`;

  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ color: THEME.fg, fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
        {year} <span style={{ color: THEME.muted, fontWeight: 400, fontSize: 13 }}>· {total.toLocaleString()} txns</span>
      </div>

      {/* month labels */}
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: GAP, marginBottom: 4 }}>
        {months.map((mo) => (
          <div
            key={mo.name}
            style={{ gridColumn: `${mo.col + 1} / span ${mo.span}`, fontSize: 11, color: THEME.muted, overflow: "hidden" }}
          >
            {mo.name}
          </div>
        ))}
      </div>

      {/* day cells */}
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: GAP }}>
        {cells.map((c) => (
          <div
            key={c.key}
            title={`${c.key}: ${c.count} txn${c.count === 1 ? "" : "s"}`}
            style={{ gridColumn: c.col + 1, gridRow: c.row + 1, aspectRatio: "1 / 1", borderRadius: 2, background: color(c.count) }}
          />
        ))}
      </div>
    </div>
  );
}

/** GitHub-style activity calendar: every active year stacked vertically, divided by month. */
export function ActivityCalendar({ txByDay }: { txByDay: Record<string, number> }) {
  const keys = Object.keys(txByDay);
  if (keys.length === 0) return null;

  const todayMs = Date.now();
  const minYear = Number(keys.reduce((a, b) => (a < b ? a : b)).slice(0, 4));
  const maxYear = new Date(todayMs).getUTCFullYear();
  const years: number[] = [];
  for (let y = minYear; y <= maxYear; y++) years.push(y);

  return (
    <div style={{ border: "1px solid #1e1e22", borderRadius: 16, padding: 20, background: "#0f0f12" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Activity on Solana</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: THEME.muted, fontSize: 12 }}>
          <span>less</span>
          {[0, 2, 5, 10, 20].map((n) => (
            <span key={n} style={{ width: 11, height: 11, borderRadius: 2, background: color(n) }} />
          ))}
          <span>more</span>
        </div>
      </div>
      {years.map((y) => (
        <YearGrid key={y} year={y} txByDay={txByDay} todayMs={todayMs} />
      ))}
    </div>
  );
}
