/** Advanced browser bootstrap APIs used by generated and custom integrations. */
export {
  hydrateSsrApplication,
  mountSpaApplication,
  type SsrClientApplicationDefinition,
  type SsrHydrateOptions,
  type SsrMountedApplication,
  type SsrSpaMountOptions,
} from './browser/SsrBrowserRuntime'
export {
  createDomainUrl,
  useDomain,
  type SsrCreateDomainUrlOptions,
  type SsrDomainApi,
} from './request/SsrDomainRuntime'
export {
  ssrWatch,
  ssrWatchEffect,
  type SsrWatchOptions,
} from './rendering/SsrReactivityRuntime'
export {
  SSR_REQUEST_RESOLUTION,
  useSsrResolution,
  type SsrRequestResolution,
} from './request/SsrRequestResolution'
export {
  SSR_HYDRATION_CONTEXT,
  type SsrHydrationContext,
} from './hydration/SsrHydrationRuntime'
export type {
  SsrApplicationDefinition,
  SsrHydrationState,
} from './application/SsrApplicationTypes'
export type { SsrDomainContext, SsrRenderRequest } from './request/SsrRequestTypes'
