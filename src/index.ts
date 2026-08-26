import './extensions/seo/types'
import type { SsrApplicationDefinition } from './SsrRuntimeTypes'

export { defineExtension } from './core/extensions/defineExtension'
export type {
  ExtensionContext,
  ExtensionDefinition,
  ExtensionEnvironment,
} from './core/extensions/index'
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  RobotsConfig,
  RobotsGroup,
  RobotsGroupsConfig,
  RobotsLegacyConfig,
  SeoApplicationConfig,
  SeoEndpointContext,
  SeoEndpointResultMeta,
  SeoImageInput,
  SeoImageValue,
  SeoInput,
  SeoLinkEntry,
  SeoMediaInput,
  SeoMediaValue,
  SeoMetaEntry,
  SeoOpenGraphDefaults,
  SeoOpenGraphInput,
  SeoPageInput,
  SeoProviderMeta,
  SeoResolvable,
  SeoRobotsInput,
  SeoRouteInput,
  SeoServerContext,
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
export { useSiteOrigin } from './SsrRequestContext'
export { setResponseRedirect, setResponseStatus } from './SsrResponseStatus'
export type { SsrResponseRedirectOptions } from './SsrResponseStatus'
export type { SsrApplicationDefinition } from './SsrRuntimeTypes'

/** Define the universal Vue application used by server and browser runtimes. */
export const defineApplication = <
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
>(
  definition: SsrApplicationDefinition<TApplicationState, TPublicConfig>
): SsrApplicationDefinition<TApplicationState, TPublicConfig> => definition
