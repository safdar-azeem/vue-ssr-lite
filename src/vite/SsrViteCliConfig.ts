/** Inline Vite config key for an explicit `vue-ssr-lite --config` selection. */
export const SSR_VITE_CLI_CONFIG_KEY = 'vueSsrLiteCliConfig'
export const SSR_VITE_CLI_CONFIG_PLUGIN = 'vue-ssr-lite:cli-config'

export interface SsrViteCliInlineConfig {
  [SSR_VITE_CLI_CONFIG_KEY]?: string
}

export const createSsrViteCliConfigMarker = (config: string) => ({
  name: SSR_VITE_CLI_CONFIG_PLUGIN,
  enforce: 'pre' as const,
  [SSR_VITE_CLI_CONFIG_KEY]: config,
})

export const createSsrViteCliInlineConfig = (
  config?: string
): SsrViteCliInlineConfig =>
  config ? { [SSR_VITE_CLI_CONFIG_KEY]: config } : {}

const flattenVitePlugins = (plugins: unknown[]): object[] => {
  const result: object[] = []
  for (const plugin of plugins) {
    if (!plugin) continue
    if (Array.isArray(plugin)) result.push(...flattenVitePlugins(plugin))
    else if (typeof plugin === 'object') result.push(plugin)
  }
  return result
}

const readConfigPath = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

export const readSsrViteCliConfig = (config: object): string | undefined => {
  try {
    const direct = readConfigPath(
      (config as SsrViteCliInlineConfig)[SSR_VITE_CLI_CONFIG_KEY]
    )
    if (direct) return direct
    const plugins = (config as { plugins?: unknown }).plugins
    if (!Array.isArray(plugins)) return undefined
    for (const plugin of flattenVitePlugins(plugins)) {
      if ((plugin as { name?: string }).name !== SSR_VITE_CLI_CONFIG_PLUGIN) {
        continue
      }
      const marked = readConfigPath(
        (plugin as SsrViteCliInlineConfig)[SSR_VITE_CLI_CONFIG_KEY]
      )
      if (marked) return marked
    }
    return undefined
  } catch {
    return undefined
  }
}
