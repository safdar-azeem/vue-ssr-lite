import { defineExtension } from '../../core/extensions/defineExtension'
import type { InternalExtensionContext } from '../../core/extensions/ExtensionContext'
import { contributeSeoHead } from './client'
import { createSeoState, type SeoState } from './state'
import { validateSeoApplicationConfig, validateSeoSiteDefaults } from './normalize'
import type { SeoApplicationConfig, SeoSiteDefaults } from './types'

export const SEO_EXTENSION_NAME = 'seo'

export const createSeoExtension = (
  config: SeoApplicationConfig = {},
  siteDefaults?: SeoSiteDefaults
) => {
  validateSeoApplicationConfig(config)
  if (siteDefaults) validateSeoSiteDefaults(siteDefaults)
  return defineExtension({
    name: SEO_EXTENSION_NAME,
    createState: () => createSeoState(config, siteDefaults),
    setup(context) {
      contributeSeoHead(context as InternalExtensionContext<SeoState>)
    },
  })
}

export type { SeoState } from './state'
export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  SeoApplicationConfig,
  SeoPageInput,
  SeoLinkEntry,
  SeoMetaEntry,
  SeoResolvable,
  SeoRouteInput,
  SeoSiteDefaults,
  UseSeoInput,
  UseSeoSource,
} from './types'
export { isPrivateSeoMode, isSeoEnabled } from './types'
export { useSeo } from './useSeo'
