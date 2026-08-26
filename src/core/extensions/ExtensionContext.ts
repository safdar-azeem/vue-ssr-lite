import type { RouteLocationNormalizedLoaded } from 'vue-router'
import type { ManagedHeadContribution } from '../../SsrManagedHead'

export interface ExtensionEnvironment {
  readonly server: boolean
  readonly production: boolean
}

export interface ExtensionApplicationIdentity {
  readonly id: string
}

/**
 * Minimal universal-safe extension context.
 *
 * Server-only capabilities (endpoint registration, Node APIs, request/response
 * objects) are intentionally absent from this public contract.
 */
export interface ExtensionContext<TState = unknown> {
  readonly application: ExtensionApplicationIdentity
  readonly route: RouteLocationNormalizedLoaded | null
  readonly environment: ExtensionEnvironment
  readonly state: TState
  contributeHead(
    contribution: ManagedHeadContribution | (() => ManagedHeadContribution)
  ): void
}

/**
 * Extra fields supplied to built-in extensions. Not part of the public
 * `defineExtension` context type.
 */
export interface InternalExtensionContext<TState = unknown>
  extends ExtensionContext<TState> {
  readonly siteOrigin: string
  readonly pathname: string
  readonly responseStatus: number
  readonly redirected: boolean
}
