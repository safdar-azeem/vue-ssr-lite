/** Public and development error-document presentation. */
import { escapeSsrHtml } from '../hydration/SsrSerialization'
import { formatSsrDevelopmentSourceLabel, sourceBaseName } from './SsrDevelopmentErrorDiagnostic'
import { isSsrErrorId } from './SsrErrorDiagnostic'

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
