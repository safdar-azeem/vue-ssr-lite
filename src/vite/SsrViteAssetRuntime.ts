import type {
  EnvironmentModuleNode,
  HtmlTagDescriptor,
  ViteDevServer,
} from 'vite'
import { isCSSRequest, normalizePath, parseAstAsync } from 'vite'
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
 * Read eager edges from Vite's transformed browser JavaScript with Vite's
 * public Rollup parser, then map those imports back to public graph nodes.
 * This adapter is the sole dependency-classification compatibility boundary.
 */
export const readEagerViteImports = async (
  server: ViteDevServer,
  module: EnvironmentModuleNode
): Promise<EnvironmentModuleNode[]> => {
  const code = module.transformResult?.code
  if (code == null) {
    throw new Error(
      `vue-ssr-lite cannot inspect eager imports for untransformed Vite module ${module.url}.`
    )
  }
  let program: Awaited<ReturnType<typeof parseAstAsync>>
  try {
    program = await parseAstAsync(code)
  } catch (error) {
    throw new Error(
      `vue-ssr-lite could not inspect eager imports for Vite module ${module.url}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const eagerIdentities: string[] = []
  for (const statement of program.body) {
    const source =
      statement.type === 'ImportDeclaration' ||
      statement.type === 'ExportAllDeclaration' ||
      statement.type === 'ExportNamedDeclaration'
        ? statement.source?.value
        : undefined
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

const transformEagerModuleGraph = async (
  server: ViteDevServer,
  entryModule: EnvironmentModuleNode
): Promise<void> => {
  const environment = server.environments.client
  const visited = new Set<EnvironmentModuleNode>([entryModule])
  const visit = async (module: EnvironmentModuleNode): Promise<void> => {
    const dependencies = (await readEagerViteImports(server, module)).filter(
      (dependency) => !visited.has(dependency)
    )
    await Promise.all(
      dependencies.map(async (dependency) => {
        visited.add(dependency)
        if (!dependency.transformResult) {
          await environment.transformRequest(dependency.url)
        }
        await visit(dependency)
      })
    )
  }
  await visit(entryModule)
}

const toApplicationStylesheet = (
  applicationId: string,
  module: EnvironmentModuleNode
): SsrApplicationStylesheet | undefined => {
  const id = module.id ?? module.url
  if (!isViteStylesheetModule(id)) return undefined
  return { applicationId, href: module.url }
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
  await environment.waitForRequestsIdle()
  const entryModule = await environment.moduleGraph.getModuleByUrl(browserEntryUrl)
  if (!entryModule) {
    throw new Error(
      `vue-ssr-lite could not find application "${applicationId}" in Vite's client module graph after transforming ${browserEntryUrl}.`
    )
  }
  await transformEagerModuleGraph(server, entryModule)
  await environment.waitForRequestsIdle()

  const styles = new Map<string, SsrApplicationStylesheet>()
  const visited = new Set<EnvironmentModuleNode>()
  // Preserve Vite's eager import order so the initial stylesheet cascade
  // matches client module evaluation. Dynamic edges are intentionally omitted;
  // future route CSS can be layered onto this application asset boundary once
  // request-specific SSR module usage is available.
  const collectStyles = async (module: EnvironmentModuleNode): Promise<void> => {
    if (visited.has(module)) return
    visited.add(module)
    const stylesheet = toApplicationStylesheet(applicationId, module)
    const identity = stylesheet && normalizeViteAssetUrl(stylesheet.href)
    if (stylesheet && identity && !styles.has(identity)) {
      styles.set(identity, stylesheet)
    }
    for (const dependency of await readEagerViteImports(server, module)) {
      await collectStyles(dependency)
    }
  }
  await collectStyles(entryModule)
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

/** Resolve only CSS reachable from modules Vue reported in this request. */
export const resolveRenderedStyleDependencies = async (
  server: ViteDevServer,
  applicationId: string,
  moduleIds: readonly string[]
): Promise<SsrRenderedApplicationAsset[]> => {
  const environment = server.environments.client
  const roots: EnvironmentModuleNode[] = []
  for (const moduleId of moduleIds) {
    let module = environment.moduleGraph.getModuleById(moduleId)
    for (const url of renderedModuleUrls(server, moduleId)) {
      if (module) break
      module = await environment.moduleGraph.getModuleByUrl(url)
      if (!module?.transformResult) {
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
        `vue-ssr-lite could not resolve rendered module ${JSON.stringify(moduleId)} in Vite's client module graph for application ${JSON.stringify(applicationId)}.`
      )
    }
    if (!module.transformResult) {
      await environment.transformRequest(module.url)
    }
    await transformEagerModuleGraph(server, module)
    roots.push(module)
  }
  await environment.waitForRequestsIdle()

  const assets = new Map<string, SsrRenderedApplicationAsset>()
  const visited = new Set<EnvironmentModuleNode>()
  const collect = async (module: EnvironmentModuleNode): Promise<void> => {
    if (visited.has(module)) return
    visited.add(module)
    const stylesheet = toApplicationStylesheet(applicationId, module)
    if (stylesheet) {
      const href = applyViteBase(stylesheet.href, server.config.base)
      const identity = normalizeViteAssetUrl(href, {
        base: server.config.base,
      })
      if (identity && !assets.has(identity)) {
        assets.set(identity, {
          ...stylesheet,
          href,
          rel: 'stylesheet',
          temporary: true,
        })
      }
    }
    for (const dependency of await readEagerViteImports(server, module)) {
      await collect(dependency)
    }
  }
  for (const root of roots) await collect(root)
  return [...assets.values()]
}

interface HtmlStartTag {
  name: string
  attributes: string
}

const RAW_TEXT_HTML_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

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
    let nameEnd = start + 2
    while (/[A-Za-z0-9:-]/.test(html[nameEnd] || '')) nameEnd += 1
    let end = nameEnd
    let quote = ''
    while (end < html.length) {
      const character = html[end]
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        break
      }
      end += 1
    }
    if (end >= html.length) break
    const name = html.slice(start + 1, nameEnd).toLowerCase()
    const attributes = html.slice(nameEnd, end)
    tags.push({
      name,
      attributes,
    })
    if (RAW_TEXT_HTML_ELEMENTS.has(name) && !attributes.trimEnd().endsWith('/')) {
      const closingStart = html.toLowerCase().indexOf(`</${name}`, end + 1)
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
  let index = 0
  while (index < source.length) {
    while (/\s|\//.test(source[index] || '')) index += 1
    const nameStart = index
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1
    if (nameStart === index) {
      index += 1
      continue
    }
    const name = source.slice(nameStart, index).toLowerCase()
    while (/\s/.test(source[index] || '')) index += 1
    let value = ''
    if (source[index] === '=') {
      index += 1
      while (/\s/.test(source[index] || '')) index += 1
      const quote = source[index]
      if (quote === '"' || quote === "'") {
        index += 1
        const valueStart = index
        while (index < source.length && source[index] !== quote) index += 1
        value = source.slice(valueStart, index)
        if (source[index] === quote) index += 1
      } else {
        const valueStart = index
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1
        value = source.slice(valueStart, index)
      }
    }
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
