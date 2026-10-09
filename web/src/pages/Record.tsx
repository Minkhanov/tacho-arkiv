import { useEffect, useState } from "react"
import { unseal } from "../../../src/core/crypto.ts"
import { recordAad, type Hex } from "../../../src/core/entities.ts"
import { formatAmount, type Address } from "../../../src/core/policy.ts"
import { byKey } from "../../../src/core/queries.ts"
import { verifyRecord } from "../../../src/core/verify.ts"
import { DEMO, reader } from "../arkiv.ts"
import { Addr, Badge, Checklist, EntityLink, ErrorNote, Panel, QueryBox, Spinner } from "../components/ui.tsx"
import { go, useAsync } from "../hooks.ts"

/** The counterparty's view: may I honour this record? */
export function RecordPage({ recordKey, dataKey, expectedPrincipal }: { recordKey: Hex; dataKey?: string; expectedPrincipal?: Address }) {
  const principal = expectedPrincipal ?? DEMO.principal
  const state = useAsync(() => verifyRecord(reader, recordKey, { expectedPrincipal: principal }), [recordKey, principal])
  const [details, setDetails] = useState<Record<string, unknown> | "error">()
  const rec = state.data?.record
  useEffect(() => {
    if (!dataKey || !rec?.envelope) return
    unseal<Record<string, unknown>>(rec.envelope, dataKey, recordAad(rec)).then(setDetails, () => setDetails("error"))
  }, [dataKey, rec])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Counterparty check</p>
          <h1 className="mono">{recordKey}</h1>
          <p className="dim">What a fuel station runs before it pumps: authorship from <code>$creator</code>, the mandate as of the record's block, and the daily cap recomputed from the agent's own records. Nothing the agent says about itself is trusted.</p>
        </div>
      </div>
      <ErrorNote error={state.error} />
      {state.loading && !state.data && <Spinner label="checking the record against Arkiv…" />}
      {state.data && (
        <div className="grid-2">
          <Panel
            title={
              <>
                Verdict {state.data.ok ? <Badge tone="ok">honour it</Badge> : <Badge tone="bad">do not honour</Badge>}
              </>
            }
            aside={<QueryBox spec={byKey(recordKey)} />}
          >
            <p className="dim small">
              Expected principal <Addr value={principal} />. Change it with <code>?principal=0x…</code> in the link.
            </p>
            <Checklist checks={state.data.checks} />
          </Panel>
          <Panel title="The record">
            {rec ? (
              <dl className="facts">
                <dt>key</dt>
                <dd>
                  <EntityLink value={rec.key} />
                </dd>
                <dt>written by ($creator)</dt>
                <dd>
                  <Addr value={rec.writer} />
                </dd>
                <dt>owner ($owner)</dt>
                <dd>
                  <Addr value={rec.owner} /> {rec.sealed && <Badge tone="info">seal address</Badge>}
                </dd>
                <dt>action</dt>
                <dd>
                  {rec.kind} · {formatAmount(rec.amount, 2)} {state.data.mandate?.policy.currency ?? ""}
                </dd>
                <dt>verdict</dt>
                <dd>
                  {rec.verdict} <span className="dim">({rec.reason})</span>
                </dd>
                <dt>block</dt>
                <dd className="mono">{rec.createdAt.toString()}</dd>
                <dt>kept until block</dt>
                <dd className="mono">{rec.expiresAt.toString()}</dd>
                <dt>mandate</dt>
                <dd>
                  <EntityLink value={rec.mandate} />
                </dd>
                <dt>details</dt>
                <dd>{details === "error" ? <span className="dim">this key does not open it</span> : details ? <pre className="json">{JSON.stringify(details, null, 2)}</pre> : <span className="dim">encrypted (AES-256-GCM); add ?k=… to the link to open</span>}</dd>
              </dl>
            ) : (
              <p className="empty">No record to show.</p>
            )}
            {state.data.mandate && (
              <p>
                <button className="btn-ghost" onClick={() => go(`agent/${state.data!.mandate!.agent}`)}>
                  inspect the agent →
                </button>
              </p>
            )}
          </Panel>
        </div>
      )}
    </div>
  )
}
