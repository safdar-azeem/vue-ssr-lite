/** Projection contracts and the explicit universal-field allowlist. */

/** serverRoutes and serverMiddleware are deliberately excluded: only Vue navigation
 * middleware belongs to the universal graph. HTTP dependencies remain server-only. */
export const SSR_UNIVERSAL_RUNTIME_FIELDS = [
  'extensions',
  'middleware',
  'router',
  'scrollBehavior',
  'createInitialState',
  'cleanup',
] as const

export type SsrUniversalRuntimeField = (typeof SSR_UNIVERSAL_RUNTIME_FIELDS)[number]

export interface SsrUniversalRuntimeProjection {
  imports: string[]
  statements?: string[]
  /** Absolute local modules proven as part of the emitted dependency closure. */
  dependencyFiles?: string[]
  /** Authoritative local or external identities selected by the server compiler. */
  dependencyIdentities?: string[]
  fields: Partial<Record<SsrUniversalRuntimeField, string>>
}

export interface SsrUniversalProjectionOptions {
  /**
   * A default-SPA application's middleware can only execute in the browser.
   * Keep projecting its exact binding, but let Vite own its normal browser
   * dependency graph instead of requiring browser/Node export equivalence.
   */
  browserOnlyMiddleware?: boolean
}

export interface SsrUniversalResolvedModule {
  identity: string
  path?: string
  external: boolean
}

export type SsrUniversalModuleResolver = (
  importer: string,
  specifier: string
) => SsrUniversalResolvedModule | undefined

export type EstreeNode = {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

export type Binding = {
  kind: 'import' | 'declaration'
  name: string
  node: EstreeNode
  declarationKind?: 'const' | 'let' | 'var'
}

export type UnwrapResult = {
  object: EstreeNode
  extra: EstreeNode[]
  configNames: Set<string>
  configDeclarators: Set<EstreeNode>
  allowedReturns: Set<EstreeNode>
}

export type ConfigHelpers = {
  calls: WeakSet<EstreeNode>
  serverIdentityCalls: WeakSet<EstreeNode>
  scopes: LexicalScopes
}

const UNIVERSAL_FIELD_SET = new Set<string>(SSR_UNIVERSAL_RUNTIME_FIELDS)

export const isUniversalField = (name: string): name is SsrUniversalRuntimeField =>
  UNIVERSAL_FIELD_SET.has(name)

export type ScopeBinding = {
  name: string
  tracked?: string
  configHelper?: 'helper' | 'server-identity' | 'namespace'
}

export type ScopeKind = 'module' | 'function' | 'block'

export type Scope = {
  parent?: Scope
  names: Map<string, ScopeBinding>
  kind: ScopeKind
}

export type LexicalScopes = {
  moduleScope: Scope
  lexicalScope: WeakMap<EstreeNode, Scope>
  nodeScope: WeakMap<EstreeNode, Scope>
  declaratorBindings: Map<EstreeNode, ScopeBinding[]>
  variableDeclarators: Array<{
    node: EstreeNode
    scope: Scope
    kind: 'const' | 'let' | 'var'
  }>
}

export interface SsrApplicationRoutesImportBinding {
  specifier: string
  imported: string
}
