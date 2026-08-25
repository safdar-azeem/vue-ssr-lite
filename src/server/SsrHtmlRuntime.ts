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
    const mountPattern = new RegExp(
      `(<([A-Za-z][\\w-]*)\\b[^>]*\\bid=["']${id}["'][^>]*>)[\\s\\S]*?(<\\/\\2>)`,
      'i'
    )
    if (!mountPattern.test(html)) {
      throw new Error(`SSR template is missing mount element ${mountSelector}.`)
    }
    html = html.replace(mountPattern, `$1${SSR_HTML_MARKER}$3`)
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
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const targetOpenPattern = new RegExp(
    `<[A-Za-z][\\w-]*\\b[^>]*\\bid=["']${escapedId}["'][^>]*>`,
    'gi'
  )
  if ([...template.matchAll(targetOpenPattern)].length > 1) {
    throw new Error(
      `Vue Teleport target "${target}" appears more than once in the SSR HTML template. Teleport target ids must be unique.`
    )
  }
  const targetPattern = new RegExp(
    `(<([A-Za-z][\\w-]*)\\b[^>]*\\bid=["']${escapedId}["'][^>]*>)([\\s\\S]*?)(<\\/\\2>)`,
    'i'
  )
  const match = targetPattern.exec(template)
  if (!match) {
    throw new Error(
      `Vue Teleport target "${target}" is missing from the SSR HTML template. Add a dedicated ${target} container outside the application mount.`
    )
  }
  if (match[3].includes(SSR_HTML_MARKER)) {
    throw new Error(
      `Vue Teleport target "${target}" cannot be the SSR application mount. Add a separate target container outside the mount.`
    )
  }
  // The injector deliberately does not attempt to parse arbitrary HTML. A
  // non-empty dedicated target could contain nested elements whose closing
  // tags make a regex-based insertion ambiguous. Require target containers to
  // be empty (apart from formatting whitespace) so Teleports are appended at
  // the actual container level rather than silently corrupting the document.
  if (match[3].trim()) {
    throw new Error(
      `Vue Teleport target "${target}" must be an empty dedicated container. Remove existing child markup from ${target} or use a separate target outside the application mount.`
    )
  }
  return template.replace(
    targetPattern,
    (_match, opening: string, _tag: string, contents: string, closing: string) =>
      `${opening}${contents}${markup}${closing}`
  )
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
