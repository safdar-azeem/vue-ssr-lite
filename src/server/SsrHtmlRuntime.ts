import { readSsrHtmlAttributes, readSsrHtmlStartTag } from '../SsrHtmlParsing'
import {
  serializeManagedHead,
  type ManagedHeadSnapshot,
} from '../SsrManagedHead'
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

const readHtmlAttribute = (source: string, target: string): string | undefined => {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i'
  ).exec(source)
  return match?.[1] ?? match?.[2] ?? match?.[3]
}

const normalizeRenderedAssetHref = (href: string): string | undefined => {
  try {
    const url = new URL(href, 'http://vue-ssr-lite.local')
    for (const name of ['direct', 'import', 't', 'v']) {
      url.searchParams.delete(name)
    }
    url.searchParams.sort()
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
  for (const element of scanSsrHtmlElementStarts(source)) {
    const tagName = element.tagName.toLowerCase()
    if (tagName === 'script') {
      const type = readHtmlAttribute(element.attributes, 'type')?.toLowerCase()
      const src = readHtmlAttribute(element.attributes, 'src')?.replaceAll(
        '&amp;',
        '&'
      )
      const identity = src && normalizeRenderedAssetHref(src)
      if (identity && type === 'module') {
        existing.add(`modulepreload:${identity}`)
      }
      continue
    }
    if (tagName !== 'link') continue
    const rel =
      readHtmlAttribute(element.attributes, 'rel')?.toLowerCase().split(/\s+/) ?? []
    const href = readHtmlAttribute(element.attributes, 'href')?.replaceAll(
      '&amp;',
      '&'
    )
    const identity = href && normalizeRenderedAssetHref(href)
    for (const supported of ['stylesheet', 'modulepreload'] as const) {
      if (identity && rel.includes(supported)) {
        existing.add(`${supported}:${identity}`)
      }
    }
  }
  const tags: string[] = []
  for (const asset of assets) {
    const normalizedHref = normalizeRenderedAssetHref(asset.href)
    if (!normalizedHref) continue
    const identity = `${asset.rel}:${normalizedHref}`
    if (existing.has(identity)) continue
    existing.add(identity)
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
  plugin?: string
  location?: string
  frame?: string
}

export type SsrErrorDocumentOptions = {
  language?: string
  errorId?: string
  development?: SsrErrorDocumentDevelopmentDetails
}

const ssrErrorDocument = (
  language: string,
  title: string,
  inner: string,
  align: 'center' | 'left'
): string =>
  `<!doctype html><html lang="${escapeSsrHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeSsrHtml(title)}</title></head><body><main id="main-content" style="min-height:70vh;display:grid;place-items:center;padding:2rem;text-align:${align};font-family:system-ui,sans-serif" tabindex="-1">${inner}</main></body></html>`

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
    const source = options.development.source
    const location = options.development.location
    const requestPathname = options.development.requestPathname ?? options.development.pathname
    const frame = options.development.frame
    const stack = options.development.stack
    const pre = (value?: string) =>
      value
        ? `<pre style="overflow:auto;white-space:pre-wrap;text-align:left">${escapeSsrHtml(value)}</pre>`
        : ''
    const labeled = (label: string, value?: string) =>
      value ? `<p>${escapeSsrHtml(label)}: ${escapeSsrHtml(value)}</p>` : ''
    return ssrErrorDocument(language, title, `<div style="max-width:56rem;width:100%"><h1>${escapeSsrHtml(title)}</h1>${
      plugin ? `<p>[plugin:${escapeSsrHtml(plugin)}]</p>` : ''
    }${
      name ? `<p><strong>${escapeSsrHtml(name)}</strong></p>` : ''
    }<p>${escapeSsrHtml(detail)}</p>${
      labeled('Source', source)
    }${
      labeled('Location', location)
    }${
      labeled('Request', requestPathname)
    }${errorIdHtml}${pre(frame)}${pre(stack)}</div>`, 'left')
  }
  return ssrErrorDocument(
    language,
    title,
    `<div><h1>${escapeSsrHtml(title)}</h1><p>${escapeSsrHtml(message)}</p>${errorIdHtml}<p><a href="/">Return home</a></p></div>`,
    'center'
  )
}
