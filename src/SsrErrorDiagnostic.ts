import { randomBytes } from 'node:crypto'
import { readSsrInitializationPhase, readSsrProductionFailure } from './SsrProductionError'
import {
  classifySsrRuntimeLoadFailure,
  readSsrRuntimeLoadFailure,
  sanitizeSsrRuntimeLoadClassification,
  SSR_RUNTIME_LOAD_MESSAGES,
} from './SsrRuntimeLoadDiagnostics'

const ERROR_NAME = /^(?:[A-Za-z_$][A-Za-z0-9_$]{0,127})$/
const NODE_ERROR_CODE = /^(?:[A-Z][A-Z0-9_]{1,80})$/
const MAX_MESSAGE = 4096
const MAX_STACK = 8192

export const SSR_ERROR_ID_PREFIX = 'vssl_'

export type SsrThrownValue = {
  name: string
  message: string
  stack?: string
}

export type SsrErrorDiagnostic = {
  readonly errorId: string
  readonly requestId: string
  readonly applicationId: string
  readonly pathname: string
  readonly errorType: string
  readonly message: string
  readonly stack?: string
  readonly phase?: string
  readonly reason?: string
  readonly code?: string
  readonly artifact?: string
  readonly package?: string
  readonly module?: string
  readonly export?: string
}

const truncate = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value

const readRuntimeLoadFailure = (error: unknown) => {
  const attached = readSsrRuntimeLoadFailure(error)
  if (attached) return attached
  return readSsrInitializationPhase(error) === 'runtime-load'
    ? classifySsrRuntimeLoadFailure(error)
    : undefined
}

export const isSsrErrorId = (value: unknown): value is string =>
  typeof value === 'string' && /^vssl_[a-f0-9]{16}$/.test(value)

let fallbackErrorSequence = 0

/** Process-local fallback when cryptographic randomness is unavailable. */
export const createSsrFallbackErrorId = (): string => {
  fallbackErrorSequence += 1
  const mixed = (BigInt(Date.now()) << 20n) | (BigInt(fallbackErrorSequence) & 0xfffffn)
  return `${SSR_ERROR_ID_PREFIX}${mixed.toString(16).padStart(16, '0').slice(-16)}`
}

export const createSsrErrorId = (): string => {
  try {
    return `${SSR_ERROR_ID_PREFIX}${randomBytes(8).toString('hex')}`
  } catch {
    return createSsrFallbackErrorId()
  }
}

export const safeSsrLogIdentifier = (value: unknown): string =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'unknown'

export const sanitizeSsrLogPathname = (value: unknown): string => {
  const rawPath = typeof value === 'string' ? value : '/'
  const pathname = rawPath.split(/[?#]/, 1)[0]!.replace(/[\u0000-\u0020\u007f]/g, '')
    .replace(/(\/(?:token|session|password|secret|authorization|reset-password)\/)[^/]+/gi, '$1[redacted]')
    .replace(/[a-f0-9]{32,}/gi, '[redacted]')
    .replace(/[^/]{80,}/g, '[redacted]').slice(0, 512)
  return pathname.startsWith('/') && !pathname.startsWith('//') ? pathname : '/'
}

export const hasSsrThrownValue = (
  details?: Record<string, unknown>
): details is Record<string, unknown> =>
  Boolean(details && Object.prototype.hasOwnProperty.call(details, 'error'))

export type SsrFailureOccurrence = {
  errorId: string
  logged: boolean
}

type SsrCarriedFailure = {
  original: unknown
  occurrence: SsrFailureOccurrence
}

const authenticOccurrences = new WeakSet<object>()
const carriedFailures = new WeakMap<object, SsrCarriedFailure>()

const isCarrierKey = (value: unknown): value is object =>
  value != null && (typeof value === 'object' || typeof value === 'function')

const isSsrFailureOccurrence = (value: unknown): value is SsrFailureOccurrence =>
  Boolean(value && typeof value === 'object' && authenticOccurrences.has(value))

const createSsrFailureOccurrence = (errorId?: string): SsrFailureOccurrence => {
  const occurrence = {
    errorId: isSsrErrorId(errorId) ? errorId : createSsrErrorId(),
    logged: false,
  }
  authenticOccurrences.add(occurrence)
  return occurrence
}

const unwrapSsrFailure = (error: unknown): unknown => {
  if (!isCarrierKey(error)) return error
  const carried = carriedFailures.get(error)
  return carried ? unwrapSsrFailure(carried.original) : error
}

const readSsrCarriedFailure = (error: unknown): SsrCarriedFailure | undefined => {
  if (!isCarrierKey(error)) return undefined
  const carried = carriedFailures.get(error)
  if (!carried) return undefined
  return readSsrCarriedFailure(carried.original) ?? {
    original: carried.original,
    occurrence: carried.occurrence,
  }
}

export const observeSsrFailure = (
  error: unknown,
  providedErrorId?: unknown,
  occurrence?: unknown
): SsrCarriedFailure => {
  const provided = isSsrErrorId(providedErrorId) ? providedErrorId : undefined
  if (isSsrFailureOccurrence(occurrence)) {
    if (provided) occurrence.errorId = provided
    return { original: unwrapSsrFailure(error), occurrence }
  }
  const carried = readSsrCarriedFailure(error)
  if (carried) {
    if (provided) carried.occurrence.errorId = provided
    return { original: unwrapSsrFailure(carried.original), occurrence: carried.occurrence }
  }
  return {
    original: error,
    occurrence: createSsrFailureOccurrence(provided),
  }
}

/** Framework-owned wrapper used only while a failure crosses an internal boundary. */
export const carrySsrFailure = (error: unknown, occurrence: SsrFailureOccurrence): object => {
  const original = unwrapSsrFailure(error)
  if (isCarrierKey(error)) {
    const existing = carriedFailures.get(error)
    if (existing && existing.occurrence === occurrence && existing.original === original) return error
  }
  const carrier = new Error()
  carrier.name = 'SsrCarriedFailure'
  carriedFailures.set(carrier, { original, occurrence })
  return carrier
}

export const readSsrErrorType = (error: unknown): string => {
  try {
    if (readSsrProductionFailure(error)) return 'SsrProductionArtifactError'
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return 'Error'
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && ERROR_NAME.test(name)) return name
  } catch {
    // Hostile getters cannot affect diagnostics.
  }
  return 'Error'
}

export const readSsrErrorCode = (error: unknown): string => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && NODE_ERROR_CODE.test(code) ? code : ''
  } catch {
    return ''
  }
}

export const readSsrErrorMessage = (error: unknown): string => {
  try {
    if (typeof error === 'string') return truncate(error, MAX_MESSAGE)
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const message = (error as { message?: unknown }).message
    return typeof message === 'string' ? truncate(message, MAX_MESSAGE) : ''
  } catch {
    return ''
  }
}

export const readSsrErrorStack = (error: unknown): string => {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return ''
    const stack = (error as { stack?: unknown }).stack
    return typeof stack === 'string' && stack.length > 0 ? truncate(stack, MAX_STACK) : ''
  } catch {
    return ''
  }
}

/** Bounded operator view of a thrown value. Never walks cause or unknown properties. */
export const describeSsrThrownValue = (error: unknown): SsrThrownValue => {
  try {
    if (typeof error === 'string') {
      return { name: 'Error', message: truncate(error, MAX_MESSAGE) || 'Unknown error.' }
    }
    if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
      return { name: 'Error', message: String(error) }
    }
    if (typeof error === 'symbol') {
      return { name: 'Error', message: error.description ? `Symbol(${error.description})` : 'Symbol' }
    }
    if (error == null) {
      return { name: 'Error', message: error === null ? 'null' : 'undefined' }
    }
    const name = readSsrErrorType(error)
    const message = readSsrErrorMessage(error)
    const stack = readSsrErrorStack(error)
    if (message || stack || error instanceof Error) {
      return {
        name,
        message: message || 'Unknown error.',
        ...(stack ? { stack } : {}),
      }
    }
    return { name, message: 'Non-Error value was thrown.' }
  } catch {
    return { name: 'Error', message: 'Unknown error.' }
  }
}

/** Never echo arbitrary exception text: it can contain upstream bodies or credentials. */
export const describeSsrFailure = (error: unknown): string => {
  const productionFailure = readSsrProductionFailure(error)
  if (productionFailure) return productionFailure.message
  const runtimeLoadFailure = readRuntimeLoadFailure(error)
  if (runtimeLoadFailure) return SSR_RUNTIME_LOAD_MESSAGES[runtimeLoadFailure.reason]
  let message = ''
  try {
    message = error instanceof Error
      ? error.message
      : typeof error === 'string' ? error : ''
  } catch {
    /* hostile getter */
  }
  if (message.includes('localhost origin in production')) {
    return 'Local production origin rejected. Automatic local smoke testing requires a direct loopback Node connection. Use an HTTPS public origin for remote or proxied requests.'
  }
  if (message.includes('Public production origins must use https://')) {
    return 'Production HTTP origin rejected. Configure HTTPS PUBLIC_URL/seo.siteUrl, or the existing intentional seo.allowHttpOrigin exception.'
  }
  if (
    message.includes('valid site origin is required')
    || /site origin must|seo.siteUrl must|PUBLIC_URL must/.test(message)
  ) {
    return 'Invalid canonical origin configuration. Check PUBLIC_URL, seo.siteUrl and resolveSiteUrl.'
  }
  if (/timed out|TimeoutError/.test(message)) return 'The request exceeded its configured deadline.'
  if (/Missing client entry|SSR client entry is missing|ENOENT/.test(message)) {
    return 'A required production file is missing. Deploy the complete client and server build together.'
  }
  if (/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(message)) {
    return 'A server runtime dependency is missing from the deployment.'
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/.test(message)) {
    return 'An upstream request failed. Check the configured service endpoint and connectivity.'
  }
  if (/Cannot read properties of (?:undefined|null)/.test(message)) {
    return 'Application code accessed a property on a missing value.'
  }
  if (/is not a function/.test(message)) {
    return 'Application code attempted to call a value that is not a function.'
  }
  if (/is not defined/.test(message)) {
    return 'Application code referenced an undefined variable.'
  }
  if (/Maximum call stack size exceeded/.test(message)) {
    return 'Application recursion exceeded the call stack limit.'
  }
  if (/response header|Response header|response status/.test(message)) {
    return 'A handler returned an invalid HTTP response.'
  }
  if (/SeoProviderFailure|SEO provider|siteSeo\.resolve\(\)|siteRobots\.resolve\(\)/.test(message)) {
    return 'An SEO provider failed while serving this request.'
  }
  return 'Application request failed. Exception contents were omitted because they may contain private data.'
}

const runtimeLoadDiagnostic = (error: unknown): Record<string, unknown> => {
  const classification = sanitizeSsrRuntimeLoadClassification(readRuntimeLoadFailure(error))
  if (!classification) return {}
  return {
    reason: classification.reason,
    ...(classification.package ? { package: classification.package } : {}),
    ...(classification.module ? { module: classification.module } : {}),
    ...(classification.export ? { export: classification.export } : {}),
  }
}

/** Safe structured metadata. Never includes message, stack, headers, cookies, body or config. */
export const createSsrSafeLogDetails = (
  details?: Record<string, unknown>
): Record<string, unknown> => {
  const hasError = hasSsrThrownValue(details)
  const error = hasError ? unwrapSsrFailure(details.error) : undefined
  const productionFailure = hasError ? readSsrProductionFailure(error) : undefined
  const initializationPhase = hasError ? readSsrInitializationPhase(error) : undefined
  const errorId = isSsrErrorId(details?.errorId)
    ? details.errorId
    : hasError
      ? readSsrCarriedFailure(details.error)?.occurrence.errorId ?? createSsrErrorId()
      : undefined
  return {
    ...(errorId ? { errorId } : {}),
    requestId: safeSsrLogIdentifier(details?.requestId),
    applicationId: safeSsrLogIdentifier(details?.applicationId ?? details?.entryId),
    ...(details?.entryId === undefined ? {} : { entryId: safeSsrLogIdentifier(details.entryId) }),
    pathname: sanitizeSsrLogPathname(details?.pathname),
    ...(hasError
      ? { error: describeSsrFailure(error), errorType: readSsrErrorType(error) }
      : {}),
    ...(initializationPhase ? { phase: initializationPhase } : {}),
    ...(productionFailure
      ? { code: productionFailure.code, artifact: productionFailure.artifact, reason: productionFailure.reason }
      : hasError ? runtimeLoadDiagnostic(error) : {}),
  }
}

/**
 * Private operator diagnostic. Adds a bounded exception view on top of safe
 * metadata. Server logs are operator-confidential: Error.message is not parsed
 * for secrets, but headers, cookies, bodies, config, env and cause are never copied.
 */
export const createSsrOperatorLogDetails = (
  details?: Record<string, unknown>
): Record<string, unknown> => {
  const safe = createSsrSafeLogDetails(details)
  if (!hasSsrThrownValue(details)) return safe
  const error = unwrapSsrFailure(details.error)
  const thrown = describeSsrThrownValue(error)
  const nodeCode = readSsrErrorCode(error)
  return {
    ...safe,
    errorType: thrown.name,
    message: thrown.message,
    ...(thrown.stack ? { stack: thrown.stack } : {}),
    ...(safe.code || !nodeCode ? {} : { code: nodeCode }),
  }
}

export const createSsrErrorDiagnostic = (input: {
  error: unknown
  requestId?: unknown
  applicationId?: unknown
  entryId?: unknown
  pathname?: unknown
  errorId?: unknown
}): SsrErrorDiagnostic => {
  const observed = observeSsrFailure(input.error, input.errorId)
  const details = createSsrOperatorLogDetails({
    error: observed.original,
    requestId: input.requestId,
    applicationId: input.applicationId,
    entryId: input.entryId,
    pathname: input.pathname,
    errorId: observed.occurrence.errorId,
  })
  const thrown = describeSsrThrownValue(observed.original)
  return {
    errorId: observed.occurrence.errorId,
    requestId: safeSsrLogIdentifier(details.requestId),
    applicationId: safeSsrLogIdentifier(details.applicationId),
    pathname: sanitizeSsrLogPathname(details.pathname),
    errorType: thrown.name,
    message: thrown.message,
    ...(thrown.stack ? { stack: thrown.stack } : {}),
    ...(typeof details.phase === 'string' ? { phase: details.phase } : {}),
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
    ...(typeof details.code === 'string' ? { code: details.code } : {}),
    ...(typeof details.artifact === 'string' ? { artifact: details.artifact } : {}),
    ...(typeof details.package === 'string' ? { package: details.package } : {}),
    ...(typeof details.module === 'string' ? { module: details.module } : {}),
    ...(typeof details.export === 'string' ? { export: details.export } : {}),
  }
}
