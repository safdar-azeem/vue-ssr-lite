import type {
  RouteLocationMatched,
  RouteLocationNormalized,
} from 'vue-router'

type RouteRecordProps = RouteLocationMatched['props'][string]

export interface MiddlewarePendingProps {
  matchedIndex: number
  props: Record<string, unknown>
}

interface RoutePropsState {
  base: RouteRecordProps
  accepted: RouteRecordProps
  acceptedOrder: number
  layers: Map<number, RouteRecordProps>
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
    pending: readonly MiddlewarePendingProps[]
  ): MiddlewarePropsTransaction
  dispose(): void
}

export const createSsrMiddlewarePropsRuntime = (): SsrMiddlewarePropsRuntime => {
  const states = new Map<RouteLocationMatched, RoutePropsState>()
  let nextMutationOrder = 1

  const stateFor = (record: RouteLocationMatched): RoutePropsState => {
    const existing = states.get(record)
    if (existing) {
      if (record.props.default !== existing.current) {
        existing.base = record.props.default
        existing.accepted = record.props.default
        existing.acceptedOrder = nextMutationOrder++
        existing.layers.clear()
        existing.current = record.props.default
      }
      return existing
    }
    const created = {
      base: record.props.default,
      accepted: record.props.default,
      acceptedOrder: 0,
      layers: new Map<number, RouteRecordProps>(),
      current: record.props.default,
    }
    states.set(record, created)
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
    record.props.default = value
    state.current = value
  }

  return {
    prepare(to, pending) {
      const mutationOrder = nextMutationOrder++
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
        byRecord.set(item.matchedIndex, {
          ...(byRecord.get(item.matchedIndex) ?? {}),
          ...item.props,
        })
      }
      const mutations: RoutePropsMutation[] = []
      for (let index = 0; index < to.matched.length; index += 1) {
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
        const after = middlewareProps
          ? ((route: RouteLocationNormalized) => ({
              ...resolveBaseProps(state.base, route),
              ...middlewareProps,
            }))
          : state.base
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
      for (const [record, state] of states) {
        if (record.props.default === state.current) {
          record.props.default = state.base
        }
      }
      states.clear()
    },
  }
}
