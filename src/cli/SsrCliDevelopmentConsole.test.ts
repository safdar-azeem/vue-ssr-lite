import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('SsrCliDevelopmentConsole', () => {
  beforeEach(() => {
    vi.stubEnv('NO_COLOR', '1')
  })

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

describe('SsrCliDevelopmentConsole color', () => {
  const colorizeErrorLine = (message: string) =>
    `\u001b[1;31mERROR: ${message}\u001b[0m`
  const colorizeFilePath = (file: string) =>
    `File: \u001b[34m${file}\u001b[0m`
  const compilerFailure = compilerError(
    'Single file component can contain only one <template> element'
  )
  const typeError = new TypeError("Cannot read properties of undefined (reading 'items')")
  const styledCompilerFailure = [
    colorizeErrorLine('Single file component can contain only one <template> element'),
    'Plugin: vite:vue',
    colorizeFilePath('src/HomeHero.vue:84:1'),
  ].join('\n')
  const plainCompilerFailure = [
    'ERROR: Single file component can contain only one <template> element',
    'Plugin: vite:vue',
    'File: src/HomeHero.vue:84:1',
  ].join('\n')
  const plainTypeError = "ERROR: Cannot read properties of undefined (reading 'items')"

  const withoutNoColor = (run: () => void) => {
    const present = Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR')
    const previous = process.env.NO_COLOR
    delete process.env.NO_COLOR
    try {
      run()
    } finally {
      if (present) process.env.NO_COLOR = previous
      else delete process.env.NO_COLOR
    }
  }

  const withStdoutTty = (isTTY: boolean, run: () => void) => {
    const stdout = process.stdout
    const originalTty = Object.getOwnPropertyDescriptor(stdout, 'isTTY')
    Object.defineProperty(stdout, 'isTTY', { configurable: true, value: isTTY })
    try {
      run()
    } finally {
      if (originalTty) Object.defineProperty(stdout, 'isTTY', originalTty)
      else delete (stdout as { isTTY?: boolean }).isTTY
    }
  }

  it('styles the ERROR line red and only the file path blue when NO_COLOR is absent', () => {
    withoutNoColor(() => {
      vi.stubEnv('FORCE_COLOR', '1')
      const formatted = formatSsrDevelopmentConsoleFailure(compilerFailure, ROOT)
      expect(formatted).toBe(styledCompilerFailure)
      expect(formatted).not.toContain('\u001b[1;31mPlugin:')
      expect(formatted).not.toContain('\u001b[34mFile:')
      expect(formatted).not.toContain('\u001b[1;31mFile:')
    })
  })

  it('keeps plain output when NO_COLOR=1 even if FORCE_COLOR is set', () => {
    vi.stubEnv('FORCE_COLOR', '1')
    vi.stubEnv('NO_COLOR', '1')
    expect(formatSsrDevelopmentConsoleFailure(compilerFailure, ROOT)).toBe(plainCompilerFailure)
    expect(formatSsrDevelopmentConsoleFailure(compilerFailure, ROOT)).not.toContain('\u001b')
  })

  it('keeps plain output when NO_COLOR is present as an empty string', () => {
    vi.stubEnv('FORCE_COLOR', '1')
    vi.stubEnv('NO_COLOR', '')
    expect(formatSsrDevelopmentConsoleFailure(compilerFailure, ROOT)).toBe(plainCompilerFailure)
    expect(formatSsrDevelopmentConsoleFailure(compilerFailure, ROOT)).not.toContain('\u001b')
  })

  it('keeps plain output in CI when NO_COLOR is absent', () => {
    withoutNoColor(() => {
      vi.stubEnv('FORCE_COLOR', '')
      vi.stubEnv('CI', 'true')
      withStdoutTty(true, () => {
        expect(formatSsrDevelopmentConsoleFailure(typeError, ROOT)).toBe(plainTypeError)
      })
    })
  })

  it('keeps plain output for non-TTY stdout when NO_COLOR is absent', () => {
    withoutNoColor(() => {
      vi.stubEnv('FORCE_COLOR', '')
      vi.stubEnv('CI', '')
      withStdoutTty(false, () => {
        expect(formatSsrDevelopmentConsoleFailure(typeError, ROOT)).toBe(plainTypeError)
      })
    })
  })
})
