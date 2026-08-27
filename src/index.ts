import './extensions/seo/types'
import type { ApplicationConfig, ServerConfig } from './SsrConfigTypes'

export { defineExtension } from './core/extensions/defineExtension'
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

const APPLICATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

/** Typed identity helper for `server.ts`. */
export const defineServer = <T extends ServerConfig>(config: T): T => config

/** Typed identity helper for explicit application registration. */
export const defineApplication = <T extends ApplicationConfig>(config: T): T => {
  if (!config || typeof config !== 'object') {
    throw new Error('defineApplication() requires an application configuration object.')
  }
  if (typeof config.name !== 'string' || !APPLICATION_NAME.test(config.name)) {
    throw new Error(
      'defineApplication() name must be a stable identifier matching /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.'
    )
  }
  if (config.render != null && config.render !== 'ssr' && config.render !== 'spa') {
    throw new Error(`Application "${config.name}" render must be "ssr" or "spa".`)
  }
  if (config.routes && config.router) {
    throw new Error(`Application "${config.name}" cannot declare both routes and router.`)
  }
  if ('port' in config && (config as { port?: unknown }).port != null) {
    throw new Error(
      `Application "${config.name}" cannot declare a port. Use defineServer({ server: { port } }).`
    )
  }
  return config
}
