import { readSsrHtmlAttributes, readSsrHtmlStartTag } from '../SsrHtmlParsing'
import {
  serializeManagedHead,
  type ManagedHeadSnapshot,
} from '../SsrManagedHead'
import {
  formatSsrDevelopmentSourceLabel,
  sourceBaseName,
} from '../SsrDevelopmentErrorDiagnostic'
import { isSsrErrorId } from '../SsrErrorDiagnostic'
import {
  escapeSsrHtml,
  getSsrStateElementId,
  serializeSsrState,
} from '../SsrSerialization'
import type { SsrHydrationState } from '../SsrRuntimeTypes'
import { readSsrPhaseTimings } from '../SsrDiagnosticsRuntime'
import {
  SSR_DEVELOPMENT_RENDERED_STYLESHEET_ATTRIBUTE,
  type SsrRenderedApplicationAsset,
} from '../SsrApplicationAssetRuntime'

export const SSR_HEAD_MARKER = '<!--vue-ssr-lite:head-->'
export const SSR_TELEPORT_MARKER = '<!--vue-ssr-lite:teleports-->'
export const SSR_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`
export const SSR_HTML_MARKER = '<!--vue-ssr-lite:html-->'
export const SSR_STATE_MARKER = '<!--vue-ssr-lite:state-->'

const assertIdSelector = (selector: string): string => {
  if (!/^#[A-Za-z][A-Za-z0-9_-]*$/.test(selector)) {
    throw new Error('vue-ssr-lite mountSelector must be a simple element id selector.')
  }
  return selector.slice(1)
}

interface SsrHtmlElementStart {
  tagName: string
  end: number
  attributes: string
  ids: string[]
}

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])
const RAW_TEXT_CLOSING = new Map([...RAW_TEXT_ELEMENTS].map((name) =>
  [name, new RegExp(`<\\/\\s*${name}\\s*>`, 'ig')] as const
))

const readElementIds = (attributes: string): string[] =>
  !/\bid\b/i.test(attributes) ? [] : readSsrHtmlAttributes(attributes)
    .filter(([name]) => name === 'id')
    .map(([, value]) => value)

/**
 * Locate real start tags without treating attribute-name suffixes or raw-text
 * contents as elements. This is intentionally only a target locator; template
 * mutation remains marker-based below.
 */
const scanSsrHtmlElementStarts = (source: string): SsrHtmlElementStart[] => {
  const elements: SsrHtmlElementStart[] = []
  let index = 0
  while (index < source.length) {
    const start = source.indexOf('<', index)
    if (start < 0) break
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4)
      index = commentEnd < 0 ? source.length : commentEnd + 3
      continue
    }
    if (!/[A-Za-z]/.test(source[start + 1] || '')) {
      index = start + 1
      continue
    }

    const tag = readSsrHtmlStartTag(source, start)
    if (!tag) break
    const { name: tagName, end, attributes } = tag
    elements.push({ tagName, end, attributes, ids: readElementIds(attributes) })

    const normalizedTag = tagName.toLowerCase()
    if (
      RAW_TEXT_ELEMENTS.has(normalizedTag) &&
      !attributes.endsWith('/')
    ) {
      const closing = RAW_TEXT_CLOSING.get(normalizedTag)!
      closing.lastIndex = end
      const match = closing.exec(source)
      index = match ? closing.lastIndex : source.length
    } else {
      index = end
    }
  }
  return elements
}

const findSsrHtmlElementById = (
  source: string,
  id: string,
  label: string
): SsrHtmlElementStart => {
  const matches = scanSsrHtmlElementStarts(source).filter((element) =>
    element.ids.includes(id)
  )
  if (!matches.length) {
    throw new Error(`${label} is missing from the SSR HTML template.`)
  }
  if (matches.length > 1 || matches[0].ids.length > 1) {
    throw new Error(
      `${label} appears more than once in the SSR HTML template. Target ids must be unique.`
    )
  }
  return matches[0]
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const dedicatedContainerPattern = (
  tagName: string,
  marker?: string
): RegExp =>
  new RegExp(
    marker
      ? `^(\\s*)${escapeRegExp(marker)}(\\s*)(<\\/\\s*${escapeRegExp(tagName)}\\s*>)`
      : `^(\\s*)(<\\/\\s*${escapeRegExp(tagName)}\\s*>)`,
    'i'
  )

const findSsrMountElement = (
  source: string,
  mountSelector: string,
  id: string
): SsrHtmlElementStart => {
  try {
    return findSsrHtmlElementById(
      source,
      id,
      `SSR template mount element ${mountSelector}`
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes('is missing from')) {
      throw new Error(`SSR template is missing mount element ${mountSelector}.`)
    }
    throw error
  }
}

export const prepareSsrHtmlTemplate = (
  source: string,
  mountSelector = '#app'
): string => {
  let html = source
  if (!html.includes(SSR_HEAD_MARKER)) {
    html = html.replace(/<\/head>/i, `\t${SSR_HEAD_MARKER}\n</head>`)
  }
  if (!html.includes(SSR_TELEPORT_MARKER)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${SSR_TELEPORT_MARKER}`)
  }
  if (!html.includes(SSR_HTML_MARKER)) {
    const id = assertIdSelector(mountSelector)
    const mount = findSsrMountElement(html, mountSelector, id)
    const remainder = html.slice(mount.end)
    const closing = dedicatedContainerPattern(mount.tagName).exec(remainder)
    if (!closing) {
      throw new Error(
        `SSR template mount element ${mountSelector} must be an empty dedicated container. Remove child markup and use the documented <div id="${id}"></div> convention.`
      )
    }
    html = `${html.slice(0, mount.end)}${SSR_HTML_MARKER}${closing[2]}${html.slice(mount.end + closing[0].length)}`
  } else {
    const id = assertIdSelector(mountSelector)
    const mount = findSsrMountElement(html, mountSelector, id)
    if (!dedicatedContainerPattern(mount.tagName, SSR_HTML_MARKER).test(
      html.slice(mount.end)
    )) {
      throw new Error(
        `SSR template mount element ${mountSelector} must contain only the managed SSR marker.`
      )
    }
  }
  if (!html.includes(SSR_STATE_MARKER)) {
    html = html.replace(/<\/body>/i, `\t${SSR_STATE_MARKER}\n</body>`)
  }
  return html
}

const stripConflictingStaticTags = (
  html: string,
  snapshot: ManagedHeadSnapshot
): string => {
  const keys = new Set(snapshot.tags.map((tag) => tag.key))
  let result = html
  if (keys.has('title')) {
    result = result.replace(/<title\b(?![^>]*data-vue-ssr-lite-head)[^>]*>[\s\S]*?<\/title>/i, '')
  }
  if (keys.has('description')) {
    result = result.replace(
      /<meta\b(?![^>]*data-vue-ssr-lite-head)[^>]*\bname=["']description["'][^>]*>/i,
      ''
    )
  }
  if (keys.has('robots')) {
    result = result.replace(
      /<meta\b(?![^>]*data-vue-ssr-lite-head)[^>]*\bname=["']robots["'][^>]*>/i,
      ''
    )
  }
  if (keys.has('canonical')) {
    result = result.replace(
      /<link\b(?![^>]*data-vue-ssr-lite-head)[^>]*\brel=["']canonical["'][^>]*>/i,
      ''
    )
  }
  return result
}

const applyHtmlAttributes = (
  html: string,
  attributes: ManagedHeadSnapshot['htmlAttributes']
): string => {
  if (!attributes) return html
  return html.replace(/<html\b([^>]*)>/i, (_match, existing: string) => {
    let merged = existing
    for (const [name, value] of Object.entries(attributes)) {
      if (!/^[A-Za-z_:][A-Za-z0-9:._-]*$/.test(name)) continue
      const attributePattern = new RegExp(
        `\\s${name.replace(/[.:_-]/g, '\\$&')}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
        'i'
      )
      merged = merged.replace(attributePattern, '')
      if (value != null) {
        merged += ` ${name}="${escapeSsrHtml(value)}"`
      }
    }
    return `<html${merged}>`
  })
}

export interface SsrHtmlInjection {
  applicationId: string
  html: string
  /** Vue-native target-to-markup Teleport result. */
  teleports: Readonly<Record<string, string>>
  head: ManagedHeadSnapshot | null
  state: SsrHydrationState<any, any>
  /** Request assets resolved from the final Vue-rendered module set. */
  assets?: readonly SsrRenderedApplicationAsset[]
}

const ASSET_ATTRIBUTE_PATTERNS = Object.fromEntries(
  ['type', 'src', 'rel', 'href'].map((name) => [name, new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'
  )])
)

const readHtmlAttribute = (source: string, target: 'type' | 'src' | 'rel' | 'href'): string | undefined => {
  const match = ASSET_ATTRIBUTE_PATTERNS[target].exec(source)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

const normalizeRenderedAssetHref = (href: string, temporary = false): string | undefined => {
  try {
    const url = new URL(href, 'http://vue-ssr-lite.local')
    // Vite development CSS ownership ignores transform/cache-busting queries.
    // Production query strings can select different resources or signatures.
    if (temporary) {
      for (const name of ['direct', 'import', 't', 'v']) url.searchParams.delete(name)
      url.searchParams.sort()
    }
    return url.origin === 'http://vue-ssr-lite.local'
      ? `${url.pathname}${url.search}`
      : url.href
  } catch {
    return undefined
  }
}

const serializeSsrRenderedAssets = (
  source: string,
  assets: readonly SsrRenderedApplicationAsset[]
): string => {
  if (!assets.length) return ''
  const existing = new Set<string>()
  const hasTemporaryAssets = assets.some((asset) => asset.temporary)
  const developmentExisting = hasTemporaryAssets ? new Set<string>() : null
  const remember = (rel: string, href: string) => {
    const identity = normalizeRenderedAssetHref(href)
    if (identity) existing.add(`${rel}:${identity}`)
    if (hasTemporaryAssets) {
      const developmentIdentity = normalizeRenderedAssetHref(href, true)
      if (developmentIdentity) developmentExisting?.add(`${rel}:${developmentIdentity}`)
    }
  }
  for (const element of scanSsrHtmlElementStarts(source)) {
    const tagName = element.tagName.toLowerCase()
    if (tagName === 'script') {
      const type = readHtmlAttribute(element.attributes, 'type')?.toLowerCase()
      const src = readHtmlAttribute(element.attributes, 'src')?.replaceAll(
        '&amp;',
        '&'
      )
      if (src && type === 'module') remember('modulepreload', src)
      continue
    }
    if (tagName !== 'link') continue
    const rel =
      readHtmlAttribute(element.attributes, 'rel')?.toLowerCase().split(/\s+/) ?? []
    const href = readHtmlAttribute(element.attributes, 'href')?.replaceAll(
      '&amp;',
      '&'
    )
    for (const supported of ['stylesheet', 'modulepreload'] as const) {
      if (href && rel.includes(supported)) remember(supported, href)
    }
  }
  const tags: string[] = []
  for (const asset of assets) {
    const normalizedHref = normalizeRenderedAssetHref(asset.href, asset.temporary)
    if (!normalizedHref) continue
    const identity = `${asset.rel}:${normalizedHref}`
    if ((asset.temporary ? developmentExisting : existing)?.has(identity)) continue
    remember(asset.rel, asset.href)
    const temporary = asset.temporary
      ? ` ${SSR_DEVELOPMENT_RENDERED_STYLESHEET_ATTRIBUTE}="${escapeSsrHtml(asset.applicationId)}"`
      : ''
    const crossorigin = asset.rel === 'modulepreload' ? ' crossorigin' : ''
    tags.push(
      `<link rel="${asset.rel}" href="${escapeSsrHtml(asset.href)}"${crossorigin}${temporary}>`
    )
  }
  return tags.join('')
}

const injectTeleportTarget = (
  template: string,
  target: string,
  markup: string
): string => {
  if (target === 'body') {
    return template.replace(SSR_TELEPORT_MARKER, () => markup)
  }
  if (target === 'head') {
    return template.replace(
      SSR_HEAD_MARKER,
      () => `${markup}${SSR_HEAD_MARKER}`
    )
  }
  if (!/^#[A-Za-z][A-Za-z0-9_-]*$/.test(target)) {
    throw new Error(
      `Vue Teleport target "${target}" is unsupported by the SSR template injector. Use body, head, or a dedicated element with a simple id selector (for example #modals).`
    )
  }

  const id = target.slice(1)
  let element: SsrHtmlElementStart
  try {
    element = findSsrHtmlElementById(
      template,
      id,
      `Vue Teleport target "${target}"`
    )
  } catch (error) {
    if (error instanceof Error && error.message.includes('appears more than once')) {
      throw new Error(
        `Vue Teleport target "${target}" appears more than once in the SSR HTML template. Teleport target ids must be unique.`
      )
    }
    throw new Error(
      `Vue Teleport target "${target}" is missing from the SSR HTML template. Add a dedicated ${target} container outside the application mount.`
    )
  }
  const remainder = template.slice(element.end)
  if (
    new RegExp(`^\\s*${escapeRegExp(SSR_HTML_MARKER)}`).test(remainder)
  ) {
    throw new Error(
      `Vue Teleport target "${target}" cannot be the SSR application mount. Add a separate target container outside the mount.`
    )
  }
  // The injector deliberately does not attempt to parse arbitrary HTML. A
  // non-empty dedicated target could contain nested elements whose closing
  // tags make a regex-based insertion ambiguous. Require target containers to
  // be empty (apart from formatting whitespace) so Teleports are appended at
  // the actual container level rather than silently corrupting the document.
  const closing = dedicatedContainerPattern(element.tagName).exec(remainder)
  if (!closing) {
    throw new Error(
      `Vue Teleport target "${target}" must be an empty dedicated container. Remove existing child markup from ${target} or use a separate target outside the application mount.`
    )
  }
  return `${template.slice(0, element.end)}${closing[1]}${markup}${closing[2]}${template.slice(element.end + closing[0].length)}`
}

const injectSsrTeleports = (
  template: string,
  teleports: Readonly<Record<string, string>>
): string => {
  let html = template
  const entries = Object.entries(teleports)
  for (const [target, markup] of entries.filter(
    ([target]) => target !== 'body' && target !== 'head'
  )) {
    if (!markup) continue
    html = injectTeleportTarget(html, target, markup)
  }
  for (const target of ['head', 'body'] as const) {
    const markup = teleports[target]
    if (markup) html = injectTeleportTarget(html, target, markup)
  }
  // `body` is represented by the package marker; remove it when Vue produced
  // no body Teleport while preserving every other target above.
  return html.replace(SSR_TELEPORT_MARKER, '')
}

export const injectSsrHtml = (
  template: string,
  injection: SsrHtmlInjection
): string => {
  for (const marker of [
    SSR_HEAD_MARKER,
    SSR_TELEPORT_MARKER,
    SSR_HTML_MARKER,
    SSR_STATE_MARKER,
  ]) {
    if (!template.includes(marker)) {
      throw new Error(`Transformed SSR template is missing marker ${marker}.`)
    }
  }
  const finishSerialization = readSsrPhaseTimings(injection)?.start('HTML state serialization')
  const stateId = getSsrStateElementId(injection.applicationId)
  const stateScript = `<script id="${escapeSsrHtml(stateId)}" type="application/json">${serializeSsrState(injection.state)}</script>`
  finishSerialization?.()
  const snapshot = injection.head ?? { tags: [] }
  const documentTemplate = stripConflictingStaticTags(template, snapshot)
  const managedHead = serializeManagedHead(snapshot)
  const renderedAssets = serializeSsrRenderedAssets(
    `${documentTemplate}${managedHead}`,
    injection.assets ?? []
  )
  const withTeleports = injectSsrTeleports(
    documentTemplate,
    injection.teleports
  )
  return applyHtmlAttributes(
    withTeleports
      .replace(SSR_HEAD_MARKER, `${managedHead}${renderedAssets}`)
      .replace(SSR_HTML_MARKER, injection.html)
      .replace(SSR_STATE_MARKER, stateScript),
    snapshot.htmlAttributes
  )
}

export type SsrErrorDocumentDevelopmentDetails = {
  name?: string
  message?: string
  stack?: string
  requestPathname?: string
  pathname?: string
  source?: string
  displaySource?: string
  plugin?: string
  location?: string
  line?: number
  column?: number
  frame?: string
}

export type SsrErrorDocumentOptions = {
  language?: string
  errorId?: string
  /** Vite `base` used only to build the development open-in-editor href. */
  viteBase?: string
  development?: SsrErrorDocumentDevelopmentDetails
}

export type SsrPublicErrorStatusCode = 400 | 421 | 500 | 503 | 504

export interface SsrPublicErrorPresentation {
  readonly statusCode: SsrPublicErrorStatusCode
  readonly statusText: string
  readonly heading: string
  readonly description: string
}

const SSR_PUBLIC_ERROR_PRESENTATIONS = {
  400: {
    statusCode: 400,
    statusText: 'Bad Request',
    heading: 'Invalid request',
    description: 'The request could not be processed.',
  },
  421: {
    statusCode: 421,
    statusText: 'Misdirected Request',
    heading: 'Host not available',
    description: 'This host is not available.',
  },
  500: {
    statusCode: 500,
    statusText: 'Internal Server Error',
    heading: 'Something went wrong',
    description: 'The request could not be completed.',
  },
  503: {
    statusCode: 503,
    statusText: 'Service Unavailable',
    heading: 'Service unavailable',
    description: 'The service is temporarily unavailable. Please try again later.',
  },
  504: {
    statusCode: 504,
    statusText: 'Gateway Timeout',
    heading: 'Request timed out',
    description: 'The server took too long to respond. Please try again.',
  },
} as const satisfies Record<SsrPublicErrorStatusCode, SsrPublicErrorPresentation>

export const resolveSsrPublicErrorPresentation = (
  statusCode: SsrPublicErrorStatusCode
): SsrPublicErrorPresentation => SSR_PUBLIC_ERROR_PRESENTATIONS[statusCode]

const SSR_ERROR_DOCUMENT_STYLES = [
  ':root{color-scheme:dark}',
  '*{box-sizing:border-box}',
  'html,body{margin:0;background:#000;color:#f5f7fa}',
  'body{min-height:100vh;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.5}',
  'main{max-width:min(100%,60rem);margin:0 auto;padding:3.5rem 1.5rem 4rem;width:max-content}',
  '.status{margin:0 0 .6rem;font-size:.8125rem;font-weight:500;letter-spacing:.01em;color:#c4cad3}',
  '.eyebrow{margin:0 0 0.6rem;font-size:.8125rem;font-weight:500;letter-spacing:.01em;color:#ff0000}',
  'h1{margin:0 0 1rem;font-size:clamp(1.35rem,3.4vw,1.85rem);font-weight:650;line-height:1.3;color:#f5f7fa;overflow-wrap:anywhere}',
  '.stack{display:flex;flex-direction:column;align-items:flex-start;gap:1rem;margin:0 0 1.5rem}',
  '.source{display:block;margin:0;font-size:.9375rem;color:#3b82f6;text-decoration:none;overflow-wrap:anywhere}',
  '.source:hover,.source:focus-visible{text-decoration:underline}',
  '.source:focus-visible,summary:focus-visible{outline:2px solid #4098ff;outline-offset:3px}',
  '.pill{display:inline-block;margin:0;padding:.2rem .55rem;border-radius:999px;background:#1a1f27;color:#c4cad3;font-size:.75rem}',
  'details{margin:0 0 2rem}',
  'summary{cursor:pointer;color:#8b939e;font-size:.875rem;width:fit-content}',
  'summary:hover{color:#f5f7fa}',
  'details p{margin:.35rem 0 0;font-size:.8125rem;color:#8b939e}',
  'pre{margin:.85rem 0 0;padding:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.8125rem;line-height:1.45;color:#c4cad3}',
  '.meta{margin:2rem 0 0;padding-top:1.25rem;border-top:1px solid #1c2128;font-size:.8125rem;color:#8b939e}',
  '.meta p{margin:.25rem 0}',
  '@media (max-width:640px){main{padding:2rem 1.15rem 3rem}h1{font-size:1.35rem}}',
].join('')

const ssrErrorDocument = (language: string, title: string, inner: string): string =>
  `<!doctype html><html lang="${escapeSsrHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeSsrHtml(title)}</title><style>${SSR_ERROR_DOCUMENT_STYLES}</style></head><body><main id="main-content" tabindex="-1">${inner}</main></body></html>`

const SSR_OPEN_IN_EDITOR_SEGMENT = '__open-in-editor'
const SSR_OPEN_IN_EDITOR_SCRIPT =
  '<script>document.addEventListener("click",function(event){var link=event.target&&event.target.closest?event.target.closest("a[data-ssr-open-source]"):null;if(!link)return;event.preventDefault();fetch(link.href,{credentials:"same-origin"}).catch(function(){})});</script>'

const normalizeDevelopmentViteBase = (base?: string): string => {
  if (!base || base === '/' || base.includes('..')) return '/'
  if (base.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(base)) return '/'
  return base.endsWith('/') ? base : `${base}/`
}

const isSafeOpenInEditorFile = (value: string): boolean => {
  if (!value || value.includes('\0') || value.includes('..')) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false
  return true
}

export const createSsrDevelopmentOpenInEditorHref = (
  details: Pick<SsrErrorDocumentDevelopmentDetails, 'displaySource' | 'line' | 'column'>,
  viteBase?: string
): string | undefined => {
  const file = details.displaySource
  if (!file || !isSafeOpenInEditorFile(file)) return undefined
  const located = formatSsrDevelopmentSourceLabel(file, details.line, details.column)
  if (!located) return undefined
  return `${normalizeDevelopmentViteBase(viteBase)}${SSR_OPEN_IN_EDITOR_SEGMENT}?file=${encodeURIComponent(located)}`
}

const developmentSourceLabel = (details: SsrErrorDocumentDevelopmentDetails): string => {
  const source = details.displaySource || (details.source ? sourceBaseName(details.source) : '')
  return source
    ? formatSsrDevelopmentSourceLabel(source, details.line, details.column)
    : details.location ?? ''
}

const developmentSourceHtml = (
  details: SsrErrorDocumentDevelopmentDetails,
  viteBase?: string
): string => {
  const label = developmentSourceLabel(details)
  if (!label) return ''
  const href = createSsrDevelopmentOpenInEditorHref(details, viteBase)
  return href
    ? `<a class="source" data-ssr-open-source href="${escapeSsrHtml(href)}">${escapeSsrHtml(label)}</a>`
    : `<span class="source">${escapeSsrHtml(label)}</span>`
}

const developmentPill = (plugin?: string, name?: string): string => {
  const label = plugin && name ? `${plugin} · ${name}` : plugin || name || ''
  return label ? `<p class="pill">${escapeSsrHtml(label)}</p>` : ''
}

const developmentDetails = (
  frame?: string,
  stack?: string,
  meta = ''
): string => {
  const pre = (value?: string) =>
    value ? `<pre>${escapeSsrHtml(value)}</pre>` : ''
  const body = `${meta}${pre(frame)}${pre(stack)}`
  if (!body) return ''
  return `<details><summary>Show details</summary>${body}</details>`
}

export const renderSsrErrorDocument = (
  title: string,
  message: string,
  languageOrOptions: string | SsrErrorDocumentOptions = 'en'
): string => {
  const options: SsrErrorDocumentOptions = typeof languageOrOptions === 'string'
    ? { language: languageOrOptions }
    : languageOrOptions ?? {}
  const language = options.language ?? 'en'
  const errorId = isSsrErrorId(options.errorId) ? options.errorId : undefined
  const errorIdHtml = errorId ? `<p>Error ID: ${escapeSsrHtml(errorId)}</p>` : ''
  if (options.development) {
    const name = options.development.name
    const detail = options.development.message ?? message
    const plugin = options.development.plugin
    const requestPathname = options.development.requestPathname ?? options.development.pathname
    const sourceHtml = developmentSourceHtml(options.development, options.viteBase)
    const pillHtml = developmentPill(plugin, name)
    const stackHtml = sourceHtml || pillHtml
      ? `<div class="stack">${sourceHtml}${pillHtml}</div>`
      : ''
    const openScript = sourceHtml.includes('data-ssr-open-source')
      ? SSR_OPEN_IN_EDITOR_SCRIPT
      : ''
    const meta = [
      requestPathname ? `<p>Request: ${escapeSsrHtml(requestPathname)}</p>` : '',
      errorIdHtml,
    ].join('')
    return ssrErrorDocument(language, title, `${
      `<p class="eyebrow">${escapeSsrHtml(title)}</p>`
    }<h1>${escapeSsrHtml(detail)}</h1>${
      stackHtml
    }${
      developmentDetails(options.development.frame, options.development.stack, meta)
    }${openScript}`)
  }
  return ssrErrorDocument(
    language,
    title,
    `<h1>${escapeSsrHtml(title)}</h1><p>${escapeSsrHtml(message)}</p>${
      errorIdHtml ? `<div class="meta">${errorIdHtml}</div>` : ''
    }`
  )
}

export const renderSsrPublicErrorDocument = (
  statusCode: SsrPublicErrorStatusCode,
  options: Pick<SsrErrorDocumentOptions, 'language' | 'errorId'> = {}
): string => {
  const presentation = resolveSsrPublicErrorPresentation(statusCode)
  const language = options.language ?? 'en'
  const errorId = isSsrErrorId(options.errorId) ? options.errorId : undefined
  const metaHtml = `<div class="meta">${
    errorId ? `<p>Error ID: ${escapeSsrHtml(errorId)}</p>` : ''
  }</div>`
  return ssrErrorDocument(
    language,
    `${presentation.statusCode} ${presentation.statusText}`,
    `<p class="status">${presentation.statusCode} · ${escapeSsrHtml(presentation.statusText)}</p><h1>${escapeSsrHtml(presentation.heading)}</h1><p>${escapeSsrHtml(presentation.description)}</p>${metaHtml}`
  )
}
