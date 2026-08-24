import type { InternalExtensionContext } from '../../core/extensions/ExtensionContext'
import { normalizeSeo } from './normalize'
import { seoToHeadContribution } from './server'
import { mergeSeoLayers, type SeoState } from './state'
import type { SeoRouteInput } from './types'

export const contributeSeoHead = (context: InternalExtensionContext<SeoState>) => {
  context.contributeHead(() => {
    const route = context.route
    const merged = mergeSeoLayers(
      context.state,
      route?.meta?.seo as SeoRouteInput | undefined
    )
    return seoToHeadContribution(
      normalizeSeo({
        config: context.state.config,
        input: merged,
        origin: context.siteOrigin,
        path: route?.path ?? '/',
        status: context.responseStatus,
      })
    )
  })
}
