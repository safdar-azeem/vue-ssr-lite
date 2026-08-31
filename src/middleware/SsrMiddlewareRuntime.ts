import type { App } from 'vue'
import {
  START_LOCATION,
  type RouteLocationNormalized,
  type Router,
} from 'vue-router'
import type { SsrRequestContext, SsrRenderRequest } from '../SsrRuntimeTypes'
import {
  executeMiddlewareChain,
  type MiddlewareNavigationPlan,
} from './SsrMiddlewareExecution'
import {
  createSsrMiddlewarePropsRuntime,
  type MiddlewarePendingProps,
  type MiddlewarePropsTransaction,
} from './SsrMiddlewareProps'
import type {
  Middleware,
  MiddlewareRedirectResult,
} from './SsrMiddlewareTypes'

export type SsrMiddlewareNavigationOutcome = 'cancel' | 'redirect' | null

export interface SsrMiddlewareInstallation {
  dispose(): void
}

export interface SsrMiddlewareExecutionController {
  install(options: {
    app: App
    router: Router
    context: SsrRequestContext<any, any>
    middleware?: readonly Middleware<any>[]
  }): SsrMiddlewareInstallation
  navigationOutcome(target?: string): SsrMiddlewareNavigationOutcome
  /** @internal Ends eligibility for framework-owned initial navigation replay. */
  completeBrowserBootstrap(): void
  dispose(): void
}

const clonePendingProps = (
  pending: readonly MiddlewarePendingProps[]
): MiddlewarePendingProps[] =>
  pending.map((entry) => ({
    matchedIndex: entry.matchedIndex,
    props: { ...entry.props },
  }))

const cloneNavigationPlan = (
  plan: MiddlewareNavigationPlan
): MiddlewareNavigationPlan =>
  plan.kind === 'continue'
    ? {
        kind: 'continue',
        props: clonePendingProps(plan.props),
        enteredMatchedIndices: [...plan.enteredMatchedIndices],
      }
    : plan

const resolveSpecialLocation = (
  router: Router,
  redirect: MiddlewareRedirectResult
): string =>
  typeof redirect.location === 'string'
    ? redirect.location
    : router.resolve(redirect.location).fullPath

const validateBrowserDocumentRedirect = (location: string, origin: string): string => {
  if (!location || /[\u0000-\u001f\u007f]/.test(location)) {
    throw new Error(
      '[vue-ssr-lite] External middleware redirect must be a non-empty HTTP(S) URL without control characters.'
    )
  }
  let target: URL
  try {
    target = new URL(location, origin)
  } catch {
    throw new Error('[vue-ssr-lite] External middleware redirect must be a valid URL.')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('[vue-ssr-lite] External middleware redirect must use HTTP or HTTPS.')
  }
  if (target.username || target.password) {
    throw new Error('[vue-ssr-lite] External middleware redirect must not contain credentials.')
  }
  return target.href
}

const abortReason = (): DOMException =>
  new DOMException('The middleware navigation was superseded.', 'AbortError')

export const createSsrMiddlewareExecutionController = (options: {
  server: boolean
  request: SsrRenderRequest<any>
}): SsrMiddlewareExecutionController => {
  const cache = new Map<string, {
    installationId: number
    plan: Extract<MiddlewareNavigationPlan, { kind: 'continue' }>
  }>()
  const browserInitialInFlight = new Map<
    string,
    Promise<MiddlewareNavigationPlan>
  >()
  const browserInitialReplay = new Map<string, MiddlewareNavigationPlan>()
  const browserInitialTargets = new Set<string>()
  const browserInitialOutcomes = new Map<
    string,
    Exclude<SsrMiddlewareNavigationOutcome, null>
  >()
  const installations = new Set<SsrMiddlewareInstallation>()
  let nextInstallationId = 1
  let navigationSequence = 0
  let activeBrowserNavigation: AbortController | undefined
  let browserBootstrapActive = !options.server
  let outcome: SsrMiddlewareNavigationOutcome = null
  let outcomeTarget: string | undefined
  let disposed = false

  const run = async (
    app: App,
    router: Router,
    context: SsrRequestContext<any, any>,
    globalMiddleware: readonly Middleware<any>[],
    installationId: number,
    to: RouteLocationNormalized,
    from: RouteLocationNormalized
  ): Promise<MiddlewareNavigationPlan> => {
    const cacheKey = to.fullPath
    if (options.server) {
      const cached = cache.get(cacheKey)
      if (cached && cached.installationId !== installationId) {
        return {
          kind: 'continue',
          props: clonePendingProps(cached.plan.props),
          enteredMatchedIndices: [...cached.plan.enteredMatchedIndices],
        }
      }
    }

    let navigationController: AbortController | undefined
    let signal = options.request.signal
    let removeRequestAbort: () => void = () => undefined

    if (!options.server) {
      activeBrowserNavigation?.abort(abortReason())
      navigationController = new AbortController()
      activeBrowserNavigation = navigationController
      signal = navigationController.signal
      const abortNavigation = () =>
        navigationController?.abort(options.request.signal.reason ?? abortReason())
      if (options.request.signal.aborted) abortNavigation()
      else {
        options.request.signal.addEventListener('abort', abortNavigation, { once: true })
        removeRequestAbort = () =>
          options.request.signal.removeEventListener('abort', abortNavigation)
      }
    }

    try {
      return await executeMiddlewareChain({
        app,
        router,
        context,
        globalMiddleware,
        to,
        from,
        server: options.server,
        signal,
      })
    } catch (error) {
      if (!options.server && signal.aborted) return { kind: 'cancel' }
      throw error
    } finally {
      removeRequestAbort()
      if (activeBrowserNavigation === navigationController) {
        activeBrowserNavigation = undefined
      }
    }
  }

  const execute = (
    app: App,
    router: Router,
    context: SsrRequestContext<any, any>,
    globalMiddleware: readonly Middleware<any>[],
    installationId: number,
    to: RouteLocationNormalized,
    from: RouteLocationNormalized
  ): Promise<MiddlewareNavigationPlan> => {
    if (options.server) {
      return run(
        app,
        router,
        context,
        globalMiddleware,
        installationId,
        to,
        from
      )
    }
    if (!browserBootstrapActive || from !== START_LOCATION) {
      return run(
        app,
        router,
        context,
        globalMiddleware,
        installationId,
        to,
        from
      )
    }
    const key = to.fullPath
    const replay = browserInitialReplay.get(key)
    if (replay) {
      browserInitialReplay.delete(key)
      return Promise.resolve(cloneNavigationPlan(replay))
    }
    const existing = browserInitialInFlight.get(key)
    if (existing) return existing
    // A different initial target supersedes any still-pending bootstrap work.
    // Remove its reuse handle immediately even if application middleware does
    // not observe AbortSignal and keeps the old promise pending.
    browserInitialInFlight.clear()
    const pending = run(
      app,
      router,
      context,
      globalMiddleware,
      installationId,
      to,
      from
    )
    browserInitialInFlight.set(key, pending)
    void pending.then(
      (plan) => {
        if (browserInitialInFlight.get(key) === pending) {
          browserInitialReplay.set(key, cloneNavigationPlan(plan))
        }
      },
      () => undefined
    )
    const clear = () => {
      if (browserInitialInFlight.get(key) === pending) {
        browserInitialInFlight.delete(key)
      }
    }
    void pending.then(clear, clear)
    return pending
  }

  return {
    install({ app, router, context, middleware = [] }) {
      if (disposed) {
        throw new Error('[vue-ssr-lite] Cannot install a disposed middleware controller.')
      }
      if (
        !Array.isArray(middleware) ||
        middleware.some((entry) => typeof entry !== 'function')
      ) {
        throw new Error(
          `[vue-ssr-lite] Application "${context.applicationId}" middleware must be an array of middleware functions.`
        )
      }
      const applicationMiddleware = [...middleware]
      const propsRuntime = createSsrMiddlewarePropsRuntime()
      const installationId = nextInstallationId++
      const transactions = new Map<object, MiddlewarePropsTransaction>()
      const stagedCache = new Map<
        object,
        Extract<MiddlewareNavigationPlan, { kind: 'continue' }>
      >()

      const rollback = (target: object) => {
        const transaction = transactions.get(target)
        transaction?.rollback()
        transactions.delete(target)
        stagedCache.delete(target)
      }

      const resolveTerminalTarget = (
        to: RouteLocationNormalized
      ): { target: object; redirected: boolean } | undefined => {
        if (transactions.has(to)) return { target: to, redirected: false }
        const redirectOrigin = to.redirectedFrom
        return redirectOrigin && transactions.has(redirectOrigin)
          ? { target: redirectOrigin, redirected: true }
          : undefined
      }

      const removeBefore = router.beforeEach(async (to, from) => {
        for (const pendingTarget of [...transactions.keys()]) {
          rollback(pendingTarget)
        }
        const browserBootstrapNavigation =
          !options.server && browserBootstrapActive && from === START_LOCATION
        if (!options.server) {
          if (browserBootstrapNavigation) browserInitialTargets.add(to.fullPath)
          else browserInitialOutcomes.delete(to.fullPath)
        }
        const navigationId = ++navigationSequence
        outcome = null
        outcomeTarget = to.fullPath
        const publishOutcome = (
          value: Exclude<SsrMiddlewareNavigationOutcome, null>
        ) => {
          if (navigationId !== navigationSequence) return
          outcome = value
          outcomeTarget = to.fullPath
          if (browserBootstrapNavigation) {
            for (const target of browserInitialTargets) {
              browserInitialOutcomes.set(target, value)
            }
          }
        }
        const plan = await execute(
          app,
          router,
          context,
          applicationMiddleware,
          installationId,
          to,
          from
        )
        if (disposed || navigationId !== navigationSequence) return false
        if (plan.kind === 'continue') {
          const transaction = propsRuntime.prepare(
            to,
            plan.props,
            plan.enteredMatchedIndices
          )
          transactions.set(to, transaction)
          try {
            transaction.commit()
          } catch (error) {
            rollback(to)
            throw error
          }
          if (options.server) {
            stagedCache.set(to, {
              kind: 'continue',
              props: clonePendingProps(plan.props),
              enteredMatchedIndices: [...plan.enteredMatchedIndices],
            })
          }
          return true
        }
        if (plan.kind === 'cancel') {
          publishOutcome('cancel')
          return false
        }
        if (plan.kind === 'redirect') {
          if (!options.server) return plan.location
          context.response.redirect = {
            location: router.resolve(plan.location).fullPath,
            statusCode: 302,
            allowExternal: false,
          }
          publishOutcome('redirect')
          return false
        }
        if (!options.server) {
          if (!plan.redirect.external) return plan.redirect.location
          const target = validateBrowserDocumentRedirect(
            resolveSpecialLocation(router, plan.redirect),
            context.siteOrigin
          )
          window.location.assign(target)
          publishOutcome('redirect')
          return false
        }
        context.response.redirect = {
          location: resolveSpecialLocation(router, plan.redirect),
          statusCode: plan.redirect.status,
          allowExternal: plan.redirect.external,
        }
        publishOutcome('redirect')
        return false
      })
      const removeAfter = router.afterEach((to, _from, failure) => {
        const terminal = resolveTerminalTarget(to)
        if (!terminal) return
        if (failure || terminal.redirected) rollback(terminal.target)
        else {
          transactions.get(terminal.target)?.accept()
          transactions.delete(terminal.target)
          const accepted = stagedCache.get(terminal.target)
          if (accepted) {
            cache.set(to.fullPath, {
              installationId,
              plan: accepted,
            })
          }
          stagedCache.delete(terminal.target)
        }
      })
      const removeError = router.onError((_error, to) => {
        const terminal = resolveTerminalTarget(to)
        if (terminal) rollback(terminal.target)
      })
      let installation: SsrMiddlewareInstallation
      let installationDisposed = false
      installation = {
        dispose() {
          if (installationDisposed) return
          installationDisposed = true
          removeBefore()
          removeAfter()
          removeError()
          transactions.clear()
          stagedCache.clear()
          propsRuntime.dispose()
          installations.delete(installation)
        },
      }
      installations.add(installation)
      return installation
    },
    navigationOutcome(target) {
      if (target !== undefined) {
        const initialOutcome = browserInitialOutcomes.get(target)
        if (initialOutcome) return initialOutcome
        return target === outcomeTarget ? outcome : null
      }
      return outcome
    },
    completeBrowserBootstrap() {
      if (!browserBootstrapActive) return
      browserBootstrapActive = false
      // START_LOCATION can persist after a cancelled or errored initial route.
      // Once the browser runtime finishes its controlled bootstrap operation,
      // no later navigation may consume work or decisions owned by that attempt.
      browserInitialInFlight.clear()
      browserInitialReplay.clear()
      browserInitialTargets.clear()
      browserInitialOutcomes.clear()
      outcome = null
      outcomeTarget = undefined
    },
    dispose() {
      if (disposed) return
      disposed = true
      browserBootstrapActive = false
      activeBrowserNavigation?.abort(abortReason())
      activeBrowserNavigation = undefined
      for (const installation of [...installations]) installation.dispose()
      cache.clear()
      browserInitialInFlight.clear()
      browserInitialReplay.clear()
      browserInitialTargets.clear()
      browserInitialOutcomes.clear()
      outcome = null
      outcomeTarget = undefined
    },
  }
}
