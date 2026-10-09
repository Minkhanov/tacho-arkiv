import type { ActionRequest, Address } from "../core/policy.ts"

/**
 * The dispatcher agent's day, as a fixed queue so the demo is reproducible. In a real
 * deployment these requests come from the agent's planner (an LLM); the guardrail and the
 * evidence do not care where a request comes from. All data is synthetic.
 */
export interface ScriptedRequest {
  kind: string
  rub: number
  details: Record<string, unknown>
  /** What a reviewer should expect, printed next to the result. */
  expect: string
}

export const DISPATCHER_DAY: ScriptedRequest[] = [
  { kind: "fuel", rub: 12_400, expect: "allowed", details: { vehicle: "TRK-07", station: "Fuel station 12, M7 km 412 (synthetic)", liters: 198, rationale: "Refuel before the Kazan to Moscow leg; tank at 18 %." } },
  { kind: "fuel", rub: 18_000, expect: "refused: over the 15 000 RUB per-action cap", details: { vehicle: "TRK-03", station: "Fuel station 4, M12 km 88 (synthetic)", liters: 288, rationale: "Fill both tanks to skip a stop." } },
  { kind: "toll", rub: 3_200, expect: "allowed", details: { vehicle: "TRK-07", plaza: "M12 toll plaza 3 (synthetic)", rationale: "Toll road saves 95 minutes on the delivery window." } },
  { kind: "repair", rub: 25_000, expect: "refused: repairs are not in the mandate", details: { vehicle: "TRK-11", shop: "Tyre service 2 (synthetic)", rationale: "Front tyre wear at 2 mm." } },
  { kind: "fuel", rub: 14_900, expect: "allowed", details: { vehicle: "TRK-03", station: "Fuel station 9, M7 km 120 (synthetic)", liters: 238, rationale: "Second leg, reefer unit running." } },
  { kind: "fuel", rub: 11_000, expect: "refused: would pass the 40 000 RUB daily cap", details: { vehicle: "TRK-05", station: "Fuel station 12, M7 km 412 (synthetic)", liters: 176, rationale: "Top up before the night run." } },
]

export function toRequest(r: ScriptedRequest, counterparty?: Address): ActionRequest {
  const req: ActionRequest = { kind: r.kind, amount: BigInt(r.rub) * 100n, tsMs: Date.now(), details: r.details }
  if (counterparty) req.counterparty = counterparty
  return req
}
