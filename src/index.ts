export * from './SsrApplicationRuntime'
export * from './SsrHydrationRuntime'
export * from './SsrReactivityRuntime'
export * from './SsrRequestContext'
export * from './SsrRequestResolution'
export * from './SsrRuntimeTypes'
export * from './SsrSerialization'
export * from './SsrDiagnosticsRuntime'

import type {
  SsrApplicationDefinition,
  SsrRuntimeDefinition,
} from './SsrRuntimeTypes'

export const defineSsrApplication = <T extends SsrApplicationDefinition<any, any, any>>(
  definition: T
): T => definition

export const defineSsrRuntime = <T extends SsrRuntimeDefinition<any>>(
  definition: T
): T => definition
