import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSsrDevelopmentConsole,
  formatSsrDevelopmentConsoleFailure,
  resetSsrDevelopmentConsole,
} from './SsrCliDevelopmentConsole'

const ROOT = '/cli-console-root'

const compilerError = (message: string, file = '/cli-console-root/src/HomeHero.vue') =>
  Object.assign(new SyntaxError(message), {
    plugin: 'vite:vue',
    id: file,
    loc: { file, line: 84, column: 1 },
  })

afterEach(() => {
  resetSsrDevelopmentConsole(ROOT)
  vi.restoreAllMocks()
})

describe('SsrCliDevelopmentConsole', () => {
  it('formats an ordinary TypeError without empty plugin or file rows', () => {
    expect(formatSsrDevelopmentConsoleFailure(
      new TypeError("Cannot read properties of undefined (reading 'items')"),
      ROOT
    )).toBe("ERROR: Cannot read properties of undefined (reading 'items')")
  })

  it('formats one concise compiler failure with a project-relative file', () => {
    expect(formatSsrDevelopmentConsoleFailure(
      compilerError('Single file component can contain only one <template> element'),
      ROOT
    )).toBe([
      'ERROR: Single file component can contain only one <template> element',
      'Plugin: vite:vue',
      'File: src/HomeHero.vue:84:1',
    ].join('\n'))
  })

  it('prints the same active failure only once', () => {
    const write = vi.fn()
    const presenter = createSsrDevelopmentConsole({ root: ROOT, write })
    const error = compilerError('Single file component can contain only one <template> element')
    expect(presenter.reportFailure(error)).toBe(true)
    expect(presenter.reportFailure(error)).toBe(false)
    expect(presenter.reportFailure(compilerError('Single file component can contain only one <template> element'))).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toMatch(/^\nERROR: Single file component can contain only one <template> element/)
    expect(String(write.mock.calls[0]![0])).not.toContain('Application runtime unavailable')
    expect(String(write.mock.calls[0]![0])).not.toContain('ssr.runtime.unavailable')
  })

  it('inserts one blank line before a newly presented error and not when that failure is suppressed', () => {
    const write = vi.fn()
    const presenter = createSsrDevelopmentConsole({ root: ROOT, write })
    const error = compilerError('Single file component can contain only one <template> element')
    expect(formatSsrDevelopmentConsoleFailure(error, ROOT)).toBe([
      'ERROR: Single file component can contain only one <template> element',
      'Plugin: vite:vue',
      'File: src/HomeHero.vue:84:1',
    ].join('\n'))
    expect(formatSsrDevelopmentConsoleFailure(error, ROOT).startsWith('\n')).toBe(false)
    expect(presenter.reportFailure(error)).toBe(true)
    expect(presenter.reportFailure(error)).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toMatch(/^\nERROR:/)
    expect(write.mock.calls[0]![0]).not.toMatch(/^\n\n/)
  })

  it('replaces the active failure when a new revision produces a different error', () => {
    const write = vi.fn()
    const presenter = createSsrDevelopmentConsole({ root: ROOT, write })
    presenter.reportFailure(compilerError('first'))
    expect(presenter.reportFailure(Object.assign(new Error('Cannot resolve import "@/components/MissingCard.vue"'), {
      plugin: 'vite:import-analysis',
      id: '/cli-console-root/src/pages/Home.vue',
      loc: { file: '/cli-console-root/src/pages/Home.vue', line: 7, column: 20 },
    }))).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1]![0]).toBe(`\n${[
      'ERROR: Cannot resolve import "@/components/MissingCard.vue"',
      'Plugin: vite:import-analysis',
      'File: src/pages/Home.vue:7:20',
    ].join('\n')}`)
  })

  it('prints recovery once for failed to ready and not for ready to ready', () => {
    const write = vi.fn()
    const presenter = createSsrDevelopmentConsole({ root: ROOT, write })
    expect(presenter.reportRecovery()).toBe(false)
    presenter.reportFailure(compilerError('broken'))
    expect(presenter.reportRecovery()).toBe(true)
    expect(presenter.reportRecovery()).toBe(false)
    expect(write.mock.calls.filter(([text]) => text === '✓ Application recovered')).toHaveLength(1)
  })

  it('does not reprint a failure that Vite already acknowledged', () => {
    const write = vi.fn()
    const presenter = createSsrDevelopmentConsole({ root: ROOT, write })
    const error = compilerError('already shown by Vite')
    presenter.acknowledgeFailure(error)
    expect(presenter.reportFailure(error)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('shares active-failure state across consoles for the same project root', () => {
    const first = vi.fn()
    const second = vi.fn()
    createSsrDevelopmentConsole({ root: ROOT, write: first }).reportFailure(compilerError('shared'))
    expect(createSsrDevelopmentConsole({ root: ROOT, write: second }).reportFailure(compilerError('shared'))).toBe(false)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
})
