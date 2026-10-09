import type { Hex } from "../../src/core/entities.ts"
import type { Address } from "../../src/core/policy.ts"
import { TIRAMISU } from "../../src/core/constants.ts"
import { useRoute } from "./hooks.ts"
import { AgentPage } from "./pages/Agent.tsx"
import { ConsolePage } from "./pages/Console.tsx"
import { HomePage } from "./pages/Home.tsx"
import { RecordPage } from "./pages/Record.tsx"

const isAddr = (s?: string): s is Address => !!s && /^0x[0-9a-fA-F]{40}$/.test(s)
const isKey = (s?: string): s is Hex => !!s && /^0x[0-9a-fA-F]{64}$/.test(s)

export function App() {
  const { path, params } = useRoute()
  const k = params.get("k") ?? undefined
  const dataKey = k && /^[A-Za-z0-9_-]{43}$/.test(k) ? k : undefined
  const p = params.get("principal") ?? undefined
  const principal = isAddr(p) ? p : undefined
  const [page, arg] = path

  let body
  if (page === "agent" && isAddr(arg)) body = <AgentPage key={arg} agent={arg} dataKey={dataKey} expectedPrincipal={principal} />
  else if (page === "record" && isKey(arg)) body = <RecordPage key={arg} recordKey={arg} dataKey={dataKey} expectedPrincipal={principal} />
  else if (page === "console") body = <ConsolePage />
  else body = <HomePage />

  return (
    <>
      <nav className="nav">
        <a className="brand" href="#/">
          <svg viewBox="0 0 64 64" width="22" height="22" aria-hidden>
            <circle cx="32" cy="32" r="28" fill="none" stroke="var(--ok)" strokeWidth="5" />
            <path d="M32 32 44 20" stroke="var(--warn)" strokeWidth="5" strokeLinecap="round" />
            <circle cx="32" cy="32" r="4" fill="var(--text)" />
          </svg>
          tacho
        </a>
        <div className="nav-links">
          <a href="#/">overview</a>
          <a href="#/agent/0xF743C97D950ac24164Ef0B045AD90baC59BA6A8f">demo agent</a>
          <a href="#/console">principal console</a>
          <a href="https://github.com/Minkhanov/tacho-arkiv" target="_blank" rel="noreferrer">
            source
          </a>
        </div>
        <span className="net" title={TIRAMISU.http}>
          <span className="dot" /> Tiramisu · 7738577
        </span>
      </nav>
      <main>{body}</main>
      <footer className="foot">
        <span>MIT · synthetic data only · reads go from your browser to the public Arkiv RPC</span>
        <a href={TIRAMISU.explorer} target="_blank" rel="noreferrer">
          block explorer
        </a>
        <a href={TIRAMISU.dataExplorer} target="_blank" rel="noreferrer">
          data explorer
        </a>
      </footer>
    </>
  )
}
