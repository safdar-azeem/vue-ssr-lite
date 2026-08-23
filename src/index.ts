export * from './SsrApplicationRuntime'
export * from './SsrConfigRuntime'
export * from './SsrConfigTypes'
export * from './SsrDomainRuntime'
export {
  normalizeSsrHost,
  normalizeSsrHostname,
  normalizeSsrHostPattern,
  stripSsrHostPort,
} from './SsrHostnameRuntime'
export * from './SsrHydrationRuntime'
export * from './SsrReactivityRuntime'
export * from './SsrRequestContext'
export * from './SsrRequestResolution'
export * from './SsrRuntimeTypes'
export * from './SsrSerialization'
export * from './SsrDiagnosticsRuntime'

import type { SsrApplicationDefinition } from './SsrRuntimeTypes'

/** Define the universal Vue application used by server and browser runtimes. */
export const defineApplication = <
  TApplicationState = Record<string, unknown>,
  TPublicConfig = unknown,
  TExtension = unknown,
>(
  definition: SsrApplicationDefinition<
    TApplicationState,
    TPublicConfig,
    TExtension
  >
): SsrApplicationDefinition<
  TApplicationState,
  TPublicConfig,
  TExtension
> => definition
