import type { NavigationGuard, Router } from 'vue-router'
import type { SsrMiddlewareExecutionController, SsrMiddlewareInstallation } from './SsrMiddlewareRuntime'
import type { SsrRenderRequest } from '../SsrRuntimeTypes'

/**
 * Keep one guard in its original position. Inspect the actual matched records
 * on every navigation, including addRoute(), aliases and later meta mutations.
 * No executor is acquired until global or matched route middleware needs it.
 */
export const createSsrBrowserMiddleware = (options: {
  server: boolean
  request: SsrRenderRequest<any>
}): SsrMiddlewareExecutionController => {
  let runtime: SsrMiddlewareExecutionController | undefined
  let bootstrapComplete = false
  let disposed = false
  const installations = new Set<SsrMiddlewareInstallation>()
  return {
    install(installationOptions) {
      if (disposed) throw new Error('[vue-ssr-lite] Cannot install a disposed middleware controller.')
      const { router, context, middleware = [] } = installationOptions
      if (!Array.isArray(middleware) || middleware.some((entry) => typeof entry !== 'function')) {
        throw new Error(`[vue-ssr-lite] Application "${context.applicationId}" middleware must be an array of middleware functions.`)
      }
      const applicationMiddleware = [...middleware]
      let guard: NavigationGuard | undefined
      let after: Parameters<Router['afterEach']>[0] | undefined
      let error: Parameters<Router['onError']>[0] | undefined
      let active: SsrMiddlewareInstallation | undefined
      let pending: Promise<void> | undefined
      let removed = false
      let sequence = 0
      const activate = () => pending ??= import('./SsrMiddlewareRuntime').then((module) => {
        if (disposed || removed) return
        runtime ??= module.createSsrMiddlewareExecutionController(options)
        if (bootstrapComplete) runtime.completeBrowserBootstrap()
        active = runtime.install({
          ...installationOptions,
          middleware: applicationMiddleware,
          registerBeforeEach: ((execute) => {
            guard = execute
            return () => { guard = undefined }
          }) as Router['beforeEach'],
          registerAfterEach: (execute) => {
            after = execute
            return () => { after = undefined }
          },
          registerOnError: (execute) => {
            error = execute
            return () => { error = undefined }
          },
        })
      }).catch((error) => {
        pending = undefined
        throw error
      })
      const removeBefore = router.beforeEach(async (to, from) => {
        const current = ++sequence
        if (disposed || removed) return false
        if (!guard) {
          // Presence is conservative: getters, explicit undefined and invalid
          // declarations reach the executor without evaluating user getters twice.
          const required = applicationMiddleware.length > 0 ||
            to.matched.some((record) => 'middleware' in record.meta)
          if (!required) return true
          await activate()
        }
        if (disposed || removed || current !== sequence) return false
        return guard?.(to, from, () => {
          throw new Error('Framework middleware guards must return their navigation result.')
        })
      })
      const removeAfter = router.afterEach((...args) => after?.(...args))
      const removeError = router.onError((...args) => error?.(...args))
      const installation = {
        dispose() {
          removed = true
          ++sequence
          removeBefore()
          removeAfter()
          removeError()
          active?.dispose()
          installations.delete(installation)
        },
      }
      installations.add(installation)
      return installation
    },
    navigationOutcome: (target) => runtime?.navigationOutcome(target) ?? null,
    completeBrowserBootstrap() {
      bootstrapComplete = true
      runtime?.completeBrowserBootstrap()
    },
    dispose() {
      disposed = true
      for (const installation of installations) installation.dispose()
      runtime?.dispose()
    },
  }
}
