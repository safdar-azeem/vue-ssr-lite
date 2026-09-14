/** Server/configuration APIs. Implementation runtimes are intentionally private. */
export { defineServer } from './config/SsrConfigRuntime'
export { defineSitemap } from './extensions/seo/SsrSitemapConfig'
export type {
  SitemapContext,
  SitemapEntriesResult,
  SitemapEntry,
  SitemapImageEntry,
  SitemapNewsEntry,
  SitemapNotFoundResult,
  SitemapProvider,
  SitemapProviderResult,
  SitemapShardCollection,
  SitemapSource,
  SitemapVideoEntry,
} from './extensions/seo/sitemap'
export type {
  RobotsConfig,
  RobotsGroup,
  SeoSiteDefaults,
  SiteRobotsConfig,
  SiteRobotsContext,
  SiteRobotsResolution,
  SiteRobotsResolver,
  SiteSeoConfig,
  SiteSeoContext,
  SiteSeoResolution,
  SiteSeoResolver,
} from './extensions/seo/types'

/** Advanced programmatic hosting and cache integrations. */
export {
  createSsrManagedServer,
  type SsrManagedServer,
  type SsrManagedServerOptions,
} from './server/runtime/SsrServerRuntime'
export {
  createSsrMemoryResponseCache,
  type SsrMemoryResponseCacheOptions,
} from './server/runtime/SsrResponseCacheRuntime'

/** Reusable server-configuration helpers. */
export {
  createSsrConsoleLogger,
  createSsrSeoEndpoints,
  requireSsrEnum,
  requireSsrEnv,
  requireSsrHostname,
  ssrEnvBoolean,
  ssrEnvList,
  ssrEnvNumber,
  type SsrSeoEndpointMode,
  type SsrSeoEndpointOptions,
} from './config/SsrRuntimeConfigRuntime'

/** Universal advanced helpers are mirrored here for server-only modules. */
export { createDomainUrl, useDomain } from './request/SsrDomainRuntime'
export type { SsrCreateDomainUrlOptions, SsrDomainApi } from './request/SsrDomainRuntime'
export { useSsrRequestContext } from './request/SsrRequestContext'

export type {
  ApplicationConfig,
  ServerConfig,
  SsrApplicationCookiesConfig,
  SsrApplicationDomainConfig,
  SsrAppShellConfig,
  SsrConfigServerOptions,
  SsrDomainMode,
  SsrDomainParamDefinition,
  SsrDomainParamSource,
  SsrPublicConfigFactory,
  SsrPublicConfigSource,
  SsrRenderMode,
  SsrSeoConfig,
  SsrSiteSeoInput,
} from './config/SsrConfigTypes'
export type {
  SsrHeaders,
  SsrHeaderValue,
  SsrPublicConfigDomain,
  SsrPublicConfigHeaders,
  SsrPublicConfigHeaderValue,
  SsrPublicConfigRequest,
} from './request/SsrRequestTypes'
export type { SsrDomainContext } from './request/SsrRequestTypes'
export type {
  SsrEndpointDefinition,
  SsrEndpointTools,
  SsrErrorRenderContext,
  SsrHttpRequest,
  SsrHttpResponse,
  SsrReadinessProbe,
  SsrResponseCache,
  SsrResponseCacheInvalidation,
  SsrResponseCacheReadOptions,
  SsrResponseCacheStrategy,
  SsrResponseCacheWriteOptions,
} from './server/runtime/SsrServerTypes'
export type {
  SsrLogger,
  SsrRenderMetrics,
} from './diagnostics/SsrDiagnosticsTypes'
