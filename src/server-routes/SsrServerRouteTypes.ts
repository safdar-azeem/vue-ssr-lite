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

/** Only middleware tuples are inferred here; callbacks are contextually typed by the mapped input. */
export type ServerRouteMiddlewareShape = Partial<Record<ServerRouteMethod | 'middleware', unknown>>

type MiddlewareTuple<Value> = NonNullable<Value> extends ServerMiddlewareList
  ? number extends NonNullable<Value>['length'] ? readonly [] : NonNullable<Value>
  : readonly []

type MiddlewareInput<Value> = Value & (unknown extends Value
  ? ServerMiddlewareList
  : NonNullable<Value> extends ServerMiddlewareList ? unknown : ServerMiddlewareList)

type MiddlewareAt<Shape extends Record<string, unknown>, Path extends PropertyKey> =
  Path extends keyof Shape ? Shape[Path] : undefined

type KnownStringKeys<Shape extends Record<string, unknown>> =
  string extends keyof Shape ? never : keyof Shape & string

type GroupContext<Prefix extends string, Group extends ServerMiddlewareList> =
  ComposeServerMiddleware<ServerRouteContext<ServerRouteParams<Prefix>>, Group>

type RouteBaseContext<Prefix extends string, Group extends ServerMiddlewareList, Path extends string> =
  Omit<GroupContext<Prefix, Group>, 'params'> & ServerRouteContext<ServerRouteParams<`${Prefix}/${Path}`>>

type PathContext<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Path extends string,
  PathMiddleware,
> = ComposeServerMiddleware<
  RouteBaseContext<Prefix, Group, Path>,
  MiddlewareTuple<PathMiddleware>
>

type MethodRoute<
  Context,
  MethodMiddleware,
> = ServerRouteHandler<Context> | {
  readonly middleware?: MiddlewareInput<MethodMiddleware>
  readonly handler: ServerRouteHandler<ComposeServerMiddleware<
    Context,
    MiddlewareTuple<MethodMiddleware>
  >>
}

type PathMiddlewareRoutes<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  PathMiddleware extends Record<string, unknown>,
> = {
  readonly [Path in keyof PathMiddleware]: ServerRouteMiddlewareShape & {
    readonly middleware?: MiddlewareInput<PathMiddleware[Path]>
  }
}

type MethodRoutes<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  PathMiddleware extends Record<string, unknown>,
  Method extends ServerRouteMethod,
  MethodMiddleware extends Record<string, unknown>,
> = {
  readonly [Path in keyof MethodMiddleware]: ServerRouteMiddlewareShape & {
    readonly [Key in Method]?: MethodRoute<
      PathContext<Prefix, Group, Path & string, MiddlewareAt<PathMiddleware, Path>>,
      MethodMiddleware[Path]
    >
  }
}

type InvalidMiddlewarePath<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Paths extends string,
  PathMiddleware extends Record<string, unknown>,
> = {
  [Path in Paths]: [ComposeServerMiddleware<
    RouteBaseContext<Prefix, Group, Path>,
    MiddlewareTuple<MiddlewareAt<PathMiddleware, Path>>
  >] extends [never] ? Path : never
}[Paths]

type InvalidMethodPath<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Paths extends string,
  PathMiddleware extends Record<string, unknown>,
  MethodMiddleware extends Record<string, unknown>,
> = {
  [Path in Paths]: [ComposeServerMiddleware<
    PathContext<Prefix, Group, Path, MiddlewareAt<PathMiddleware, Path>>,
    MiddlewareTuple<MiddlewareAt<MethodMiddleware, Path>>
  >] extends [never] ? Path : never
}[Paths]

type ValidateRouteMiddleware<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Paths extends string,
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown>,
  PostMiddleware extends Record<string, unknown>,
  PutMiddleware extends Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown>,
> = [
  InvalidMiddlewarePath<Prefix, Group, Paths, PathMiddleware>
  | InvalidMethodPath<Prefix, Group, Paths, PathMiddleware, GetMiddleware>
  | InvalidMethodPath<Prefix, Group, Paths, PathMiddleware, HeadMiddleware>
  | InvalidMethodPath<Prefix, Group, Paths, PathMiddleware, PostMiddleware>
  | InvalidMethodPath<Prefix, Group, Paths, PathMiddleware, PutMiddleware>
  | InvalidMethodPath<Prefix, Group, Paths, PathMiddleware, PatchMiddleware>
  | InvalidMethodPath<Prefix, Group, Paths, PathMiddleware, DeleteMiddleware>
  | InvalidMethodPath<Prefix, Group, Paths, PathMiddleware, OptionsMiddleware>,
] extends [never] ? unknown : { readonly __invalidServerMiddleware__: never }

export type InferredServerRoutesInput<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown> = Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown> = Record<string, unknown>,
  PostMiddleware extends Record<string, unknown> = Record<string, unknown>,
  PutMiddleware extends Record<string, unknown> = Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown> = Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown> = Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly prefix?: Prefix
  readonly middleware?: Group & ValidateServerMiddleware<
    ServerRouteContext<ServerRouteParams<Prefix>>,
    NoInfer<Group>
  >
  readonly routes:
    PathMiddlewareRoutes<Prefix, Group, PathMiddleware>
    & MethodRoutes<Prefix, Group, PathMiddleware, 'GET', GetMiddleware>
    & MethodRoutes<Prefix, Group, PathMiddleware, 'HEAD', HeadMiddleware>
    & MethodRoutes<Prefix, Group, PathMiddleware, 'POST', PostMiddleware>
    & MethodRoutes<Prefix, Group, PathMiddleware, 'PUT', PutMiddleware>
    & MethodRoutes<Prefix, Group, PathMiddleware, 'PATCH', PatchMiddleware>
    & MethodRoutes<Prefix, Group, PathMiddleware, 'DELETE', DeleteMiddleware>
    & MethodRoutes<Prefix, Group, PathMiddleware, 'OPTIONS', OptionsMiddleware>
} & ValidateRouteMiddleware<
  Prefix,
  Group,
  KnownStringKeys<PathMiddleware>
  | KnownStringKeys<GetMiddleware>
  | KnownStringKeys<HeadMiddleware>
  | KnownStringKeys<PostMiddleware>
  | KnownStringKeys<PutMiddleware>
  | KnownStringKeys<PatchMiddleware>
  | KnownStringKeys<DeleteMiddleware>
  | KnownStringKeys<OptionsMiddleware>,
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware
>

type InferredRoutePaths<
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown>,
  PostMiddleware extends Record<string, unknown>,
  PutMiddleware extends Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown>,
> = KnownStringKeys<PathMiddleware>
  | KnownStringKeys<GetMiddleware>
  | KnownStringKeys<HeadMiddleware>
  | KnownStringKeys<PostMiddleware>
  | KnownStringKeys<PutMiddleware>
  | KnownStringKeys<PatchMiddleware>
  | KnownStringKeys<DeleteMiddleware>
  | KnownStringKeys<OptionsMiddleware>

type NormalizedRoutePaths<
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown>,
  PostMiddleware extends Record<string, unknown>,
  PutMiddleware extends Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown>,
> = [InferredRoutePaths<
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware
>] extends [never]
  ? string
  : InferredRoutePaths<
    PathMiddleware,
    GetMiddleware,
    HeadMiddleware,
    PostMiddleware,
    PutMiddleware,
    PatchMiddleware,
    DeleteMiddleware,
    OptionsMiddleware
  >

type NormalizedServerRoutePath<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Path extends string,
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware,
> = {
  readonly middleware?: MiddlewareInput<PathMiddleware>
  readonly GET?: MethodRoute<PathContext<Prefix, Group, Path, PathMiddleware>, GetMiddleware>
  readonly HEAD?: MethodRoute<PathContext<Prefix, Group, Path, PathMiddleware>, HeadMiddleware>
  readonly POST?: MethodRoute<PathContext<Prefix, Group, Path, PathMiddleware>, PostMiddleware>
  readonly PUT?: MethodRoute<PathContext<Prefix, Group, Path, PathMiddleware>, PutMiddleware>
  readonly PATCH?: MethodRoute<PathContext<Prefix, Group, Path, PathMiddleware>, PatchMiddleware>
  readonly DELETE?: MethodRoute<PathContext<Prefix, Group, Path, PathMiddleware>, DeleteMiddleware>
  readonly OPTIONS?: MethodRoute<PathContext<Prefix, Group, Path, PathMiddleware>, OptionsMiddleware>
}

/** Normalized public result after the input-only reverse-mapped inference layers have run. */
export type InferredServerRoutesResult<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown> = Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown> = Record<string, unknown>,
  PostMiddleware extends Record<string, unknown> = Record<string, unknown>,
  PutMiddleware extends Record<string, unknown> = Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown> = Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown> = Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown> = Record<string, unknown>,
> = {
  readonly prefix?: Prefix
  readonly middleware?: Group
  readonly routes: {
    readonly [Path in NormalizedRoutePaths<
      PathMiddleware,
      GetMiddleware,
      HeadMiddleware,
      PostMiddleware,
      PutMiddleware,
      PatchMiddleware,
      DeleteMiddleware,
      OptionsMiddleware
    >]: NormalizedServerRoutePath<
      Prefix,
      Group,
      Path,
      MiddlewareAt<PathMiddleware, Path>,
      MiddlewareAt<GetMiddleware, Path>,
      MiddlewareAt<HeadMiddleware, Path>,
      MiddlewareAt<PostMiddleware, Path>,
      MiddlewareAt<PutMiddleware, Path>,
      MiddlewareAt<PatchMiddleware, Path>,
      MiddlewareAt<DeleteMiddleware, Path>,
      MiddlewareAt<OptionsMiddleware, Path>
    >
  }
}

type ListAt<Shape, Key extends PropertyKey> = Key extends keyof Shape
  ? MiddlewareTuple<Shape[Key]>
  : readonly []

type DeclaredPathContext<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Path extends string,
  Shape extends ServerRouteMiddlewareShape,
> = ComposeServerMiddleware<
  RouteBaseContext<Prefix, Group, Path>,
  ListAt<Shape, 'middleware'>
>

type DeclaredServerRoutePath<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Path extends string,
  Shape extends ServerRouteMiddlewareShape,
> = {
  readonly [Key in keyof Shape]: Key extends 'middleware'
    ? Shape[Key] & ValidateServerMiddleware<
      RouteBaseContext<Prefix, Group, Path>,
      ListAt<NoInfer<Shape>, 'middleware'>
    >
    : Key extends ServerRouteMethod
      ? ServerRouteHandler<DeclaredPathContext<Prefix, Group, Path, Shape>> | {
        readonly middleware?: Shape[Key] & ValidateServerMiddleware<
          DeclaredPathContext<Prefix, Group, Path, Shape>,
          ListAt<NoInfer<Shape>, Key>
        >
        readonly handler: ServerRouteHandler<ComposeServerMiddleware<
          DeclaredPathContext<Prefix, Group, Path, Shape>,
          ListAt<NoInfer<Shape>, Key>
        >>
      }
      : never
}

/**
 * Public explicit-generic route definition contract. `Paths` describes the complete
 * route shape, as it did before independent middleware-tuple inference was added.
 */
export type ServerRoutesInput<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Paths extends Readonly<Record<string, ServerRouteMiddlewareShape>>,
> = {
  readonly prefix?: Prefix
  readonly middleware?: Group & ValidateServerMiddleware<
    ServerRouteContext<ServerRouteParams<Prefix>>,
    NoInfer<Group>
  >
  readonly routes: {
    readonly [Path in keyof Paths]: DeclaredServerRoutePath<
      Prefix,
      Group,
      Path & string,
      Paths[Path]
    >
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
