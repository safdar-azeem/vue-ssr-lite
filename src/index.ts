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
  SeoApplicationConfig,
  SeoInput,
  SeoLinkEntry,
  SeoMetaEntry,
  SeoResolvable,
  SeoRouteInput,
  UseSeoInput,
} from './extensions/seo/types'
export { useSeo } from './extensions/seo/useSeo'
export { usePublicConfig } from './SsrPublicConfig'
/** Authoritative public origin for application-owned absolute URLs. */
export { useSiteOrigin } from './SsrRequestContext'
export { setResponseStatus } from './SsrResponseStatus'
export type { SsrApplicationDefinition } from './SsrRuntimeTypes'

/** Define the universal Vue application used by server and browser runtimes. */
export const defineApplication = <
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
>(
  definition: SsrApplicationDefinition<TApplicationState, TPublicConfig>
): SsrApplicationDefinition<TApplicationState, TPublicConfig> => definition
