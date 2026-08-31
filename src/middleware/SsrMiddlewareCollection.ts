import type {
  RouteLocationMatched,
  RouteLocationNormalized,
  RouteRecordNormalized,
} from 'vue-router'
import type { Middleware } from './SsrMiddlewareTypes'

export interface CollectedMiddleware {
  middleware: Middleware<any>
  matchedIndex: number | null
  routeLabel?: string
}

export interface MiddlewareCollection {
  entries: CollectedMiddleware[]
  enteredMatchedIndices: number[]
}

export const canonicalRouteRecord = (
  record: RouteLocationMatched
): RouteRecordNormalized => record.aliasOf ?? record

export const resolveEnteredMatchedIndices = (
  from: RouteLocationNormalized,
  to: RouteLocationNormalized
): number[] => {
  const activeRecords = new Set(from.matched.map(canonicalRouteRecord))
  const enteredMatchedIndices: number[] = []

  for (let index = 0; index < to.matched.length; index += 1) {
    const record = to.matched[index]!
    if (!activeRecords.has(canonicalRouteRecord(record))) {
      enteredMatchedIndices.push(index)
    }
  }

  return enteredMatchedIndices
}

export const middlewareLabel = (
  entry: CollectedMiddleware,
  index: number
): string => {
  const name = entry.middleware.name || `middleware #${index + 1}`
  return entry.routeLabel
    ? `Middleware "${name}" declared on route "${entry.routeLabel}"`
    : `Global middleware "${name}"`
}

export const collectMiddleware = (
  globalMiddleware: readonly Middleware<any>[],
  to: RouteLocationNormalized,
  from: RouteLocationNormalized
): MiddlewareCollection => {
  const entries: CollectedMiddleware[] = []
  const enteredMatchedIndices = resolveEnteredMatchedIndices(from, to)
  const seen = new Set<Middleware<any>>()
  const add = (entry: CollectedMiddleware) => {
    if (typeof entry.middleware !== 'function') {
      const owner = entry.routeLabel
        ? `Route "${entry.routeLabel}"`
        : 'Application middleware'
      throw new Error(`[vue-ssr-lite] ${owner} must contain only middleware functions.`)
    }
    if (seen.has(entry.middleware)) return
    seen.add(entry.middleware)
    entries.push(entry)
  }

  for (const middleware of globalMiddleware) {
    add({ middleware, matchedIndex: null })
  }
  for (const matchedIndex of enteredMatchedIndices) {
    const record = to.matched[matchedIndex]!
    const declared = record.meta.middleware
    if (declared === undefined) continue
    if (!Array.isArray(declared)) {
      throw new Error(
        `[vue-ssr-lite] Route "${record.path}" meta.middleware must be an array of middleware functions.`
      )
    }
    for (const middleware of declared) {
      add({
        middleware,
        matchedIndex,
        routeLabel: record.name == null
          ? record.path
          : `${String(record.name)} (${record.path})`,
      })
    }
  }
  return { entries, enteredMatchedIndices }
}
