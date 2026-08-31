import type { App } from 'vue'
import type {
  RouteLocationNormalized,
  RouteLocationRaw,
  Router,
} from 'vue-router'
import type { SsrDomainContext } from '../SsrConfigTypes'

export type MiddlewareRedirectStatus = 301 | 302 | 303 | 307 | 308

export interface MiddlewareCookieOptions {
  /** Cookie scope. Defaults to `/`. */
  path?: string
  domain?: string
  expires?: Date
  /** Lifetime in seconds. */
  maxAge?: number
  sameSite?: 'lax' | 'strict' | 'none' | boolean
  secure?: boolean
  /** Server-only. Browser middleware throws when this is true. */
  httpOnly?: boolean
}

export interface MiddlewareCookies {
  get(name: string): string | undefined
  set(name: string, value: string, options?: MiddlewareCookieOptions): void
  remove(name: string, options?: MiddlewareCookieOptions): void
}

export interface MiddlewareRedirectOptions {
  external?: boolean
  status?: MiddlewareRedirectStatus
}

/** @internal Created only by `context.redirect()`. */
export interface MiddlewareRedirectResult {
  readonly __vueSsrLiteMiddlewareRedirect: true
  readonly location: RouteLocationRaw
  readonly external: boolean
  readonly status: MiddlewareRedirectStatus
}

export interface MiddlewarePropsResult {
  props: Record<string, unknown>
}

export type MiddlewareResult =
  | void
  | undefined
  | true
  | false
  | RouteLocationRaw
  | MiddlewarePropsResult
  | MiddlewareRedirectResult

export interface MiddlewareContext<TPublicConfig = unknown> {
  app: App
  router: Router
  cookies: MiddlewareCookies
  to: RouteLocationNormalized
  from: RouteLocationNormalized | null
  server: boolean
  domain: SsrDomainContext
  origin: string
  publicConfig: TPublicConfig
  signal: AbortSignal
  redirect(
    location: RouteLocationRaw,
    options?: MiddlewareRedirectOptions
  ): MiddlewareRedirectResult
}

export type Middleware<TPublicConfig = unknown> = (
  context: MiddlewareContext<TPublicConfig>
) => MiddlewareResult | Promise<MiddlewareResult>

declare module 'vue-router' {
  interface RouteMeta {
    middleware?: readonly Middleware<any>[]
  }
}
