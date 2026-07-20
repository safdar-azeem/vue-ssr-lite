import { resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { normalizePath } from 'vite'
import {
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
  resolveSsrConfigPath,
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
const DEFAULT_CLIENT_OUT_DIR = 'dist/client'

/** Module scripts with `src` (any attribute order). */
const MODULE_SRC_SCRIPT_RE =
  /<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=\s*["'][^"']+["'])[^>]*>\s*<\/script>/gi

const isSsrConfigFile = (filePath: string, configPath: string): boolean => {
  const normalized = normalizePath(filePath)
  if (configPath && normalized === normalizePath(configPath)) return true
  return /\/ssr\.config\.(ts|mts|js|mjs)$/.test(normalized)
}

export const vueSsrLite = (options: SsrVitePluginOptions = {}): Plugin => {
  let root = resolve(options.root || process.cwd())
  let configPath = ''
  let entries: SsrViteEntries | null = null
  let clientOutDir = DEFAULT_CLIENT_OUT_DIR
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

  const invalidateConfigCache = () => {
    entries = null
    virtualClients.clear()
    clientOutDir = DEFAULT_CLIENT_OUT_DIR
  }

  const ensureEntries = async (): Promise<SsrViteEntries> => {
    if (entries) return entries
    configPath = await resolveSsrConfigPath(root, options.config)
    const config = await loadSsrConfigFile(root, configPath)
    entries = extractSsrViteEntries(config)
    clientOutDir = config.server?.clientOutDir || DEFAULT_CLIENT_OUT_DIR
    syncVirtualClients()
    return entries
  }

  const invalidateVirtualModules = (server: ViteDevServer) => {
    const runtimeModule = server.moduleGraph.getModuleById(RESOLVED_RUNTIME)
    if (runtimeModule) server.moduleGraph.invalidateModule(runtimeModule)
    for (const application of entries?.applications ?? []) {
      const clientId = `${RESOLVED_CLIENT_PREFIX}${application.id}`
      const clientModule = server.moduleGraph.getModuleById(clientId)
      if (clientModule) server.moduleGraph.invalidateModule(clientModule)
    }
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
      const resolvedOutDir =
        userConfig.build?.outDir || clientOutDir || DEFAULT_CLIENT_OUT_DIR
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
          : {
              manifest: true,
              outDir: resolvedOutDir,
              rollupOptions: { input },
            },
      }
    },
    configResolved(config) {
      root = config.root
    },
    configureServer(server) {
      void ensureEntries().then(() => {
        if (configPath) server.watcher.add(configPath)
      })
    },
    async handleHotUpdate({ file, server }) {
      if (!isSsrConfigFile(file, configPath)) return
      invalidateVirtualModules(server)
      invalidateConfigCache()
      await ensureEntries()
      if (configPath) server.watcher.add(configPath)
      invalidateVirtualModules(server)
      server.ws.send({ type: 'full-reload' })
      return []
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
        // Strip every module-src script so ssr.config remains the only wiring.
        const withoutManualEntry = prepared.replace(MODULE_SRC_SCRIPT_RE, '')
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
