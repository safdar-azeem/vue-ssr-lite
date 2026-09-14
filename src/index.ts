export { defineServerRoutes } from './server/routes/defineServerRoutes'
export { defineServerMiddleware } from './server/routes/defineServerMiddleware'
export type {
  GlobalServerMiddleware,
  ServerMiddleware,
  ServerMiddlewareHandler,
  ServerMiddlewareBaseContext,
  ServerRouteContext,
  ServerRouteHandler,
  ServerRouteMethod,
  ServerRoutesDefinition,
} from './server/routes/SsrServerRouteTypes'
import './extensions/seo/types'
import './middleware/SsrMiddlewareTypes'

export { defineExtension } from './extensions/core/defineExtension'
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
} from './extensions/core/index'
export type { AppContext, AppInitializer } from './application/SsrAppContext'
export type {
  ApplicationConfig,
  ServerConfig,
  SsrAppShellConfig,
  SsrRenderMode,
  SsrSeoConfig,
  SsrSiteSeoInput,
} from './config/SsrConfigTypes'
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
export { usePublicConfig } from './config/SsrPublicConfig'
/** Authoritative public origin for application-owned absolute URLs. */
export { useOrigin } from './request/SsrRequestContext'
export { useDomain, type SsrDomainApi } from './request/SsrDomainRuntime'
export { redirectTo, setHttpStatus } from './request/SsrResponseStatus'
export type { SsrResponseRedirectOptions } from './request/SsrResponseStatus'

export { defineServer, defineApplication } from './config/SsrPublicConfigHelpers'
