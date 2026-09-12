import { resolve } from 'node:path'
import { describeSsrThrownValue } from '../SsrErrorDiagnostic'
import {
  formatSsrDevelopmentSourceLabel,
  readSsrDevelopmentErrorDetails,
  sourceBaseName,
  type SsrDevelopmentErrorDetails,
} from '../SsrDevelopmentErrorDiagnostic'

export type SsrDevelopmentConsole = {
  readonly root: string
  formatFailure: (error: unknown) => string
  reportFailure: (error: unknown) => boolean
  acknowledgeFailure: (error: unknown) => void
  reportRecovery: () => boolean
}

type SsrDevelopmentConsoleSession = {
  fingerprint?: string
  failed: boolean
}

const sessions = new Map<string, SsrDevelopmentConsoleSession>()

const sessionKey = (root: string): string => resolve(root)

const sessionFor = (root: string): SsrDevelopmentConsoleSession => {
  const key = sessionKey(root)
  const existing = sessions.get(key)
  if (existing) return existing
  const session: SsrDevelopmentConsoleSession = { failed: false }
  sessions.set(key, session)
  return session
}

export const resetSsrDevelopmentConsole = (root?: string): void => {
  if (root) sessions.delete(sessionKey(root))
  else sessions.clear()
}

const writeDevelopmentConsole = (text: string): void => {
  console.log(text)
}

const SSR_DEVELOPMENT_ERROR_LABEL = 'ERROR:'
const ANSI_BOLD_RED = '\u001b[1;31m'
const ANSI_RESET = '\u001b[0m'

const shouldColorSsrDevelopmentConsole = (): boolean => {
  if (process.env.NO_COLOR) return false
  const force = process.env.FORCE_COLOR
  if (force === '0') return false
  if (force) return true
  if (process.env.CI) return false
  return process.stdout.isTTY === true
}

const formatSsrDevelopmentErrorLabel = (): string =>
  shouldColorSsrDevelopmentConsole()
    ? `${ANSI_BOLD_RED}${SSR_DEVELOPMENT_ERROR_LABEL}${ANSI_RESET}`
    : SSR_DEVELOPMENT_ERROR_LABEL

const visibleSource = (details: SsrDevelopmentErrorDetails): string =>
  details.displaySource || (details.source ? sourceBaseName(details.source) : '')

const fingerprintDevelopmentError = (
  details: SsrDevelopmentErrorDetails,
  name: string,
  message: string
): string =>
  [name, message, details.plugin ?? '', visibleSource(details), details.line ?? '', details.column ?? ''].join('\n')

export const formatSsrDevelopmentConsoleFailure = (
  error: unknown,
  root?: string
): string => {
  const thrown = describeSsrThrownValue(error)
  const details = readSsrDevelopmentErrorDetails(error, { root })
  const lines = [`${formatSsrDevelopmentErrorLabel()} ${thrown.message}`]
  if (details.plugin) lines.push(`Plugin: ${details.plugin}`)
  const file = formatSsrDevelopmentSourceLabel(
    visibleSource(details),
    details.line,
    details.column
  )
  if (file) lines.push(`File: ${file}`)
  return lines.join('\n')
}

export const createSsrDevelopmentConsole = (options: {
  root: string
  write?: (text: string) => void
}): SsrDevelopmentConsole => {
  const session = sessionFor(options.root)
  const write = options.write ?? writeDevelopmentConsole
  const identify = (error: unknown) => {
    const thrown = describeSsrThrownValue(error)
    const details = readSsrDevelopmentErrorDetails(error, { root: options.root })
    return fingerprintDevelopmentError(details, thrown.name, thrown.message)
  }
  return {
    root: options.root,
    formatFailure: (error) => formatSsrDevelopmentConsoleFailure(error, options.root),
    reportFailure: (error) => {
      const fingerprint = identify(error)
      if (session.failed && session.fingerprint === fingerprint) return false
      session.failed = true
      session.fingerprint = fingerprint
      write(`\n${formatSsrDevelopmentConsoleFailure(error, options.root)}`)
      return true
    },
    acknowledgeFailure: (error) => {
      session.failed = true
      session.fingerprint = identify(error)
    },
    reportRecovery: () => {
      if (!session.failed) return false
      session.failed = false
      session.fingerprint = undefined
      write('✓ Application recovered')
      return true
    },
  }
}
