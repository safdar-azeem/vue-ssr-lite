/** Public HTTP types only. This module must remain safe for the browser entrypoint. */
export interface ServerMiddlewareBaseContext {
  readonly requestId: string
}

export interface ServerRouteContext<Params extends object = Record<string, string>>
  extends ServerMiddlewareBaseContext {
  readonly params: Readonly<Params>
}

export type ServerRouteHandler<Context = ServerRouteContext> = (
  request: Request,
  context: Context
) => Response | Promise<Response>

type FrameworkKeys = 'requestId' | 'params'
type RequiredContext<Requires extends object> =
  ServerMiddlewareBaseContext & Omit<Requires, FrameworkKeys> &
  { readonly [Key in keyof Requires as Key extends 'params' ? Key : never]: Readonly<Requires[Key]> }

export type ServerMiddlewareHandler<
  Provides extends object = {},
  Requires extends object = {},
> = Extract<FrameworkKeys, keyof Provides> extends never
  ? (
      request: Request,
      context: RequiredContext<Requires> & Partial<Provides>,
      next: () => Promise<Response>
    ) => Response | Promise<Response>
  : never

// Required, invariant phantom properties prevent widening away Provides/Requires.
// They have no runtime representation and are never consulted during dispatch.
declare const serverMiddlewareContract: unique symbol
export type ServerMiddleware<Provides extends object = {}, Requires extends object = {}> =
  ServerMiddlewareHandler<Provides, Requires> & {
    readonly [serverMiddlewareContract]: {
      readonly providesKeys: keyof Provides
      readonly requiresKeys: keyof Requires
      readonly provides: (value: Provides) => Provides
      readonly requires: (value: Requires) => Requires
    }
  }

export type GlobalServerMiddleware = ServerMiddleware<{}, {}>
export type ServerRouteMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'

/** Existential storage shape; typed composition happens in defineServerRoutes. */
export type AnyServerMiddleware = ((
  request: Request,
  context: any,
  next: () => Promise<Response>
) => Response | Promise<Response>) & {
  readonly [serverMiddlewareContract]: {
    readonly providesKeys: PropertyKey
    readonly requiresKeys: PropertyKey
    readonly provides: (value: any) => any
    readonly requires: (value: any) => any
  }
}
export type ServerMiddlewareList = readonly AnyServerMiddleware[]

type ProvidesOf<M extends AnyServerMiddleware> = ReturnType<M[typeof serverMiddlewareContract]['provides']>
type RequiresOf<M extends AnyServerMiddleware> = ReturnType<M[typeof serverMiddlewareContract]['requires']>
type ContextKeys<Context> = Context extends unknown ? keyof Context : never
type UnsatisfiedMiddleware<Context, M extends AnyServerMiddleware> = M extends AnyServerMiddleware
  ? [Context] extends [RequiresOf<M>] ? never : M
  : never

type ParamName<Segment extends string> = Segment extends `:${infer Name}` ? Name : never
type ParamNames<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? ParamName<Segment> | ParamNames<Rest>
  : ParamName<Path>
export type ServerRouteParams<Path extends string> = {
  readonly [Name in ParamNames<Path>]: string
}

/** Fold a tuple left to right, rejecting unsatisfied requirements and all duplicate keys. */
export type ComposeServerMiddleware<Context, Middleware extends ServerMiddlewareList> =
  Middleware extends readonly [infer First extends AnyServerMiddleware, ...infer Rest extends ServerMiddlewareList]
    ? [UnsatisfiedMiddleware<Context, First>] extends [never]
      ? Extract<ContextKeys<Context> | FrameworkKeys, First[typeof serverMiddlewareContract]['providesKeys']> extends never
        ? ComposeServerMiddleware<Context & ProvidesOf<First>, Rest>
        : never
      : never
    : Middleware extends readonly []
      ? Context
      : number extends Middleware['length']
        ? Middleware[number] extends GlobalServerMiddleware ? Context : never
        : never

export type ValidateServerMiddleware<Context, Middleware extends ServerMiddlewareList> =
  [ComposeServerMiddleware<Context, Middleware>] extends [never] ? never : Middleware

/** Only middleware is inferred here; callbacks are contextually typed by the mapped input. */
export type ServerRouteMiddlewareShape = Partial<
  Record<ServerRouteMethod | 'middleware', unknown>
>
type ListAt<Shape, Key extends PropertyKey> = Key extends keyof Shape
  ? NonNullable<Shape[Key]> extends ServerMiddlewareList ? NonNullable<Shape[Key]> : readonly []
  : readonly []

type GroupContext<Prefix extends string, Group extends ServerMiddlewareList> =
  ComposeServerMiddleware<ServerRouteContext<ServerRouteParams<Prefix>>, Group>
type PathContext<Prefix extends string, Group extends ServerMiddlewareList, Path extends string, Shape> =
  ComposeServerMiddleware<
    Omit<GroupContext<Prefix, Group>, 'params'> & ServerRouteContext<ServerRouteParams<`${Prefix}/${Path}`>>,
    ListAt<Shape, 'middleware'>
  >

type TypedServerRoutePath<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Path extends string,
  Shape extends ServerRouteMiddlewareShape,
> = {
  [Key in keyof Shape]: Key extends 'middleware'
    ? Shape[Key] & ValidateServerMiddleware<
        Omit<GroupContext<Prefix, Group>, 'params'> & ServerRouteContext<ServerRouteParams<`${Prefix}/${Path}`>>,
        ListAt<NoInfer<Shape>, Key>
      >
    : Key extends ServerRouteMethod
      ? ServerRouteHandler<PathContext<Prefix, Group, Path, Shape>> | {
          middleware?: Shape[Key] & ValidateServerMiddleware<
            PathContext<Prefix, Group, Path, Shape>, ListAt<NoInfer<Shape>, Key>
          >
          handler: ServerRouteHandler<ComposeServerMiddleware<
            PathContext<Prefix, Group, Path, Shape>, ListAt<NoInfer<Shape>, Key>
          >>
        }
      : never
}

export type ServerRoutesInput<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Paths extends Record<string, ServerRouteMiddlewareShape>,
> = {
  readonly prefix?: Prefix
  readonly middleware?: Group & ValidateServerMiddleware<ServerRouteContext<ServerRouteParams<Prefix>>, NoInfer<Group>>
  readonly routes: {
    [Path in keyof Paths]: TypedServerRoutePath<Prefix, Group, Path & string, Paths[Path]>
  }
}

/** Application-owned collection accepted by serverRoutes configuration. */
export interface ServerRoutesDefinition {
  readonly prefix?: string
  readonly middleware?: ServerMiddlewareList
  readonly routes: Readonly<Record<string, {
    readonly middleware?: ServerMiddlewareList
  } & Partial<Record<ServerRouteMethod, ServerRouteHandler<any> | {
    readonly middleware?: ServerMiddlewareList
    readonly handler: ServerRouteHandler<any>
  }>>>>
}
