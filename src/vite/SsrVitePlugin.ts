import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ResolveFn, Rollup, ViteDevServer } from 'vite'
import { normalizePath } from 'vite'
import {
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
  resolveSsrConfigPath,
  SSR_CLIENT_VIRTUAL_PREFIX,
  SSR_HTML_VIRTUAL_PREFIX,
  SSR_RENDERER_VIRTUAL_ID,
  SSR_RUNTIME_VIRTUAL_ID,
  type SsrViteApplicationEntry,
  type SsrViteEntries,
} from '../SsrConfigCompileRuntime'
import { prepareSsrHtmlTemplate, SSR_HTML_TEMPLATE } from '../server/SsrHtmlRuntime'
import {
  serializeSsrProductionAssetMetadata,
  SSR_PRODUCTION_ASSET_METADATA_PATH,
} from '../SsrAssetMetadata'
import {
  createSsrStylesheetLinkTags,
  resolveApplicationStyleDependencies,
} from './SsrViteAssetRuntime'

export interface SsrVitePluginOptions {
  /** Optional path to `server.ts` (auto-discovered when omitted). */
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

// Vue and Vue Router are host-owned peers. Dedupe plus SSR transformation keep
// linked workspaces and installed consumers on that same host identity.
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
// The HTTP/CLI runtime is intentionally outside Vite. SSR application
// creation and rendering are not: they must execute beside compiled SFCs so
// Vue's active render instance and template helpers share one module identity.
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url)
const CURRENT_MODULE_DIRECTORY = dirname(CURRENT_MODULE_PATH)
const DISTRIBUTION_DIRECTORY =
  basename(CURRENT_MODULE_DIRECTORY) === 'chunks'
    ? dirname(CURRENT_MODULE_DIRECTORY)
    : CURRENT_MODULE_DIRECTORY
const FALLBACK_SSR_RENDERER_ENTRY = normalizePath(
  CURRENT_MODULE_PATH.endsWith('.ts')
    ? resolve(CURRENT_MODULE_DIRECTORY, '../SsrRenderRuntime.ts')
    : resolve(DISTRIBUTION_DIRECTORY, 'internal-ssr-renderer.mjs')
)
const RESOLVED_CLIENT_PREFIX = `\0${SSR_CLIENT_VIRTUAL_PREFIX}`
const RESOLVED_HTML_PREFIX = `\0${SSR_HTML_VIRTUAL_PREFIX}`
const DEFAULT_CLIENT_OUT_DIR = 'dist/client'

const existingFile = async (filePath: string): Promise<string | undefined> => {
  try {
    await access(filePath)
    return normalizePath(filePath)
  } catch {
    return undefined
  }
}

const findSourceRendererFromAncestor = async (
  start: string
): Promise<string | undefined> => {
  let directory = resolve(start)
  while (true) {
    try {
      const manifest = JSON.parse(
        await readFile(resolve(directory, 'package.json'), 'utf8')
      ) as { name?: unknown }
      if (manifest.name === 'vue-ssr-lite') {
        const sourceRenderer = await existingFile(
          resolve(directory, 'src/SsrRenderRuntime.ts')
        )
        if (sourceRenderer) return sourceRenderer
      }
    } catch {
      // Continue through parent package scopes.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

const resolveSsrRendererEntry = async (
  projectRoot: string
): Promise<string> => {
  if (CURRENT_MODULE_PATH.endsWith('.ts')) return FALLBACK_SSR_RENDERER_ENTRY

  try {
    // Resolve through the installed package rather than assuming the plugin
    // itself was not bundled while loading vite.config.ts.
    const packageViteEntry = fileURLToPath(
      import.meta.resolve('vue-ssr-lite/vite')
    )
    const installedRenderer = await existingFile(
      resolve(dirname(packageViteEntry), 'internal-ssr-renderer.mjs')
    )
    if (installedRenderer) return installedRenderer
  } catch {
    // A clean source checkout may not have emitted package files yet.
  }

  return (
    (await findSourceRendererFromAncestor(projectRoot)) ??
    FALLBACK_SSR_RENDERER_ENTRY
  )
}

/**
 * Rollup resolves `[hash]` (including a length-qualified `[hash:8]`) from an
 * asset's content when it applies an `assetFileNames` string template. The
 * final filename is intentionally not inspected: a literal hash-looking name
 * does not establish that Rollup derived the URL from the asset content.
 *
 * A callback has no public post-render provenance describing which template it
 * selected for an individual asset. Re-running a consumer callback here could
 * yield a different result or introduce side effects, so callback-based asset
 * names stay conservative.
 */
const hasContentHashedAssetFileNames = (
  assetFileNames: unknown
): assetFileNames is string =>
  typeof assetFileNames === 'string' &&
  (assetFileNames.includes('[hash]') || assetFileNames.includes('[hash:'))

const createAssetRevisionIdentity = (
  asset: Pick<
    Rollup.PreRenderedAsset,
    'names' | 'originalFileNames' | 'source'
  >
): string => {
  const digest = createHash('sha256')
  digest.update(typeof asset.source === 'string' ? 'string\0' : 'bytes\0')
  digest.update(asset.source)
  digest.update('\0names\0')
  digest.update(JSON.stringify(asset.names))
  digest.update('\0originals\0')
  digest.update(JSON.stringify(asset.originalFileNames))
  return digest.digest('hex')
}

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

const isResolvedServerConfig = (
  filePath: string,
  projectRoot: string,
  configPath?: string
): boolean => {
  const normalized = normalizePath(filePath)
  if (configPath && normalized === normalizePath(configPath)) return true
  return ['server.ts'].some(
    (name) => normalized === normalizePath(resolve(projectRoot, name))
  )
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
  const revisionedAssetIdentitiesByNamingCallback = new WeakMap<
    (asset: Rollup.PreRenderedAsset) => string,
    Set<string>
  >()

  const clientPublicUrl = (applicationId: string): string =>
    `${SSR_CLIENT_PUBLIC_PREFIX}${applicationId}`

  const sharedHtmlInput = (applicationId: string): string =>
    normalizePath(resolve(root, '.vue-ssr-lite', `${applicationId}.html`))

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
    outputOptions(outputOptions) {
      const assetFileNames = outputOptions.assetFileNames
      if (!hasContentHashedAssetFileNames(assetFileNames)) return null
      const revisionedAssetIdentities = new Set<string>()
      const trackedAssetFileNames = (asset: Rollup.PreRenderedAsset): string => {
        revisionedAssetIdentities.add(createAssetRevisionIdentity(asset))
        return assetFileNames
      }
      revisionedAssetIdentitiesByNamingCallback.set(
        trackedAssetFileNames,
        revisionedAssetIdentities
      )
      return { ...outputOptions, assetFileNames: trackedAssetFileNames }
    },
    async config(userConfig, environment) {
      root = resolve(options.root || userConfig.root || process.cwd())
      if (userConfig.base !== undefined) configuredBuildBase = userConfig.base
      const resolved = await ensureEntries()
      const input = Object.fromEntries(
        await Promise.all(
          resolved.applications.map(async (entry) => {
            const templatePath = resolve(root, entry.template)
            const shared =
              resolved.applications.filter(
                (candidate) => resolve(root, candidate.template) === templatePath
              ).length > 1
            try {
              await access(templatePath)
              if (!shared) return [entry.id, templatePath] as const
            } catch {
              // Use the virtual HTML document when the conventional template is absent.
            }
            return [entry.id, sharedHtmlInput(entry.id)] as const
          })
        )
      )
      const resolvedOutDir =
        userConfig.build?.outDir || clientOutDir || DEFAULT_CLIENT_OUT_DIR
      return {
        resolve: {
          dedupe: [...new Set([...FRAMEWORK_DEDUPE, ...(options.dedupe ?? [])])],
        },
        optimizeDeps: {
          // Generated clients are virtual, so Vite's HTML scanner cannot see
          // their Vue imports until the first browser request. Prebundle these
          // peers so hydration does not race an optimizer restart on first load.
          include: ['vue', 'vue-router'],
          // The framework is already ESM. Serve it through Vite's normal module
          // graph, which revalidates responses, including its shared chunks.
          // Optimizer URLs depend on config/lockfile hashes, not package source:
          // rebuilding the same version can otherwise retain old navigation
          // code both in the optimizer cache and in an immutable browser cache.
          exclude: ['vue-ssr-lite'],
        },
        ssr: {
          // Transform the framework in Vite's SSR graph so linked workspaces
          // and installed consumers share the same deduped Vue/Vue Router
          // identities as compiled SFCs. Externalizing a symlinked package can
          // resolve its peer imports from the package checkout instead of the
          // consuming application, leaving template helpers without Vue's
          // active render instance during SSR.
          noExternal: [
            ...new Set(['vue-ssr-lite', ...(options.ssrNoExternal ?? [])]),
          ],
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
      if (!isResolvedServerConfig(file, root, configPath)) return
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
      if (id === SSR_RENDERER_VIRTUAL_ID) {
        return resolveSsrRendererEntry(root)
      }
      if (virtualClients.has(id)) {
        return `${RESOLVED_CLIENT_PREFIX}${id.slice(SSR_CLIENT_VIRTUAL_PREFIX.length)}`
      }
      const publicId = stripViteBase(normalizePath(id))
      const publicEntry = publicClients.get(publicId)
      if (publicEntry) {
        return `${RESOLVED_CLIENT_PREFIX}${publicEntry.id}`
      }
      const sharedHtml = entries?.applications.find(
        (application) =>
          normalizePath(id) === sharedHtmlInput(application.id) ||
          publicId.endsWith(`/.vue-ssr-lite/${application.id}.html`) ||
          publicId === `.vue-ssr-lite/${application.id}.html`
      )
      if (sharedHtml) {
        return sharedHtmlInput(sharedHtml.id)
      }
      const htmlId = publicId.includes(SSR_HTML_VIRTUAL_PREFIX)
        ? publicId.slice(publicId.indexOf(SSR_HTML_VIRTUAL_PREFIX))
        : id.includes(SSR_HTML_VIRTUAL_PREFIX)
          ? id.slice(id.indexOf(SSR_HTML_VIRTUAL_PREFIX))
          : undefined
      if (htmlId) {
        return `\0${htmlId}`
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
          configuredBuildBase ?? resolvedBase
        )
      }
      const sharedResolved = await ensureEntries()
      const sharedHtml = sharedResolved.applications.find(
        (application) => normalizePath(id) === sharedHtmlInput(application.id)
      )
      if (sharedHtml) {
        try {
          return await readFile(resolve(root, sharedHtml.template), 'utf8')
        } catch {
          return SSR_HTML_TEMPLATE
        }
      }
      if (id.startsWith(RESOLVED_HTML_PREFIX) || id.startsWith(`\0${SSR_HTML_VIRTUAL_PREFIX}`)) {
        const resolved = await ensureEntries()
        const applicationId = id
          .replace(/^\0/, '')
          .slice(SSR_HTML_VIRTUAL_PREFIX.length)
          .replace(/\.html$/, '')
        const entry = resolved.applications.find((candidate) => candidate.id === applicationId)
        if (!entry) return
        try {
          return await readFile(resolve(root, entry.template), 'utf8')
        } catch {
          return SSR_HTML_TEMPLATE
        }
      }
      if (!id.startsWith(RESOLVED_CLIENT_PREFIX)) return
      const applicationId = id.slice(RESOLVED_CLIENT_PREFIX.length)
      const entry = entries?.applications.find(
        ({ id: candidate }) => candidate === applicationId
      )
      if (!entry) return
      return generateSsrClientModule(root, entry)
    },
    generateBundle(outputOptions, bundle) {
      if (this.environment.config.consumer !== 'client') return
      const immutable: string[] = []
      const revisionedAssetIdentities =
        typeof outputOptions.assetFileNames === 'function'
          ? revisionedAssetIdentitiesByNamingCallback.get(
              outputOptions.assetFileNames
            )
          : undefined
      const outputAssetIdentityCounts = new Map<string, number>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'asset') continue
        const identity = createAssetRevisionIdentity(output)
        outputAssetIdentityCounts.set(
          identity,
          (outputAssetIdentityCounts.get(identity) ?? 0) + 1
        )
      }
      for (const output of Object.values(bundle)) {
        // Rollup exposes the pre-substitution placeholder filename for chunks.
        // It differs from the final filename only when Rollup actually replaced
        // a content-hash placeholder. Explicit fileName chunks have identical
        // preliminary/final names, even when their literal text looks hashed.
        // OutputAsset has no equivalent public provenance signal, so assets are
        // deliberately conservative rather than inferred from their names.
        if (
          output.type === 'chunk' &&
          output.preliminaryFileName !== output.fileName
        ) {
          immutable.push(output.fileName)
        }
        // Rollup invokes the tracked naming callback only for assets whose
        // individual filename is derived through the hashed assetFileNames
        // template. Explicit fileName assets bypass it. Require a unique
        // identity match as well, so an ambiguous same-source output stays
        // conservatively cached. Manifest intersection during serving remains
        // the final guard against public-directory copies.
        const assetIdentity =
          output.type === 'asset'
            ? createAssetRevisionIdentity(output)
            : undefined
        if (
          output.type === 'asset' &&
          output.originalFileNames.length &&
          assetIdentity &&
          revisionedAssetIdentities?.has(assetIdentity) &&
          outputAssetIdentityCounts.get(assetIdentity) === 1
        ) {
          immutable.push(output.fileName)
        }
      }
      this.emitFile({
        type: 'asset',
        fileName: SSR_PRODUCTION_ASSET_METADATA_PATH,
        source: serializeSsrProductionAssetMetadata(immutable),
      })
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html, context) {
        const filename = normalizePath(context.filename)
        const requestPath = normalizePath(context.path || '')
        const originalUrl = normalizePath(
          String((context as { originalUrl?: string }).originalUrl || '')
        )
        const htmlApplicationId =
          /(?:virtual:vue-ssr-lite\/html\/|@vue-ssr-lite\/html\/)([A-Za-z][A-Za-z0-9_-]*)/.exec(
            `${requestPath}\n${filename}\n${originalUrl}`
          )?.[1] ??
          /\.vue-ssr-lite\/([A-Za-z][A-Za-z0-9_-]*)\.html$/.exec(filename)?.[1]
        const templateMatches =
          entries?.applications.filter(
            (candidate) =>
              filename === normalizePath(resolve(root, candidate.template))
          ) ?? []
        const entry =
          (htmlApplicationId
            ? entries?.applications.find((candidate) => candidate.id === htmlApplicationId)
            : undefined) ??
          (templateMatches.length === 1 ? templateMatches[0] : undefined) ??
          (entries?.applications.length === 1 ? entries.applications[0] : undefined)
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
            entry.main,
            resolve(root, 'index.html')
          )) ?? resolve(root, entry.main)
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
