import { useEffect, useRef, useState } from "react"
import { parseMandate, type Hex, type Mandate } from "../../../src/core/entities.ts"
import { issueMandate, renewMandate, revokeMandate } from "../../../src/core/ops.ts"
import { demoPolicy, formatAmount, type Address } from "../../../src/core/policy.ts"
import { mandatesByPrincipal } from "../../../src/core/queries.ts"
import { humanDuration, secondsLeft } from "../../../src/core/time.ts"
import type { TachoWriter } from "../../../src/core/writer.ts"
import { connectWallet, DEMO, reader } from "../arkiv.ts"
import { Badge, EntityLink, Panel, QueryBox } from "../components/ui.tsx"
import { go, useHead } from "../hooks.ts"

/**
 * The principal's side, signed by a browser wallet. Optional: the inspector needs no wallet.
 * Writing needs test GLM on Tiramisu (hub.arkiv.network/faucet).
 */
export function ConsolePage() {
  const head = useHead()
  const [w, setW] = useState<{ account: Address; writer: TachoWriter }>()
  const [mandates, setMandates] = useState<Mandate[]>([])
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [agent, setAgent] = useState<string>(DEMO.agent)
  const [perAction, setPerAction] = useState("15000")
  const [perDay, setPerDay] = useState("40000")
  const [kinds, setKinds] = useState("fuel,toll")
  const [lease, setLease] = useState("900")
  const [auto, setAuto] = useState(false)
  const autoRef = useRef<ReturnType<typeof setInterval>>(undefined)

  const say = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 30))
  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true)
    try {
      say(`${label}: ${await fn()}`)
      await refresh()
    } catch (err) {
      say(`${label} failed: ${(err as Error).message.split("\n")[0]}`)
    } finally {
      setBusy(false)
    }
  }
  const refresh = async (account = w?.account) => {
    if (!account) return
    const rows = await reader.find(mandatesByPrincipal(account), { max: 50 })
    const out: Mandate[] = []
    for (const e of rows) {
      try {
        out.push(parseMandate(e))
      } catch {
        /* ignore */
      }
    }
    setMandates(out)
  }

  useEffect(() => {
    clearInterval(autoRef.current)
    if (!auto || !w) return
    // "The human is still here": renew every live mandate once a minute while this tab is open.
    autoRef.current = setInterval(() => {
      for (const m of mandates) void renewMandate(w.writer, m.key, m.policy.leaseSeconds).then((r) => say(`auto heartbeat ${m.key.slice(0, 10)}…: tx ${r.txHash}`), (e: Error) => say(`auto heartbeat failed: ${e.message.split("\n")[0]}`))
    }, 60_000)
    return () => clearInterval(autoRef.current)
  }, [auto, w, mandates])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Principal console</p>
          <h1>Grant, renew and revoke authority</h1>
          <p className="dim">Signs with your browser wallet on the Tiramisu testnet. The inspector does not need this page; it is here so you can play the principal yourself.</p>
        </div>
        <div className="head-actions">
          {w ? (
            <Badge tone="ok">connected {w.account.slice(0, 8)}…</Badge>
          ) : (
            <button
              className="btn"
              onClick={() =>
                void connectWallet().then(
                  (x) => {
                    setW(x)
                    void refresh(x.account)
                  },
                  (e: Error) => say(e.message),
                )
              }
            >
              Connect wallet
            </button>
          )}
        </div>
      </div>

      <div className="grid-2">
        <Panel title="Issue a mandate">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!w) return say("connect a wallet first")
              const policy = demoPolicy({
                perActionCap: BigInt(Math.round(Number(perAction) * 100)),
                perDayCap: BigInt(Math.round(Number(perDay) * 100)),
                kinds: kinds.split(",").map((k) => k.trim()).filter(Boolean),
                leaseSeconds: Math.max(30, Math.round(Number(lease) / 2) * 2),
                purpose: "Mandate issued from the Tacho principal console (synthetic test data).",
              })
              void run("issue", async () => {
                const r = await issueMandate(w.writer, agent as Address, policy)
                return `mandate ${r.mandateKey} (tx ${r.txHash})`
              })
            }}
          >
            <label>
              agent wallet
              <input value={agent} onChange={(e) => setAgent(e.target.value)} spellCheck={false} />
            </label>
            <div className="row">
              <label>
                per action, RUB
                <input value={perAction} onChange={(e) => setPerAction(e.target.value)} inputMode="decimal" />
              </label>
              <label>
                per day, RUB
                <input value={perDay} onChange={(e) => setPerDay(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            <div className="row">
              <label>
                kinds
                <input value={kinds} onChange={(e) => setKinds(e.target.value)} />
              </label>
              <label>
                lease, seconds
                <input value={lease} onChange={(e) => setLease(e.target.value)} inputMode="numeric" />
              </label>
            </div>
            <button className="btn" disabled={!w || busy}>
              Issue (readonly, owner-only extension)
            </button>
          </form>
        </Panel>

        <Panel title={`Your live mandates · ${mandates.length}`} aside={w ? <QueryBox spec={mandatesByPrincipal(w.account)} /> : undefined}>
          {!w && <p className="empty">Connect a wallet to see the mandates it has issued.</p>}
          {w && mandates.length === 0 && <p className="empty">None live. Expired and revoked mandates leave the query surface.</p>}
          <ul className="mlist">
            {mandates.map((m) => (
              <li key={m.key}>
                <div>
                  <EntityLink value={m.key} /> → agent <span className="mono">{m.agent.slice(0, 10)}…</span>
                  <div className="dim small">
                    {m.policy.kinds.join(", ")} · ≤ {formatAmount(m.policy.perActionCap, 2)} / action · ≤ {formatAmount(m.policy.perDayCap, 2)} / day · lease {head !== undefined ? humanDuration(secondsLeft(m.expiresAt, head)) : "…"}
                  </div>
                </div>
                <div className="actions">
                  <button className="btn-ghost" disabled={busy} onClick={() => void run("heartbeat", async () => `tx ${(await renewMandate(w!.writer, m.key as Hex, m.policy.leaseSeconds)).txHash}`)}>
                    heartbeat
                  </button>
                  <button className="btn-ghost danger" disabled={busy} onClick={() => void run("revoke", async () => `tx ${(await revokeMandate(w!.writer, m.key as Hex)).txHash}`)}>
                    revoke
                  </button>
                  <button className="btn-ghost" onClick={() => go(`agent/${m.agent}`)}>
                    inspect
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {w && (
            <label className="toggle">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> keep renewing every minute while this tab is open
            </label>
          )}
        </Panel>
      </div>

      <Panel title="Activity">
        {log.length === 0 ? <p className="empty">Nothing yet.</p> : <pre className="log">{log.join("\n")}</pre>}
      </Panel>
    </div>
  )
}
