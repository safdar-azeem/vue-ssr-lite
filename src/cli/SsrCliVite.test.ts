import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSsrViteCliConfigMarker,
  readSsrViteCliConfig,
  SSR_VITE_CLI_CONFIG_KEY,
  SSR_VITE_CLI_CONFIG_PLUGIN,
} from '../vite/SsrViteCliConfig'
import {
  createSsrDevelopmentConsole,
  resetSsrDevelopmentConsole,
} from './SsrCliDevelopmentConsole'
import { createSsrCliDevelopmentViteConfig, createSsrCliDevelopmentViteLogger } from './SsrCliVite'

afterEach(() => {
  resetSsrDevelopmentConsole('/app')
  resetSsrDevelopmentConsole('/project')
  vi.restoreAllMocks()
})

const viteLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  warnOnce: vi.fn(),
  error: vi.fn(),
  clearScreen: vi.fn(),
  hasErrorLogged: vi.fn(() => false),
  hasWarned: false,
})

describe('createSsrCliDevelopmentViteConfig', () => {
  it('forwards an explicit CLI config into the Vite inline config', () => {
    const config = createSsrCliDevelopmentViteConfig(
      { root: '/app', cliConfig: '/app/config/platform.ts' },
      31001
    )
    expect(config).toMatchObject({
      root: '/app',
      appType: 'custom',
      clearScreen: false,
      [SSR_VITE_CLI_CONFIG_KEY]: '/app/config/platform.ts',
      server: {
        middlewareMode: true,
        hmr: { port: 31001, clientPort: 31001 },
      },
    })
    expect(typeof config.customLogger?.error).toBe('function')
    expect(config.plugins).toEqual([
      expect.objectContaining({
        name: SSR_VITE_CLI_CONFIG_PLUGIN,
        [SSR_VITE_CLI_CONFIG_KEY]: '/app/config/platform.ts',
      }),
    ])
  })

  it('does not inject a CLI config when the flag was omitted', () => {
    const config = createSsrCliDevelopmentViteConfig({ root: '/app' })
    expect(config).not.toHaveProperty(SSR_VITE_CLI_CONFIG_KEY)
    expect(config.plugins).toBeUndefined()
    expect(typeof config.customLogger?.error).toBe('function')
  })

  it('reads the CLI config from the marker plugin when the inline key is absent', () => {
    expect(
      readSsrViteCliConfig({
        plugins: [createSsrViteCliConfigMarker('/app/config/platform.ts')],
      })
    ).toBe('/app/config/platform.ts')
  })
})

describe('createSsrCliDevelopmentViteLogger', () => {
  it('prints a concise structured Vite compiler error without the default stack dump', () => {
    const write = vi.fn()
    const base = viteLogger()
    const logger = createSsrCliDevelopmentViteLogger(
      createSsrDevelopmentConsole({ root: '/project', write }),
      base
    )
    const error = Object.assign(
      new SyntaxError('Single file component can contain only one <template> element'),
      {
        plugin: 'vite:vue',
        id: '/project/src/HomeHero.vue',
        loc: { file: '/project/src/HomeHero.vue', line: 84, column: 1 },
        stack: 'SyntaxError: Single file component can contain only one <template> element\n    at compile',
      }
    )
    logger.error('Internal server error: Single file component can contain only one <template> element\n    at compile', { error })
    expect(write).toHaveBeenCalledWith(`\n${[
      'ERROR: Single file component can contain only one <template> element',
      'Plugin: vite:vue',
      'File: src/HomeHero.vue:84:1',
    ].join('\n')}`)
    expect(base.error).not.toHaveBeenCalled()
    expect(logger.hasErrorLogged(error)).toBe(true)
  })

  it('leaves Vite info unchanged and lets the presenter own the blank line before an active error', () => {
    const write = vi.fn()
    const base = viteLogger()
    const logger = createSsrCliDevelopmentViteLogger(
      createSsrDevelopmentConsole({ root: '/project', write }),
      base
    )
    const error = Object.assign(
      new SyntaxError('Single file component can contain only one <template> element'),
      {
        plugin: 'vite:vue',
        id: '/project/src/HomeHero.vue',
        loc: { file: '/project/src/HomeHero.vue', line: 84, column: 1 },
      }
    )
    logger.info('[vite] connected.')
    logger.error('Internal server error', { error })
    logger.error('Internal server error', { error })
    expect(base.info).toHaveBeenCalledWith('[vite] connected.')
    expect(base.info.mock.calls[0]![0]).toBe('[vite] connected.')
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toMatch(/^\nERROR: Single file component can contain only one <template> element/)
    expect(base.error).not.toHaveBeenCalled()
  })

  it('falls through to Vite for unknown errors and still preserves info output', () => {
    const write = vi.fn()
    const base = viteLogger()
    const logger = createSsrCliDevelopmentViteLogger(
      createSsrDevelopmentConsole({ root: '/project', write }),
      base
    )
    const error = new Error('optimizer exploded')
    logger.info('[vite] connected.')
    logger.error('optimizer exploded\n    at vite', { error })
    expect(base.info).toHaveBeenCalledWith('[vite] connected.')
    expect(base.error).toHaveBeenCalledWith('optimizer exploded\n    at vite', { error })
    expect(write).not.toHaveBeenCalled()
    expect(logger.hasErrorLogged(error)).toBe(true)
  })
})
