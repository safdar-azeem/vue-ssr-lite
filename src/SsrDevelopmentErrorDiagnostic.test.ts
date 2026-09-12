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

const expectFileIdentity = (details: ReturnType<typeof readSsrDevelopmentErrorDetails>) => {
  expect(details).not.toHaveProperty('editorHref')
  expect(JSON.stringify(details)).not.toContain('vscode:')
  expect(JSON.stringify(details)).not.toContain('__open-in-editor')
}

describe('SsrDevelopmentErrorDiagnostic', () => {
  it('reads allowlisted Vite compiler fields without inventing missing values', () => {
    const error = viteStyleError()
    expect(readSsrDevelopmentErrorDetails(error)).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
      line: 10,
      column: 1,
      location: 'HomeHero.vue:10:1',
      frame: '  8 | <template>\n  9 | <template>\n    | ^',
    })
    expectFileIdentity(readSsrDevelopmentErrorDetails(error))
    expect(readSsrDevelopmentErrorDetails(
      carrySsrFailure(error, observeSsrFailure(error).occurrence)
    )).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
      line: 10,
      column: 1,
      location: 'HomeHero.vue:10:1',
      frame: '  8 | <template>\n  9 | <template>\n    | ^',
    })
  })

  it('maps a project-local source to a relative display path without an editor contract', () => {
    const details = readSsrDevelopmentErrorDetails(viteStyleError(), { root: '/project' })
    expect(details).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
      displaySource: 'src/HomeHero.vue',
      line: 10,
      column: 1,
      location: 'HomeHero.vue:10:1',
      frame: '  8 | <template>\n  9 | <template>\n    | ^',
    })
    expectFileIdentity(details)
  })

  it('does not invent line or column when location is absent', () => {
    const details = readSsrDevelopmentErrorDetails(Object.assign(new Error('failed'), {
      id: '/project/src/HomeHero.vue',
    }), { root: '/project' })
    expect(details).toEqual({
      source: '/project/src/HomeHero.vue',
      displaySource: 'src/HomeHero.vue',
    })
    expect(details.line).toBeUndefined()
    expect(details.column).toBeUndefined()
    expectFileIdentity(details)
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
      line: 12,
      column: 1,
      location: 'HomeHero.vue:12:1',
    })
    expectFileIdentity(readSsrDevelopmentErrorDetails(error))
  })

  it('does not create project-relative paths for virtual or unsafe sources', () => {
    for (const id of ['virtual:module', '\0module', 'https://example.com/HomeHero.vue', 'javascript:alert(1)', 'data:text/html,oops']) {
      const details = readSsrDevelopmentErrorDetails(Object.assign(new Error('failed'), {
        plugin: 'vite:vue',
        id,
        loc: { file: id, line: 10, column: 1 },
      }), { root: '/project' })
      expect(details.displaySource).toBeUndefined()
      expectFileIdentity(details)
      expect(details.plugin).toBe('vite:vue')
    }
  })

  it('does not treat a path outside the project as an application-relative source', () => {
    const details = readSsrDevelopmentErrorDetails(Object.assign(new Error('failed'), {
      id: '/private/secret.vue',
      loc: { file: '/private/secret.vue', line: 3, column: 1 },
    }), { root: '/project' })
    expect(details.displaySource).toBeUndefined()
    expect(details.displaySource).not.toMatch(/\.\./)
    expect(details.source).toBe('/private/secret.vue')
    expectFileIdentity(details)
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
    expect(() => readSsrDevelopmentErrorDetails(error, { root: '/project' })).not.toThrow()
    expect(readSsrDevelopmentErrorDetails(error, { root: '/project' })).toEqual({})
  })

  it('accepts a plugin-shaped pluginCode only when plugin is absent', () => {
    const details = readSsrDevelopmentErrorDetails(Object.assign(new Error('failed'), {
      pluginCode: 'vite:vue',
      id: '/project/src/HomeHero.vue',
    }))
    expect(details).toEqual({
      plugin: 'vite:vue',
      source: '/project/src/HomeHero.vue',
    })
    expectFileIdentity(details)
  })

  it('does not guess line or column from string loc fields', () => {
    const details = readSsrDevelopmentErrorDetails(Object.assign(new Error('failed'), {
      loc: { file: '/project/src/HomeHero.vue', line: '10', column: '1' },
    }))
    expect(details).toEqual({
      source: '/project/src/HomeHero.vue',
    })
    expectFileIdentity(details)
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
    expect(readSsrDevelopmentErrorDetails(error, { root: '/project' })).toEqual({})
  })
})
