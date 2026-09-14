import type { ExtensionContext } from './ExtensionContext'

/**
 * Long-lived extension definition. State is created by the runtime per SSR
 * request on the server and per application instance in the browser.
 */
export interface ExtensionDefinition<TState = unknown> {
  /** Stable unique identity. Duplicate names fail in every environment. */
  readonly name: string
  /** Runtime-owned scoped state. Do not store request data on the definition. */
  createState?(): TState
  /**
   * Runs once for the active request (server) or application (client).
   * Return a cleanup function to release request/application resources.
   */
  setup?(context: ExtensionContext<TState>): void | (() => void)
}
