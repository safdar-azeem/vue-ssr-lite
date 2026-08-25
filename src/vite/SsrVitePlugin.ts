import { resolve } from 'node:path'
import type { Plugin, ResolveFn, ViteDevServer } from 'vite'
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
import { resolveSitemapConfigPath } from '../server/SsrSitemapConfig'
import { prepareSsrHtmlTemplate } from '../server/SsrHtmlRuntime'
import {
  createSsrStylesheetLinkTags,
  resolveApplicationStyleDependencies,
} from './SsrViteAssetRuntime'

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

// Vue and Vue Router are host-owned peers: that package contract is the
// singleton guarantee. Dedupe is still useful defense-in-depth for linked
// workspaces and Vite's client/SSR module graphs, but must not be the ownership
// mechanism.
const FRAMEWORK_DEDUPE = [
  'vue',
  'vue-router',
  'vue-ssr-lite',
]

/**
 * Stable browser-facing URLs for generated application clients.
 *
 * This is deliberately separate from Vite's internal virtual-module ids. The
 * URL is emitted into HTML and resolved back to the internal id by this
 * plugin, so consumers never depend on Vite's `\0`/`/@id` representation.
 */
const SSR_CLIENT_PUBLIC_PREFIX = '/@vue-ssr-lite/client/'
const RESOLVED_RUNTIME = `\0${SSR_RUNTIME_VIRTUAL_ID}`
const RESOLVED_CLIENT_PREFIX = `\0${SSR_CLIENT_VIRTUAL_PREFIX}`
const DEFAULT_CLIENT_OUT_DIR = 'dist/client'

/**
 * Vite path-resolves string `build.ssr` entries. Accept both the bare virtual id
 * and a root-prefixed filesystem form of the same id.
 */
const isSsrRuntimeVirtualId = (id: string): boolean =>
  id === SSR_RUNTIME_VIRTUAL_ID ||
  id.endsWith(`/${SSR_RUNTIME_VIRTUAL_ID}`) ||
  id.endsWith(`\\${SSR_RUNTIME_VIRTUAL_ID}`)

/** Module scripts with `src` (any attribute order). */
const MODULE_SRC_SCRIPT_RE =
  /<script\b(?=[^>]*\btype\s*=\s*["']module["'])(?=[^>]*\bsrc\s*=\s*["']([^"']+)["'])[^>]*>\s*<\/script>/gi

const isSsrConfigFile = (filePath: string, configPath?: string): boolean => {
  const normalized = normalizePath(filePath)
  if (configPath && normalized === normalizePath(configPath)) return true
  return /\/(?:ssr|sitemap)\.config\.(ts|mts|js|mjs)$/.test(normalized)
}

export const vueSsrLite = (options: SsrVitePluginOptions = {}): Plugin => {
  let root = resolve(options.root || process.cwd())
  let resolvedBase = '/'
  let configuredBuildBase: string | undefined
  let configPath: string | undefined
  let entries: SsrViteEntries | null = null
  let clientOutDir = DEFAULT_CLIENT_OUT_DIR
  let resolveClientModule: ResolveFn | undefined
  const virtualClients = new Map<string, SsrViteApplicationEntry>()
  const publicClients = new Map<string, SsrViteApplicationEntry>()

  const clientPublicUrl = (applicationId: string): string =>
    `${SSR_CLIENT_PUBLIC_PREFIX}${applicationId}`

  const stripViteBase = (id: string): string => {
    const cleanId = id.split(/[?#]/, 1)[0]
    if (resolvedBase === '/' || !resolvedBase.startsWith('/')) return cleanId
    const normalizedBase = resolvedBase.endsWith('/')
      ? resolvedBase.slice(0, -1)
      : resolvedBase
    return cleanId === normalizedBase
      ? '/'
      : cleanId.startsWith(`${normalizedBase}/`)
        ? cleanId.slice(normalizedBase.length)
        : cleanId
  }

  const syncVirtualClients = () => {
    virtualClients.clear()
    publicClients.clear()
    for (const application of entries?.applications ?? []) {
      virtualClients.set(
        `${SSR_CLIENT_VIRTUAL_PREFIX}${application.id}`,
        application
      )
      publicClients.set(clientPublicUrl(application.id), application)
    }
  }

  const invalidateConfigCache = () => {
    entries = null
    virtualClients.clear()
    publicClients.clear()
    clientOutDir = DEFAULT_CLIENT_OUT_DIR
  }

  const ensureEntries = async (): Promise<SsrViteEntries> => {
    if (entries) return entries
    configPath = await resolveSsrConfigPath(root, options.config)
    const config = await loadSsrConfigFile(root, configPath)
    entries = extractSsrViteEntries(config, { root })
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
    // Keep one plugin instance across client/SSR environment config clones so
    // virtual-module state stays consistent during production builds.
    sharedDuringBuild: true,
    async config(userConfig, environment) {
      root = resolve(options.root || userConfig.root || process.cwd())
      if (userConfig.base !== undefined) configuredBuildBase = userConfig.base
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
          // Keep the published runtime on its intentional Node package boundary.
          // Its Vue and Vue Router imports resolve through host-owned peers, so
          // externalization no longer creates a private framework identity.
          external: ['vue-ssr-lite'],
          noExternal: [...new Set(options.ssrNoExternal ?? [])],
        },
        build: environment.isSsrBuild
          ? undefined
          : {
              manifest: true,
              ssrManifest: true,
              outDir: resolvedOutDir,
              rollupOptions: { input },
            },
      }
    },
    configResolved(config) {
      root = config.root
      // Vite resolves full URL bases to their effective pathname for dev
      // routing. Keep this distinct from the configured production build base.
      resolvedBase = config.base
      resolveClientModule = config.createResolver()
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
      if (isSsrRuntimeVirtualId(id)) return RESOLVED_RUNTIME
      if (virtualClients.has(id)) {
        return `${RESOLVED_CLIENT_PREFIX}${id.slice(SSR_CLIENT_VIRTUAL_PREFIX.length)}`
      }
      const publicId = stripViteBase(normalizePath(id))
      const publicEntry = publicClients.get(publicId)
      if (publicEntry) {
        return `${RESOLVED_CLIENT_PREFIX}${publicEntry.id}`
      }
      return undefined
    },
    async load(id) {
      if (id === RESOLVED_RUNTIME) {
        const resolved = await ensureEntries()
        const absoluteConfig =
          configPath ?? (await resolveSsrConfigPath(root, options.config))
        return generateSsrRuntimeModule(
          root,
          absoluteConfig,
          resolved.applications,
          await resolveSitemapConfigPath(root),
          configuredBuildBase ?? resolvedBase
        )
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
      async handler(html, context) {
        const filename = normalizePath(context.filename)
        const entry = entries?.applications.find(
          (candidate) =>
            filename === normalizePath(resolve(root, candidate.template))
        )
        if (!entry) return html
        const clientUrl = clientPublicUrl(entry.id)
        const prepared = prepareSsrHtmlTemplate(
          html,
          entry.mountSelector || '#app'
        )
        // Replace only the application's normal Vite bootstrap. Other module
        // scripts (analytics, verification, widgets, etc.) remain consumer-owned.
        const definitionPath = normalizePath(
          (await resolveClientModule?.(
            entry.definition,
            resolve(root, 'index.html')
          )) ?? resolve(root, entry.definition)
        ).split(/[?#]/, 1)[0]
        const applicationSources = new Set<string>()
        const scripts = [...prepared.matchAll(MODULE_SRC_SCRIPT_RE)]
        await Promise.all(
          scripts.map(async (script) => {
            const source = script[1]
            const cleanSource = source.split(/[?#]/, 1)[0]
            const sourcePath = normalizePath(
              (await resolveClientModule?.(source, context.filename)) ??
                (cleanSource.startsWith('/')
                  ? resolve(root, `.${cleanSource}`)
                  : resolve(root, cleanSource))
            ).split(/[?#]/, 1)[0]
            if (sourcePath === definitionPath) applicationSources.add(source)
          })
        )
        const withoutManualEntry = prepared.replace(
          MODULE_SRC_SCRIPT_RE,
          (script, source: string) => {
            return applicationSources.has(source) ? '' : script
          }
        )
        const stylesheetTags =
          entry.kind === 'ssr' && context.server
            ? createSsrStylesheetLinkTags(
                withoutManualEntry,
                await resolveApplicationStyleDependencies(
                  context.server,
                  entry.id,
                  clientUrl
                ),
                {
                  base: resolvedBase,
                  htmlPath: context.path,
                }
              )
            : []
        if (withoutManualEntry.includes(clientUrl)) {
          return stylesheetTags.length
            ? { html: withoutManualEntry, tags: stylesheetTags }
            : withoutManualEntry
        }
        return {
          html: withoutManualEntry,
          tags: [
            ...stylesheetTags,
            {
              tag: 'script',
              attrs: { type: 'module', src: clientUrl },
              injectTo: 'body',
            },
          ],
        }
      },
    },
  }
}
