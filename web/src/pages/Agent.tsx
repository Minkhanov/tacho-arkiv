import { useEffect, useMemo, useRef, useState } from "react"
import { ExpirationTime } from "@arkiv-network/sdk"
import { REASON, TIRAMISU } from "../../../src/core/constants.ts"
import { unseal } from "../../../src/core/crypto.ts"
import { parseAck, parseMandate, parseRecord, recordAad, sameAddr, type Ack, type Hex, type Mandate, type TachoRecord } from "../../../src/core/entities.ts"
import { fateOf, lifecycle, type LifecycleEvent, type MandateFate } from "../../../src/core/history.ts"
import { dayWindow, formatAmount, type Address } from "../../../src/core/policy.ts"
import { acksForMandate, forgeriesForMandate, mandatesForAgent, recordsByAgent, sealedByAgent, spentSince, unsealedByAgent } from "../../../src/core/queries.ts"
import { blockToDate, humanDuration, secondsLeft } from "../../../src/core/time.ts"
import { connectWallet, DEMO, onEntityEvent, publicClient, reader } from "../arkiv.ts"
import { Addr, Badge, EntityLink, ErrorNote, LeaseRing, Panel, QueryBox, Spinner } from "../components/ui.tsx"
import { TachoDisc, type DiscMark } from "../components/TachoDisc.tsx"
import { go, useAsync, useHead } from "../hooks.ts"

const REASON_TEXT: Record<string, string> = {
  [REASON.ok]: "within policy",
  [REASON.noLiveMandate]: "no live mandate",
  [REASON.wrongAgent]: "mandate names another agent",
  [REASON.kindNotAllowed]: "kind not granted",
  [REASON.counterpartyNotAllowed]: "counterparty not allowed",
  [REASON.overActionCap]: "over per-action cap",
  [REASON.overDayCap]: "over daily cap",
  [REASON.invalidAmount]: "invalid amount",
}

function parseAll<T>(rows: unknown[], parse: (e: never) => T): T[] {
  const out: T[] = []
  for (const r of rows) {
    try {
      out.push(parse(r as never))
    } catch {
      /* not a valid tacho/v1 entity: skip it rather than trust it */
    }
  }
  return out
}

interface MandateView {
  mandate: Mandate
  live: boolean
  fate: MandateFate
  events: LifecycleEvent[]
  forged: TachoRecord[]
  acks: Ack[]
}

/**
 * Everything the inspector knows about an agent, from Arkiv alone: the records it wrote
 * (`$creator`), every mandate they cite plus any live mandate naming it, each mandate's lifecycle
 * from the event logs, and the records that cite those mandates but were written by someone else.
 */
async function loadAgent(agent: Address) {
  const [mRows, rRows, uRows, head] = await Promise.all([
    reader.find(mandatesForAgent(agent), { max: 50 }),
    reader.find(recordsByAgent(agent), { max: 400 }),
    reader.find(unsealedByAgent(agent), { max: 50 }),
    reader.head(),
  ])
  const live = parseAll(mRows, parseMandate)
  const records = parseAll(rRows, parseRecord)
  const unsealed = parseAll(uRows, parseRecord)

  // Mandates to show: the live ones, then the most recent ones the records cite (expired or revoked).
  const order: string[] = []
  for (const m of live) order.push(m.key.toLowerCase())
  for (const r of records) if (!order.includes(r.mandate.toLowerCase())) order.push(r.mandate.toLowerCase())
  const keys = order.slice(0, 4) // three queries per mandate: keep a page load cheap

  const views: MandateView[] = []
  for (const k of keys) {
    let mandate = live.find((m) => m.key.toLowerCase() === k)
    const isLive = !!mandate
    if (!mandate) {
      // No longer live: read it as of the first block a record cites it (atBlock).
      const cites = records.filter((r) => r.mandate.toLowerCase() === k)
      const first = cites.reduce((b, r) => (r.createdAt < b ? r.createdAt : b), cites[0]!.createdAt)
      const past = await reader.getEntityAt(k as Hex, first)
      if (!past) continue
      try {
        mandate = parseMandate(past)
      } catch {
        continue
      }
    }
    const [events, forgedRows, ackRows] = await Promise.all([
      lifecycle(publicClient, mandate.key, mandate.createdAt, head).catch(() => [] as LifecycleEvent[]),
      reader.find(forgeriesForMandate(mandate.key, mandate.agent), { max: 50 }),
      reader.find(acksForMandate(mandate.key), { max: 200 }),
    ])
    views.push({
      mandate,
      live: isLive,
      events,
      fate: fateOf(events, head, isLive ? mandate.expiresAt : undefined),
      forged: parseAll(forgedRows, parseRecord),
      acks: parseAll(ackRows, parseAck),
    })
  }
  // record key -> the counterparty wallets ($creator) that acknowledged it
  const honoured = new Map<string, Address[]>()
  for (const a of views.flatMap((v) => v.acks)) honoured.set(a.record.toLowerCase(), [...(honoured.get(a.record.toLowerCase()) ?? []), a.writer])
  return { views, records, unsealed, forged: views.flatMap((v) => v.forged), honoured, head, headAt: Date.now() }
}

export function AgentPage({ agent, dataKey, expectedPrincipal }: { agent: Address; dataKey?: string; expectedPrincipal?: Address }) {
  const head = useHead()
  const principal = expectedPrincipal ?? (sameAddr(agent, DEMO.agent) ? DEMO.principal : undefined)
  const state = useAsync(() => loadAgent(agent), [agent])

  // Live: react to entity events over WebSocket instead of polling.
  const [lastEvent, setLastEvent] = useState<string>()
  const reloadTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const keys = useMemo(() => new Set((state.data?.views ?? []).map((v) => v.mandate.key.toLowerCase())), [state.data])
  useEffect(() => {
    return onEntityEvent((e) => {
      const ours = ("owner" in e && sameAddr(e.owner, agent)) || keys.has(e.entityKey.toLowerCase())
      if (!ours) return
      setLastEvent(`${e.type} · block ${e.blockNumber}`)
      clearTimeout(reloadTimer.current)
      reloadTimer.current = setTimeout(state.reload, 1200)
    })
  }, [agent, keys, state.reload])
  // No timer: every Arkiv query costs the public RPC's anonymous budget (see README › Rate limits of the public RPC),
  // and a page left open must not burn it. Forgeries come from wallets nobody can predict, so they show up on "refresh".

  const [details, setDetails] = useState<Record<string, Record<string, unknown> | "error">>({})
  useEffect(() => {
    if (!dataKey || !state.data) return
    for (const r of state.data.records) {
      if (details[r.key] || !r.envelope) continue
      unseal<Record<string, unknown>>(r.envelope, dataKey, recordAad(r)).then(
        (d) => setDetails((x) => ({ ...x, [r.key]: d })),
        () => setDetails((x) => ({ ...x, [r.key]: "error" })),
      )
    }
  }, [dataKey, state.data, details])

  const data = state.data
  const liveCount = data?.views.filter((v) => v.live).length ?? 0
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Agent inspection</p>
          <h1 className="mono">{agent}</h1>
          <p className="dim">
            Read in your browser straight from Arkiv (Tiramisu). There is no Tacho server.{" "}
            {lastEvent ? <Badge tone="info">live · {lastEvent}</Badge> : <Badge tone="muted">live via WebSocket</Badge>}
          </p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={state.reload} disabled={state.loading}>
            {state.loading ? "reading…" : "refresh"}
          </button>
        </div>
      </div>

      <ErrorNote error={state.error} />
      {!data && state.loading && <Spinner />}

      {data && (
        <>
          <Panel title={`Authority · ${liveCount} live mandate${liveCount === 1 ? "" : "s"}`} aside={<QueryBox spec={mandatesForAgent(agent)} />}>
            {liveCount === 0 && (
              <p className="empty">
                No live mandate names this agent. Whatever it tries now is refused and recorded with reason <code>no_live_mandate</code>. A mandate leaves the query surface the moment its lease runs out or its principal revokes it.
              </p>
            )}
            <div className="mandates">
              {data.views.map((v) => (
                <MandateCard key={v.mandate.key} v={v} head={head ?? data.head} headRef={{ block: data.head, timeMs: data.headAt }} records={data.records} expectedPrincipal={principal} />
              ))}
            </div>
          </Panel>

          {data.forged.length > 0 && (
            <Panel className="panel-bad" title={`Forged records · ${data.forged.length}`} aside={data.views[0] ? <QueryBox spec={forgeriesForMandate(data.views[0].mandate.key, data.views[0].mandate.agent)} /> : undefined}>
              <p className="dim">
                These records copy our project attribute, the record type and the mandate key — anyone can write those. Their <code>$creator</code> is not the agent the mandate names, so they count for nothing.
              </p>
              <RecordsTable records={data.forged} forged details={{}} />
            </Panel>
          )}

          {data.unsealed.length > 0 && (
            <Panel className="panel-bad" title={`Unsealed records · ${data.unsealed.length}`} aside={<QueryBox spec={unsealedByAgent(agent)} />}>
              <p className="dim">
                Written by this agent but not owned by the seal address, so their <code>$owner</code> could still delete them. A Tacho runtime never leaves a record like this; a counterparty refuses to honour it.
              </p>
              <RecordsTable records={data.unsealed} details={details} head={head} />
            </Panel>
          )}

          <Panel
            title={
              <>
                Records · {data.records.length}{" "}
                {data.records.length > 0 && data.unsealed.length === 0 && <Badge tone="info">all sealed: $owner = 0x…dEaD</Badge>}
              </>
            }
            aside={
              <div className="asides">
                <QueryBox spec={recordsByAgent(agent)} />
                <QueryBox spec={sealedByAgent(agent)} />
              </div>
            }
          >
            <p className="dim">
              One sealed record per attempt, allowed or refused, written by the agent's wallet (<code>$creator</code>) and handed to the seal address in the same atomic batch, so nobody can delete it.
              {!dataKey && " Details are encrypted; open this page with the data key in the link (#…?k=…) to read them."}
            </p>
            <RecordsTable records={data.records} details={details} head={head} honoured={data.honoured} />
          </Panel>
        </>
      )}
    </div>
  )
}

function FateBadge({ fate, head }: { fate: MandateFate; head: bigint }) {
  if (fate.state === "live") return <Badge tone="ok">live · {humanDuration(secondsLeft(fate.expiresAt, head))} left</Badge>
  if (fate.state === "revoked")
    return (
      <a href={`${TIRAMISU.explorer}/tx/${fate.txHash}`} target="_blank" rel="noreferrer">
        <Badge tone="bad">revoked at block {fate.block.toString()}</Badge>
      </a>
    )
  return <Badge tone="warn">lease expired at block {fate.block.toString()}</Badge>
}

function MandateCard({ v, head, headRef, records, expectedPrincipal }: { v: MandateView; head: bigint; headRef: { block: bigint; timeMs: number }; records: TachoRecord[]; expectedPrincipal?: Address }) {
  const m = v.mandate
  const p = m.policy
  const mine = records.filter((r) => r.mandate.toLowerCase() === m.key.toLowerCase())
  // Show the policy day of the latest activity: today for a live mandate, the day it ended otherwise.
  const anchorMs = v.live ? Date.now() : Math.max(...mine.map((r) => r.tsMs), blockToDate(m.createdAt, headRef).getTime())
  const { startMs, endMs } = dayWindow(anchorMs, p.dayOffsetMinutes)
  const day = mine.filter((r) => r.tsMs >= startMs && r.tsMs < endMs)
  const spent = day.filter((r) => r.verdict === "allowed").reduce((s, r) => s + r.amount, 0n)
  const left = v.live ? secondsLeft(m.expiresAt, head) : 0
  const heartbeats = v.events.filter((e) => e.type === "ExpiryExtended")
  const marks: DiscMark[] = [
    ...day.map((r) => ({ key: r.key, tsMs: r.tsMs, amount: r.amount, kind: r.verdict === "allowed" ? ("allowed" as const) : ("refused" as const) })),
    ...v.forged.filter((r) => r.tsMs >= startMs && r.tsMs < endMs).map((r) => ({ key: r.key, tsMs: r.tsMs, amount: r.amount, kind: "forged" as const })),
  ]
  const principalOk = expectedPrincipal ? sameAddr(m.principal, expectedPrincipal) : undefined
  return (
    <article className={`mandate ${v.live ? "" : "mandate-past"}`}>
      <div className="mandate-main">
        <div className="mandate-lease">
          <LeaseRing secondsLeft={left} leaseSeconds={p.leaseSeconds} />
          <div>
            <div className="big">{v.live ? humanDuration(left) : v.fate.state === "revoked" ? "revoked" : "expired"}</div>
            <div className="dim small">
              {v.live ? "lease left · renewed by the principal's heartbeat" : "no authority: the agent's next attempt is refused"} · <FateBadge fate={v.fate} head={head} />
            </div>
          </div>
        </div>
        <dl className="facts">
          <dt>mandate</dt>
          <dd>
            <EntityLink value={m.key} />
          </dd>
          <dt>principal ($creator)</dt>
          <dd>
            <Addr value={m.principal} /> {principalOk === true && <Badge tone="ok">expected principal</Badge>}
            {principalOk === false && <Badge tone="bad">not the expected principal</Badge>}
          </dd>
          <dt>may spend on</dt>
          <dd>{p.kinds.join(", ")}</dd>
          <dt>limits</dt>
          <dd>
            ≤ {formatAmount(p.perActionCap, p.decimals)} per action · ≤ {formatAmount(p.perDayCap, p.decimals)} {p.currency} per day <span className="dim">(UTC{p.dayOffsetMinutes >= 0 ? "+" : ""}{p.dayOffsetMinutes / 60})</span>
          </dd>
          <dt>lifecycle (event logs)</dt>
          <dd>
            issued at block {m.createdAt.toString()} · {heartbeats.length} heartbeat{heartbeats.length === 1 ? "" : "s"}
            {v.fate.state === "revoked" ? ` · revoked at block ${v.fate.block}` : v.fate.state === "expired" ? ` · lease ran out at block ${v.fate.block}` : ""}
          </dd>
          <dt>evidence kept</dt>
          <dd>{p.retentionDays} days, extendable by anyone</dd>
          <dt>flags</dt>
          <dd>
            <Badge tone="info" title="The limits cannot be changed under the agent: revoke and reissue instead">readonly</Badge> <Badge tone="muted" title="Only the principal can renew the lease">owner-only extension</Badge>
          </dd>
        </dl>
        <p className="purpose">{p.purpose}</p>
        <QueryBox spec={spentSince(m.key, m.agent, startMs)} />
      </div>
      <TachoDisc
        marks={marks}
        ticks={heartbeats.map((h) => blockToDate(h.block, headRef).getTime())}
        stopMs={v.fate.state === "revoked" ? blockToDate(v.fate.block, headRef).getTime() : undefined}
        dayStartMs={startMs}
        perActionCap={p.perActionCap}
        spent={spent}
        perDayCap={p.perDayCap}
        decimals={p.decimals}
        currency={p.currency}
        nowMs={Date.now()}
      />
    </article>
  )
}

function RecordsTable({ records, details, forged, head, honoured }: { records: TachoRecord[]; details: Record<string, Record<string, unknown> | "error">; forged?: boolean; head?: bigint; honoured?: Map<string, Address[]> }) {
  const [busy, setBusy] = useState<string>()
  const [msg, setMsg] = useState<string>()
  if (records.length === 0) return <p className="empty">No records yet.</p>
  const extend = async (key: Hex) => {
    setBusy(key)
    setMsg(undefined)
    try {
      const { writer, account } = await connectWallet()
      const r = await writer.extendEntity({ entityKey: key, expires: ExpirationTime.fromDays(60) })
      setMsg(`Extended by ${account} (a wallet that does not own the record): tx ${r.txHash}`)
    } catch (err) {
      setMsg((err as Error).message.split("\n")[0])
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <div className="table-wrap">
      {msg && <p className="note">{msg}</p>}
      <table className="records">
        <thead>
          <tr>
            <th>time</th>
            <th>kind</th>
            <th className="num">amount, RUB</th>
            <th>verdict</th>
            <th>written by</th>
            <th>evidence</th>
            <th>details</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {records.map((r) => {
            const d = details[r.key]
            return (
              <tr key={r.key} className={forged ? "row-bad" : r.verdict === "allowed" ? "row-ok" : "row-warn"}>
                <td className="mono">{new Date(r.tsMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                <td>{r.kind}</td>
                <td className="num mono">{formatAmount(r.amount, 2)}</td>
                <td>
                  {forged ? <Badge tone="bad">claims {r.verdict}</Badge> : r.verdict === "allowed" ? <Badge tone="ok">allowed</Badge> : <Badge tone="warn">refused</Badge>}
                  <div className="dim small">{REASON_TEXT[r.reason] ?? r.reason}</div>
                  {honoured?.get(r.key.toLowerCase())?.map((w) => (
                    <div key={w} className="small" title={`Acknowledged by ${w} ($creator of the ack entity)`}>
                      <Badge tone="info">honoured by {w.slice(0, 8)}…</Badge>
                    </div>
                  ))}
                </td>
                <td>
                  <Addr value={r.writer} /> {forged ? <Badge tone="bad">forged</Badge> : <Badge tone="ok">agent</Badge>}
                </td>
                <td>
                  {r.sealed ? (
                    <Badge tone="info" title="Owner is the seal address: nobody can delete it">
                      sealed
                    </Badge>
                  ) : (
                    <Badge tone="warn">not sealed</Badge>
                  )}
                  <div className="dim small">{head !== undefined ? `kept ${humanDuration(secondsLeft(r.expiresAt, head))}` : `until block ${r.expiresAt}`}</div>
                </td>
                <td className="details">{d === "error" ? <span className="dim">wrong key</span> : d ? <DetailText d={d} /> : <span className="dim">encrypted</span>}</td>
                <td className="actions">
                  <button className="btn-ghost" onClick={() => go(`record/${r.key}`)}>
                    verify
                  </button>
                  {!forged && r.permissionlessExtension && (
                    <button className="btn-ghost" disabled={busy === r.key} onClick={() => void extend(r.key)} title="Any wallet may extend this record's retention (permissionlessExtension)">
                      {busy === r.key ? "…" : "keep 60 d"}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function DetailText({ d }: { d: Record<string, unknown> }) {
  const parts = [d.vehicle, d.station ?? d.plaza ?? d.shop, d.liters ? `${d.liters} l` : undefined].filter(Boolean)
  return (
    <span title={JSON.stringify(d, null, 2)}>
      {parts.join(" · ")}
      {typeof d.rationale === "string" && <div className="dim small">“{d.rationale}”</div>}
    </span>
  )
}
