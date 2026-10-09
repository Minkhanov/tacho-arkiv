import { TIRAMISU } from "../core/constants.ts"
import type { Check } from "../core/verify.ts"

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
export const bold = c("1")
export const dim = c("2")
export const red = c("31")
export const green = c("32")
export const yellow = c("33")
export const cyan = c("36")
export const magenta = c("35")

export const short = (h: string, n = 6) => (h.length > 2 + n * 2 ? `${h.slice(0, 2 + n)}…${h.slice(-4)}` : h)
export const txUrl = (h: string) => `${TIRAMISU.explorer}/tx/${h}`
export const entityUrl = (k: string) => `${TIRAMISU.dataExplorer}/entity/${k}`

export function say(role: string, msg: string) {
  const tag = { principal: cyan("principal  "), agent: magenta("agent      "), counterparty: green("counterparty"), forger: red("forger     "), tacho: bold("tacho      ") }[role] ?? role.padEnd(12)
  console.log(`${dim(new Date().toISOString().slice(11, 19))} ${tag} ${msg}`)
}

export function printChecks(checks: Check[]) {
  for (const ch of checks) {
    const mark = { pass: green("✔"), fail: red("✘"), warn: yellow("!"), skip: dim("·") }[ch.status]
    console.log(`   ${mark} ${ch.label}`)
    console.log(dim(`       ${ch.detail}`))
    if (ch.query) console.log(dim(`       query: ${ch.query}`))
  }
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Minimal flag parser: `--name value`, `--flag`, positional args. */
export function parseArgs(argv: string[]) {
  const pos: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const name = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next
        i++
      } else flags[name] = true
    } else pos.push(a)
  }
  return { pos, flags }
}
