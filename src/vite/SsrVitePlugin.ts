import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { normalizePath } from 'vite'
import {
  generateSsrClientModule,
  generateSsrRuntimeModule,
  resolveSsrConfigPath,
  resolveSsrViteEntries,
  SSR_CLIENT_VIRTUAL_PREFIX,
  SSR_RUNTIME_VIRTUAL_ID,
  type SsrViteApplicationEntry,
  type SsrViteEntries,
} from '../SsrConfigCompileRuntime'
import { prepareSsrHtmlTemplate } from '../server/SsrHtmlRuntime'

export type { SsrViteApplicationEntry }

export interface SsrVitePluginOptions {
  /** Optional path to `ssr.config.*` (auto-discovered when omitted). */
  config?: string
  root?: string
  /**
   * Additional packages to deduplicate. `vue-ssr-lite` always dedupes the Vue
   * framework packages it renders with.
   */
  dedupe?: string[]
  /**
   * Additional dependencies to keep in the SSR bundle (`ssr.noExternal`).
   */
  ssrNoExternal?: (string | RegExp)[]
}

const FRAMEWORK_DEDUPE = [
  '@vue/server-renderer',
  'vue',
  'vue-router',
  'vue-ssr-lite',
]

const RESOLVED_RUNTIME = `\0${SSR_RUNTIME_VIRTUAL_ID}`
const RESOLVED_CLIENT_PREFIX = `\0${SSR_CLIENT_VIRTUAL_PREFIX}`

export const vueSsrLite = (options: SsrVitePluginOptions = {}): Plugin => {
  let root = resolve(options.root || process.cwd())
  let configPath = ''
  let entries: SsrViteEntries | null = null
  const virtualClients = new Map<string, SsrViteApplicationEntry>()

  const syncVirtualClients = () => {
    virtualClients.clear()
    for (const application of entries?.applications ?? []) {
      virtualClients.set(
        `${SSR_CLIENT_VIRTUAL_PREFIX}${application.id}`,
        application
      )
    }
  }

  const ensureEntries = async (): Promise<SsrViteEntries> => {
    if (entries) return entries
    configPath = await resolveSsrConfigPath(root, options.config)
    entries = await resolveSsrViteEntries(root, configPath)
    syncVirtualClients()
    return entries
  }

  return {
    name: 'vue-ssr-lite',
    enforce: 'pre',
    async config(userConfig, environment) {
      root = resolve(options.root || userConfig.root || process.cwd())
      const resolved = await ensureEntries()
      const input = Object.fromEntries(
        resolved.applications.map((entry) => [
          entry.id,
          resolve(root, entry.template),
        ])
      )
      return {
        resolve: {
          dedupe: [...new Set([...FRAMEWORK_DEDUPE, ...(options.dedupe ?? [])])],
        },
        ssr: {
          external: ['vue-ssr-lite'],
          noExternal: [...new Set(options.ssrNoExternal ?? [])],
        },
        build: environment.isSsrBuild
          ? undefined
          : { manifest: true, rollupOptions: { input } },
      }
    },
    configResolved(config) {
      root = config.root
    },
    resolveId(id) {
      if (id === SSR_RUNTIME_VIRTUAL_ID) return RESOLVED_RUNTIME
      if (virtualClients.has(id)) {
        return `${RESOLVED_CLIENT_PREFIX}${id.slice(SSR_CLIENT_VIRTUAL_PREFIX.length)}`
      }
      return undefined
    },
    async load(id) {
      if (id === RESOLVED_RUNTIME) {
        const resolved = await ensureEntries()
        const absoluteConfig =
          configPath || (await resolveSsrConfigPath(root, options.config))
        return generateSsrRuntimeModule(root, absoluteConfig, resolved.applications)
      }
      if (!id.startsWith(RESOLVED_CLIENT_PREFIX)) return
      const applicationId = id.slice(RESOLVED_CLIENT_PREFIX.length)
      const entry = entries?.applications.find(
        ({ id: candidate }) => candidate === applicationId
      )
      if (!entry) return
      return generateSsrClientModule(root, entry)
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const filename = normalizePath(context.filename)
        const entry = entries?.applications.find(
          (candidate) =>
            filename === normalizePath(resolve(root, candidate.template))
        )
        if (!entry) return html
        const virtualId = `${SSR_CLIENT_VIRTUAL_PREFIX}${entry.id}`
        const prepared = prepareSsrHtmlTemplate(
          html,
          entry.mountSelector || '#app'
        )
        // Strip any manual bootstrap script so ssr.config remains the only wiring.
        const withoutManualEntry = prepared.replace(
          /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']+["'][^>]*>\s*<\/script>/gi,
          (tag) =>
            /src=["'][^"']*ErpClient[^"']*["']/i.test(tag) ||
            /src=["'][^"']*main\.ts["']/i.test(tag)
              ? ''
              : tag
        )
        if (withoutManualEntry.includes(`import ${JSON.stringify(virtualId)}`)) {
          return withoutManualEntry
        }
        return {
          html: withoutManualEntry,
          tags: [
            {
              tag: 'script',
              attrs: { type: 'module' },
              children: `import ${JSON.stringify(virtualId)}`,
              injectTo: 'body',
            },
          ],
        }
      },
    },
  }
}
