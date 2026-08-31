import type {
  RouteLocationMatched,
  RouteLocationNormalized,
  RouteRecordNormalized,
} from 'vue-router'
import { canonicalRouteRecord } from './SsrMiddlewareCollection'

type RouteRecordProps = RouteLocationMatched['props'][string]

export interface MiddlewarePendingProps {
  matchedIndex: number
  props: Record<string, unknown>
}

interface RoutePropsState {
  accepted: RouteRecordProps
  acceptedOrder: number
  layers: Map<number, RouteRecordProps>
  bindings: Map<RouteLocationMatched, RoutePropsBinding>
}

interface RoutePropsBinding {
  base: RouteRecordProps
  current: RouteRecordProps
}

interface RoutePropsMutation {
  record: RouteLocationMatched
  state: RoutePropsState
  after: RouteRecordProps
}

export interface MiddlewarePropsTransaction {
  commit(): void
  accept(): void
  rollback(): void
}

const resolveBaseProps = (
  base: RouteRecordProps,
  route: RouteLocationNormalized
): Record<string, unknown> => {
  if (base === true) return { ...route.params }
  if (typeof base === 'function') return { ...(base(route) ?? {}) }
  if (base && typeof base === 'object') return { ...base }
  return {}
}

const routeLabel = (record: RouteLocationMatched): string =>
  record.name == null ? record.path : `${String(record.name)} (${record.path})`

export interface SsrMiddlewarePropsRuntime {
  prepare(
    to: RouteLocationNormalized,
    pending: readonly MiddlewarePendingProps[],
    enteredMatchedIndices: readonly number[]
  ): MiddlewarePropsTransaction
  dispose(): void
}

export const createSsrMiddlewarePropsRuntime = (): SsrMiddlewarePropsRuntime => {
  const states = new Map<RouteRecordNormalized, RoutePropsState>()
  let nextMutationOrder = 1

  const bindingFor = (
    record: RouteLocationMatched,
    state: RoutePropsState
  ): RoutePropsBinding => {
    const existing = state.bindings.get(record)
    if (existing) return existing
    const created = {
      base: record.props.default,
      current: record.props.default,
    }
    state.bindings.set(record, created)
    return created
  }

  const stateFor = (record: RouteLocationMatched): RoutePropsState => {
    const key = canonicalRouteRecord(record)
    const existing = states.get(key)
    if (existing) {
      const binding = bindingFor(record, existing)
      if (record.props.default !== binding.current) {
        binding.base = record.props.default
        binding.current = record.props.default
        existing.accepted = record.props.default
        existing.acceptedOrder = nextMutationOrder++
        existing.layers.clear()
      }
      return existing
    }
    const created = {
      accepted: record.props.default,
      acceptedOrder: 0,
      layers: new Map<number, RouteRecordProps>(),
      bindings: new Map<RouteLocationMatched, RoutePropsBinding>([
        [
          record,
          {
            base: record.props.default,
            current: record.props.default,
          },
        ],
      ]),
    }
    states.set(key, created)
    return created
  }

  const applyState = (
    record: RouteLocationMatched,
    state: RoutePropsState
  ): void => {
    let order = state.acceptedOrder
    let value = state.accepted
    for (const [layerOrder, layerValue] of state.layers) {
      if (layerOrder <= order) continue
      order = layerOrder
      value = layerValue
    }
    const binding = bindingFor(record, state)
    record.props.default = value
    binding.current = value
  }

  return {
    prepare(to, pending, enteredMatchedIndices) {
      const mutationOrder = nextMutationOrder++
      const entered = new Set<number>()
      for (const matchedIndex of enteredMatchedIndices) {
        if (
          !Number.isInteger(matchedIndex) ||
          matchedIndex < 0 ||
          matchedIndex >= to.matched.length
        ) {
          throw new Error(
            `[vue-ssr-lite] Cached middleware route scope no longer matches route "${to.fullPath}".`
          )
        }
        entered.add(matchedIndex)
      }
      const byRecord = new Map<number, Record<string, unknown>>()
      for (const item of pending) {
        if (
          !Number.isInteger(item.matchedIndex) ||
          item.matchedIndex < 0 ||
          item.matchedIndex >= to.matched.length
        ) {
          throw new Error(
            `[vue-ssr-lite] Cached middleware props no longer match route "${to.fullPath}".`
          )
        }
        if (!entered.has(item.matchedIndex)) {
          throw new Error(
            `[vue-ssr-lite] Cached middleware props target a route record that was not entered for "${to.fullPath}".`
          )
        }
        byRecord.set(item.matchedIndex, {
          ...(byRecord.get(item.matchedIndex) ?? {}),
          ...item.props,
        })
      }
      const mutations: RoutePropsMutation[] = []
      for (let index = 0; index < to.matched.length; index += 1) {
        if (entered.has(index)) continue
        const record = to.matched[index]!
        const state = states.get(canonicalRouteRecord(record))
        if (state) applyState(record, state)
      }
      for (const index of entered) {
        const record = to.matched[index]!
        const middlewareProps = byRecord.get(index)
        if (
          middlewareProps &&
          (!record.components || !Object.prototype.hasOwnProperty.call(record.components, 'default'))
        ) {
          throw new Error(
            `[vue-ssr-lite] Route middleware returned props for route "${routeLabel(record)}", but that route has no default view.`
          )
        }
        const state = stateFor(record)
        const binding = bindingFor(record, state)
        const after = middlewareProps
          ? ((route: RouteLocationNormalized) => ({
              ...resolveBaseProps(binding.base, route),
              ...middlewareProps,
            }))
          : binding.base
        mutations.push({ record, state, after })
      }
      let committed = false
      let settled = false
      return {
        commit() {
          if (committed || settled) return
          committed = true
          for (const mutation of mutations) {
            mutation.state.layers.set(mutationOrder, mutation.after)
            applyState(mutation.record, mutation.state)
          }
        },
        accept() {
          if (!committed || settled) return
          settled = true
          for (const mutation of mutations) {
            mutation.state.layers.delete(mutationOrder)
            if (mutationOrder >= mutation.state.acceptedOrder) {
              mutation.state.accepted = mutation.after
              mutation.state.acceptedOrder = mutationOrder
            }
            applyState(mutation.record, mutation.state)
          }
        },
        rollback() {
          if (!committed || settled) return
          settled = true
          for (const mutation of mutations) {
            mutation.state.layers.delete(mutationOrder)
            applyState(mutation.record, mutation.state)
          }
        },
      }
    },
    dispose() {
      for (const state of states.values()) {
        for (const [record, binding] of state.bindings) {
          if (record.props.default === binding.current) {
            record.props.default = binding.base
          }
        }
      }
      states.clear()
    },
  }
}
