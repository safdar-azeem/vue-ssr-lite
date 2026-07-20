import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  compileSsrConfig,
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
} from '../SsrConfigCompileRuntime'
import { vueSsrLite } from '../vite/SsrVitePlugin'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/clean-consumer'
)

describe('clean-consumer fixture', () => {
  it('loads ssr.config and extracts a single SPA Vite entry', async () => {
    const config = await loadSsrConfigFile(fixtureRoot)
    expect(config.name).toBe('clean-consumer')
    const entries = extractSsrViteEntries(config)
    expect(entries.applications).toHaveLength(1)
    expect(entries.applications[0]).toMatchObject({
      id: 'app',
      kind: 'spa',
      template: 'index.html',
      definition: './src/AppApplication.ts',
    })
  })

  it('defaults plugin client outDir to dist/client', async () => {
    const plugin = vueSsrLite({ root: fixtureRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    const config = (await configHook.call(
      {} as never,
      { root: fixtureRoot },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )) as { build?: { outDir?: string } }
    expect(config.build?.outDir).toBe('dist/client')
  })

  it('injects the virtual client and keeps the HTML shell free of bootstrap scripts', async () => {
    const plugin = vueSsrLite({ root: fixtureRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
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
      throw new Error('vueSsrLite must expose transformIndexHtml.')
    }
    const source = await readFile(join(fixtureRoot, 'index.html'), 'utf8')
    const result = transform.handler.call(
      {} as never,
      `${source}\n<script type="module" src="/src/main.ts"></script>\n`,
      {
        path: '/index.html',
        filename: join(fixtureRoot, 'index.html'),
      } as never
    )
    const htmlOut =
      typeof result === 'string'
        ? result
        : result && typeof result === 'object' && 'html' in result
          ? String(result.html)
          : ''
    expect(htmlOut).not.toContain('main.ts')
    const tags =
      result && typeof result === 'object' && 'tags' in result
        ? result.tags
        : []
    expect(JSON.stringify(tags)).toContain('virtual:vue-ssr-lite/client/app')
  })

  it('generates a SPA client entry and a runtime that imports no SPA module', async () => {
    const config = await loadSsrConfigFile(fixtureRoot)
    const entries = extractSsrViteEntries(config)
    const client = generateSsrClientModule(fixtureRoot, entries.applications[0])
    expect(client).toContain('mountSpaApplication')
    expect(client).toContain('AppApplication.ts')

    const runtime = generateSsrRuntimeModule(
      fixtureRoot,
      join(fixtureRoot, 'ssr.config.mjs'),
      entries.applications
    )
    expect(runtime).toContain('ssr.config.mjs')
    expect(runtime).not.toContain('AppApplication')
    expect(runtime).not.toContain('mountSpaApplication')
  })

  it('production compile requires runtime and domain.production, not publicConfig.api', async () => {
    await expect(
      compileSsrConfig(
        {
          default: {
            name: 'clean-consumer',
            applications: {
              app: {
                render: 'spa',
                application: {
                  module: './src/AppApplication.ts',
                  exportName: 'appApplication',
                },
                template: 'index.html',
                domain: {
                  development: 'localhost',
                  production: 'app.example.com',
                },
              },
            },
          },
        },
        { development: false, root: fixtureRoot }
      )
    ).rejects.toThrow(/requires `runtime`/)

    await expect(
      compileSsrConfig(
        {
          default: {
            name: 'clean-consumer',
            runtime: 'unified',
            applications: {
              app: {
                render: 'spa',
                application: {
                  module: './src/AppApplication.ts',
                  exportName: 'appApplication',
                },
                template: 'index.html',
                domain: {
                  development: 'localhost',
                  production: '',
                },
              },
            },
          },
        },
        { development: false, root: fixtureRoot }
      )
    ).rejects.toThrow(/requires domain.production/)

    const compiled = await compileSsrConfig(
      {
        default: {
          name: 'clean-consumer',
          runtime: 'unified',
          applications: {
            app: {
              render: 'spa',
              application: {
                module: './src/AppApplication.ts',
                exportName: 'appApplication',
              },
              template: 'index.html',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
              },
              publicConfig: { greeting: 'hello' },
            },
          },
        },
      },
      { development: false, root: fixtureRoot }
    )
    expect(compiled.server.role).toBe('unified')
    expect(compiled.applications[0]?.publicConfig).toEqual({ greeting: 'hello' })
  })
})
