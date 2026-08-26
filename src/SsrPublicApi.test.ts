import { describe, expect, it } from 'vitest'
import * as publicApi from './index'

const UNIVERSAL_EXPORTS = [
  'defineApplication',
  'defineExtension',
  'setResponseRedirect',
  'setResponseStatus',
  'usePublicConfig',
  'useSeo',
  'useSiteOrigin',
]

const HIDDEN_EXPORTS = [
  'createSsrApplication',
  'defineSsrConfig',
  'renderSsrHead',
  'SSR_REQUEST_CONTEXT',
  'useSsrRequestContext',
  'hydrateSsrApplication',
  'renderSsrApplication',
  'createManagedHeadController',
]

describe('universal public API surface', () => {
  it('exposes only the approved hosted-application helpers', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...UNIVERSAL_EXPORTS].sort())
  })

  it('does not publish server or renderer internals from the package root', () => {
    for (const name of HIDDEN_EXPORTS) {
      expect(publicApi).not.toHaveProperty(name)
    }
  })
})
