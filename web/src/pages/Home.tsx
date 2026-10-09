import { useEffect, useState } from "react"
import { parseMandate, parseRecord, sameAddr, type Hex, type Mandate, type TachoRecord } from "../../../src/core/entities.ts"
import { formatAmount } from "../../../src/core/policy.ts"
import { namespaceRecords } from "../../../src/core/queries.ts"
import { DEMO, onEntityEvent, reader } from "../arkiv.ts"
import { Addr, Badge, ErrorNote, Panel, QueryBox, Spinner } from "../components/ui.tsx"
import { go, useAsync } from "../hooks.ts"

type FeedRow = { r: TachoRecord; status: "genuine" | "forged" | "unknown" }

/** Every tacho/v1 record from anyone, labelled by checking `$creator` against its mandate. */
async function loadFeed(): Promise<FeedRow[]> {
  const rows = await reader.find(namespaceRecords(), { max: 30 })
  const records: TachoRecord[] = []
  for (const e of rows) {
    try {
      records.push(parseRecord(e))
    } catch {
      /* skip entities that only pretend to be records */
    }
  }
  const mandates = new Map<string, Mandate | null>()
  for (const k of new Set(records.map((r) => r.mandate.toLowerCase()))) {
    // The mandate may have expired since; read it as of the first record's block that cites it.
    const firstBlock = records.filter((r) => r.mandate.toLowerCase() === k).reduce((b, r) => (r.createdAt < b ? r.createdAt : b), records[0]!.createdAt)
    const e = await reader.getEntityAt(k as Hex, firstBlock).catch(() => null)
    try {
      mandates.set(k, e ? parseMandate(e) : null)
    } catch {
      mandates.set(k, null)
    }
  }
  return records.map((r) => {
    const m = mandates.get(r.mandate.toLowerCase())
    return { r, status: !m ? "unknown" : sameAddr(m.agent, r.writer) ? "genuine" : "forged" }
  })
}

export function HomePage() {
  const [addr, setAddr] = useState<string>(DEMO.agent)
  const feed = useAsync(loadFeed, [])
  useEffect(() => onEntityEvent((e) => {
    if (e.type === "EntityCreated" && (sameAddr(e.owner, DEMO.agent) || sameAddr(e.owner, DEMO.forger))) setTimeout(feed.reload, 1500)
  }), [feed.reload])

  return (
    <div className="page">
      <section className="hero">
        <p className="eyebrow">Arkiv · Tiramisu testnet · CROPS</p>
        <h1>
          A tachograph for <span className="accent">AI agents</span>.
        </h1>
        <p className="lede">
          A truck's tachograph records driving time so that neither the driver nor the haulier can rewrite it, and an inspector reads it at the roadside. An AI agent that spends a company's money has no such device: its log sits in the vendor's database. Tacho puts the agent's authority and every action it takes on Arkiv, where the lease runs out on its own, nobody can delete the evidence, and anyone can read it without us.
        </p>
        <form
          className="lookup"
          onSubmit={(e) => {
            e.preventDefault()
            if (/^0x[0-9a-fA-F]{40}$/.test(addr.trim())) go(`agent/${addr.trim()}`)
          }}
        >
          <input value={addr} onChange={(e) => setAddr(e.target.value)} spellCheck={false} aria-label="Agent wallet address" placeholder="0x… agent wallet" />
          <button className="btn" type="submit">
            Inspect agent
          </button>
        </form>
        <p className="dim small">
          Pre-filled with the demo dispatcher agent. No wallet, no login, no Tacho server: this page queries the public Tiramisu RPC directly.
        </p>
      </section>

      <section className="how">
        <article>
          <h3>1 · The mandate is a lease</h3>
          <p>
            The principal grants the agent a mandate: what it may buy, the per-action and daily caps. It lives 15 minutes. The principal's heartbeat renews it with <code>extendEntity</code>. No heartbeat, no authority. Revoking deletes it, and an agent listening on a WebSocket stops on the event.
          </p>
        </article>
        <article>
          <h3>2 · Every attempt leaves a sealed record</h3>
          <p>
            Allowed or refused, each attempt becomes a record written by the agent's wallet. In the same atomic batch the record is handed to an address nobody holds: no operator can delete it. <code>readonly</code> blocks edits; any party can extend it during a dispute. The details are AES-GCM ciphertext.
          </p>
        </article>
        <article>
          <h3>3 · Trust comes from $creator</h3>
          <p>
            Anyone can write <code>project = tacho/v1</code>. A counterparty honours a record only if its <code>$creator</code> is the agent the mandate names, the mandate's <code>$creator</code> is the principal, the mandate was alive at the record's block, and the daily cap still holds.
          </p>
        </article>
      </section>

      <Panel title="Live: every tacho/v1 record, from anyone" aside={<QueryBox spec={namespaceRecords()} />}>
        <ErrorNote error={feed.error} />
        {feed.loading && !feed.data && <Spinner />}
        {feed.data && feed.data.length === 0 && <p className="empty">No records yet on this network.</p>}
        {feed.data && feed.data.length > 0 && (
          <table className="records compact">
            <thead>
              <tr>
                <th>time</th>
                <th>written by</th>
                <th>action</th>
                <th>claims</th>
                <th>check</th>
              </tr>
            </thead>
            <tbody>
              {feed.data.map(({ r, status }) => (
                <tr key={r.key} className={status === "forged" ? "row-bad" : ""} onClick={() => go(`record/${r.key}`)} style={{ cursor: "pointer" }}>
                  <td className="mono">{new Date(r.tsMs).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                  <td>
                    <Addr value={r.writer} />
                  </td>
                  <td>
                    {r.kind} {formatAmount(r.amount, 2)}
                  </td>
                  <td>{r.verdict === "allowed" ? <Badge tone="ok">allowed</Badge> : <Badge tone="warn">refused</Badge>}</td>
                  <td>{status === "genuine" ? <Badge tone="ok">$creator = mandate's agent</Badge> : status === "forged" ? <Badge tone="bad">forged: wrong $creator</Badge> : <Badge tone="muted">mandate not found</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  )
}
