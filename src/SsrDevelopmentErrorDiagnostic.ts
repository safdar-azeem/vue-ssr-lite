import { isAbsolute, relative, resolve } from 'node:path'
import { unwrapSsrFailure } from './SsrErrorDiagnostic'

const MAX_PLUGIN = 128
const MAX_SOURCE = 512
const MAX_FRAME = 4096
const MAX_LINE = 1_000_000
const MAX_COLUMN = 1_000_000
const PLUGIN_NAME =
  /^(?:@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)?(?::[A-Za-z0-9._-]+)*)$/
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export type SsrDevelopmentErrorDetails = {
  readonly plugin?: string
  readonly source?: string
  readonly displaySource?: string
  readonly line?: number
  readonly column?: number
  readonly location?: string
  readonly frame?: string
}

export type SsrDevelopmentErrorPresentationOptions = {
  readonly root?: string
}

const readBoundedString = (value: unknown, max: number): string => {
  try {
    if (typeof value !== 'string' || value.length === 0) return ''
    return value.length > max ? value.slice(0, max) : value
  } catch {
    return ''
  }
}

const readBoundedInteger = (value: unknown, min: number, max: number): number | undefined => {
  try {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return undefined
    }
    return value
  } catch {
    return undefined
  }
}

const rawSourceCandidate = (value: unknown): string => {
  try {
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

const sanitizeSource = (value: unknown): string => {
  const raw = readBoundedString(value, MAX_SOURCE + 128)
  if (!raw) return ''
  return raw.split(/[?#]/, 1)[0]!.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_SOURCE)
}

export const isSsrLocalDevelopmentSource = (value: string): boolean => {
  if (!value || value.startsWith('\0') || value.startsWith('virtual:')) return false
  if (WINDOWS_PATH.test(value)) return true
  if (value.startsWith('//') || URL_SCHEME.test(value)) return false
  return true
}

export const sourceBaseName = (source: string): string => {
  const parts = source.split(/[/\\]/)
  return parts[parts.length - 1] || source
}

export const formatSsrDevelopmentSourceLabel = (
  source: string,
  line?: number,
  column?: number
): string => {
  if (!source) return ''
  if (line === undefined) return source
  return column === undefined ? `${source}:${line}` : `${source}:${line}:${column}`
}

const readPlugin = (error: object): string => {
  let plugin = ''
  let pluginCode = ''
  try { plugin = readBoundedString((error as { plugin?: unknown }).plugin, MAX_PLUGIN) } catch { /* hostile */ }
  if (PLUGIN_NAME.test(plugin)) return plugin
  try { pluginCode = readBoundedString((error as { pluginCode?: unknown }).pluginCode, MAX_PLUGIN) } catch { /* hostile */ }
  if (PLUGIN_NAME.test(pluginCode) && /[:/]/.test(pluginCode)) return pluginCode
  return ''
}

const readLoc = (error: object): { file: string; local: boolean; line?: number; column?: number } => {
  try {
    const loc = (error as { loc?: unknown }).loc
    if (!loc || typeof loc !== 'object') return { file: '', local: false }
    const rawFile = rawSourceCandidate((loc as { file?: unknown }).file)
    return {
      file: sanitizeSource(rawFile),
      local: isSsrLocalDevelopmentSource(rawFile.split(/[?#]/, 1)[0] || rawFile),
      line: readBoundedInteger((loc as { line?: unknown }).line, 1, MAX_LINE),
      column: readBoundedInteger((loc as { column?: unknown }).column, 0, MAX_COLUMN),
    }
  } catch {
    return { file: '', local: false }
  }
}

const formatLocation = (source: string, line?: number, column?: number): string => {
  if (line === undefined) return column === undefined ? '' : `Column: ${column}`
  const suffix = column === undefined ? String(line) : `${line}:${column}`
  const label = sourceBaseName(source)
  return label ? `${label}:${suffix}` : suffix
}

const resolveLocalSource = (source: string, local: boolean, root?: string): string | undefined => {
  if (!source || !local || !isSsrLocalDevelopmentSource(source)) return undefined
  try {
    const absolute = isAbsolute(source) ? source : root ? resolve(root, source) : ''
    if (!absolute || !isAbsolute(absolute) || !isSsrLocalDevelopmentSource(absolute)) return undefined
    return absolute
  } catch {
    return undefined
  }
}

export const toSsrDevelopmentDisplaySource = (
  source: string,
  root?: string
): string | undefined => {
  if (!root || !source) return undefined
  const absolute = resolveLocalSource(source, true, root)
  if (!absolute) return undefined
  try {
    const display = relative(root, absolute)
    if (!display || display.startsWith('..') || isAbsolute(display)) return undefined
    return display.replaceAll('\\', '/')
  } catch {
    return undefined
  }
}

const presentSource = (
  source: string,
  local: boolean,
  root?: string
): Pick<SsrDevelopmentErrorDetails, 'displaySource'> => {
  const absolute = resolveLocalSource(source, local, root)
  if (!absolute) return {}
  const displaySource = root ? toSsrDevelopmentDisplaySource(absolute, root) : undefined
  return displaySource ? { displaySource } : {}
}

/** Allowlisted Vite/compiler fields for the development SSR error page only. */
export const readSsrDevelopmentErrorDetails = (
  error: unknown,
  options?: SsrDevelopmentErrorPresentationOptions
): SsrDevelopmentErrorDetails => {
  try {
    error = unwrapSsrFailure(error)
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return {}
    let plugin = ''
    let rawId: unknown
    let id = ''
    let frame = ''
    try { plugin = readPlugin(error) } catch { /* hostile plugin getters */ }
    try { rawId = (error as { id?: unknown }).id } catch { /* hostile id */ }
    try { id = sanitizeSource(rawId) } catch { /* hostile id */ }
    const idLocal = isSsrLocalDevelopmentSource(
      (rawSourceCandidate(rawId).split(/[?#]/, 1)[0] || rawSourceCandidate(rawId))
    )
    const loc = readLoc(error)
    try {
      frame = readBoundedString((error as { frame?: unknown }).frame, MAX_FRAME)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    } catch { /* hostile frame */ }
    const source = loc.file || id
    const local = loc.file ? loc.local : idLocal
    const location = formatLocation(source, loc.line, loc.column)
    const presented = source ? presentSource(source, local, options?.root) : {}
    return {
      ...(plugin ? { plugin } : {}),
      ...(source ? { source } : {}),
      ...(presented.displaySource ? { displaySource: presented.displaySource } : {}),
      ...(loc.line !== undefined ? { line: loc.line } : {}),
      ...(loc.column !== undefined ? { column: loc.column } : {}),
      ...(location ? { location } : {}),
      ...(frame ? { frame } : {}),
    }
  } catch {
    return {}
  }
}

export const isSsrStructuredViteError = (error: unknown): boolean => {
  const details = readSsrDevelopmentErrorDetails(error)
  return Boolean(details.plugin || details.source)
}
