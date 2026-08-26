import type { ExtensionDefinition } from '../core/extensions/ExtensionDefinition'
import type { SsrApplicationDefinition } from '../SsrRuntimeTypes'
import { createSeoExtension } from './seo/index'
import { isSeoEnabled } from './seo/types'
import type { SeoSiteDefaults } from './seo/types'

export const resolveBuiltInExtensions = (
  application: SsrApplicationDefinition<any, any>,
  siteDefaults?: SeoSiteDefaults
): ExtensionDefinition[] => {
  if (!isSeoEnabled(application.seo)) return []
  return [createSeoExtension(application.seo, siteDefaults)]
}
