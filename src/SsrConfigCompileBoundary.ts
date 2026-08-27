import { access, readFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { init as initEsModuleLexer, parse as parseEsModule } from 'es-module-lexer'
import type { Plugin } from 'esbuild'
import type { ApplicationConfig } from './SsrConfigTypes'

const MODULE_EXTENSIONS = ['', '.ts', '.mts', '.js', '.mjs', '.tsx', '.jsx'] as const
const SCRIPT_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.tsx', '.jsx'])

/**
 * Vite-owned universal modules. The configuration compiler stops here instead of
 * transforming Vue SFCs or treating them as text.
 */
export const SSR_CONFIG_UNIVERSAL_MODULE_RE =
  /\.(vue|css|scss|sass|less|styl|stylus|pcss|postcss|sss|png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|eot|mp4|webm|ogg)(?:$|\?)/i

export const SSR_CONFIG_UNIVERSAL_NAMESPACE = 'vue-ssr-lite-config-universal'

export interface SsrConfigModuleGraph {
  imports: Map<string, string[]>
  universalImporters: Set<string>
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

export const createSsrConfigBoundaryPlugin = (
  graph: SsrConfigModuleGraph
): Plugin => ({
  name: 'vue-ssr-lite-config-boundary',
  setup(build) {
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.vueSsrLiteConfigBoundary) return undefined
      if (args.namespace === SSR_CONFIG_UNIVERSAL_NAMESPACE) {
        return { path: args.path, namespace: SSR_CONFIG_UNIVERSAL_NAMESPACE }
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
      if (resolved.errors.length) return resolved
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
        recordImport(graph, args.importer, resolved.path)
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

const normalizeGraphPath = (filePath: string): string =>
  filePath.replaceAll('\\', '/')

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
  for (const specifier of await readRelativeSpecifiers(entryFile)) {
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
