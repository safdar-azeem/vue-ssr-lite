/** Private build/render contract. Never a consumer configuration option. */
export const SSR_BROWSER_BOOTSTRAP_SOURCES = {
  navigation: 'navigation/SsrNavigationRuntime.ts',
  middleware: 'middleware/SsrMiddlewareRuntime.ts',
  seo: 'extensions/seo/SsrSeoLifecycle.ts',
  extensions: 'extensions/core/ExtensionRuntime.ts',
} as const

export type SsrBrowserBootstrapCapability = keyof typeof SSR_BROWSER_BOOTSTRAP_SOURCES

// The renderer can be bundled separately from the HTTP host. A non-enumerable
// symbol carries its final request result across that boundary, never into JSON.
const REQUEST_BOOTSTRAP = Symbol.for('vue-ssr-lite.internal.request-bootstrap')

export const attachSsrRequestBootstrap = <T extends object>(
  result: T,
  capabilities: readonly SsrBrowserBootstrapCapability[]
): T => {
  Object.defineProperty(result, REQUEST_BOOTSTRAP, {
    value: Object.freeze([...new Set(capabilities)]),
  })
  return result
}

export const readSsrRequestBootstrap = (result: object): readonly SsrBrowserBootstrapCapability[] =>
  (result as { [REQUEST_BOOTSTRAP]?: readonly SsrBrowserBootstrapCapability[] })[REQUEST_BOOTSTRAP] ?? []

/** Renderer request result: navigation when a router exists, middleware only when that navigation needs it. */
export const requestBootstrapCapabilities = (
  hasRouter: boolean,
  needsMiddleware: boolean
): readonly SsrBrowserBootstrapCapability[] => {
  const capabilities: SsrBrowserBootstrapCapability[] = []
  if (hasRouter) capabilities.push('navigation')
  if (needsMiddleware) capabilities.push('middleware')
  return capabilities
}
