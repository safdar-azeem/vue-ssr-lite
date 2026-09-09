import type {
  InferredServerRoutesInput,
  InferredServerRoutesResult,
  ServerMiddlewareList,
  ServerRouteMiddlewareShape,
  ServerRoutesInput,
} from './SsrServerRouteTypes'

type InferredRoutesInput<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown>,
  PostMiddleware extends Record<string, unknown>,
  PutMiddleware extends Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown>,
> = InferredServerRoutesInput<
  Prefix,
  Group,
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware
>

type InferredRoutesResult<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown>,
  PostMiddleware extends Record<string, unknown>,
  PutMiddleware extends Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown>,
> = InferredServerRoutesResult<
  Prefix,
  Group,
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware
>

type DefinedRoutesInput<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Paths extends Readonly<Record<string, ServerRouteMiddlewareShape>>,
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown>,
  PostMiddleware extends Record<string, unknown>,
  PutMiddleware extends Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown>,
> = InferredRoutesInput<
    Prefix,
    Group,
    PathMiddleware,
    GetMiddleware,
    HeadMiddleware,
    PostMiddleware,
    PutMiddleware,
    PatchMiddleware,
    DeleteMiddleware,
    OptionsMiddleware
  > & ([NoInfer<Paths>] extends [never]
    ? unknown
    : ServerRoutesInput<Prefix, Group, Exclude<Paths, never>>)

type DefinedRoutesResult<
  Prefix extends string,
  Group extends ServerMiddlewareList,
  Paths extends Readonly<Record<string, ServerRouteMiddlewareShape>>,
  PathMiddleware extends Record<string, unknown>,
  GetMiddleware extends Record<string, unknown>,
  HeadMiddleware extends Record<string, unknown>,
  PostMiddleware extends Record<string, unknown>,
  PutMiddleware extends Record<string, unknown>,
  PatchMiddleware extends Record<string, unknown>,
  DeleteMiddleware extends Record<string, unknown>,
  OptionsMiddleware extends Record<string, unknown>,
> = InferredRoutesResult<
  Prefix,
  Group,
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware
> & ([NoInfer<Paths>] extends [never]
  ? unknown
  : ServerRoutesInput<Prefix, Group, Exclude<Paths, never>>)

export function defineServerRoutes<
  const Prefix extends string = '',
  const Group extends ServerMiddlewareList = readonly [],
  const Paths extends Readonly<Record<string, ServerRouteMiddlewareShape>> = never,
  const PathMiddleware extends Record<string, unknown> = Record<string, unknown>,
  const GetMiddleware extends Record<string, unknown> = Record<string, unknown>,
  const HeadMiddleware extends Record<string, unknown> = Record<string, unknown>,
  const PostMiddleware extends Record<string, unknown> = Record<string, unknown>,
  const PutMiddleware extends Record<string, unknown> = Record<string, unknown>,
  const PatchMiddleware extends Record<string, unknown> = Record<string, unknown>,
  const DeleteMiddleware extends Record<string, unknown> = Record<string, unknown>,
  const OptionsMiddleware extends Record<string, unknown> = Record<string, unknown>,
>(definition: DefinedRoutesInput<
  Prefix,
  Group,
  Paths,
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware
>): DefinedRoutesResult<
  Prefix,
  Group,
  Paths,
  PathMiddleware,
  GetMiddleware,
  HeadMiddleware,
  PostMiddleware,
  PutMiddleware,
  PatchMiddleware,
  DeleteMiddleware,
  OptionsMiddleware
>
export function defineServerRoutes(definition: object): object {
  return definition
}
