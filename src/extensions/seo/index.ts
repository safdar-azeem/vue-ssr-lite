import { defineExtension } from '../../core/extensions/defineExtension'
import type { InternalExtensionContext } from '../../core/extensions/ExtensionContext'
import { contributeSeoHead } from './client'
import { createSeoState, type SeoState } from './state'
import type { SeoApplicationConfig } from './types'

export const SEO_EXTENSION_NAME = 'seo'

export const createSeoExtension = (config: SeoApplicationConfig = {}) =>
  defineExtension({
    name: SEO_EXTENSION_NAME,
    createState: () => createSeoState(config),
    setup(context) {
      contributeSeoHead(context as InternalExtensionContext<SeoState>)
    },
  })

export type { SeoState } from './state'
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
} from './types'
export { isPrivateSeoMode, isSeoEnabled } from './types'
export { useSeo } from './useSeo'
