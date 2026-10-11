#!/usr/bin/env node
/**
 * Tacho CLI. Every role in the demo is a separate wallet:
 *   principal    — the fleet owner who grants and renews the mandate
 *   agent        — the AI dispatcher that spends under it
 *   counterparty — the fuel station that checks a record before it pumps
 *   forger       — anyone else, writing a fake record into our namespace
 * Run `npm run tacho -- help`.
 */
import { ExpirationTime } from "@arkiv-network/sdk"
import { createWalletClient, formatEther, parseEther } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { meter, RpcBudgetError, rpcHttp, TIRAMISU_CHAIN, watchMandate } from "../core/clients.ts"
import { DEFAULTS, REASON, TIRAMISU, VERDICT } from "../core/constants.ts"
import { generateDataKey, unseal } from "../core/crypto.ts"
import { parseMandate, parseRecord, recordAad, recordBatch, type Hex } from "../core/entities.ts"
import { attempt, honour, issueMandate, loadMandate, renewMandate, revokeMandate, spentToday } from "../core/ops.ts"
import { demoPolicy, formatAmount, type Address } from "../core/policy.ts"
import { curlFor, forgeriesForMandate, mandatesForAgent, queryString, recordsByAgent } from "../core/queries.ts"
import { humanDuration, secondsLeft } from "../core/time.ts"
import { verifyRecord } from "../core/verify.ts"
import { addressOf, dataKey, loadState, logEvent, publicClient, reader, ROLES, rpc, saveState, socket, writerOf, type DemoState } from "./env.ts"
import { DISPATCHER_DAY, toRequest } from "./scenario.ts"
import { bold, dim, entityUrl, green, parseArgs, printChecks, red, say, short, sleep, txUrl, yellow } from "./ui.ts"

const { pos, flags } = parseArgs(process.argv.slice(2))
const cmd = pos.shift() ?? "help"

function needMandate(s: DemoState): Hex {
  const k = (flags.mandate as Hex | undefined) ?? s.mandate?.key
  if (!k) throw new Error("no mandate yet: run `npm run tacho -- issue` first (or pass --mandate 0x…)")
  return k
}

async function cmdWallets() {
  const pc = publicClient()
  for (const r of ROLES) {
    const a = addressOf(r)
    const bal = await pc.getBalance({ address: a })
    console.log(`${r.padEnd(13)} ${a}  ${formatEther(bal)} GLM`)
  }
}

async function cmdFund() {
  const amount = parseEther(String(flags.glm ?? "1"))
  const key = process.env.TACHO_PRINCIPAL_KEY as Hex
  const wallet = createWalletClient({ chain: TIRAMISU_CHAIN, transport: rpcHttp(rpc().http), account: privateKeyToAccount(key) })
  const pc = publicClient()
  for (const r of ROLES.filter((x) => x !== "principal")) {
    const to = addressOf(r)
    try {
      const hash = await wallet.sendTransaction({ to, value: amount })
      const rcpt = await pc.waitForTransactionReceipt({ hash })
      say("principal", `sent ${formatEther(amount)} GLM to ${r} ${short(to)}: ${rcpt.status} ${dim(txUrl(hash))}`)
    } catch (err) {
      say("principal", red(`transfer to ${r} failed: ${(err as Error).message.split("\n")[0]}`))
    }
  }
}

async function cmdIssue() {
  const s = loadState()
  const policy = demoPolicy({
    ...(flags.lease ? { leaseSeconds: Number(flags.lease) } : {}),
    ...(flags.action ? { perActionCap: BigInt(Number(flags.action) * 100) } : {}),
    ...(flags.day ? { perDayCap: BigInt(Number(flags.day) * 100) } : {}),
    ...(typeof flags.kinds === "string" ? { kinds: flags.kinds.split(",") } : {}),
    ...(typeof flags.counterparty === "string" ? { counterparties: [flags.counterparty as Address] } : {}),
  })
  const agent = addressOf("agent")
  const r = await issueMandate(writerOf("principal"), agent, policy)
  s.mandate = { key: r.mandateKey, txHash: r.txHash, principal: addressOf("principal"), agent, issuedAt: new Date().toISOString() }
  saveState(s)
  logEvent(s, { role: "principal", action: "issue-mandate", entityKey: r.mandateKey, txHash: r.txHash })
  say("principal", `mandate ${bold(short(r.mandateKey))} for agent ${short(agent)}: ${policy.kinds.join("+")}, ≤ ${formatAmount(policy.perActionCap, 2)} per action, ≤ ${formatAmount(policy.perDayCap, 2)} RUB per day, lease ${humanDuration(policy.leaseSeconds)}`)
  say("principal", dim(txUrl(r.txHash)))
  return r.mandateKey
}

async function cmdHeartbeat() {
  const s = loadState()
  const key = needMandate(s)
  const m = await loadMandate(reader(), key, addressOf("principal"))
  if (!m) throw new Error("mandate is not live (expired or revoked): issue a new one")
  const every = flags.every ? Number(flags.every) : 0
  do {
    const r = await renewMandate(writerOf("principal"), key, m.policy.leaseSeconds)
    logEvent(s, { role: "principal", action: "heartbeat", entityKey: key, txHash: r.txHash, block: String(r.expiresAt) })
    say("principal", `heartbeat: lease renewed to block ~${r.expiresAt} ${dim(txUrl(r.txHash))}`)
    if (every > 0) await sleep(every * 1000)
  } while (every > 0)
}

async function cmdRevoke() {
  const s = loadState()
  const key = needMandate(s)
  const r = await revokeMandate(writerOf("principal"), key)
  logEvent(s, { role: "principal", action: "revoke", entityKey: key, txHash: r.txHash })
  say("principal", `${red("revoked")} mandate ${short(key)} ${dim(txUrl(r.txHash))}`)
}

async function cmdAct() {
  const s = loadState()
  const [kind, rub] = pos
  if (!kind || !rub) throw new Error("usage: tacho act <kind> <rub> [--vehicle TRK-07] [--note text]")
  const req = toRequest({ kind, rub: Number(rub), expect: "", details: { vehicle: flags.vehicle ?? "TRK-01", note: flags.note ?? "manual" } }, addressOf("counterparty"))
  await runAttempt(s, req)
}

async function runAttempt(s: DemoState, req: ReturnType<typeof toRequest>, expect?: string) {
  const r = await attempt(
    { reader: reader(), writer: writerOf("agent"), mandateKey: needMandate(s), principal: addressOf("principal"), dataKey: dataKey() },
    req,
  )
  logEvent(s, { role: "agent", action: `record:${r.decision.verdict}:${r.decision.reason}`, entityKey: r.recordKey, txHash: r.txHash, note: `${req.kind} ${formatAmount(req.amount, 2)} RUB` })
  const v = r.decision.verdict === VERDICT.allowed ? green("ALLOWED") : red("REFUSED")
  say("agent", `${req.kind.padEnd(6)} ${formatAmount(req.amount, 2).padStart(10)} RUB → ${v} ${dim(r.decision.reason)}  record ${short(r.recordKey)} (sealed)${expect ? dim(`  expected: ${expect}`) : ""}`)
  return r
}

async function cmdAgent() {
  const s = loadState()
  const mandateKey = needMandate(s)
  const gap = Number(flags.gap ?? 4) * 1000
  let revokedAt: number | undefined
  const ws = socket()
  const unwatch = watchMandate(ws, mandateKey, {
    onRevoked: (e) => {
      revokedAt = Date.now()
      say("agent", red(`mandate revoked at block ${e.blockNumber} (WebSocket event): halting`))
    },
    onRenewed: (e) => say("agent", dim(`lease renewed by the principal (block ${e.blockNumber})`)),
    onError: (err) => say("agent", yellow(`watch error: ${err.message}`)),
  })
  for (const step of DISPATCHER_DAY) {
    if (revokedAt) break
    await runAttempt(s, toRequest(step, addressOf("counterparty")), step.expect)
    await sleep(gap)
  }
  unwatch()
}

async function cmdVerify(record?: string) {
  const key = (record ?? pos[0]) as Hex | undefined
  if (!key) throw new Error("usage: tacho verify <recordKey> [--principal 0x…]")
  const expected = (flags.principal as Address | undefined) ?? addressOf("principal")
  const report = await verifyRecord(reader(), key, { expectedPrincipal: expected, counterparty: addressOf("counterparty") })
  say("counterparty", `verify ${short(key)}: ${report.ok ? green("PASS") : red("FAIL")}`)
  printChecks(report.checks)
  return report
}

async function cmdHonour(record?: string) {
  const s = loadState()
  const key = (record ?? pos[0]) as Hex | undefined
  if (!key) throw new Error("usage: tacho honour <recordKey>")
  const res = await honour(reader(), writerOf("counterparty"), key, { expectedPrincipal: addressOf("principal") })
  if (res.ackKey) {
    logEvent(s, { role: "counterparty", action: "ack", entityKey: res.ackKey, txHash: res.txHash!, note: `for record ${key}` })
    say("counterparty", `${green("honoured")} record ${short(key)}: ack ${short(res.ackKey)} ${dim(txUrl(res.txHash!))}`)
  } else {
    say("counterparty", `${red("refused to honour")} record ${short(key)}:`)
    printChecks(res.report.checks.filter((c) => c.status !== "pass"))
  }
  return res
}

async function cmdForge() {
  const s = loadState()
  const mandateKey = needMandate(s)
  const forger = writerOf("forger")
  const predicted = await forger.predictKey()
  const fields = { mandate: mandateKey, kind: "fuel", amount: BigInt(Number(flags.rub ?? 90_000) * 100), verdict: VERDICT.allowed, reason: REASON.ok, tsMs: Date.now() }
  const batch = await recordBatch({ fields, details: { vehicle: "TRK-07", note: "forged" }, dataKey: generateDataKey(), retentionDays: 7, predicted })
  const r = await forger.executeBatch(batch)
  logEvent(s, { role: "forger", action: "forged-record", entityKey: r.createdEntities[0]!, txHash: r.txHash })
  say("forger", `wrote a fake ${formatAmount(fields.amount, 2)} RUB "allowed" record ${short(r.createdEntities[0]!)} with the same project, type and mandate attributes`)
  return r.createdEntities[0]!
}

async function cmdExtend() {
  const key = pos[0] as Hex | undefined
  if (!key) throw new Error("usage: tacho extend <entityKey> [--days 60] [--as counterparty]")
  const role = (flags.as as (typeof ROLES)[number] | undefined) ?? "counterparty"
  const s = loadState()
  const r = await writerOf(role).extendEntity({ entityKey: key, expires: ExpirationTime.fromDays(Number(flags.days ?? 60)) })
  logEvent(s, { role, action: "extend", entityKey: key, txHash: r.txHash })
  say(role, `extended ${short(key)} to block ~${r.expiresAt} (permissionless Lifetime Extension) ${dim(txUrl(r.txHash))}`)
}

async function cmdInspect() {
  const agent = (flags.agent as Address | undefined) ?? addressOf("agent")
  const rd = reader()
  const head = await rd.head()
  console.log(bold(`Agent ${agent}`) + dim(`  (head block ${head})`))
  const mandates = (await rd.find(mandatesForAgent(agent))).map(parseMandate)
  console.log(`\nLive mandates (${mandates.length})  ${dim(queryString(mandatesForAgent(agent)))}`)
  for (const m of mandates) {
    const spent = await spentToday(rd, m, Date.now())
    console.log(`  ${short(m.key)} from principal ${short(m.principal)}  lease ${humanDuration(secondsLeft(m.expiresAt, head))}  spent today ${formatAmount(spent, 2)} / ${formatAmount(m.policy.perDayCap, 2)} ${m.policy.currency}`)
    const forged = await rd.find(forgeriesForMandate(m.key, m.agent))
    if (forged.length) console.log(red(`    ${forged.length} forged record(s) claim this mandate: ${forged.map((f) => short(f.key!)).join(", ")}`))
  }
  const spec = recordsByAgent(agent)
  const recs = (await rd.find(spec, { max: 50 })).map(parseRecord)
  console.log(`\nRecords written by the agent (${recs.length}, newest first)  ${dim(queryString(spec))}`)
  for (const r of recs) {
    console.log(`  ${short(r.key)} ${r.kind.padEnd(6)} ${formatAmount(r.amount, 2).padStart(10)}  ${r.verdict === "allowed" ? green(r.verdict) : red(r.verdict)} ${dim(r.reason)}  ${r.sealed ? "sealed" : yellow("NOT sealed")}  block ${r.createdAt}`)
  }
  console.log(dim(`\nSame data without this app:\n${curlFor(spec, { limit: 10 })}`))
}

async function cmdDecrypt() {
  const key = pos[0] as Hex | undefined
  if (!key) throw new Error("usage: tacho decrypt <recordKey>")
  const e = await reader().getEntity(key)
  if (!e) throw new Error("record not found")
  const r = parseRecord(e)
  console.log(JSON.stringify(await unseal(r.envelope, dataKey(), recordAad(r)), null, 2))
}

/** The whole story, start to finish, on Tiramisu. Used for the demo video and by judges. */
async function cmdDemo() {
  const s = loadState()
  console.log(bold("\nTacho — a tachograph for AI agents, on Arkiv (Tiramisu testnet)\n"))
  const mandateKey = await cmdIssue()
  await sleep(1500)

  // The agent follows its mandate over WebSocket so a revocation stops it without polling.
  let revokedAt: number | undefined
  let revokeSentAt: number | undefined
  const ws = socket()
  const unwatch = watchMandate(ws, mandateKey, {
    onRevoked: (e) => {
      revokedAt = Date.now()
      const lag = revokeSentAt ? `, ${revokedAt - revokeSentAt} ms after the principal sent the revoke` : ""
      say("agent", red(`mandate revoked (EntityDeleted at block ${e.blockNumber}, via WebSocket${lag}): halting`))
    },
    onError: (err) => say("agent", yellow(`watch error: ${err.message}`)),
  })

  const allowed: Hex[] = []
  for (const step of DISPATCHER_DAY) {
    const r = await runAttempt(s, toRequest(step, addressOf("counterparty")), step.expect)
    if (r.decision.verdict === VERDICT.allowed) allowed.push(r.recordKey)
  }

  console.log()
  await cmdHonour(allowed[0])
  console.log()
  const forged = await cmdForge()
  await cmdHonour(forged)
  console.log()
  if (allowed[0]) {
    // The station disputes nothing yet, but keeps its evidence longer than the fleet's retention.
    const ex = await writerOf("counterparty").extendEntity({ entityKey: allowed[0], expires: ExpirationTime.fromDays(60) })
    logEvent(s, { role: "counterparty", action: "extend", entityKey: allowed[0], txHash: ex.txHash })
    say("counterparty", `extended record ${short(allowed[0])} to ~60 days: a wallet that does not own it (permissionlessExtension) ${dim(txUrl(ex.txHash))}`)
  }
  say("principal", "heartbeat (the human is still here)")
  const hb = await renewMandate(writerOf("principal"), mandateKey, DEFAULTS.leaseSeconds)
  logEvent(s, { role: "principal", action: "heartbeat", entityKey: mandateKey, txHash: hb.txHash })

  const pause = Number(flags["pause-before-revoke"] ?? 0)
  if (pause > 0) {
    say("tacho", dim(`pausing ${pause} s before the revocation (inspect the live mandate now)`))
    await sleep(pause * 1000)
  }
  console.log()
  revokeSentAt = Date.now()
  const rv = await revokeMandate(writerOf("principal"), mandateKey)
  logEvent(s, { role: "principal", action: "revoke", entityKey: mandateKey, txHash: rv.txHash })
  say("principal", `${red("revoke")} ${dim(txUrl(rv.txHash))}`)
  for (let i = 0; i < 20 && !revokedAt; i++) await sleep(250)
  say("agent", dim("the next request in the queue arrives after the revocation:"))
  await runAttempt(s, toRequest({ kind: "fuel", rub: 5_000, expect: "refused: no live mandate", details: { vehicle: "TRK-07", rationale: "Attempt after revocation." } }, addressOf("counterparty")), "refused: no live mandate")
  unwatch()

  console.log(bold("\nInspect it yourself, without this CLI:"))
  console.log(`  web:      https://minkhanov.github.io/tacho-arkiv/#/agent/${addressOf("agent")}`)
  console.log(`  explorer: ${entityUrl(allowed[0] ?? mandateKey)}`)
  console.log(`  curl:     ${dim(curlFor(recordsByAgent(addressOf("agent")), { limit: 10 }))}`)
}

function help() {
  console.log(`tacho — a tachograph for AI agents on Arkiv (${TIRAMISU.http})

  keys                         print fresh testnet keys for .env (fund them at hub.arkiv.network/faucet)
  wallets                      role addresses and GLM balances
  fund [--glm 1]               send GLM from the principal to the other roles
  issue [--lease 900] [--action 15000] [--day 40000] [--kinds fuel,toll]
  heartbeat [--every 60]       renew the mandate's lease (Lifetime Extension), once or in a loop
  revoke                       delete the mandate: a watching agent halts at once
  act <kind> <rub>             one agent attempt under the current mandate
  agent [--gap 4]              run the dispatcher's scripted day; halts on revocation
  verify <recordKey>           the counterparty's checks
  honour <recordKey>           verify, then write a sealed acknowledgement
  forge [--rub 90000]          the forger writes a fake record into the namespace
  extend <key> [--days 60] [--as counterparty]   permissionless Lifetime Extension of a record
  inspect [--agent 0x…]        what anyone can see about an agent
  decrypt <recordKey>          open a record's details with TACHO_DATA_KEY
  demo                         the whole story on Tiramisu`)
}

async function main() {
  switch (cmd) {
    case "keys": {
      for (const r of ROLES) console.log(`TACHO_${r.toUpperCase()}_KEY=${generatePrivateKey()}`)
      console.log(`TACHO_DATA_KEY=${generateDataKey()}`)
      return
    }
    case "wallets":
      return cmdWallets()
    case "fund":
      return cmdFund()
    case "issue":
      return void (await cmdIssue())
    case "heartbeat":
      return cmdHeartbeat()
    case "revoke":
      return cmdRevoke()
    case "act":
      return cmdAct()
    case "agent":
      return cmdAgent()
    case "verify":
      return void (await cmdVerify())
    case "honour":
      return void (await cmdHonour())
    case "forge":
      return void (await cmdForge())
    case "extend":
      return cmdExtend()
    case "inspect":
      return cmdInspect()
    case "decrypt":
      return cmdDecrypt()
    case "demo":
      return cmdDemo()
    default:
      return help()
  }
}

main()
  .then(() => {
    if (meter.units > 0) console.log(dim(`public RPC query budget used by this run: ${meter.units} units in ${meter.queries} queries (anonymous budget: 10 000 units per hour per IP, see README)`))
    process.exit(0)
  })
  .catch((err) => {
    // viem wraps a failed fetch in several layers; the RPC budget error is the one worth reading.
    let shown = err instanceof Error ? err.message : String(err)
    for (let e: unknown = err, i = 0; e instanceof Error && i < 8; e = (e as { cause?: unknown }).cause, i++) {
      if (e instanceof RpcBudgetError) shown = e.message
    }
    console.error(red(`error: ${shown}`))
    process.exit(1)
  })

