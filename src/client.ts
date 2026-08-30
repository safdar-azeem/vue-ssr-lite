/** Advanced browser bootstrap APIs used by generated and custom integrations. */
export {
  hydrateSsrApplication,
  mountSpaApplication,
  type SsrClientApplicationDefinition,
  type SsrHydrateOptions,
  type SsrMountedApplication,
  type SsrSpaMountOptions,
} from './SsrBrowserRuntime'
export {
  createDomainUrl,
  useDomain,
  type SsrCreateDomainUrlOptions,
  type SsrDomainApi,
} from './SsrDomainRuntime'
export {
  ssrWatch,
  ssrWatchEffect,
  type SsrWatchOptions,
} from './SsrReactivityRuntime'
export {
  SSR_REQUEST_RESOLUTION,
  useSsrResolution,
  type SsrRequestResolution,
} from './SsrRequestResolution'
export {
  SSR_HYDRATION_CONTEXT,
  type SsrHydrationContext,
} from './SsrHydrationRuntime'
export type {
  SsrApplicationDefinition,
  SsrHydrationState,
  SsrRenderRequest,
} from './SsrRuntimeTypes'
export type { SsrDomainContext } from './SsrConfigTypes'
