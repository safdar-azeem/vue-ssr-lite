export { defineServerRoutes } from './server-routes/defineServerRoutes'
export { defineServerMiddleware } from './server-routes/defineServerMiddleware'
export type {
  GlobalServerMiddleware,
  ServerMiddleware,
  ServerMiddlewareHandler,
  ServerMiddlewareBaseContext,
  ServerRouteContext,
  ServerRouteHandler,
  ServerRouteMethod,
  ServerRoutesDefinition,
} from './server-routes/SsrServerRouteTypes'
import './extensions/seo/types'
import './middleware/SsrMiddlewareTypes'
import type { ApplicationConfig, ServerConfig } from './SsrConfigTypes'

export { defineExtension } from './core/extensions/defineExtension'
export { defineMiddleware } from './middleware/defineMiddleware'
export { LoadingIndicator, RouterView } from './navigation/index'
export { setContext, useFetch } from './data/index'
export type {
  SetContextOptions,
  UseFetchDoneContext,
  UseFetchError,
  UseFetchErrorContext,
  UseFetchOptions,
  UseFetchOptionsBase,
  UseFetchOptionsParameter,
  UseFetchPolicy,
  UseFetchResult,
  UseFetchReturn,
  UseFetchVariablePrimitive,
  UseFetchVariableShape,
  UseFetchVariableValue,
  UseFetchVariables,
  VariablesOption,
} from './data/index'
export type {
  Middleware,
  MiddlewareContext,
  MiddlewareCookieOptions,
  MiddlewareCookies,
  MiddlewarePropsResult,
  MiddlewareRedirectOptions,
  MiddlewareRedirectResult,
  MiddlewareRedirectStatus,
  MiddlewareResult,
} from './middleware/SsrMiddlewareTypes'
export type {
  ExtensionContext,
  ExtensionDefinition,
  ExtensionEnvironment,
} from './core/extensions/index'
export type { AppContext, AppInitializer } from './SsrAppContext'
export type {
  ApplicationConfig,
  ServerConfig,
  SsrAppShellConfig,
  SsrRenderMode,
  SsrSeoConfig,
  SsrSiteSeoInput,
} from './SsrConfigTypes'
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  RobotsConfig,
  RobotsGroup,
  SeoImageInput,
  SeoImageValue,
  SeoLinkEntry,
  SeoMediaInput,
  SeoMediaValue,
  SeoMetaEntry,
  SeoOpenGraphDefaults,
  SeoOpenGraphInput,
  SeoPageInput,
  SeoResolvable,
  SeoRobotsInput,
  SeoRouteInput,
  SeoSiteDefaults,
  SeoTwitterInput,
  SiteRobotsConfig,
  SiteRobotsContext,
  SiteRobotsResolution,
  SiteRobotsResolver,
  SiteSeoConfig,
  SiteSeoContext,
  SiteSeoResolution,
  SiteSeoResolver,
  UseSeoInput,
  UseSeoSource,
} from './extensions/seo/types'
export { useSeo } from './extensions/seo/useSeo'
export { usePublicConfig } from './SsrPublicConfig'
/** Authoritative public origin for application-owned absolute URLs. */
export { useOrigin } from './SsrRequestContext'
export { useDomain, type SsrDomainApi } from './SsrDomainRuntime'
export { redirectTo, setHttpStatus } from './SsrResponseStatus'
export type { SsrResponseRedirectOptions } from './SsrResponseStatus'

const APPLICATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Typed identity helper for `server.ts`. */
export const defineServer = <T extends ServerConfig>(config: T): T => config

/** Typed identity helper for explicit application registration. */
export const defineApplication = <T extends ApplicationConfig>(config: T): T => {
  if (!config || typeof config !== 'object') {
    throw new Error('defineApplication() requires an application configuration object.')
  }
  const applicationName = config.name
  if (typeof applicationName !== 'string' || !APPLICATION_NAME.test(applicationName)) {
    throw new Error(
      'defineApplication() name must be a stable identifier matching /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.'
    )
  }
  if (config.render != null && config.render !== 'ssr' && config.render !== 'spa') {
    throw new Error(`Application "${applicationName}" render must be "ssr" or "spa".`)
  }
  if (config.routes && config.router) {
    throw new Error(`Application "${applicationName}" cannot declare both routes and router.`)
  }
  if (config.host != null && config.domain != null) {
    throw new Error(
      `Application "${applicationName}" cannot declare both "host" and "domain". Use "host" for simple static host matching or "domain" for environment-aware domain routing.`
    )
  }
  if ('serverMiddleware' in config && config.serverMiddleware !== undefined) {
    throw new Error('serverMiddleware belongs on defineServer(), not defineApplication().')
  }
  if ('port' in config && (config as { port?: unknown }).port != null) {
    throw new Error(
      `Application "${applicationName}" cannot declare a port. Use defineServer({ server: { port } }).`
    )
  }
  return config
}
