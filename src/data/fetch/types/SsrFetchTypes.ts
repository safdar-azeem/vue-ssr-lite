import type { MaybeRefOrGetter, ShallowRef } from 'vue'

export type UseFetchPolicy = 'network-only' | 'cache-first'
export type UseFetchVariablePrimitive = string | number | boolean | null | undefined
export type UseFetchVariableValue = UseFetchVariablePrimitive | readonly UseFetchVariablePrimitive[]
export type UseFetchVariables = Record<string, UseFetchVariableValue>
export type UseFetchVariableShape<TVariables extends object> = {
  [K in keyof TVariables]: TVariables[K] extends UseFetchVariableValue ? TVariables[K] : never
}

/** Application request defaults consumed only by first-party useFetch. */
export interface SetContextOptions {
  headers?: HeadersInit
}

export interface UseFetchError {
  readonly name: 'UseFetchError'
  readonly kind: 'http' | 'network' | 'parse' | 'timeout'
  readonly message: string
  readonly status?: number
  readonly statusText?: string
}

export interface UseFetchReturn<TData> {
  data: ShallowRef<TData | undefined>
  pending: Readonly<ShallowRef<boolean>>
  error: Readonly<ShallowRef<UseFetchError | null>>
  refresh: () => Promise<void>
}

/** Await observes the initial SSR execution only; browser network work never suspends setup. */
export type UseFetchResult<TData> = UseFetchReturn<TData> & PromiseLike<UseFetchReturn<TData>>

export interface UseFetchDoneContext<TData, TVariables extends object> {
  readonly data: TData
  readonly variables: Readonly<TVariables>
  /** Opaque public identity. Its encoding is not API. */
  readonly key: string
  readonly server: boolean
  readonly status: number
  readonly statusText: string
}

export interface UseFetchErrorContext<TVariables extends object> {
  readonly error: UseFetchError
  readonly variables: Readonly<TVariables>
  readonly key: string
  readonly server: boolean
  readonly status?: number
  readonly statusText?: string
}

export interface UseFetchOptionsBase<TData, TVariables extends object> {
  key?: string
  method?: 'GET' | 'HEAD'
  headers?: HeadersInit
  /** Skip stored defaults only; automatic SSR credential forwarding is separate. */
  context?: boolean
  credentials?: RequestCredentials
  mode?: RequestMode
  redirect?: RequestRedirect
  referrer?: string
  referrerPolicy?: ReferrerPolicy
  integrity?: string
  cache?: RequestCache
  fetchPolicy?: UseFetchPolicy
  nextFetchPolicy?: UseFetchPolicy
  server?: boolean
  immediate?: boolean
  timeout?: number
  signal?: AbortSignal
  onDone?: (ctx: UseFetchDoneContext<TData, TVariables>) => void
  onError?: (ctx: UseFetchErrorContext<TVariables>) => void
}

export type VariablesOption<TVariables extends object> = {} extends TVariables
  ? { variables?: MaybeRefOrGetter<UseFetchVariableShape<TVariables>> }
  : { variables: MaybeRefOrGetter<UseFetchVariableShape<TVariables>> }

export type UseFetchOptions<TData, TVariables extends object> =
  UseFetchOptionsBase<TData, TVariables> & VariablesOption<TVariables>

export type UseFetchOptionsParameter<TData, TVariables extends object> = {} extends TVariables
  ? [options?: UseFetchOptions<TData, TVariables>]
  : [options: UseFetchOptions<TData, TVariables>]
