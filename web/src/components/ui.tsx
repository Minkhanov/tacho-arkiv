import { useState, type ReactNode } from "react"
import { TIRAMISU } from "../../../src/core/constants.ts"
import { curlFor, queryString, type QuerySpec } from "../../../src/core/queries.ts"
import type { Check } from "../../../src/core/verify.ts"

export const short = (h?: string, n = 6) => (!h ? "—" : h.length > 2 + n * 2 ? `${h.slice(0, 2 + n)}…${h.slice(-4)}` : h)

export function Addr({ value, label }: { value?: string; label?: string }) {
  if (!value) return <span className="mono dim">—</span>
  return (
    <a className="mono addr" href={`${TIRAMISU.dataExplorer}/owner/${value}`} target="_blank" rel="noreferrer" title={value}>
      {label ? <span className="addr-label">{label}</span> : null}
      {short(value)}
    </a>
  )
}

export function EntityLink({ value }: { value: string }) {
  return (
    <a className="mono" href={`${TIRAMISU.dataExplorer}/entity/${value}`} target="_blank" rel="noreferrer" title={`Open ${value} in the Arkiv Data Explorer`}>
      {short(value)}
    </a>
  )
}

export function Badge({ tone, children, title }: { tone: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  )
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="btn-ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  )
}

/** Every panel can show the exact query behind it, and the curl that reproduces it without this app. */
export function QueryBox({ spec, atBlock }: { spec: QuerySpec; atBlock?: bigint }) {
  const [open, setOpen] = useState(false)
  const q = queryString(spec)
  const curl = curlFor(spec, atBlock === undefined ? { limit: 50 } : { limit: 50, atBlock })
  return (
    <div className="querybox">
      <button className="btn-ghost querybox-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "hide query" : "</> query"}
      </button>
      {open && (
        <div className="querybox-body">
          <p className="dim small">{spec.why}</p>
          <div className="code-row">
            <code>{q}</code>
            <Copy text={q} />
          </div>
          <div className="code-row">
            <code className="curl">{curl}</code>
            <Copy text={curl} />
          </div>
        </div>
      )}
    </div>
  )
}

export function Panel({ title, aside, children, className }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ""}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

export function Checklist({ checks }: { checks: Check[] }) {
  return (
    <ul className="checklist">
      {checks.map((c) => (
        <li key={c.id} className={`check check-${c.status}`}>
          <span className="check-mark" aria-hidden>
            {{ pass: "✔", fail: "✘", warn: "!", skip: "·" }[c.status]}
          </span>
          <div>
            <div className="check-label">{c.label}</div>
            <div className="check-detail">{c.detail}</div>
            {c.query && <code className="check-query">{c.query}</code>}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** A ring that empties as the lease runs out. */
export function LeaseRing({ secondsLeft, leaseSeconds }: { secondsLeft: number; leaseSeconds: number }) {
  const frac = Math.max(0, Math.min(1, secondsLeft / leaseSeconds))
  const r = 26
  const c = 2 * Math.PI * r
  const tone = secondsLeft <= 0 ? "var(--bad)" : frac < 0.2 ? "var(--warn)" : "var(--ok)"
  return (
    <svg className="lease-ring" viewBox="0 0 64 64" role="img" aria-label={`lease ${Math.round(frac * 100)} % left`}>
      <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line)" strokeWidth="6" />
      <circle cx="32" cy="32" r={r} fill="none" stroke={tone} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 32 32)" />
    </svg>
  )
}

export function Spinner({ label = "reading Arkiv…" }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" />
      {label}
    </div>
  )
}

export function ErrorNote({ error }: { error?: Error }) {
  if (!error) return null
  return <p className="error">Could not read Arkiv: {error.message.split("\n")[0]}</p>
}
