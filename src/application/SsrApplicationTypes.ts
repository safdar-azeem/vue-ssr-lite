import type { SsrRenderMetrics } from '../diagnostics/SsrDiagnosticsTypes'
import type { ExtensionDefinition } from '../extensions/core/ExtensionDefinition'
import type { SeoApplicationConfig } from '../extensions/seo/types'
import type { SsrHydrationContext, SsrHydrationController } from '../hydration/SsrHydrationRuntime'
import type { Middleware } from '../middleware/SsrMiddlewareTypes'
import type {
  SsrDomainContext,
  SsrRenderRequest,
  SsrRequestContext,
  SsrResponseState,
} from '../request/SsrRequestTypes'
import type { SsrRequestResolution, SsrResolutionController } from '../request/SsrRequestResolution'
import type { App, Component, Plugin } from 'vue'
import type { Router, RouterHistory, RouteRecordRaw, RouterScrollBehavior } from 'vue-router'

export interface SsrHydrationState<TApplicationState = unknown, TPublicConfig = unknown> {
  version: 1
  applicationId: string
  publicConfig: TPublicConfig
  domain: SsrDomainContext
  application: TApplicationState
  /** Authoritative public origin resolved during SSR. */
  siteOrigin?: string
  /** Validated public site defaults resolved on the server. */
  siteSeo?: import('../extensions/seo/types').SeoSiteDefaults
  /**
   * Serializable state contributed by installed application plugins, keyed by
   * an opaque plugin identifier. `vue-ssr-lite` never inspects the values.
   */
  plugins?: Record<string, unknown>
}

export interface SsrApplicationSetup<TApplicationState, TPublicConfig> {
  app: App
  router: Router | null
  context: SsrRequestContext<TApplicationState, TPublicConfig>
  /** Generic hydration state contract for installed application plugins. */
  hydration: SsrHydrationContext
  /** Generic server-render resolution contract for installed plugins. */
  resolution: SsrRequestResolution
  server: boolean
}

export interface SsrApplicationDefinition<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> {
  /** Optional identity used by tests and compile-time resolution. */
  id?: string
  /** The universal root component used for both SSR and browser execution. */
  root: Component
  routes?: RouteRecordRaw[] | (() => RouteRecordRaw[])
  /**
   * Advanced request-safe router factory. vue-ssr-lite supplies memory history
   * on the server and web history in the browser.
   */
  router?: (options: { history: RouterHistory; server: boolean }) => Router
  /**
   * Optional router scroll behaviour. When omitted, a sensible default is used
   * (restore saved position, scroll to hash, otherwise top). Provide one to keep
   * an application's existing behaviour exactly when adopting the definition.
   */
  scrollBehavior?: RouterScrollBehavior
  /** Application-wide middleware, in declaration order. */
  middleware?: readonly Middleware<TPublicConfig>[]
  /** Application default render mode. Route `meta.render` may override it. */
  defaultRender?: 'spa' | 'ssr'
  /**
   * Vue plugins installed for every isolated server/browser app. Prefer a
   * factory for stateful plugins so concurrent SSR requests never share state.
   * A static list is suitable only for stateless/global-safe plugins.
   */
  plugins?: readonly Plugin[] | (() => readonly Plugin[])
  /** Declarative built-in SEO configuration. Omitted means SEO is enabled. */
  seo?: SeoApplicationConfig
  /**
   * Universal-safe custom runtime extensions. Built-in SEO is auto-attached
   * and must not be registered here.
   */
  extensions?: readonly ExtensionDefinition[]
  createInitialState?: () => TApplicationState
  install?: (setup: SsrApplicationSetup<TApplicationState, TPublicConfig>) => void | Promise<void>
  cleanup?: (context: SsrRequestContext<TApplicationState, TPublicConfig>) => void | Promise<void>
}

/** Internal application definition after configuration assigns its identity. */
export type SsrResolvedApplicationDefinition<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> = SsrApplicationDefinition<TApplicationState, TPublicConfig> & { id: string }

export interface SsrCreatedApplication<
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
> {
  app: App
  router: Router | null
  context: SsrRequestContext<TApplicationState, TPublicConfig>
  /** Per-request hydration controller owning plugin state and disposal. */
  hydration: SsrHydrationController
  /** Per-request resolution controller, shared across render passes. */
  resolution: SsrResolutionController
  /** Core managed-head collector for this application instance. */
  managedHead: import('../head/SsrManagedHead').ManagedHeadController
  /** @internal Core-owned route middleware lifecycle for this app/request. */
  middleware: import('../middleware/SsrMiddlewareRuntime').SsrMiddlewareExecutionController | null
  /** @internal Application-owned first-party fetch runtime. */
  fetchRuntime: import('../data/fetch/runtime/SsrFetchRuntime').SsrFetchRuntime
}

export interface SsrRenderResult<TApplicationState = unknown, TPublicConfig = unknown> {
  html: string
  /** Vue-native target-to-markup Teleport result. */
  teleports: Record<string, string>
  /** Module ids reported by Vue for the final accepted SSR render pass. */
  renderedModules: readonly string[]
  head: import('../head/SsrManagedHead').ManagedHeadSnapshot
  response: SsrResponseState
  hydrationState: SsrHydrationState<TApplicationState, TPublicConfig>
  metrics: SsrRenderMetrics
}
