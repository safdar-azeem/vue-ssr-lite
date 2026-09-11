/** Safe runtime-load classification. Never copy exception text into structured fields; operator logs read name/message/stack separately. */

export const SSR_RUNTIME_LOAD_REASONS = [
  'missing-runtime-dependency',
  'missing-named-export',
  'invalid-module-export',
  'module-format-incompatibility',
  'module-syntax-error',
  'invalid-runtime-export',
  'runtime-load-failed',
] as const

export type SsrRuntimeLoadFailureReason = typeof SSR_RUNTIME_LOAD_REASONS[number]

export type SsrRuntimeLoadClassification = {
  reason: SsrRuntimeLoadFailureReason
  package?: string
  module?: string
  export?: string
}

export const SSR_RUNTIME_LOAD_MESSAGES: Record<SsrRuntimeLoadFailureReason, string> = {
  'missing-runtime-dependency':
    'A server runtime dependency is missing from the deployment.',
  'missing-named-export':
    'The compiled server runtime imports a named export that the dependency does not provide.',
  'invalid-module-export':
    'The compiled server runtime requested a module export that the package does not expose.',
  'module-format-incompatibility':
    'The compiled server runtime could not load a module because of an ESM and CommonJS format mismatch.',
  'module-syntax-error':
    'The compiled server runtime or a loaded module contains invalid JavaScript syntax.',
  'invalid-runtime-export':
    'The compiled server runtime loaded but did not expose the export contract vue-ssr-lite requires.',
  'runtime-load-failed':
    'The compiled server runtime could not be loaded. Exception contents were omitted because they may contain private data.',
}

export const SSR_RUNTIME_LOAD_NODE_CODES: Record<string, SsrRuntimeLoadFailureReason> = {
  ERR_MODULE_NOT_FOUND: 'missing-runtime-dependency',
  MODULE_NOT_FOUND: 'missing-runtime-dependency',
  ERR_PACKAGE_PATH_NOT_EXPORTED: 'invalid-module-export',
  ERR_PACKAGE_IMPORT_NOT_DEFINED: 'invalid-module-export',
  ERR_INVALID_PACKAGE_TARGET: 'invalid-module-export',
  ERR_INVALID_PACKAGE_CONFIG: 'invalid-module-export',
  ERR_UNSUPPORTED_DIR_IMPORT: 'invalid-module-export',
  ERR_INVALID_MODULE_SPECIFIER: 'invalid-module-export',
  ERR_REQUIRE_ESM: 'module-format-incompatibility',
  ERR_UNKNOWN_MODULE_FORMAT: 'module-format-incompatibility',
  ERR_UNKNOWN_FILE_EXTENSION: 'module-format-incompatibility',
  ERR_UNSUPPORTED_ESM_URL_SCHEME: 'module-format-incompatibility',
  ERR_VUE_SSR_LITE_INVALID_RUNTIME_EXPORT: 'invalid-runtime-export',
}

const RUNTIME_LOAD_FAILURE = Symbol.for('vue-ssr-lite.internal.runtime-load-failure')
const RUNTIME_LOAD_REASON_SET = new Set<string>(SSR_RUNTIME_LOAD_REASONS)
const GENERIC_FAILURE: SsrRuntimeLoadClassification = { reason: 'runtime-load-failed' }
const PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/
const MODULE_SPECIFIER = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const EXPORT_NAME = /^(?:default|[A-Za-z_$][A-Za-z0-9_$]{0,127})$/
const PARSE_FAILURE =
  /^(?:Unexpected (?:token|identifier|string|number|end of input)|Invalid or unexpected token|missing \) after argument list)\b/

const isSafeModuleSpecifier = (value: string): boolean => {
  if (value.length < 1 || value.length > 128 || value !== value.trim()) return false
  if (/[\u0000-\u0020\u007f\\?#%]/.test(value) || value.includes('..')) return false
  if (/^(?:[A-Za-z]:|file:|https?:|data:|node:|npm:)/i.test(value)) return false
  if (value.startsWith('.') || value.startsWith('/')) return false
  return MODULE_SPECIFIER.test(value)
}

const isSafePackageName = (value: string): boolean =>
  isSafeModuleSpecifier(value) && PACKAGE_NAME.test(value)

const isSafeExportName = (value: string): boolean => EXPORT_NAME.test(value)

const identifiersFromSpecifier = (value: string): Pick<SsrRuntimeLoadClassification, 'package' | 'module'> => {
  if (!isSafeModuleSpecifier(value)) return {}
  return isSafePackageName(value) ? { package: value } : { module: value }
}

const exportField = (value: string): Pick<SsrRuntimeLoadClassification, 'export'> =>
  isSafeExportName(value) ? { export: value } : {}

export const sanitizeSsrRuntimeLoadClassification = (
  value: unknown
): SsrRuntimeLoadClassification | undefined => {
  try {
    if (!value || typeof value !== 'object') return undefined
    const reason = (value as { reason?: unknown }).reason
    if (typeof reason !== 'string' || !RUNTIME_LOAD_REASON_SET.has(reason)) return undefined
    const classification: SsrRuntimeLoadClassification = { reason: reason as SsrRuntimeLoadFailureReason }
    const pkg = (value as { package?: unknown }).package
    const moduleName = (value as { module?: unknown }).module
    const exported = (value as { export?: unknown }).export
    if (typeof pkg === 'string' && isSafePackageName(pkg)) classification.package = pkg
    if (typeof moduleName === 'string' && isSafeModuleSpecifier(moduleName)) {
      if (isSafePackageName(moduleName)) classification.package ??= moduleName
      else classification.module = moduleName
    }
    if (typeof exported === 'string' && isSafeExportName(exported)) classification.export = exported
    return classification
  } catch {
    return undefined
  }
}

const freezeClassification = (
  classification: SsrRuntimeLoadClassification
): SsrRuntimeLoadClassification =>
  Object.freeze({ ...classification })

const readErrorName = (error: unknown): string => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const name = (error as { name?: unknown }).name
    return typeof name === 'string' ? name : ''
  } catch {
    return ''
  }
}

const readErrorCode = (error: unknown): string => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : ''
  } catch {
    return ''
  }
}

const readDiagnosticLine = (error: unknown): string => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const message = (error as { message?: unknown }).message
    if (typeof message !== 'string' || message.length === 0) return ''
    return message.split(/\r?\n/, 1)[0]!.slice(0, 512)
  } catch {
    return ''
  }
}

const readQuoted = (input: string, start: number): { value: string; next: number } | undefined => {
  const quote = input[start]
  if (quote !== "'" && quote !== '"') return undefined
  const end = input.indexOf(quote, start + 1)
  if (end <= start + 1 || end - start - 1 > 128) return undefined
  return { value: input.slice(start + 1, end), next: end + 1 }
}

const readErrorStack = (error: unknown): string => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const stack = (error as { stack?: unknown }).stack
    return typeof stack === 'string' && stack.length > 0 && stack.length <= 8192 ? stack : ''
  } catch {
    return ''
  }
}

const loaderStackFrames = (error: unknown): string =>
  readErrorStack(error).split(/\r?\n/).slice(1, 16).join('\n')

const isNativeSyntaxError = (error: unknown): boolean => {
  try {
    return error instanceof SyntaxError && readErrorName(error) === 'SyntaxError'
  } catch {
    return false
  }
}

const hasNodeEsmLoaderStack = (error: unknown): boolean => {
  const frames = loaderStackFrames(error)
  return /(?:node:)?internal\/modules\/esm(?:\/|:|$)/.test(frames) ||
    /\bat (?:async )?ModuleJob\b/.test(frames)
}

const hasViteLoaderStack = (error: unknown): boolean =>
  /(?:\/vite\/dist\/node\/|\/vite-node\/)/.test(loaderStackFrames(error))

const canExtractLoaderIdentifiers = (error: unknown): boolean =>
  hasNodeEsmLoaderStack(error) || hasViteLoaderStack(error)

const reasonOnly = (reason: SsrRuntimeLoadFailureReason): SsrRuntimeLoadClassification => ({ reason })

const maybeIdentifiers = (
  error: unknown,
  classification: SsrRuntimeLoadClassification
): SsrRuntimeLoadClassification =>
  canExtractLoaderIdentifiers(error) ? classification : reasonOnly(classification.reason)

const classifyNamedExport = (line: string): SsrRuntimeLoadClassification | undefined => {
  const nodePrefix = 'The requested module '
  if (line.startsWith(nodePrefix)) {
    const imported = readQuoted(line, nodePrefix.length)
    if (!imported) return { reason: 'missing-named-export' }
    const mid = ' does not provide an export named '
    if (!line.startsWith(mid, imported.next)) return { reason: 'missing-named-export' }
    const exported = readQuoted(line, imported.next + mid.length)
    if (!exported) return { reason: 'missing-named-export' }
    return {
      reason: 'missing-named-export',
      ...identifiersFromSpecifier(imported.value),
      ...exportField(exported.value),
    }
  }
  const vitePrefix = line.startsWith('[vite] ') ? '[vite] Named export ' : 'Named export '
  if (line.startsWith(vitePrefix)) {
    const exported = readQuoted(line, vitePrefix.length)
    if (!exported) return { reason: 'missing-named-export' }
    const mid = ' not found. The requested module '
    if (!line.startsWith(mid, exported.next)) return { reason: 'missing-named-export' }
    const imported = readQuoted(line, exported.next + mid.length)
    if (!imported) return { reason: 'missing-named-export' }
    return {
      reason: 'missing-named-export',
      ...identifiersFromSpecifier(imported.value),
      ...exportField(exported.value),
    }
  }
  return undefined
}

const classifyMissingDependency = (line: string): SsrRuntimeLoadClassification | undefined => {
  for (const prefix of ["Cannot find package ", "Cannot find module "] as const) {
    if (!line.startsWith(prefix)) continue
    const imported = readQuoted(line, prefix.length)
    if (!imported) return { reason: 'missing-runtime-dependency' }
    return {
      reason: 'missing-runtime-dependency',
      ...identifiersFromSpecifier(imported.value),
    }
  }
  return undefined
}

export class SsrRuntimeLoadError extends Error {
  readonly [RUNTIME_LOAD_FAILURE]: SsrRuntimeLoadClassification
  readonly code?: string

  constructor(classification: SsrRuntimeLoadClassification) {
    const safe = sanitizeSsrRuntimeLoadClassification(classification) ?? GENERIC_FAILURE
    super(`[vue-ssr-lite] runtime-load.${safe.reason}: ${SSR_RUNTIME_LOAD_MESSAGES[safe.reason]}`)
    this.name = 'SsrRuntimeLoadError'
    this[RUNTIME_LOAD_FAILURE] = freezeClassification(safe)
    if (safe.reason === 'invalid-runtime-export') {
      this.code = 'ERR_VUE_SSR_LITE_INVALID_RUNTIME_EXPORT'
    }
  }
}

export const createSsrRuntimeLoadFailure = (
  reason: SsrRuntimeLoadFailureReason,
  details?: Omit<SsrRuntimeLoadClassification, 'reason'>
): SsrRuntimeLoadError =>
  new SsrRuntimeLoadError({ reason, ...details })

export const readSsrRuntimeLoadFailure = (error: unknown): SsrRuntimeLoadClassification | undefined => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
    return sanitizeSsrRuntimeLoadClassification(
      (error as { [RUNTIME_LOAD_FAILURE]?: unknown })[RUNTIME_LOAD_FAILURE]
    )
  } catch {
    return undefined
  }
}

export const classifySsrRuntimeLoadFailure = (error: unknown): SsrRuntimeLoadClassification => {
  try {
    const attached = readSsrRuntimeLoadFailure(error)
    if (attached) return attached
    if (error == null || (typeof error !== 'object' && typeof error !== 'function')) return GENERIC_FAILURE
    const code = readErrorCode(error)
    const mapped = code && Object.hasOwn(SSR_RUNTIME_LOAD_NODE_CODES, code)
      ? SSR_RUNTIME_LOAD_NODE_CODES[code]
      : undefined
    const line = readDiagnosticLine(error)
    if (mapped === 'missing-runtime-dependency') {
      return maybeIdentifiers(error, classifyMissingDependency(line) ?? reasonOnly(mapped))
    }
    if (mapped) return reasonOnly(mapped)
    const namedExportPattern = line.includes('does not provide an export named') ||
      /^\s*(?:\[vite\] )?Named export /.test(line)
    if (namedExportPattern && (isNativeSyntaxError(error) || line.startsWith('[vite] '))) {
      return maybeIdentifiers(error, classifyNamedExport(line) ?? reasonOnly('missing-named-export'))
    }
    if (
      isNativeSyntaxError(error) &&
      line.includes('Cannot use import statement outside a module')
    ) {
      return reasonOnly('module-format-incompatibility')
    }
    if (isNativeSyntaxError(error) && PARSE_FAILURE.test(line)) return reasonOnly('module-syntax-error')
    return GENERIC_FAILURE
  } catch {
    return GENERIC_FAILURE
  }
}

const isUsableRuntimeExport = (value: unknown): boolean => {
  if (typeof value === 'function') return true
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** Generated SsrRuntime.js must default-export a factory or config object. */
export const assertSsrRuntimeModuleExport = (loaded: unknown): void => {
  if (typeof loaded === 'function') return
  if (!isUsableRuntimeExport(loaded)) throw createSsrRuntimeLoadFailure('invalid-runtime-export')
  let tag: unknown
  try {
    tag = (loaded as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag]
  } catch {
    return
  }
  if (tag !== 'Module') return
  let exported: unknown
  try {
    exported = (loaded as { default?: unknown }).default
  } catch {
    throw createSsrRuntimeLoadFailure('invalid-runtime-export')
  }
  if (!isUsableRuntimeExport(exported)) throw createSsrRuntimeLoadFailure('invalid-runtime-export')
}
