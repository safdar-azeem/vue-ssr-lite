import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { createSsrProductionViteBuildOptions } from './SsrCliBuildOptions'

describe('createSsrProductionViteBuildOptions', () => {
  it('keeps the SSR virtual entry on rollupOptions.input (not build.ssr string)', () => {
    const root = '/tmp/ssr-app'
    const options = createSsrProductionViteBuildOptions(root)

    expect(options.build.ssr).toBe(true)
    expect(options.build.rollupOptions.input).toBe(SSR_RUNTIME_VIRTUAL_ID)
    expect(options.build.outDir).toBe(resolve(root, 'dist/server'))
    expect(options.build.rollupOptions.output.entryFileNames).toBe(
      'SsrRuntime.js'
    )
  })
})
