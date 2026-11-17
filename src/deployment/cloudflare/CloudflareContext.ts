import { AsyncLocalStorage } from 'node:async_hooks'

/** Native Worker invocation values. Server-only and owned by exactly one request. */
export interface CloudflareRequestContext<Env = Record<string, unknown>> {
  readonly env: Env
  readonly ctx: {
    waitUntil(promise: Promise<unknown>): void
    passThroughOnException?(): void
  }
  /** Same-origin server fetches run through this Worker in-process; `undefined` means "use the network". */
  readonly dispatchOrigin?: (url: string, init: RequestInit) => Promise<Response> | undefined
}

// One store per isolate even if the framework is bundled twice.
const STORE = Symbol.for('vue-ssr-lite.cloudflare-request-context')
const values = globalThis as unknown as Record<PropertyKey, unknown>
const storage = (values[STORE] ??= new AsyncLocalStorage<CloudflareRequestContext<any>>()) as
  AsyncLocalStorage<CloudflareRequestContext<any>>

export const runWithCloudflareRequestContext = <T>(context: CloudflareRequestContext<any>, execute: () => T): T =>
  storage.run(Object.freeze({ env: context.env, ctx: context.ctx, dispatchOrigin: context.dispatchOrigin }), execute)

/**
 * Cloudflare Worker bindings (`env`) for the current request, or `undefined`
 * outside a Cloudflare Worker request (Node, Vercel, development, browser).
 *
 * Server-only: call it from server routes, server middleware, SSR setup or
 * `useFetch` handlers that run on the server. Never return bindings or secret
 * values to the browser; they are not serialized by the framework.
 */
export const getCloudflareEnv = <Env = Record<string, unknown>>(): Env | undefined =>
  storage.getStore()?.env as Env | undefined

/** The Worker `ExecutionContext` for the current request, when running on Cloudflare. */
export const getCloudflareExecutionContext = (): CloudflareRequestContext['ctx'] | undefined =>
  storage.getStore()?.ctx
