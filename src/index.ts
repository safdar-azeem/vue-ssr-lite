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

export const defineSsrApplication = <T extends SsrApplicationDefinition<any, any, any>>(
  definition: T
): T => definition
