import type { ViteDevServer } from 'vite'

const SSR_VITE_RESOLVED_CONFIG_PATH = Symbol.for(
  'vue-ssr-lite.internal.vite-resolved-config-path'
)

/** Config identity already selected by vueSsrLite for the Vite runtime graph. */
export const readSsrViteResolvedConfigPath = (
  server: ViteDevServer
): string | undefined => {
  try {
    const value = (server as { [SSR_VITE_RESOLVED_CONFIG_PATH]?: unknown })[
      SSR_VITE_RESOLVED_CONFIG_PATH
    ]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export const attachSsrViteResolvedConfigPath = (
  server: ViteDevServer,
  path: string | undefined
) => {
  Object.defineProperty(server, SSR_VITE_RESOLVED_CONFIG_PATH, {
    value: path,
    configurable: true,
    enumerable: false,
  })
}
