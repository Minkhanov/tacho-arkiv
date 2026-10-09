import { formatAmount } from "../../../src/core/policy.ts"

export interface DiscMark {
  key: string
  tsMs: number
  amount: bigint
  kind: "allowed" | "refused" | "forged"
}

/**
 * The day as a tachograph disc: 24 hours around the dial, one spoke per record, its length the
 * amount relative to the per-action cap. Green allowed, amber refused, red forged.
 */
export function TachoDisc(props: {
  marks: DiscMark[]
  /** Heartbeats (lease renewals), drawn as short cyan ticks on the rim. */
  ticks?: number[]
  /** Revocation time, drawn as a red stop line. */
  stopMs?: number | undefined
  dayStartMs: number
  perActionCap: bigint
  spent: bigint
  perDayCap: bigint
  decimals: number
  currency: string
  nowMs: number
}) {
  const size = 320
  const cx = size / 2
  const cy = size / 2
  const rIn = 70
  const rOut = 140
  const angle = (ms: number) => ((ms - props.dayStartMs) / 86_400_000) * 2 * Math.PI - Math.PI / 2
  const pt = (a: number, r: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const
  const fill = props.perDayCap > 0n ? Number((props.spent * 1000n) / props.perDayCap) / 1000 : 0
  const nowA = angle(props.nowMs)
  return (
    <svg className="disc" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Tachograph disc of the current policy day">
      <circle cx={cx} cy={cy} r={rOut + 6} fill="var(--panel-2)" stroke="var(--line)" />
      <circle cx={cx} cy={cy} r={rIn - 6} fill="var(--bg)" stroke="var(--line)" />
      {Array.from({ length: 24 }, (_, h) => {
        const a = (h / 24) * 2 * Math.PI - Math.PI / 2
        const [x1, y1] = pt(a, rOut - (h % 3 === 0 ? 10 : 5))
        const [x2, y2] = pt(a, rOut + 6)
        const [tx, ty] = pt(a, rOut + 18)
        return (
          <g key={h}>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--muted)" strokeWidth={h % 3 === 0 ? 1.5 : 0.75} />
            {h % 3 === 0 && (
              <text x={tx} y={ty} className="disc-hour" textAnchor="middle" dominantBaseline="middle">
                {String(h).padStart(2, "0")}
              </text>
            )}
          </g>
        )
      })}
      {props.marks.map((m) => {
        const a = angle(m.tsMs)
        const rel = props.perActionCap > 0n ? Math.min(1.25, Number((m.amount * 1000n) / props.perActionCap) / 1000) : 0.5
        const [x1, y1] = pt(a, rIn)
        const [x2, y2] = pt(a, rIn + 8 + (rOut - rIn - 14) * Math.min(1, rel))
        const color = m.kind === "allowed" ? "var(--ok)" : m.kind === "refused" ? "var(--warn)" : "var(--bad)"
        return <line key={m.key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={m.kind === "forged" ? 4 : 3} strokeLinecap="round" opacity={0.95} />
      })}
      {(props.ticks ?? [])
        .filter((t) => t >= props.dayStartMs && t < props.dayStartMs + 86_400_000)
        .map((t, i) => {
          const a = angle(t)
          const [x1, y1] = pt(a, rOut - 2)
          const [x2, y2] = pt(a, rOut + 6)
          return <line key={`hb${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--info)" strokeWidth="2" strokeLinecap="round" />
        })}
      {props.stopMs !== undefined && props.stopMs >= props.dayStartMs && props.stopMs < props.dayStartMs + 86_400_000 && (
        <line x1={pt(angle(props.stopMs), rIn - 6)[0]} y1={pt(angle(props.stopMs), rIn - 6)[1]} x2={pt(angle(props.stopMs), rOut + 8)[0]} y2={pt(angle(props.stopMs), rOut + 8)[1]} stroke="var(--bad)" strokeWidth="2" strokeDasharray="4 3" />
      )}
      {props.nowMs >= props.dayStartMs && props.nowMs < props.dayStartMs + 86_400_000 && (
        <line x1={cx} y1={cy} x2={pt(nowA, rOut + 4)[0]} y2={pt(nowA, rOut + 4)[1]} stroke="var(--text)" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
      )}
      <circle cx={cx} cy={cy} r={rIn - 14} fill="none" stroke="var(--line)" strokeWidth="5" />
      <circle
        cx={cx}
        cy={cy}
        r={rIn - 14}
        fill="none"
        stroke={fill > 1 ? "var(--bad)" : fill > 0.85 ? "var(--warn)" : "var(--ok)"}
        strokeWidth="5"
        strokeDasharray={`${2 * Math.PI * (rIn - 14) * Math.min(1, fill)} 999`}
        transform={`rotate(-90 ${cx} ${cy})`}
        strokeLinecap="round"
      />
      <text x={cx} y={cy - 8} textAnchor="middle" className="disc-big">
        {formatAmount(props.spent / 10n ** BigInt(props.decimals), 0)}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" className="disc-small">
        of {formatAmount(props.perDayCap / 10n ** BigInt(props.decimals), 0)} {props.currency}
      </text>
    </svg>
  )
}
