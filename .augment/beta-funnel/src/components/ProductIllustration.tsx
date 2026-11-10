import type { ReactNode } from 'react';

/**
 * A static product illustration. It is labeled as such and does not present
 * invented live crowd counts, parking spots, or ride ETAs as real data.
 */
const HOURS = [
  { label: '11a', h: 18 },
  { label: '1p', h: 28 },
  { label: '3p', h: 36 },
  { label: '5p', h: 52 },
  { label: '7p', h: 78 },
  { label: '9p', h: 92 },
  { label: '11p', h: 64 },
];

export function ProductIllustration() {
  return (
    <figure className="relative">
      <div className="grid gap-4 sm:grid-cols-2">
        <PlanCard />
        <div className="flex flex-col gap-4">
          <PassCard />
          <BusynessCard />
        </div>
      </div>
      <figcaption className="mt-4 text-center text-[12px] leading-relaxed text-[var(--bone-muted)] sm:text-left">
        Product illustration — not live data. The chart is an example of typical
        busyness by hour, the usual pattern for a time of day, not a live crowd
        reading.
      </figcaption>
    </figure>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-3xl border border-[var(--line)] bg-[var(--navy)]/80 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-sm ${className}`}
    >
      {children}
    </div>
  );
}

function PlanCard() {
  return (
    <Card className="flex flex-col justify-between">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--cyan)]">
          A shared plan
        </p>
        <h3 className="mt-2 text-2xl font-semibold tracking-tight">Saturday out</h3>
        <p className="mt-1 text-sm text-[var(--bone-muted)]">One link, everyone sees the same night.</p>
      </div>
      <ol className="mt-6 space-y-3">
        {[
          { when: '11:00', what: 'Brunch' },
          { when: '15:30', what: 'A walk through Midtown' },
          { when: '21:00', what: "A friend's party" },
        ].map((stop, i) => (
          <li key={stop.when} className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--cyan-dim)] text-[11px] font-semibold text-[var(--cyan)]">
              {i + 1}
            </span>
            <span className="w-12 text-[12px] tabular-nums text-[var(--bone-muted)]">{stop.when}</span>
            <span className="text-sm text-[var(--bone)]">{stop.what}</span>
          </li>
        ))}
      </ol>
      <div className="mt-6 rounded-full border border-[var(--line)] bg-white/5 px-4 py-2 text-center text-[12px] text-[var(--bone-muted)]">
        bytspot.app/plan/…
      </div>
    </Card>
  );
}

function PassCard() {
  return (
    <Card>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--cyan)]">
        Party pass
      </p>
      <div className="mt-3 flex items-center gap-4">
        <PassPattern />
        <div>
          <p className="font-semibold">Guest pass</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--bone-muted)]">
            Guests can open an App Clip — no download needed.
          </p>
        </div>
      </div>
    </Card>
  );
}

function PassPattern() {
  return (
    <svg
      viewBox="0 0 64 64"
      className="h-16 w-16 shrink-0 rounded-xl bg-[var(--navy-deep)] p-1.5"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="60" height="60" rx="6" fill="none" stroke="#00BFFF" strokeOpacity="0.4" />
      {[
        [8, 8, 10, 10],
        [22, 8, 6, 10],
        [36, 8, 20, 6],
        [8, 22, 6, 14],
        [18, 22, 14, 6],
        [36, 18, 8, 18],
        [48, 18, 8, 8],
        [8, 40, 16, 8],
        [28, 32, 8, 16],
        [40, 40, 16, 16],
      ].map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill="#00BFFF" opacity={0.85} />
      ))}
    </svg>
  );
}

function BusynessCard() {
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--cyan)]">
          Typical busyness by hour
        </p>
        <p className="text-[11px] text-[var(--bone-muted)]">Example</p>
      </div>
      <div className="mt-4 flex h-24 items-end gap-2">
        {HOURS.map((hour) => (
          <div key={hour.label} className="flex flex-1 flex-col items-center gap-1.5">
            <div
              className="w-full rounded-t-md bg-[var(--cyan)]/80"
              style={{ height: `${hour.h}%` }}
            />
            <span className="text-[10px] text-[var(--bone-muted)]">{hour.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
