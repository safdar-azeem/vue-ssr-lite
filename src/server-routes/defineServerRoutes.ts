import type {
  ServerMiddlewareList,
  ServerRouteMiddlewareShape,
  ServerRoutesInput,
} from './SsrServerRouteTypes'

/** Typed identity helper. Compilation and HTTP mechanics belong to the server runtime. */
export function defineServerRoutes<
  const Prefix extends string = '',
  const Group extends ServerMiddlewareList = readonly [],
  const Paths extends Record<string, ServerRouteMiddlewareShape> = {},
>(definition: ServerRoutesInput<Prefix, Group, Paths>): ServerRoutesInput<Prefix, Group, Paths> {
  return definition
}
