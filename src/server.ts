/** Server/configuration APIs. Implementation runtimes are intentionally private. */
export { defineSsrConfig } from './SsrConfigRuntime'
export { defineSitemap } from './server/SsrSitemapConfig'
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
  RobotsGroupsConfig,
  RobotsLegacyConfig,
  SeoEndpointContext,
  SeoEndpointResultMeta,
  SeoProviderMeta,
  SeoServerContext,
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
} from './server/SsrServerRuntime'
export {
  createSsrMemoryResponseCache,
  type SsrMemoryResponseCacheOptions,
} from './server/SsrResponseCacheRuntime'

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
} from './server/SsrRuntimeConfigRuntime'

/** Universal advanced helpers are mirrored here for server-only modules. */
export { createDomainUrl, useSsrDomain } from './SsrDomainRuntime'
export type { SsrCreateDomainUrlOptions, SsrDomainApi } from './SsrDomainRuntime'
export { useSsrRequestContext } from './SsrRequestContext'

export type {
  SsrApplicationConfig,
  SsrApplicationCookiesConfig,
  SsrApplicationDomainConfig,
  SsrApplicationModuleRef,
  SsrConfig,
  SsrConfigExport,
  SsrConfigServerOptions,
  SsrConfigShared,
  SsrDomainContext,
  SsrDomainMode,
  SsrDomainParamDefinition,
  SsrDomainParamSource,
  SsrMultiApplicationConfig,
  SsrPublicConfigFactory,
  SsrPublicConfigSource,
  SsrRenderMode,
  SsrSingleApplicationConfig,
} from './SsrConfigTypes'
export type {
  SsrEndpointDefinition,
  SsrEndpointTools,
  SsrErrorRenderContext,
  SsrHeaders,
  SsrHeaderValue,
  SsrHttpRequest,
  SsrHttpResponse,
  SsrLogger,
  SsrPublicConfigDomain,
  SsrPublicConfigHeaders,
  SsrPublicConfigHeaderValue,
  SsrPublicConfigRequest,
  SsrReadinessProbe,
  SsrRenderMetrics,
  SsrResponseCache,
  SsrResponseCacheInvalidation,
  SsrResponseCacheReadOptions,
  SsrResponseCacheStrategy,
  SsrResponseCacheWriteOptions,
} from './SsrRuntimeTypes'
