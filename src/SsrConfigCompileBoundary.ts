import { access, readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { init as initEsModuleLexer, parse as parseEsModule } from 'es-module-lexer'
import type { Plugin } from 'esbuild'
import type { ApplicationConfig } from './SsrConfigTypes'
import {
  isDefineApplicationModuleSource,
  resolveApplicationMiddlewareImportBindings,
  resolveApplicationRoutesImportBindings,
  resolveApplicationRoutesImportSpecifiers,
  sourceDeclaresSpaOnlyApplication,
  type SsrApplicationRoutesImportBinding,
} from './SsrUniversalProjection'

const MODULE_EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '.tsx', '.jsx'] as const
const SCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.tsx', '.jsx'])

/**
 * Vite-owned universal modules. The configuration compiler stops here instead of
 * transforming Vue SFCs or treating them as text.
 */
export const SSR_CONFIG_UNIVERSAL_MODULE_RE =
  /\.(vue|css|scss|sass|less|styl|stylus|pcss|postcss|sss|png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|eot|mp4|webm|ogg)(?:$|\?)/i

export const SSR_CONFIG_UNIVERSAL_NAMESPACE = 'vue-ssr-lite-config-universal'

/** Dedicated routes modules owned by Vite, not the Node config evaluator. */
export const SSR_CONFIG_APPLICATION_ROUTES_NAMESPACE =
  'vue-ssr-lite-config-application-routes'

/** Browser-only middleware modules owned by the client bundler. */
export const SSR_CONFIG_BROWSER_MIDDLEWARE_NAMESPACE =
  'vue-ssr-lite-config-browser-middleware'

export interface SsrConfigModuleGraph {
  imports: Map<string, string[]>
  universalImporters: Set<string>
  /** Dedicated `defineApplication({ routes })` modules stubbed out of Node evaluation. */
  applicationRoutesModules?: Set<string>
  /** Route export names required by each synthetic application-routes module. */
  applicationRoutesExports?: Map<string, Set<string>>
  /** Middleware export names required by each synthetic browser-middleware module. */
  browserMiddlewareExports?: Map<string, Set<string>>
  /** Local middleware modules omitted from the Node config-discovery walk. */
  browserMiddlewareModules?: Set<string>
  /** Local modules also reached through a server-executed config edge. */
  serverConfigModules?: Set<string>
  /** Every esbuild resolution edge, including aliases and external packages. */
  resolutions?: SsrConfigModuleResolution[]
}

export interface SsrConfigModuleResolution {
  importer: string
  specifier: string
  resolved: string
  external: boolean
  identity?: string
}

export interface SsrConfigResolvedModuleIdentity {
  identity: string
  path?: string
  external: boolean
}

export const createSsrConfigModuleGraph = (): SsrConfigModuleGraph => ({
  imports: new Map(),
  universalImporters: new Set(),
  applicationRoutesModules: new Set(),
  applicationRoutesExports: new Map(),
  browserMiddlewareExports: new Map(),
  browserMiddlewareModules: new Set(),
  serverConfigModules: new Set(),
  resolutions: [],
})

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export const resolveExistingModule = async (
  basePath: string
): Promise<string | undefined> => {
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${basePath}${extension}`
    if (await exists(candidate)) return candidate
  }
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = resolve(basePath, `index${extension}`)
    if (await exists(candidate)) return candidate
  }
  return undefined
}

const isScriptModule = (filePath: string): boolean =>
  SCRIPT_EXTENSIONS.has(extname(filePath).toLowerCase())

const importClauseIncludesDefineApplication = (statement: string): boolean => {
  const fromIndex = statement.lastIndexOf('from')
  const clause = fromIndex >= 0 ? statement.slice(0, fromIndex) : statement
  return /\bdefineApplication\b/.test(clause)
}

export const moduleImportsDefineApplication = (
  source: string,
  imports: readonly { n?: string; ss: number; se: number }[]
): boolean =>
  imports.some((item) => {
    if (!item.n) return false
    return importClauseIncludesDefineApplication(source.slice(item.ss, item.se))
  })

const recordImport = (
  graph: SsrConfigModuleGraph,
  importer: string | undefined,
  resolved: string
) => {
  if (!importer) return
  const normalizedImporter = normalizeResolutionPath(importer)
  const normalizedResolved = normalizeResolutionPath(resolved)
  const list = graph.imports.get(normalizedImporter) ?? []
  if (!list.includes(normalizedResolved)) list.push(normalizedResolved)
  graph.imports.set(normalizedImporter, list)
}

const normalizeResolutionPath = (filePath: string): string =>
  filePath.replaceAll('\\', '/').replace(/^\/private(?=\/(?:var|tmp)\/)/, '')

const recordResolution = (
  graph: SsrConfigModuleGraph,
  importer: string | undefined,
  specifier: string,
  resolved: string,
  external: boolean
) => {
  if (!importer || !resolved) return
  const edge: SsrConfigModuleResolution = {
    importer: normalizeResolutionPath(importer),
    specifier,
    resolved: external ? resolved : normalizeResolutionPath(resolved),
    external,
    identity: external ? resolveExternalModuleIdentity(importer, specifier, resolved) : undefined,
  }
  const resolutions = (graph.resolutions ??= [])
  if (
    !resolutions.some(
      (item) =>
        item.importer === edge.importer &&
        item.specifier === edge.specifier &&
        item.resolved === edge.resolved &&
        item.external === edge.external
    )
  ) {
    resolutions.push(edge)
  }
}

const resolveExternalModuleIdentity = (
  importer: string,
  specifier: string,
  fallback: string
): string => {
  try {
    const resolved = import.meta.resolve(specifier, pathToFileURL(importer).href)
    return resolved.startsWith('file:')
      ? `external-file:${normalizeResolutionPath(fileURLToPath(resolved))}`
      : `external:${resolved}`
  } catch {
    return `external:${fallback}`
  }
}

/** Resolve an AST edge to the exact identity selected by the config esbuild run. */
export const resolveSsrConfigGraphModule = (
  graph: SsrConfigModuleGraph,
  importer: string,
  specifier: string
): SsrConfigResolvedModuleIdentity | undefined => {
  const normalizedImporter = normalizeResolutionPath(importer)
  const edge = graph.resolutions?.find(
    (item) => item.importer === normalizedImporter && item.specifier === specifier
  )
  if (!edge) return undefined
  if (edge.external) {
    return {
      identity: edge.identity ?? `external:${edge.resolved}`,
      external: true,
    }
  }
  return {
    identity: edge.resolved,
    path: edge.resolved,
    external: false,
  }
}

const isUniversalSpecifier = (specifier: string): boolean =>
  SSR_CONFIG_UNIVERSAL_MODULE_RE.test(specifier)

const resolveLibraryInternalConfigImport = async (
  specifier: string
): Promise<string | undefined> => {
  if (!specifier.startsWith('.')) return undefined
  const normalized = specifier.replaceAll('\\', '/').replace(/\.[cm]?[jt]sx?$/, '')
  const match = normalized.match(/(?:^|\/)src\/(index|SsrConfigRuntime)$/)
  if (!match) return undefined
  return resolveExistingModule(resolve(dirname(fileURLToPath(import.meta.url)), match[1]))
}

export const sourceImportsUniversalModules = async (source: string): Promise<boolean> => {
  await initEsModuleLexer
  const [imports] = parseEsModule(source)
  return imports.some((item) => Boolean(item.n && isUniversalSpecifier(item.n)))
}

const routesBindingCache = new WeakMap<
  SsrConfigModuleGraph,
  Map<string, Promise<SsrApplicationRoutesImportBinding[]>>
>()

const readApplicationRoutesBindings = (
  graph: SsrConfigModuleGraph,
  filePath: string
): Promise<SsrApplicationRoutesImportBinding[]> => {
  const cache = routesBindingCache.get(graph) ??
    new Map<string, Promise<SsrApplicationRoutesImportBinding[]>>()
  routesBindingCache.set(graph, cache)
  const existing = cache.get(filePath)
  if (existing) return existing
  const pending = (async () => {
    if (!isScriptModule(filePath)) return []
    try {
      return await resolveApplicationRoutesImportBindings(
        await readFile(filePath, 'utf8'),
        filePath
      )
    } catch {
      return []
    }
  })()
  cache.set(filePath, pending)
  return pending
}

const middlewareBindingCache = new WeakMap<
  SsrConfigModuleGraph,
  Map<string, Promise<SsrApplicationRoutesImportBinding[]>>
>()

const readApplicationMiddlewareBindings = (
  graph: SsrConfigModuleGraph,
  filePath: string
): Promise<SsrApplicationRoutesImportBinding[]> => {
  const cache = middlewareBindingCache.get(graph) ??
    new Map<string, Promise<SsrApplicationRoutesImportBinding[]>>()
  middlewareBindingCache.set(graph, cache)
  const existing = cache.get(filePath)
  if (existing) return existing
  const pending = (async () => {
    if (!isScriptModule(filePath)) return []
    const source = await readFile(filePath, 'utf8')
    if (!await sourceDeclaresSpaOnlyApplication(source, filePath)) return []
    // Once SPA-only status is proven, extraction failures must fail the
    // config build rather than falling through to Node evaluation of an
    // unknown browser dependency.
    return await resolveApplicationMiddlewareImportBindings(source, filePath)
  })()
  cache.set(filePath, pending)
  return pending
}

const stubApplicationRoutesModule = (
  graph: SsrConfigModuleGraph,
  importer: string,
  specifier: string,
  resolvedPath: string,
  importedBindings: readonly string[]
) => {
  const normalized = normalizeResolutionPath(resolvedPath)
  recordImport(graph, importer, normalized)
  recordResolution(graph, importer, specifier, normalized, false)
  graph.universalImporters.add(normalized)
  graph.applicationRoutesModules ??= new Set()
  graph.applicationRoutesModules.add(normalized)
  graph.applicationRoutesExports ??= new Map()
  const exports = graph.applicationRoutesExports.get(normalized) ?? new Set<string>()
  for (const imported of importedBindings) exports.add(imported)
  graph.applicationRoutesExports.set(normalized, exports)
  return {
    path: normalized,
    namespace: SSR_CONFIG_APPLICATION_ROUTES_NAMESPACE,
    external: false,
  }
}

const IDENTIFIER_NAME = /^[$A-Z_a-z][$\w]*$/u

const applicationRoutesStub = (
  graph: SsrConfigModuleGraph,
  filePath: string
): string => {
  const normalized = normalizeResolutionPath(filePath)
  const imported = graph.applicationRoutesExports?.get(normalized) ?? new Set<string>()
  const named = [...imported]
    .filter((name) => name !== 'default' && IDENTIFIER_NAME.test(name))
    .map((name) => `export { applicationRoutes as ${name} };`)
  return [
    'const applicationRoutes = [];',
    'export default applicationRoutes;',
    ...named,
    '',
  ].join('\n')
}

const stubApplicationBrowserMiddlewareModule = (
  graph: SsrConfigModuleGraph,
  importer: string,
  specifier: string,
  resolvedPath: string,
  external: boolean,
  importedBindings: readonly string[]
) => {
  const key = external ? `external:${resolvedPath}` : normalizeResolutionPath(resolvedPath)
  recordResolution(graph, importer, specifier, resolvedPath, external)
  // Keep the edge in both graph indexes for authoritative client resolution,
  // but mark local middleware modules so config-discovery audits skip their
  // browser-owned dependency closure.
  if (!external) {
    const normalized = normalizeResolutionPath(resolvedPath)
    recordImport(graph, importer, normalized)
    graph.browserMiddlewareModules ??= new Set()
    graph.browserMiddlewareModules.add(normalized)
  }
  graph.browserMiddlewareExports ??= new Map()
  const exports = graph.browserMiddlewareExports.get(key) ?? new Set<string>()
  for (const imported of importedBindings) exports.add(imported)
  graph.browserMiddlewareExports.set(key, exports)
  return {
    path: key,
    namespace: SSR_CONFIG_BROWSER_MIDDLEWARE_NAMESPACE,
    external: false,
  }
}

const applicationBrowserMiddlewareStub = (
  graph: SsrConfigModuleGraph,
  filePath: string
): string => {
  const imported = graph.browserMiddlewareExports?.get(filePath) ?? new Set<string>()
  const named = [...imported]
    .filter((name) => name !== 'default' && name !== '*' && IDENTIFIER_NAME.test(name))
    .map((name) => `export { browserMiddleware as ${name} };`)
  return [
    'const browserMiddleware = () => true;',
    'export default browserMiddleware;',
    ...named,
    '',
  ].join('\n')
}

export const createSsrConfigBoundaryPlugin = (
  graph: SsrConfigModuleGraph
): Plugin => ({
  name: 'vue-ssr-lite-config-boundary',
  setup(build) {
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.vueSsrLiteConfigBoundary) return undefined
      if (
        args.namespace === SSR_CONFIG_UNIVERSAL_NAMESPACE ||
        args.namespace === SSR_CONFIG_APPLICATION_ROUTES_NAMESPACE ||
        args.namespace === SSR_CONFIG_BROWSER_MIDDLEWARE_NAMESPACE
      ) {
        return { path: args.path, namespace: args.namespace }
      }
      if (args.importer && isScriptModule(args.importer)) {
        const routesBindings = await readApplicationRoutesBindings(graph, args.importer)
        const matchingBindings = routesBindings.filter(
          (binding) => binding.specifier === args.path
        )
        if (matchingBindings.length) {
          const resolved = await build.resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
            pluginData: { vueSsrLiteConfigBoundary: true },
          })
          const fallback =
            args.path.startsWith('.') || args.path.startsWith('/') || isAbsolute(args.path)
              ? await resolveExistingModule(
                  resolve(args.resolveDir || dirname(args.importer), args.path)
                )
              : undefined
          const resolvedPath =
            resolved.path && !resolved.errors.length ? resolved.path : fallback
          if (resolvedPath) {
            return stubApplicationRoutesModule(
              graph,
              args.importer,
              args.path,
              resolvedPath,
              matchingBindings.map((binding) => binding.imported)
            )
          }
          const normalized = normalizeResolutionPath(args.path)
          graph.applicationRoutesExports ??= new Map()
          graph.applicationRoutesExports.set(
            normalized,
            new Set(matchingBindings.map((binding) => binding.imported))
          )
          return {
            path: args.path,
            namespace: SSR_CONFIG_APPLICATION_ROUTES_NAMESPACE,
            external: false,
          }
        }
        const middlewareBindings = await readApplicationMiddlewareBindings(graph, args.importer)
        const matchingMiddleware = middlewareBindings.filter(
          (binding) => binding.specifier === args.path
        )
        if (matchingMiddleware.length) {
          const resolved = await build.resolve(args.path, {
            kind: args.kind,
            importer: args.importer,
            namespace: args.namespace,
            resolveDir: args.resolveDir,
            pluginData: { vueSsrLiteConfigBoundary: true },
          })
          const fallback =
            args.path.startsWith('.') || args.path.startsWith('/') || isAbsolute(args.path)
              ? await resolveExistingModule(
                  resolve(args.resolveDir || dirname(args.importer), args.path)
                )
              : undefined
          const resolvedPath =
            resolved.path && !resolved.errors.length ? resolved.path : fallback
          const localSpecifier =
            args.path.startsWith('.') || args.path.startsWith('/') || isAbsolute(args.path)
          return stubApplicationBrowserMiddlewareModule(
            graph,
            args.importer,
            args.path,
            resolvedPath ?? (localSpecifier
              ? resolve(args.resolveDir || dirname(args.importer), args.path)
              : args.path),
            resolvedPath ? Boolean(resolved.external) : !localSpecifier,
            matchingMiddleware.map((binding) => binding.imported)
          )
        }
      }
      if (isUniversalSpecifier(args.path)) {
        if (args.importer) graph.universalImporters.add(args.importer)
        return {
          path: resolve(args.resolveDir || dirname(args.importer || args.path), args.path),
          namespace: SSR_CONFIG_UNIVERSAL_NAMESPACE,
        }
      }
      const resolved = await build.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        namespace: args.namespace,
        resolveDir: args.resolveDir,
        pluginData: { vueSsrLiteConfigBoundary: true },
      })
      if (resolved.errors.length) {
        // Source fixtures can be copied to an isolated project directory while
        // retaining their library-internal `../../src/index` import. Preserve
        // that import's package identity instead of treating the copied path as
        // a new consumer-relative module.
        const libraryInternal = await resolveLibraryInternalConfigImport(args.path)
        if (!libraryInternal) return resolved
        recordResolution(graph, args.importer, args.path, libraryInternal, false)
        recordImport(graph, args.importer, libraryInternal)
        return { path: libraryInternal, external: false }
      }
      if (resolved.path) {
        recordResolution(graph, args.importer, args.path, resolved.path, Boolean(resolved.external))
      }
      if (resolved.path && isUniversalSpecifier(resolved.path)) {
        if (args.importer) graph.universalImporters.add(args.importer)
        return {
          path: resolved.path,
          namespace: SSR_CONFIG_UNIVERSAL_NAMESPACE,
          external: false,
        }
      }
      if (resolved.path && !resolved.external) {
        const normalized = normalizeResolutionPath(resolved.path)
        recordImport(graph, args.importer, normalized)
        graph.serverConfigModules ??= new Set()
        graph.serverConfigModules.add(normalized)
      }
      return resolved
    })
    build.onLoad(
      { filter: /.*/, namespace: SSR_CONFIG_UNIVERSAL_NAMESPACE },
      () => ({
        contents: 'export default {};\n',
        loader: 'js',
      })
    )
    build.onLoad(
      { filter: /.*/, namespace: SSR_CONFIG_APPLICATION_ROUTES_NAMESPACE },
      (args) => ({
        contents: applicationRoutesStub(graph, args.path),
        loader: 'js',
      })
    )
    build.onLoad(
      { filter: /.*/, namespace: SSR_CONFIG_BROWSER_MIDDLEWARE_NAMESPACE },
      (args) => ({
        contents: applicationBrowserMiddlewareStub(graph, args.path),
        loader: 'js',
      })
    )
  },
})

export const bundleSsrConfigModule = async (
  root: string,
  entry: string
): Promise<{ code: string; graph: SsrConfigModuleGraph }> => {
  const graph = createSsrConfigModuleGraph()
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent',
    plugins: [createSsrConfigBoundaryPlugin(graph)],
  })
  const code = result.outputFiles?.[0]?.text
  if (!code) throw new Error(`Failed to bundle server config: ${entry}`)
  return { code, graph }
}

/**
 * Bundle independent application declarations in one esbuild invocation.
 *
 * Application discovery used to start a complete esbuild service build for
 * every candidate file. Besides repeating package/tsconfig resolution, that
 * also reparsed the same library helpers for every application. A single
 * multi-entry build preserves an independent output module for each entry and
 * lets the boundary plugin record one authoritative union graph.
 */
export const bundleSsrConfigModules = async (
  root: string,
  entries: readonly string[]
): Promise<{ codes: Map<string, string>; graph: SsrConfigModuleGraph }> => {
  const graph = createSsrConfigModuleGraph()
  const codes = new Map<string, string>()
  if (!entries.length) return { codes, graph }

  const entryPoints = Object.fromEntries(
    entries.map((entry, index) => [`application-${index}`, entry])
  )
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints,
    outdir: resolve(root, '.vue-ssr-lite-config-discovery'),
    entryNames: '[name]',
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent',
    plugins: [createSsrConfigBoundaryPlugin(graph)],
  })
  const outputByName = new Map(
    (result.outputFiles ?? []).map((output) => [
      basename(output.path, extname(output.path)),
      output.text,
    ])
  )
  entries.forEach((entry, index) => {
    const code = outputByName.get(`application-${index}`)
    if (!code) throw new Error(`Failed to bundle application config: ${entry}`)
    codes.set(entry, code)
  })
  return { codes, graph }
}

const normalizeGraphPath = (filePath: string): string =>
  filePath.replaceAll('\\', '/').replace(/^\/private(?=\/(?:var|tmp)\/)/, '')

const lookupGraphList = (
  graph: Map<string, string[]>,
  filePath: string
): string[] => {
  const direct = graph.get(filePath)
  if (direct?.length) return direct
  const normalized = normalizeGraphPath(filePath)
  for (const [key, value] of graph) {
    if (normalizeGraphPath(key) === normalized) return value
  }
  const tail = normalized.split('/').slice(-4).join('/')
  for (const [key, value] of graph) {
    if (normalizeGraphPath(key).endsWith(tail)) return value
  }
  return []
}

const graphHasUniversalImporter = (
  graph: SsrConfigModuleGraph,
  filePath: string
): boolean => {
  if (graph.universalImporters.has(filePath)) return true
  const normalized = normalizeGraphPath(filePath)
  for (const importer of graph.universalImporters) {
    if (normalizeGraphPath(importer) === normalized) return true
    if (normalizeGraphPath(importer).endsWith(normalized.split('/').slice(-4).join('/'))) {
      return true
    }
  }
  return false
}

const moduleTouchesUniversal = (
  filePath: string,
  graph: SsrConfigModuleGraph,
  seen: Set<string>
): boolean => {
  if (seen.has(filePath)) return false
  seen.add(filePath)
  if (graphHasUniversalImporter(graph, filePath)) return true
  for (const child of lookupGraphList(graph.imports, filePath)) {
    if (moduleTouchesUniversal(child, graph, seen)) return true
  }
  return false
}

const APPLICATION_DISCOVERY_DEPTH = 4

export const resolveApplicationRoutesModule = (
  applicationFile: string,
  graph: SsrConfigModuleGraph,
  applicationName = applicationFile
): string | undefined => {
  if (graphHasUniversalImporter(graph, applicationFile)) {
    throw new Error(
      `Application "${applicationName}" module ${applicationFile} imports Vue or other Vite-owned assets. ` +
        'Keep route components in a dedicated routes module so configuration stays outside the Vue graph.'
    )
  }
  const direct = lookupGraphList(graph.imports, applicationFile)
  const vueTouching = direct.filter((file) =>
    moduleTouchesUniversal(file, graph, new Set())
  )
  if (vueTouching.length > 1) {
    throw new Error(
      `Application "${applicationName}" imports multiple Vue-touching modules (${vueTouching.join(', ')}). ` +
        'Import exactly one dedicated routes module from the application file.'
    )
  }
  return vueTouching[0]
}

const readRelativeSpecifiers = async (filePath: string): Promise<string[]> => {
  const source = await readFile(filePath, 'utf8')
  await initEsModuleLexer
  const [imports] = parseEsModule(source)
  const specifiers: string[] = []
  for (const item of imports) {
    if (!item.n) continue
    if (!(item.n.startsWith('.') || item.n.startsWith('/') || isAbsolute(item.n))) {
      continue
    }
    specifiers.push(item.n)
  }
  return specifiers
}

export const collectSkippedApplicationRoutesFiles = async (
  files: readonly string[]
): Promise<Set<string>> => {
  const skipped = new Set<string>()
  for (const file of files) {
    if (!isScriptModule(file)) continue
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (await sourceImportsUniversalModules(source)) {
      skipped.add(normalizeGraphPath(file))
    }
    const specifiers = await resolveApplicationRoutesImportSpecifiers(source, file)
    for (const specifier of specifiers) {
      if (!(specifier.startsWith('.') || specifier.startsWith('/') || isAbsolute(specifier))) {
        continue
      }
      const resolved = await resolveExistingModule(resolve(dirname(file), specifier))
      if (resolved) skipped.add(normalizeGraphPath(resolved))
    }
  }
  return skipped
}

const isInsideRoot = (filePath: string, root?: string): boolean => {
  if (!root) return true
  const normalizedRoot = normalizeGraphPath(root).replace(/\/$/, '')
  const normalizedFile = normalizeGraphPath(filePath)
  return (
    normalizedFile === normalizedRoot ||
    normalizedFile.startsWith(`${normalizedRoot}/`)
  )
}

export const collectApplicationDeclarationFiles = async (
  entryFile: string,
  depth = 0,
  seen: Set<string> = new Set(),
  root?: string
): Promise<{ files: string[]; truncated: boolean }> => {
  if (seen.has(entryFile)) return { files: [], truncated: false }
  if (depth > APPLICATION_DISCOVERY_DEPTH) {
    return { files: [], truncated: true }
  }
  seen.add(entryFile)
  if (!isScriptModule(entryFile) && depth > 0) return { files: [], truncated: false }
  const files = depth > 0 ? [entryFile] : []
  let truncated = false
  const source = isScriptModule(entryFile) ? await readFile(entryFile, 'utf8') : ''
  // A proven defineApplication() module is the terminal declaration node. Its
  // route, component, CSS, and server-provider imports belong to other graphs
  // and must not be reclassified as application declarations.
  if (depth > 0 && source && (await isDefineApplicationModuleSource(source, entryFile))) {
    return { files, truncated: false }
  }
  const routesSpecifiers = source
    ? await resolveApplicationRoutesImportSpecifiers(source, entryFile)
    : []
  for (const specifier of await readRelativeSpecifiers(entryFile)) {
    if (routesSpecifiers.includes(specifier)) continue
    const resolved = await resolveExistingModule(resolve(dirname(entryFile), specifier))
    if (!resolved || !isScriptModule(resolved) || !isInsideRoot(resolved, root)) continue
    const nested = await collectApplicationDeclarationFiles(resolved, depth + 1, seen, root)
    files.push(...nested.files)
    truncated = truncated || nested.truncated
  }
  return { files, truncated }
}

const APPLICATION_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export const isEvaluatedApplicationConfig = (
  value: unknown
): value is ApplicationConfig => {
  if (!value || typeof value !== 'object') return false
  const record = value as ApplicationConfig & { applications?: unknown }
  if (typeof record.name !== 'string' || !APPLICATION_NAME.test(record.name)) return false
  if (Array.isArray(record.applications)) return false
  return true
}

export const readEvaluatedApplicationExport = (
  namespace: Record<string, unknown>
): ApplicationConfig | undefined => {
  const candidates: unknown[] = [namespace.default, ...Object.values(namespace)]
  for (const candidate of candidates) {
    if (isEvaluatedApplicationConfig(candidate)) return candidate
  }
  return undefined
}
