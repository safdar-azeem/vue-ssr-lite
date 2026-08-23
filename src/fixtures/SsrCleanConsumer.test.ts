import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
  normalizeSsrConfig,
  resolveSsrConfigPath,
} from '../SsrConfigCompileRuntime'
import { vueSsrLite } from '../vite/SsrVitePlugin'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/clean-consumer'
)

describe('zero-config clean consumer fixture', () => {
  it('discovers standard Vue files without ssr.config', async () => {
    expect(await resolveSsrConfigPath(fixtureRoot)).toBeUndefined()
    const config = await loadSsrConfigFile(fixtureRoot)
    const normalized = normalizeSsrConfig(config, { root: fixtureRoot })
    expect(normalized.applications.app).toMatchObject({
      id: 'app',
      render: 'ssr',
      template: './index.html',
      mountSelector: '#app',
      hosts: ['*'],
    })
    expect(normalized.applications.app.application).toEqual({
      module: './src/main.ts',
    })
  })

  it('generates the default SSR browser and server entries', async () => {
    const config = await loadSsrConfigFile(fixtureRoot)
    const entries = extractSsrViteEntries(config, { root: fixtureRoot })
    expect(entries.applications).toEqual([
      expect.objectContaining({
        id: 'app',
        kind: 'ssr',
        definition: './src/main.ts',
        template: './index.html',
        mountSelector: '#app',
      }),
    ])
    const client = generateSsrClientModule(fixtureRoot, entries.applications[0])
    expect(client).toContain('hydrateSsrApplication')
    expect(client).toContain('/src/main.ts')
    const runtime = generateSsrRuntimeModule(
      fixtureRoot,
      undefined,
      entries.applications
    )
    expect(runtime).toContain('const config = {}')
    expect(runtime).toContain('/src/main.ts')
    expect(runtime).not.toContain('ssr.config')
  })

  it('replaces only main.ts while preserving other module scripts', async () => {
    const plugin = vueSsrLite({ root: fixtureRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') throw new Error('Missing config hook.')
    await configHook.call(
      {} as never,
      { root: fixtureRoot },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )
    const transform = plugin.transformIndexHtml
    if (!transform || typeof transform === 'function' || !transform.handler) {
      throw new Error('Missing HTML transform.')
    }
    const source = `${await readFile(join(fixtureRoot, 'index.html'), 'utf8')}\n<script type="module" src="/analytics.ts"></script>`
    const result = transform.handler.call(
      {} as never,
      source,
      {
        path: '/index.html',
        filename: join(fixtureRoot, 'index.html'),
      } as never
    )
    const html = typeof result === 'string' ? result : String(result?.html || '')
    expect(html).not.toContain('/src/main.ts')
    expect(html).toContain('/analytics.ts')
    expect(JSON.stringify(typeof result === 'object' ? result.tags : [])).toContain(
      'virtual:vue-ssr-lite/client/app'
    )
  })
})
