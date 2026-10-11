import { useCallback, useEffect, useRef, useState } from "react"
import { publicClient } from "./arkiv.ts"

/** Hash routing: works on GitHub Pages and keeps `?k=` (the data key) in the fragment, never sent to a server. */
export interface Route {
  path: string[]
  params: URLSearchParams
}

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "")
  const [p = "", q = ""] = raw.split("?")
  return { path: p.split("/").filter(Boolean), params: new URLSearchParams(q) }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])
  return route
}

export function go(path: string) {
  const keep = new URLSearchParams()
  for (const name of ["k", "apikey"]) {
    const v = parseHash().params.get(name)
    if (v) keep.set(name, v)
  }
  const q = keep.toString()
  window.location.hash = "#/" + path.replace(/^\//, "") + (q && !path.includes("?") ? `?${q}` : "")
}

export interface AsyncState<T> {
  data?: T
  error?: Error
  loading: boolean
  reload: () => void
}

/** Run an async loader, keep the last good result while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true })
  const [tick, setTick] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    fn().then(
      (data) => id === seq.current && setState({ data, loading: false }),
      (error: Error) => id === seq.current && setState((s) => ({ ...s, error, loading: false })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { ...state, reload }
}

/** Head block estimated locally between refreshes (2-second blocks), for live countdowns. */
export function useHead(): bigint | undefined {
  const [anchor, setAnchor] = useState<{ block: bigint; at: number }>()
  const [, force] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () =>
      publicClient.getBlockNumber().then(
        (block) => alive && setAnchor({ block, at: Date.now() }),
        () => undefined,
      )
    load()
    const refresh = setInterval(load, 30_000)
    const tick = setInterval(() => force((x) => x + 1), 1_000)
    return () => {
      alive = false
      clearInterval(refresh)
      clearInterval(tick)
    }
  }, [])
  if (!anchor) return undefined
  return anchor.block + BigInt(Math.floor((Date.now() - anchor.at) / 2_000))
}
