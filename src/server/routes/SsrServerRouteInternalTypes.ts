import type {
  ServerMiddlewareList,
  ServerRouteHandler,
  ServerRouteMethod,
} from './SsrServerRouteTypes'

export interface SsrCompiledServerRouteMethod {
  readonly middleware: ServerMiddlewareList
  readonly handler: ServerRouteHandler<any>
}

export interface SsrCompiledServerRoute {
  readonly pattern: string
  readonly matcher: RegExp
  readonly paramNames: readonly string[]
  readonly specificity: readonly number[]
  readonly methods: Readonly<Partial<Record<ServerRouteMethod, SsrCompiledServerRouteMethod>>>
  readonly allow: string
}

export interface SsrCompiledServerRoutes {
  readonly staticRoutes: Readonly<Record<string, SsrCompiledServerRoute>>
  readonly dynamicRoutes: readonly SsrCompiledServerRoute[]
  readonly ownedPaths: readonly string[]
}

export interface SsrServerRouteMatch {
  readonly route: SsrCompiledServerRoute
  readonly params: Readonly<Record<string, string>>
}
