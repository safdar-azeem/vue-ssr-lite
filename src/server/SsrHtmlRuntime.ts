import {
  serializeManagedHead,
  type ManagedHeadSnapshot,
} from '../SsrManagedHead'
import {
  escapeSsrHtml,
  getSsrStateElementId,
  serializeSsrState,
} from '../SsrSerialization'
import type { SsrHydrationState } from '../SsrRuntimeTypes'

export const SSR_HEAD_MARKER = '<!--vue-ssr-lite:head-->'
export const SSR_TELEPORT_MARKER = '<!--vue-ssr-lite:teleports-->'
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
  ids: string[]
}

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

const readElementIds = (attributes: string): string[] => {
  const ids: string[] = []
  let index = 0
  while (index < attributes.length) {
    while (/\s|\//.test(attributes[index] || '')) index += 1
    const nameStart = index
    while (index < attributes.length && !/[\s=/>]/.test(attributes[index])) {
      index += 1
    }
    if (index === nameStart) {
      index += 1
      continue
    }
    const name = attributes.slice(nameStart, index).toLowerCase()
    while (/\s/.test(attributes[index] || '')) index += 1
    let value = ''
    if (attributes[index] === '=') {
      index += 1
      while (/\s/.test(attributes[index] || '')) index += 1
      const quote = attributes[index]
      if (quote === '"' || quote === "'") {
        index += 1
        const valueStart = index
        while (index < attributes.length && attributes[index] !== quote) {
          index += 1
        }
        value = attributes.slice(valueStart, index)
        if (attributes[index] === quote) index += 1
      } else {
        const valueStart = index
        while (index < attributes.length && !/[\s>]/.test(attributes[index])) {
          index += 1
        }
        value = attributes.slice(valueStart, index)
      }
    }
    if (name === 'id') ids.push(value)
  }
  return ids
}

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

    let nameEnd = start + 2
    while (/[A-Za-z0-9:-]/.test(source[nameEnd] || '')) nameEnd += 1
    const tagName = source.slice(start + 1, nameEnd)
    let end = nameEnd
    let quote = ''
    while (end < source.length) {
      const character = source[end]
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === '>') {
        break
      }
      end += 1
    }
    if (end >= source.length) break
    end += 1
    elements.push({
      tagName,
      end,
      ids: readElementIds(source.slice(nameEnd, end - 1)),
    })

    const normalizedTag = tagName.toLowerCase()
    if (
      RAW_TEXT_ELEMENTS.has(normalizedTag) &&
      !source.slice(nameEnd, end).trimEnd().endsWith('/>')
    ) {
      const closing = new RegExp(`<\\/\\s*${normalizedTag}\\s*>`, 'ig')
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
  const stateId = getSsrStateElementId(injection.applicationId)
  const stateScript = `<script id="${escapeSsrHtml(stateId)}" type="application/json">${serializeSsrState(injection.state)}</script>`
  const snapshot = injection.head ?? { tags: [] }
  const documentTemplate = stripConflictingStaticTags(template, snapshot)
  const withTeleports = injectSsrTeleports(
    documentTemplate,
    injection.teleports
  )
  return applyHtmlAttributes(
    withTeleports
      .replace(SSR_HEAD_MARKER, serializeManagedHead(snapshot))
      .replace(SSR_HTML_MARKER, injection.html)
      .replace(SSR_STATE_MARKER, stateScript),
    snapshot.htmlAttributes
  )
}

export const renderSsrErrorDocument = (
  title: string,
  message: string,
  language = 'en'
): string => `<!doctype html><html lang="${escapeSsrHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeSsrHtml(title)}</title></head><body><main id="main-content" style="min-height:70vh;display:grid;place-items:center;padding:2rem;text-align:center;font-family:system-ui,sans-serif" tabindex="-1"><div><h1>${escapeSsrHtml(title)}</h1><p>${escapeSsrHtml(message)}</p><p><a href="/">Return home</a></p></div></main></body></html>`
