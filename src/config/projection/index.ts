/** Configuration projection boundary used by the compiler and Vite integration. */
export {
  SSR_UNIVERSAL_RUNTIME_FIELDS,
  type SsrUniversalRuntimeField,
  type SsrUniversalRuntimeProjection,
  type SsrUniversalProjectionOptions,
  type SsrUniversalResolvedModule,
  type SsrUniversalModuleResolver,
  type SsrApplicationRoutesImportBinding,
} from './types'
export {
  hasUniversalRuntimeValue,
  assertUniversalProjectionCoverage,
  projectUniversalRuntimeSource,
  mergeUniversalRuntimeProjections,
} from './project'
export {
  isDefineApplicationModuleSource,
  resolveApplicationRoutesImportBindings,
  resolveApplicationRoutesImportSpecifiers,
  resolveApplicationMiddlewareImportBindings,
  sourceDeclaresServerConfigRoutes,
  sourceDeclaresSpaOnlyApplication,
} from './source-analysis'
export {
  assertNoImportedUniversalConfigMutation,
} from './imported-mutation'
