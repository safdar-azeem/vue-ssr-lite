import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { ManagedHeadController } from '../../SsrManagedHead'
import type {
  ExtensionContext,
  ExtensionEnvironment,
  InternalExtensionContext,
} from './ExtensionContext'
import type { ExtensionDefinition } from './ExtensionDefinition'

export const SSR_EXTENSION_RUNTIME = Symbol.for('vue-ssr:extension-runtime')

export interface ExtensionRuntimeOptions {
  applicationId: string
  server: boolean
  production: boolean
  getRoute: () => RouteLocationNormalizedLoaded | null
  getSiteOrigin: () => string
  getResponseStatus: () => number
  managedHead: ManagedHeadController
}

interface ActiveExtension<TState = unknown> {
  definition: ExtensionDefinition<TState>
  state: TState
  cleanup?: () => void
}

const isProduction = (): boolean =>
  typeof process !== 'undefined' && process.env.NODE_ENV === 'production'

export const wrapExtensionError = (
  name: string,
  lifecycle: string,
  cause: unknown
): Error => {
  const error = new Error(
    `[vue-ssr-lite] Extension "${name}" failed during ${lifecycle}.`
  )
  error.cause = cause
  return error
}

export const assertUniqueExtensionNames = (
  extensions: readonly ExtensionDefinition[]
): void => {
  const seen = new Set<string>()
  for (const extension of extensions) {
    if (seen.has(extension.name)) {
      throw new Error(
        isProduction()
          ? `[vue-ssr-lite] Duplicate extension "${extension.name}".`
          : `[vue-ssr-lite] Duplicate extension "${extension.name}". Each resolved extension name must be unique.`
      )
    }
    seen.add(extension.name)
  }
}

export const resolveExtensions = (
  builtIns: readonly ExtensionDefinition[],
  custom: readonly ExtensionDefinition[] = []
): ExtensionDefinition[] => {
  const resolved = [...builtIns, ...custom]
  assertUniqueExtensionNames(resolved)
  return resolved
}

export interface ExtensionRuntime {
  readonly extensions: readonly ExtensionDefinition[]
  readonly disposed: boolean
  getState<TState = unknown>(name: string): TState | undefined
  has(name: string): boolean
  setup(): void
  dispose(): void
}

export const createExtensionRuntime = (
  builtIns: readonly ExtensionDefinition[],
  custom: readonly ExtensionDefinition[],
  options: ExtensionRuntimeOptions
): ExtensionRuntime => {
  const extensions = resolveExtensions(builtIns, custom)
  const active: ActiveExtension[] = []
  let disposed = false

  const environment: ExtensionEnvironment = {
    server: options.server,
    production: options.production,
  }

  const createContext = <TState>(
    definition: ExtensionDefinition<TState>,
    state: TState
  ): InternalExtensionContext<TState> => ({
    application: { id: options.applicationId },
    get route() {
      return options.getRoute()
    },
    environment,
    state,
    get siteOrigin() {
      return options.getSiteOrigin()
    },
    get responseStatus() {
      return options.getResponseStatus()
    },
    contributeHead(contribution) {
      options.managedHead.contribute(definition.name, contribution)
    },
  })

  return {
    extensions,
    get disposed() {
      return disposed
    },
    getState<TState = unknown>(name: string): TState | undefined {
      return active.find((entry) => entry.definition.name === name)?.state as
        | TState
        | undefined
    },
    has(name) {
      return active.some((entry) => entry.definition.name === name)
    },
    setup() {
      for (const definition of extensions) {
        let state: unknown
        try {
          state = definition.createState?.()
        } catch (error) {
          throw wrapExtensionError(definition.name, 'createState', error)
        }
        const entry: ActiveExtension = { definition, state }
        active.push(entry)
        if (!definition.setup) continue
        try {
          const context = createContext(
            definition,
            state
          ) as ExtensionContext<unknown>
          const cleanup = definition.setup(context)
          if (typeof cleanup === 'function') entry.cleanup = cleanup
        } catch (error) {
          throw wrapExtensionError(definition.name, 'setup', error)
        }
      }
    },
    dispose() {
      disposed = true
      while (active.length > 0) {
        const entry = active.pop()
        if (!entry?.cleanup) continue
        try {
          entry.cleanup()
        } catch (error) {
          console.error(
            `[vue-ssr-lite] Extension "${entry.definition.name}" cleanup failed`,
            error
          )
        }
      }
    },
  }
}
