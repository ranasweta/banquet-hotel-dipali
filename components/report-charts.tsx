/**
 * The chart pieces the Reports overview is built from. Deliberately hand-rolled: three small
 * primitives on the app's own tokens weigh nothing next to a charting library, and the two
 * things a library would give us here — an axis and a tooltip engine — neither of these needs.
 *
 * The rules they follow, so a later chart follows them too:
 *   · Thin marks, no borders. A 2px gap in the surface colour separates touching fills; a
 *     stroke around a mark would add ink that isn't data.
 *   · Every value is written next to its mark. Nothing is reachable only by hovering, so the
 *     charts read the same on a phone, in print, and to a screen reader.
 *   · Identity never rides on colour alone — each swatch has its label beside it.
 *   · One hue for the ranking bars. Bar length already carries the magnitude; colouring them
 *     by value would spend the identity channel restating it.
 * The stage ramp itself lives in globals.css (`--stage-1..4`), stepped per mode.
 */
export type Segment = { label: string; value: number; color: string }

/** A labelled number. The dashboard's unit of "one fact". */
export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{hint}</div>}
    </div>
  )
}

/**
 * The figure the page leads with. Proportional figures, not tabular: `tabular-nums` gives every
 * digit the width of a zero, which reads loose at this size (it belongs in columns, not here).
 */
export function Hero({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-5xl font-semibold leading-none">{value}</div>
      {sub && <div className="mt-2 text-xs text-muted-foreground">{sub}</div>}
    </div>
  )
}

/** A ratio against its whole. The track is a wash of the same hue, so the state reads across it. */
export function Meter({ pct, label }: { pct: number; label?: string }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 min-w-10 flex-1 rounded-full bg-[color-mix(in_oklab,var(--stage-3)_18%,transparent)]"
        role="img"
        aria-label={label ?? `${w}%`}
      >
        <div className="h-full rounded-full bg-[var(--stage-3)]" style={{ width: `${w}%` }} />
      </div>
      <span className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {w.toFixed(0)}%
      </span>
    </div>
  )
}

/**
 * Part-to-whole at a glance, capped at six segments by the caller. Drawn as one dashed circle
 * per segment rather than as pie wedges: a stroke dash can be shortened by exactly 2px, which
 * is how the segments get their surface gap without a border being drawn around anything.
 */
export function Donut({
  segments,
  centerValue,
  centerLabel,
  ariaLabel,
}: {
  segments: Segment[]
  centerValue: string
  centerLabel: string
  ariaLabel: string
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const R = 62
  const C = 2 * Math.PI * R
  const GAP = 2 // px of circumference, in the surface colour

  // Each arc starts where every arc before it ended. Written as a running sum rather than an
  // accumulator so nothing is reassigned mid-render; six segments make the cost irrelevant.
  const lengths = segments.map((s) => (s.value / total) * C)
  const arcs = segments.map((s, i) => ({
    ...s,
    len: Math.max(0, lengths[i]! - GAP),
    offset: lengths.slice(0, i).reduce((a, b) => a + b, 0),
  }))

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
      <svg viewBox="0 0 160 160" className="size-40 shrink-0" role="img" aria-label={ariaLabel}>
        <g transform="rotate(-90 80 80)">
          {arcs.map((a) => (
            <circle
              key={a.label}
              cx="80"
              cy="80"
              r={R}
              fill="none"
              stroke={a.color}
              strokeWidth="18"
              strokeDasharray={`${a.len} ${C - a.len}`}
              strokeDashoffset={-a.offset}
            >
              <title>{`${a.label}: ${a.value} (${Math.round((a.value / total) * 100)}%)`}</title>
            </circle>
          ))}
        </g>
        <text x="80" y="76" textAnchor="middle" className="fill-foreground text-xl font-semibold">
          {centerValue}
        </text>
        <text x="80" y="94" textAnchor="middle" className="fill-muted-foreground text-[10px]">
          {centerLabel}
        </text>
      </svg>
      <ul className="min-w-40 flex-1 space-y-1.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-sm">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="flex-1 truncate">{s.label}</span>
            <span className="tabular-nums">{s.value}</span>
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {total > 0 ? Math.round((s.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A ranking. Sorted descending by the caller, one hue for every bar, the value written at the
 * tip. The bar is square where it leaves the baseline and rounded at the data end — the shape
 * says which end is the measurement.
 */
export function RankBars({
  rows,
  unit,
}: {
  rows: { label: string; value: number; note?: string }[]
  unit: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate" title={r.label}>
              {r.label}
              {r.note && <span className="ml-1.5 text-xs text-muted-foreground">{r.note}</span>}
            </span>
            <span className="shrink-0 tabular-nums">
              {r.value}
              <span className="ml-1 text-xs text-muted-foreground">{unit}</span>
            </span>
          </div>
          <div
            className="mt-1 h-2.5 rounded-r-[4px] bg-[var(--stage-3)]"
            style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }}
          />
        </li>
      ))}
    </ul>
  )
}
