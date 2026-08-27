import {
  createMemoryHistory,
  createRouter,
  type Router,
  type RouteLocationMatched,
  type RouteRecordRaw,
} from 'vue-router'
import type { SsrRenderMode } from './SsrConfigTypes'

const isRenderMode = (value: unknown): value is SsrRenderMode =>
  value === 'ssr' || value === 'spa'

export const resolveMatchedRenderMode = (
  matched: readonly RouteLocationMatched[],
  defaultRender: SsrRenderMode
): SsrRenderMode => {
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    const render = matched[index]?.meta?.render
    if (isRenderMode(render)) return render
  }
  return defaultRender
}

const MATCHER_COMPONENT = { render: () => null }

const hasOwn = <T extends object, K extends PropertyKey>(
  value: T,
  key: K
): value is T & Record<K, unknown> => Object.prototype.hasOwnProperty.call(value, key)

/**
 * Clone a route record into a valid Vue Router matcher input.
 *
 * Vue Router treats `'alias' in record` as “aliases exist” and then iterates
 * the value. Copying `alias: undefined` therefore throws `aliases is not iterable`.
 * Optional routing fields are omitted unless they are actually present, so the
 * matcher keeps alias, redirect, name, params, children, and meta without
 * synthesizing invalid own-properties.
 */
export const stripRouteForMatching = (route: RouteRecordRaw): RouteRecordRaw => {
  const stripped: Record<string, unknown> = {
    path: route.path,
    component: MATCHER_COMPONENT,
    meta: route.meta ?? {},
  }
  if (route.name != null) stripped.name = route.name
  if (hasOwn(route, 'alias') && route.alias != null) stripped.alias = route.alias
  if (hasOwn(route, 'redirect') && route.redirect != null) {
    stripped.redirect = route.redirect
  }
  if (hasOwn(route, 'props') && route.props != null) stripped.props = route.props
  if (route.children?.length) {
    stripped.children = route.children.map(stripRouteForMatching)
  }
  return stripped as unknown as RouteRecordRaw
}

export const validateRouteRenderBoundaries = (
  routes: readonly RouteRecordRaw[] | undefined,
  defaultRender: SsrRenderMode,
  applicationId: string
): boolean => {
  let hasOverride = false
  const walk = (
    records: readonly RouteRecordRaw[],
    inherited: SsrRenderMode,
    parentPath: string
  ) => {
    for (const record of records) {
      const path = record.path || parentPath || '/'
      const declared = record.meta?.render
      if (declared != null && !isRenderMode(declared)) {
        throw new Error(
          `Application "${applicationId}" route "${path}" meta.render must be "ssr" or "spa".`
        )
      }
      if (declared) hasOverride = true
      if (inherited === 'spa' && declared === 'ssr') {
        throw new Error(
          `Application "${applicationId}" route "${path}" cannot override an SPA parent back to SSR.`
        )
      }
      const effective = declared ?? inherited
      if (record.children?.length) walk(record.children, effective, path)
    }
  }
  if (routes?.length) walk(routes, defaultRender, '')
  return hasOverride
}

const toMatcherLocation = (url: string): string => {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  }
  return url.startsWith('/') ? url : `/${url}`
}

export interface SsrRouteRenderMatcher {
  /** Synchronous. Does not navigate or mutate shared router state. */
  resolve: (url: string) => SsrRenderMode
}

const MAX_REDIRECT_HOPS = 16

export const createRouteRenderMatcher = (
  routes: RouteRecordRaw[],
  defaultRender: SsrRenderMode
): SsrRouteRenderMatcher => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: routes.map(stripRouteForMatching),
  })
  return {
    resolve(url: string) {
      const origin = toMatcherLocation(url)
      const seen = new Set<string>()
      let current = origin
      for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
        if (seen.has(current)) {
          throw new Error(`Redirect cycle detected while classifying "${origin}".`)
        }
        seen.add(current)
        const resolved = router.resolve(current)
        const record = resolved.matched[resolved.matched.length - 1]
        const redirect = record?.redirect
        if (redirect == null) {
          return resolveMatchedRenderMode(resolved.matched, defaultRender)
        }
        const target =
          typeof redirect === 'function'
            ? redirect(resolved, router.currentRoute.value)
            : redirect
        current = router.resolve(target).fullPath
      }
      throw new Error(`Redirect cycle detected while classifying "${origin}".`)
    },
  }
}

type HistoryIntent = 'push' | 'replace' | 'pop'

export const installCrossRenderNavigation = (
  router: Router,
  defaultRender: SsrRenderMode
): void => {
  let intent: HistoryIntent = 'push'
  const resetIntent = () => {
    intent = 'push'
  }

  if (typeof window !== 'undefined') {
    window.addEventListener(
      'popstate',
      () => {
        intent = 'pop'
      },
      true
    )
  }

  const history = router.options.history
  const go = history.go.bind(history)
  history.go = (delta: number) => {
    intent = 'pop'
    return go(delta)
  }

  const push = router.push.bind(router)
  const replaceNav = router.replace.bind(router)
  router.push = ((to, ...rest: unknown[]) => {
    intent = 'push'
    return (push as (...args: unknown[]) => ReturnType<Router['push']>)(to, ...rest)
  }) as Router['push']
  router.replace = ((to, ...rest: unknown[]) => {
    intent = 'replace'
    return (replaceNav as (...args: unknown[]) => ReturnType<Router['replace']>)(
      to,
      ...rest
    )
  }) as Router['replace']

  router.beforeEach((to, from) => {
    if (!from.matched.length) return true
    const fromMode = resolveMatchedRenderMode(from.matched, defaultRender)
    const toMode = resolveMatchedRenderMode(to.matched, defaultRender)
    if (fromMode === toMode) {
      if (intent === 'pop') resetIntent()
      return true
    }
    const url = to.fullPath
    const replaceDocument =
      intent === 'replace' || intent === 'pop' || Boolean(to.redirectedFrom)
    if (typeof window !== 'undefined') {
      if (replaceDocument) window.location.replace(url)
      else window.location.assign(url)
    }
    resetIntent()
    return false
  })
}
