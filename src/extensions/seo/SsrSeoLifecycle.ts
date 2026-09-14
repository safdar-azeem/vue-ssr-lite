import type { ExtensionRuntime } from '../core/ExtensionRuntime'
import type { SsrRequestContext } from '../../request/SsrRequestTypes'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { recomputeSeoResponseStatus, type SeoState } from './state'

export { createSeoExtension } from './index'

export const updateSsrSeoRoute = (
  runtime: ExtensionRuntime,
  response: SsrRequestContext['response'],
  route: RouteLocationNormalizedLoaded
): void => {
  const state = runtime.getState<SeoState>('seo')
  if (state) recomputeSeoResponseStatus(state, response, route)
}
