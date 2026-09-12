import { unwrapSsrFailure } from './SsrErrorDiagnostic'

const MAX_PLUGIN = 128
const MAX_SOURCE = 512
const MAX_FRAME = 4096
const MAX_LINE = 1_000_000
const MAX_COLUMN = 1_000_000
const PLUGIN_NAME =
  /^(?:@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)?(?::[A-Za-z0-9._-]+)*)$/

export type SsrDevelopmentErrorDetails = {
  readonly plugin?: string
  readonly source?: string
  readonly location?: string
  readonly frame?: string
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

const sanitizeSource = (value: unknown): string => {
  const raw = readBoundedString(value, MAX_SOURCE + 128)
  if (!raw) return ''
  return raw.split(/[?#]/, 1)[0]!.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_SOURCE)
}

const sourceBaseName = (source: string): string => {
  const parts = source.split(/[/\\]/)
  return parts[parts.length - 1] || source
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

const readLoc = (error: object): { file: string; line?: number; column?: number } => {
  try {
    const loc = (error as { loc?: unknown }).loc
    if (!loc || typeof loc !== 'object') return { file: '' }
    return {
      file: sanitizeSource((loc as { file?: unknown }).file),
      line: readBoundedInteger((loc as { line?: unknown }).line, 1, MAX_LINE),
      column: readBoundedInteger((loc as { column?: unknown }).column, 0, MAX_COLUMN),
    }
  } catch {
    return { file: '' }
  }
}

const formatLocation = (source: string, line?: number, column?: number): string => {
  if (line === undefined) return column === undefined ? '' : `Column: ${column}`
  const suffix = column === undefined ? String(line) : `${line}:${column}`
  const label = sourceBaseName(source)
  return label ? `${label}:${suffix}` : suffix
}

/** Allowlisted Vite/compiler fields for the development SSR error page only. */
export const readSsrDevelopmentErrorDetails = (error: unknown): SsrDevelopmentErrorDetails => {
  try {
    error = unwrapSsrFailure(error)
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return {}
    let plugin = ''
    let id = ''
    let frame = ''
    try { plugin = readPlugin(error) } catch { /* hostile plugin getters */ }
    try { id = sanitizeSource((error as { id?: unknown }).id) } catch { /* hostile id */ }
    const loc = readLoc(error)
    try {
      frame = readBoundedString((error as { frame?: unknown }).frame, MAX_FRAME)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    } catch { /* hostile frame */ }
    const source = loc.file || id
    const location = formatLocation(source, loc.line, loc.column)
    return {
      ...(plugin ? { plugin } : {}),
      ...(source ? { source } : {}),
      ...(location ? { location } : {}),
      ...(frame ? { frame } : {}),
    }
  } catch {
    return {}
  }
}
