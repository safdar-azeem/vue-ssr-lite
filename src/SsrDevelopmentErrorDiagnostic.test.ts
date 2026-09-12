import { describe, expect, it } from 'vitest'
import { carrySsrFailure, observeSsrFailure } from './SsrErrorDiagnostic'
import { readSsrDevelopmentErrorDetails } from './SsrDevelopmentErrorDiagnostic'

const viteStyleError = () =>
  Object.assign(new SyntaxError('Single file component can contain only one <template> element'), {
    plugin: 'vite:vue',
    id: '/project/src/HomeHero.vue',
    loc: { file: '/project/src/HomeHero.vue', line: 10, column: 1 },
    frame: '  8 | <template>\n  9 | <template>\n    | ^',
    stack:
      'SyntaxError: Single file component can contain only one <template> element\n    at createError (/plugin-vue)',
  })

describe('SsrDevelopmentErrorDiagnostic', () => {
  it('reads allowlisted Vite compiler fields without inventing missing values', () => {
    const error = viteStyleError()
    expect(readSsrDevelopmentErrorDetails(error)).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
      location: 'HomeHero.vue:10:1',
      frame: '  8 | <template>\n  9 | <template>\n    | ^',
    })
    expect(readSsrDevelopmentErrorDetails(
      carrySsrFailure(error, observeSsrFailure(error).occurrence)
    )).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
      location: 'HomeHero.vue:10:1',
      frame: '  8 | <template>\n  9 | <template>\n    | ^',
    })
  })

  it('uses id when loc.file is absent', () => {
    const error = Object.assign(new SyntaxError('duplicate template'), {
      plugin: 'vite:vue',
      id: '/project/src/HomeHero.vue?vue&type=template',
      loc: { line: 12, column: 1 },
    })
    expect(readSsrDevelopmentErrorDetails(error)).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
      location: 'HomeHero.vue:12:1',
    })
  })

  it('ignores ordinary TypeErrors and primitive throws', () => {
    expect(readSsrDevelopmentErrorDetails(new TypeError('missing'))).toEqual({})
    expect(readSsrDevelopmentErrorDetails('plain string failure')).toEqual({})
    expect(readSsrDevelopmentErrorDetails(undefined)).toEqual({})
  })

  it('does not invent a plugin from pluginCode codes or stack text', () => {
    const error = Object.assign(new Error('Single file component can contain only one <template> element'), {
      pluginCode: 'DUPLICATE_TEMPLATE',
      stack: 'Error: failed\n    at vite:vue (/plugin-vue)',
    })
    expect(readSsrDevelopmentErrorDetails(error)).toEqual({})
  })

  it('does not throw when allowlisted getters are hostile', () => {
    const error = new Error('safe')
    for (const key of ['plugin', 'pluginCode', 'id', 'loc', 'frame', 'cause']) {
      Object.defineProperty(error, key, { get() { throw new Error(`hostile ${key}`) } })
    }
    expect(() => readSsrDevelopmentErrorDetails(error)).not.toThrow()
    expect(readSsrDevelopmentErrorDetails(error)).toEqual({})
  })

  it('accepts a plugin-shaped pluginCode only when plugin is absent', () => {
    expect(readSsrDevelopmentErrorDetails(Object.assign(new Error('failed'), {
      pluginCode: 'vite:vue',
      id: '/project/src/HomeHero.vue',
    }))).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
    })
  })

  it('does not guess line or column from string loc fields', () => {
    expect(readSsrDevelopmentErrorDetails(Object.assign(new Error('failed'), {
      loc: { file: '/project/src/HomeHero.vue', line: '10', column: '1' },
    }))).toEqual({
      source: '/project/src/HomeHero.vue',
    })
  })

  it('does not walk cause or arbitrary properties', () => {
    const error = Object.assign(new Error('render failed'), {
      secret: 'private-token',
      cause: {
        plugin: 'vite:vue',
        id: '/private/secret.vue',
        frame: 'secret-frame',
      },
    })
    expect(readSsrDevelopmentErrorDetails(error)).toEqual({})
  })
})
