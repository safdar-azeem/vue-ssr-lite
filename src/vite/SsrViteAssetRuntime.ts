import { readSsrHtmlAttributes, readSsrHtmlStartTag } from '../SsrHtmlParsing'
import type {
  EnvironmentModuleNode,
  HtmlTagDescriptor,
  TransformResult,
  ViteDevServer,
} from 'vite'
import { isCSSRequest, normalizePath } from 'vite'
import { parse } from 'es-module-lexer'
import { relative } from 'node:path'
import {
  SSR_DEVELOPMENT_STYLESHEET_ATTRIBUTE,
  type SsrRenderedApplicationAsset,
  type SsrApplicationStylesheet,
} from '../SsrApplicationAssetRuntime'

const STYLE_LANGUAGE_RE =
  /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/i
const STYLE_LANGUAGE_NAME_RE =
  /^(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/i
const NON_STYLESHEET_QUERIES = new Set(['inline', 'raw', 'url'])
const VOLATILE_VITE_QUERIES = new Set(['direct', 'import', 't', 'v'])
const LOCAL_URL_ORIGIN = 'http://vue-ssr-lite.local'
// Vite injects these public runtime modules into transformed code without
// representing them as application dependency edges in every module type.
const VITE_RUNTIME_MODULE_PATHS = new Set(['/@vite/client', '/@vite/env'])

const splitUrl = (
  value: string
): { pathname: string; query: URLSearchParams } => {
  const queryStart = value.indexOf('?')
  const hashStart = value.indexOf('#')
  const end = hashStart < 0 ? value.length : hashStart
  const pathname = value.slice(0, queryStart < 0 ? end : Math.min(queryStart, end))
  const query = new URLSearchParams(
    queryStart < 0 ? '' : value.slice(queryStart + 1, end)
  )
  return { pathname, query }
}

/** Classify only real Vite CSS language modules, including Vue style submodules. */
export const isViteStylesheetModule = (id: string): boolean => {
  if (!isCSSRequest(id)) return false
  const { pathname, query } = splitUrl(id)
  for (const name of NON_STYLESHEET_QUERIES) {
    if (query.has(name)) return false
  }
  if (STYLE_LANGUAGE_RE.test(pathname)) return true
  if (query.get('type') !== 'style') return false
  return [...query.keys()].some((name) =>
    name.startsWith('lang.') && STYLE_LANGUAGE_NAME_RE.test(name.slice(5))
  )
}

const normalizeBasePath = (base: string): string => {
  if (!base || base === './' || base === '/') return '/'
  try {
    const pathname = new URL(base, LOCAL_URL_ORIGIN).pathname
    return pathname.endsWith('/') ? pathname : `${pathname}/`
  } catch {
    return '/'
  }
}

const applyViteBase = (value: string, base: string): string => {
  const basePath = normalizeBasePath(base)
  if (
    basePath === '/' ||
    !value.startsWith('/') ||
    value.startsWith(basePath)
  ) {
    return value
  }
  return `${basePath.slice(0, -1)}${value}`
}

const normalizeLocalPath = (
  value: string,
  htmlPath: string,
  base: string
): string | undefined => {
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    /^(?:data|javascript|mailto):/i.test(value)
  ) {
    return undefined
  }
  let resolved: URL
  try {
    resolved = new URL(value, new URL(htmlPath || '/', LOCAL_URL_ORIGIN))
  } catch {
    return undefined
  }
  if (resolved.origin !== LOCAL_URL_ORIGIN) return undefined
  const basePath = normalizeBasePath(base)
  let pathname = resolved.pathname
  if (basePath !== '/' && pathname.startsWith(basePath)) {
    pathname = `/${pathname.slice(basePath.length)}`
  }
  for (const name of [...resolved.searchParams.keys()]) {
    if (VOLATILE_VITE_QUERIES.has(name)) resolved.searchParams.delete(name)
  }
  resolved.searchParams.sort()
  const search = resolved.searchParams.toString()
  return `${pathname}${search ? `?${search}` : ''}`
}

/**
 * Normalize a Vite browser URL for logical identity comparisons. Meaningful
 * transform queries remain; cache/HMR/direct-request queries do not.
 */
export const normalizeViteAssetUrl = (
  value: string,
  options: { base?: string; htmlPath?: string } = {}
): string | undefined =>
  normalizeLocalPath(value, options.htmlPath ?? '/', options.base ?? '/')

/**
 * Vite's public module graph intentionally combines eager and dynamic edges.
 * Read eager edges from Vite's transformed browser JavaScript with a dedicated
 * module lexer, then map those imports back to public graph nodes.
 * This adapter is the sole dependency-classification compatibility boundary.
 */
const readEagerViteImportsFromCode = async (
  server: ViteDevServer,
  module: EnvironmentModuleNode,
  code: string | null | undefined
): Promise<EnvironmentModuleNode[]> => {
  if (code == null) {
    throw new Error(
      `vue-ssr-lite cannot inspect eager imports for untransformed Vite module ${module.url}.`
    )
  }
  let imports: Awaited<ReturnType<typeof parse>>[0]
  try {
    const parsed = await parse(code)
    imports = parsed[0]
  } catch (error) {
    throw new Error(
      `vue-ssr-lite could not inspect eager imports for Vite module ${module.url}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const eagerIdentities: string[] = []
  for (const imported of imports) {
    // `d === -1` covers static import/export-from declarations, including
    // source-phase imports. Dynamic import and import.meta stay excluded.
    const source = imported.d === -1 ? imported.n : undefined
    if (typeof source !== 'string') continue
    const identity = normalizeViteAssetUrl(source, {
      base: server.config.base,
      htmlPath: module.url,
    })
    if (
      identity &&
      !VITE_RUNTIME_MODULE_PATHS.has(identity) &&
      !eagerIdentities.includes(identity)
    ) {
      eagerIdentities.push(identity)
    }
  }
  const matchedIdentities = new Set<string>()
  const dependencies = [...module.importedModules].filter((dependency) => {
    const identity = normalizeViteAssetUrl(dependency.url, {
      base: server.config.base,
      htmlPath: module.url,
    })
    if (!identity || !eagerIdentities.includes(identity)) return false
    matchedIdentities.add(identity)
    return true
  })
  // Some Vite/plugin runtime helpers are injected after import analysis and
  // intentionally have no module-graph edge. They cannot own application
  // assets through the supported graph contract. A missing stylesheet edge,
  // however, would reintroduce FOUC and must fail loudly.
  const missingStylesheets = eagerIdentities.filter(
    (identity) =>
      isViteStylesheetModule(identity) && !matchedIdentities.has(identity)
  )
  if (missingStylesheets.length) {
    throw new Error(
      `vue-ssr-lite could not map eager stylesheet imports from ${module.url} into Vite's public module graph: ${missingStylesheets.join(', ')}.`
    )
  }
  return dependencies
}

export const readEagerViteImports = async (
  server: ViteDevServer,
  module: EnvironmentModuleNode
): Promise<EnvironmentModuleNode[]> =>
  readEagerViteImportsFromCode(server, module, module.transformResult?.code)

interface SsrViteAssetGraphAnalysis {
  eagerDependencies: Map<
    EnvironmentModuleNode,
    readonly EnvironmentModuleNode[]
  >
  stylesheets: {
    href: string
    identity: string | undefined
    renderedHref: string
    renderedIdentity: string | undefined
  }[]
  isCurrent: () => boolean
}

interface SsrViteEagerEdge {
  isCurrent: () => boolean
  dependencies: Promise<EnvironmentModuleNode[]>
}

interface SsrViteEagerGraphStore {
  edges: WeakMap<EnvironmentModuleNode, SsrViteEagerEdge>
  graphs: WeakMap<EnvironmentModuleNode, {
    isCurrent: () => boolean
    work: Promise<SsrViteAssetGraphAnalysis>
  }>
}

// These stores contain only Vite code/dependency metadata. They are owned by
// an environment, so a Vite restart cannot retain its old graph. No HTML,
// rendered module selection, or application/request state is stored here.
// vite.config may bundle the plugin separately from the managed server. Own
// the store on Vite's environment so both copies join the same preparation.
const EAGER_GRAPH_STORE = Symbol.for('vue-ssr-lite.internal.vite-eager-graph')
const getEagerGraphStore = (environment: ViteDevServer['environments']['client']) => {
  const owner = environment as typeof environment & { [EAGER_GRAPH_STORE]?: SsrViteEagerGraphStore }
  let store = owner[EAGER_GRAPH_STORE]
  if (!store) {
    store = { edges: new WeakMap(), graphs: new WeakMap() }
    Object.defineProperty(owner, EAGER_GRAPH_STORE, { value: store })
  }
  return store
}

const resolveSsrViteEagerEdge = (
  server: ViteDevServer,
  module: EnvironmentModuleNode,
  entryTransform?: TransformResult
): SsrViteEagerEdge => {
  const environment = server.environments.client
  const store = getEagerGraphStore(environment)
  const existing = store.edges.get(module)
  if (existing?.isCurrent()) return existing
  const invalidation = module.lastInvalidationTimestamp
  const hmr = module.lastHMRTimestamp
  let pending = true
  let transform: TransformResult | null | undefined
  let importedModules: EnvironmentModuleNode['importedModules'] | undefined
  const isCurrent = () => server.environments.client === environment &&
    module.lastInvalidationTimestamp === invalidation && module.lastHMRTimestamp === hmr &&
    (!module.id || environment.moduleGraph.getModuleById(module.id) === module) &&
    (pending || (module.transformResult === transform && module.importedModules === importedModules))
  const dependencies = (async () => {
    // Publish the entire transform + edge analysis as one shared operation.
    // Overlapping roots must not independently transform the same cold child.
    // Vite also coalesces this call with browser requests and revalidates HMR.
    transform = entryTransform ?? module.transformResult ?? await environment.transformRequest(module.url)
    if (!transform) {
      throw new Error(`vue-ssr-lite cannot inspect eager imports for untransformed Vite module ${module.url}.`)
    }
    importedModules = module.importedModules
    const result = await readEagerViteImportsFromCode(server, module, transform.code)
    pending = false
    return result
  })()
  const edge = { isCurrent, dependencies }
  store.edges.set(module, edge)
  void dependencies.catch(() => {
    if (store.edges.get(module) === edge) store.edges.delete(module)
  })
  return edge
}

/** @internal Kept for transport callers; graph metadata now has Vite ownership. */
export const runWithSsrViteAssetResolutionContext = <T>(
  work: () => T
): T => work()

const resolveSsrViteEagerGraph = (
  server: ViteDevServer,
  entryModule: EnvironmentModuleNode,
  entryTransform?: TransformResult
): Promise<SsrViteAssetGraphAnalysis> => {
  const environment = server.environments.client
  const store = getEagerGraphStore(environment)
  const existing = store.graphs.get(entryModule)
  if (existing?.isCurrent()) return existing.work
  const checks: (() => boolean)[] = []
  const isCurrent = () => server.environments.client === environment &&
    checks.every((check) => check())
  const analysis: SsrViteAssetGraphAnalysis = { eagerDependencies: new Map(), stylesheets: [], isCurrent }
  const visited = new Set<EnvironmentModuleNode>()
  const visit = async (module: EnvironmentModuleNode): Promise<void> => {
    if (visited.has(module)) return
    visited.add(module)
    // A shared graph traversal awaits only transforms it actually needs.
    // Never follow Vite's dynamic edges or wait for unrelated client work.
    const edge = resolveSsrViteEagerEdge(server, module, module === entryModule ? entryTransform : undefined)
    checks.push(edge.isCurrent)
    const dependencies = await edge.dependencies
    analysis.eagerDependencies.set(module, dependencies)
    await Promise.all(dependencies.map(visit))
  }
  const work = visit(entryModule).then(() => {
    const collected = new Set<EnvironmentModuleNode>()
    const collect = (module: EnvironmentModuleNode) => {
      if (collected.has(module)) return
      collected.add(module)
      if (isViteStylesheetModule(module.id ?? module.url)) {
        const href = module.url
        const renderedHref = applyViteBase(href, server.config.base)
        analysis.stylesheets.push({
          href,
          identity: normalizeViteAssetUrl(href),
          renderedHref,
          renderedIdentity: normalizeViteAssetUrl(renderedHref, { base: server.config.base }),
        })
      }
      for (const dependency of analysis.eagerDependencies.get(module) ?? []) collect(dependency)
    }
    collect(entryModule)
    return analysis
  })
  const record = { isCurrent, work }
  store.graphs.set(entryModule, record)
  void work.catch(() => {
    if (store.graphs.get(entryModule) === record) store.graphs.delete(entryModule)
  })
  // If the optimizer invalidated a transform while returning it, that result
  // still serves this traversal, but isCurrent prevents reusing it next time.
  return work
}

/**
 * Ask Vite to transform an application's generated browser entry, wait for
 * its complete static graph, and collect only stylesheet modules reachable by
 * static edges. Vite remains responsible for resolution and CSS processing.
 */
export const resolveApplicationStyleDependencies = async (
  server: ViteDevServer,
  applicationId: string,
  browserEntryUrl: string
): Promise<SsrApplicationStylesheet[]> => {
  const environment = server.environments.client
  const transformed = await environment.transformRequest(browserEntryUrl)
  if (!transformed) {
    throw new Error(
      `vue-ssr-lite could not transform the browser entry for application "${applicationId}" at ${browserEntryUrl}.`
    )
  }
  const entryModule = await environment.moduleGraph.getModuleByUrl(browserEntryUrl)
  if (!entryModule) {
    throw new Error(
      `vue-ssr-lite could not find application "${applicationId}" in Vite's client module graph after transforming ${browserEntryUrl}.`
    )
  }
  // `transformRequest` completes the entry's module-graph update. The eager
  // traversal then awaits every missing dependency transform it discovers, so
  // a global wait for unrelated client-environment requests is unnecessary.
  const analysis = await resolveSsrViteEagerGraph(server, entryModule, transformed)
  const styles = new Map<string, SsrApplicationStylesheet>()
  // Preserve Vite's eager import order so the initial stylesheet cascade
  // matches client module evaluation. Dynamic edges are intentionally omitted;
  // selected route CSS belongs to the rendered-module asset boundary below.
  for (const { href, identity } of analysis.stylesheets) {
    if (identity && !styles.has(identity)) {
      styles.set(identity, { applicationId, href })
    }
  }
  return [...styles.values()]
}

const renderedModuleUrls = (
  server: ViteDevServer,
  moduleId: string
): string[] => {
  const normalized = normalizePath(moduleId).replace(/^\0+/, '')
  const queryIndex = normalized.indexOf('?')
  const pathname = queryIndex < 0 ? normalized : normalized.slice(0, queryIndex)
  const query = queryIndex < 0 ? '' : normalized.slice(queryIndex)
  const relativePath = normalizePath(relative(server.config.root, pathname))
  return [...new Set([
    normalized,
    ...(relativePath && !relativePath.startsWith('../')
      ? [`/${relativePath}${query}`]
      : []),
  ])]
}

const resolveRenderedModuleGraph = async (
  server: ViteDevServer,
  moduleId: string,
  applicationId?: string
): Promise<SsrViteAssetGraphAnalysis> => {
  const environment = server.environments.client
  let module = environment.moduleGraph.getModuleById(moduleId)
  for (const url of renderedModuleUrls(server, moduleId)) {
    if (module) break
    module = await environment.moduleGraph.getModuleByUrl(url)
    // Once Vite supplies a node, let the shared edge operation own its cold
    // transform. Using its canonical URL also joins Vite's browser work.
    if (!module) {
      try {
        await environment.transformRequest(url)
      } catch {
        continue
      }
      module = await environment.moduleGraph.getModuleByUrl(url)
    }
  }
  if (!module) {
    throw new Error(
      `vue-ssr-lite could not resolve rendered module ${JSON.stringify(moduleId)} in Vite's client module graph${applicationId === undefined ? '' : ` for application ${JSON.stringify(applicationId)}`}.`
    )
  }
  return resolveSsrViteEagerGraph(server, module)
}

/**
 * Called when Vite actually transforms an SSR component, including a lazy
 * component requested by Vue Router. Never inspect/invoke route loaders here.
 * Preparing browser code runs alongside SSR compilation/evaluation; it does
 * not execute client code, follow dynamic edges, or select response assets.
 */
export const prepareSsrViteComponentAssets = (server: ViteDevServer, moduleId: string): void => {
  // Only component compilation units, not server/config modules or Vue query
  // submodules. The full component's eager graph includes its scripts/styles.
  if (!/\.(?:vue|jsx|tsx)$/.test(moduleId) || moduleId.startsWith('\0')) return
  void resolveRenderedModuleGraph(server, moduleId).catch(() => {
    // A speculative client transform must not fail SSR navigation or leave an
    // unhandled rejection on cancellation/HMR/shutdown. Actual rendered asset
    // resolution still awaits the graph and reports failures normally.
  })
}

/** Resolve only CSS reachable from modules Vue reported in this request. */
export const resolveRenderedStyleDependencies = async (
  server: ViteDevServer,
  applicationId: string,
  moduleIds: readonly string[]
): Promise<SsrRenderedApplicationAsset[]> => {
  // Start independent roots together so cold dependencies are discovered in
  // the same Vite optimizer crawl, not serially after each preceding graph.
  // Promise.all retains input order; completion order must not change CSS's
  // cascade. Shared nodes join the same transform/edge analysis above.
  const analyses = await Promise.all(moduleIds.map((moduleId) =>
    resolveRenderedModuleGraph(server, moduleId, applicationId)
  ))
  const assets = new Map<string, SsrRenderedApplicationAsset>()
  for (const analysis of analyses) {
    for (const { renderedHref: href, renderedIdentity: identity } of analysis.stylesheets) {
      if (identity && !assets.has(identity)) {
        assets.set(identity, {
          applicationId,
          href,
          rel: 'stylesheet',
          temporary: true,
        })
      }
    }
  }
  return [...assets.values()]
}

interface HtmlStartTag {
  name: string
  attributes: string
}

const RAW_TEXT_HTML_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])
const RAW_TEXT_HTML_CLOSING = new Map([...RAW_TEXT_HTML_ELEMENTS].map((name) =>
  [name, new RegExp(`</${name}`, 'ig')] as const
))

const readHtmlStartTags = (html: string): HtmlStartTag[] => {
  const tags: HtmlStartTag[] = []
  let index = 0
  while (index < html.length) {
    const start = html.indexOf('<', index)
    if (start < 0) break
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4)
      index = end < 0 ? html.length : end + 3
      continue
    }
    if (!/[A-Za-z]/.test(html[start + 1] || '')) {
      index = start + 1
      continue
    }
    const tag = readSsrHtmlStartTag(html, start)
    if (!tag) break
    const { attributes } = tag
    const name = tag.name.toLowerCase()
    const end = tag.end - 1
    tags.push({
      name,
      attributes,
    })
    if (RAW_TEXT_HTML_ELEMENTS.has(name) && !attributes.trimEnd().endsWith('/')) {
      const closing = RAW_TEXT_HTML_CLOSING.get(name)!
      closing.lastIndex = end + 1
      const closingStart = closing.exec(html)?.index ?? -1
      const closingEnd = closingStart < 0 ? -1 : html.indexOf('>', closingStart)
      index = closingEnd < 0 ? html.length : closingEnd + 1
    } else {
      index = end + 1
    }
  }
  return tags
}

const readHtmlAttributes = (source: string): Map<string, string> => {
  const attributes = new Map<string, string>()
  for (const [name, value] of readSsrHtmlAttributes(source)) {
    if (!attributes.has(name)) attributes.set(name, value)
  }
  return attributes
}

const readExistingStylesheetIdentities = (
  html: string,
  base: string,
  htmlPath: string
): Set<string> => {
  const stylesheets = new Set<string>()
  for (const tag of readHtmlStartTags(html)) {
    if (tag.name !== 'link') continue
    const attributes = readHtmlAttributes(tag.attributes)
    const rel = attributes.get('rel')?.toLowerCase().split(/\s+/) ?? []
    if (!rel.includes('stylesheet')) continue
    const href = attributes.get('href')?.replaceAll('&amp;', '&')
    const identity = href && normalizeViteAssetUrl(href, { base, htmlPath })
    if (identity) stylesheets.add(identity)
  }
  return stylesheets
}

/** Generate escaped-by-Vite link descriptors for missing application styles. */
export const createSsrStylesheetLinkTags = (
  html: string,
  stylesheets: readonly SsrApplicationStylesheet[],
  options: { base: string; htmlPath: string }
): HtmlTagDescriptor[] => {
  if (!stylesheets.length) return []
  const identities = readExistingStylesheetIdentities(
    html,
    options.base,
    options.htmlPath
  )
  const tags: HtmlTagDescriptor[] = []
  for (const stylesheet of stylesheets) {
    const identity = normalizeViteAssetUrl(stylesheet.href, options)
    if (!identity || identities.has(identity)) continue
    identities.add(identity)
    tags.push({
      tag: 'link',
      attrs: {
        rel: 'stylesheet',
        href: stylesheet.href,
        [SSR_DEVELOPMENT_STYLESHEET_ATTRIBUTE]: stylesheet.applicationId,
      },
      injectTo: 'head',
    })
  }
  return tags
}
