import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import {
  compileSsrConfig,
  SSR_RUNTIME_VIRTUAL_ID,
} from '../SsrConfigCompileRuntime'
import { vueSsrLite } from './SsrVitePlugin'
import { importSsrViteModule } from './SsrViteModuleRuntime'

let root = ''
let server: ViteDevServer | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-module-runner-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src/main.ts'),
    [
      "export const namedApplication = { root: {}, marker: 'named' }",
      "export default { root: {}, marker: 'default' }",
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'ssr.config.mjs'),
    [
      'export default {',
      '  server: { port: 0 },',
      '  application: {',
      "    module: './src/main.ts',",
      "    exportName: 'namedApplication',",
      '  },',
      '}',
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><body><div id="app"></div></body></html>'
  )
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    future: { removeSsrLoadModule: 'warn' },
    plugins: [vueSsrLite({ root })],
    server: {
      middlewareMode: true,
      hmr: { server: createHttpServer() },
    },
    appType: 'custom',
  })
})

afterEach(async () => {
  await server?.close()
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('Vite SSR ModuleRunner imports', () => {
  it('delegates to the Vite-owned SSR runner and returns its namespace', async () => {
    const namespace = { marker: 'module namespace' }
    const importModule = vi
      .spyOn(server!.environments.ssr.runner, 'import')
      .mockResolvedValueOnce(namespace)

    await expect(importSsrViteModule(server!, '/src/main.ts')).resolves.toBe(
      namespace
    )
    expect(importModule).toHaveBeenCalledOnce()
    expect(importModule).toHaveBeenCalledWith('/src/main.ts')
  })

  it('rejects a non-runnable SSR environment without a legacy fallback', async () => {
    const nonRunnableServer = {
      environments: { ssr: server!.environments.client },
    } as unknown as ViteDevServer

    await expect(
      importSsrViteModule(nonRunnableServer, '/src/main.ts')
    ).rejects.toThrow(
      'requires a Vite RunnableDevEnvironment for the "ssr" environment'
    )
  })

  it('preserves errors thrown by the runner', async () => {
    const moduleError = new Error('application module evaluation failed')
    vi.spyOn(server!.environments.ssr.runner, 'import').mockRejectedValueOnce(
      moduleError
    )

    await expect(
      importSsrViteModule(server!, '/src/main.ts')
    ).rejects.toBe(moduleError)
  })

  it('imports application default and named exports through ModuleRunner', async () => {
    const applicationModule = await importSsrViteModule<{
      default: { marker: string }
      namedApplication: { marker: string }
    }>(server!, '/src/main.ts')

    expect(applicationModule.default.marker).toBe('default')
    expect(applicationModule.namedApplication.marker).toBe('named')
  })

  it('supplies relative application modules to config compilation unchanged', async () => {
    const compiled = await compileSsrConfig(
      {
        server: { port: 0 },
        application: {
          module: './src/main.ts',
          exportName: 'namedApplication',
        },
      },
      {
        development: true,
        root,
        importModule: (specifier) => importSsrViteModule(server!, specifier),
      }
    )

    expect(compiled.applications[0].application).toMatchObject({
      marker: 'named',
    })
  })

  it('evaluates the virtual SSR runtime through the plugin pipeline', async () => {
    const runtime = await importSsrViteModule<{
      default: () => Promise<{
        app: { marker: string }
        __vueSsrLiteViteBase: string
      }>
    }>(server!, SSR_RUNTIME_VIRTUAL_ID)

    await expect(runtime.default()).resolves.toMatchObject({
      app: { marker: 'named' },
      __vueSsrLiteViteBase: '/',
    })
  })

  it('observes an updated module after Vite handles its file change', async () => {
    const modulePath = join(root, 'src/hmr.ts')
    const hmrModule = (revision: string) =>
      [
        `export const revision = ${JSON.stringify(revision)}`,
        ';(globalThis as any).__VUE_SSR_LITE_HMR_TEST__?.(revision)',
        'if (import.meta.hot) import.meta.hot.accept()',
        '',
      ].join('\n')
    await writeFile(modulePath, hmrModule('before'))
    await expect(
      importSsrViteModule<{ revision: string }>(server!, '/src/hmr.ts')
    ).resolves.toMatchObject({ revision: 'before' })

    const hmrProcessed = new Promise<void>((resolveUpdate) => {
      ;(
        globalThis as typeof globalThis & {
          __VUE_SSR_LITE_HMR_TEST__?: (revision: string) => void
        }
      ).__VUE_SSR_LITE_HMR_TEST__ = (revision) => {
        if (revision === 'after') resolveUpdate()
      }
    })
    await writeFile(modulePath, hmrModule('after'))
    await hmrProcessed
    delete (
      globalThis as typeof globalThis & {
        __VUE_SSR_LITE_HMR_TEST__?: (revision: string) => void
      }
    ).__VUE_SSR_LITE_HMR_TEST__

    await expect(
      importSsrViteModule<{ revision: string }>(server!, '/src/hmr.ts')
    ).resolves.toMatchObject({ revision: 'after' })
  })
})
