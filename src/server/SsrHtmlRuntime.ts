import {
  escapeSsrHtml,
  getSsrStateElementId,
  renderSsrHead,
  serializeSsrState,
} from '../SsrSerialization'
import type { SsrHeadPayload, SsrHydrationState } from '../SsrRuntimeTypes'

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

const applyHtmlAttributes = (
  html: string,
  attributes: SsrHeadPayload['htmlAttributes']
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
  teleports: string
  head: SsrHeadPayload | null
  state: SsrHydrationState<any, any>
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
  const documentTemplate = injection.head?.title
    ? template.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '')
    : template
  return applyHtmlAttributes(
    documentTemplate
      .replace(SSR_HEAD_MARKER, renderSsrHead(injection.head))
      .replace(SSR_TELEPORT_MARKER, injection.teleports)
      .replace(SSR_HTML_MARKER, injection.html)
      .replace(SSR_STATE_MARKER, stateScript),
    injection.head?.htmlAttributes
  )
}

export const renderSsrErrorDocument = (
  title: string,
  message: string,
  language = 'en'
): string => `<!doctype html><html lang="${escapeSsrHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeSsrHtml(title)}</title></head><body><main id="main-content" style="min-height:70vh;display:grid;place-items:center;padding:2rem;text-align:center;font-family:system-ui,sans-serif" tabindex="-1"><div><h1>${escapeSsrHtml(title)}</h1><p>${escapeSsrHtml(message)}</p><p><a href="/">Return home</a></p></div></main></body></html>`
