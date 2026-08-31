import type { App } from 'vue'
import {
  START_LOCATION,
  type RouteLocationNormalized,
  type RouteLocationRaw,
  type Router,
} from 'vue-router'
import type { SsrRequestContext } from '../SsrRuntimeTypes'
import { collectMiddleware, middlewareLabel } from './SsrMiddlewareCollection'
import { createMiddlewareCookies } from './SsrMiddlewareCookies'
import type { MiddlewarePendingProps } from './SsrMiddlewareProps'
import {
  classifyMiddlewareResult,
  createMiddlewareRedirectResult,
} from './SsrMiddlewareResult'
import type {
  Middleware,
  MiddlewareContext,
  MiddlewareRedirectResult,
} from './SsrMiddlewareTypes'

export type MiddlewareNavigationPlan =
  | {
      kind: 'continue'
      props: MiddlewarePendingProps[]
      enteredMatchedIndices: number[]
    }
  | { kind: 'cancel' }
  | { kind: 'redirect'; location: RouteLocationRaw }
  | { kind: 'special-redirect'; redirect: MiddlewareRedirectResult }

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The middleware navigation was aborted.', 'AbortError')
}

export const executeMiddlewareChain = async (options: {
  app: App
  router: Router
  context: SsrRequestContext<any, any>
  globalMiddleware: readonly Middleware<any>[]
  to: RouteLocationNormalized
  from: RouteLocationNormalized
  server: boolean
  signal: AbortSignal
}): Promise<MiddlewareNavigationPlan> => {
  const collection = collectMiddleware(
    options.globalMiddleware,
    options.to,
    options.from
  )
  const pending = new Map<number, Record<string, unknown>>()
  const cookies = createMiddlewareCookies({
    server: options.server,
    request: options.context.request,
    response: options.context.response,
  })

  for (let index = 0; index < collection.entries.length; index += 1) {
    throwIfAborted(options.signal)
    const entry = collection.entries[index]!
    const middlewareContext: MiddlewareContext<any> = {
      app: options.app,
      router: options.router,
      cookies,
      to: options.to,
      from: options.from === START_LOCATION ? null : options.from,
      server: options.server,
      domain: options.context.domain,
      origin: options.context.siteOrigin,
      publicConfig: options.context.publicConfig,
      signal: options.signal,
      redirect: createMiddlewareRedirectResult,
    }
    const classified = classifyMiddlewareResult(
      await entry.middleware(middlewareContext),
      middlewareLabel(entry, index),
      options.to.fullPath
    )
    if (classified.kind === 'continue') continue
    if (classified.kind === 'cancel') return { kind: 'cancel' }
    if (classified.kind === 'redirect') {
      return { kind: 'redirect', location: classified.location }
    }
    if (classified.kind === 'special-redirect') {
      return { kind: 'special-redirect', redirect: classified.redirect }
    }
    if (entry.matchedIndex === null) {
      throw new Error(
        `[vue-ssr-lite] ${middlewareLabel(entry, index)} returned props while navigating to "${options.to.fullPath}". Route props require middleware declared on a route record.`
      )
    }
    pending.set(entry.matchedIndex, {
      ...(pending.get(entry.matchedIndex) ?? {}),
      ...classified.props,
    })
  }
  throwIfAborted(options.signal)
  return {
    kind: 'continue',
    enteredMatchedIndices: [...collection.enteredMatchedIndices],
    props: [...pending].map(([matchedIndex, props]) => ({
      matchedIndex,
      props: { ...props },
    })),
  }
}
