import { mkdtemp, rm } from 'node:fs/promises'
import { request as requestHttp } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createServer,
  moduleRunnerTransform,
  type DevEnvironment,
  type ViteDevServer,
} from 'vite'
import { ModuleRunner } from 'vite/module-runner'
import { SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { closeViteDevServer } from '../SsrTestFixtures'
import {
  createSsrManagedServer,
  type SsrManagedServer,
} from '../server/SsrServerRuntime'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'

const multiRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/architecture-multi-domain'
)

/** Execute client-compiled modules in Node without using the SSR Vue pipeline. */
const fetchClientModuleForRunner = async (
  environment: DevEnvironment,
  id: string,
  importer?: string,
  options?: { cached?: boolean; startOffset?: number }
) => {
  let fetched: Awaited<ReturnType<DevEnvironment['fetchModule']>> | undefined
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fetched = await environment.fetchModule(id, importer, options)
      break
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('new version of the pre-bundle') || attempt === 7) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
  if (!fetched || !('code' in fetched) || typeof fetched.code !== 'string') {
    return fetched!
  }
  const wrapped = await moduleRunnerTransform(fetched.code, null, fetched.url ?? id, fetched.code)
  if (!wrapped?.code) return fetched
  return { ...fetched, code: wrapped.code }
}

const createBrowserModuleRunner = (environment: DevEnvironment) =>
  new ModuleRunner({
    hmr: false,
    transport: {
      async invoke(payload) {
        const name = (payload as { data?: { name?: string } }).data?.name
        const data = (payload as { data?: { data?: unknown[] } }).data?.data ?? []
        try {
          if (name === 'fetchModule') {
            const [id, importer, options] = data as [
              string,
              string | undefined,
              { cached?: boolean; startOffset?: number } | undefined,
            ]
            return {
              result: await fetchClientModuleForRunner(environment, id, importer, options),
            }
          }
          if (name === 'getBuiltins') {
            return { result: [] }
          }
          return { error: { message: `Unknown runner invoke "${name}"` } }
        } catch (error) {
          return {
            error: {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            },
          }
        }
      },
    },
  })

const readInjectedApplicationId = (html: string): string | undefined => {
  const payload = html.match(
    /<script type="application\/json" id="vue-ssr-lite-domain">([^<]+)<\/script>/
  )?.[1]
  if (!payload) return undefined
  return (JSON.parse(payload) as { applicationId?: string }).applicationId
}

const installDocument = (html: string, path: string) => {
  document.open()
  document.write(html)
  document.close()
  window.history.replaceState({}, '', path)
}

let viteCacheDir = ''
let devServer: ViteDevServer | undefined
let managedServer: SsrManagedServer | undefined

afterEach(async () => {
  await managedServer?.close().catch(() => undefined)
  await closeViteDevServer(devServer)
  if (viteCacheDir) {
    await rm(viteCacheDir, { recursive: true, force: true })
  }
  viteCacheDir = ''
  managedServer = undefined
  devServer = undefined
  document.documentElement.innerHTML = ''
})

describe('multi-domain Admin SPA browser entry', () => {
  it('mounts the host-routed Admin SPA from the generated browser entry', async () => {
    viteCacheDir = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-admin-spa-'))
    devServer = await createServer({
      root: multiRoot,
      configFile: join(multiRoot, 'vite.config.ts'),
      cacheDir: viteCacheDir,
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
    })
    managedServer = await createSsrManagedServer({
      production: false,
      root: multiRoot,
      vite: devServer,
      loadRuntime: () => importSsrViteModule(devServer!, SSR_RUNTIME_VIRTUAL_ID),
    })
    await managedServer.listen()
    const port = managedServer.address().port
    const requestHtml = (path: string, host: string) =>
      new Promise<string>((resolve, reject) => {
        const request = requestHttp(
          {
            hostname: '127.0.0.1',
            port,
            path,
            headers: {
              accept: 'text/html',
              host,
              'x-forwarded-host': host,
            },
          },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk: Buffer) => chunks.push(chunk))
            response.on('end', () => {
              const html = Buffer.concat(chunks).toString('utf8')
              if (response.statusCode !== 200) {
                reject(
                  new Error(
                    `Expected ${host}${path} to succeed; received ${response.statusCode}: ${html}`
                  )
                )
                return
              }
              resolve(html)
            })
          }
        )
        request.on('error', reject)
        request.end()
      })

    const dashboardHtml = await requestHtml('/', 'admin.localhost')
    expect(dashboardHtml).toContain('/@vue-ssr-lite/client/admin')
    expect(dashboardHtml).not.toContain('/@vue-ssr-lite/client/website')
    expect(dashboardHtml).not.toContain('/@vue-ssr-lite/client/docs')
    expect(readInjectedApplicationId(dashboardHtml)).toBe('admin')

    installDocument(dashboardHtml, '/')
    await devServer.environments.client.warmupRequest('/@vue-ssr-lite/client/admin')
    await devServer.environments.client.waitForRequestsIdle()
    const browserRunner = createBrowserModuleRunner(devServer.environments.client)
    try {
      const client = await browserRunner.import<{
        definition: { id: string }
        ready: Promise<{ unmount: () => void } | void>
      }>('/@vue-ssr-lite/client/admin')
      expect(client.definition.id).toBe('admin')
      const mounted = await client.ready
      expect(document.body.textContent).toContain('ADMIN_DASHBOARD_SFC')
      mounted?.unmount()

      const usersHtml = await requestHtml('/users', 'admin.localhost')
      expect(usersHtml).toContain('/@vue-ssr-lite/client/admin')
      expect(readInjectedApplicationId(usersHtml)).toBe('admin')
      installDocument(usersHtml, '/users')
      browserRunner.clearCache()
      const usersClient = await browserRunner.import<{
        definition: { id: string }
        ready: Promise<{ unmount: () => void } | void>
      }>('/@vue-ssr-lite/client/admin')
      const usersMounted = await usersClient.ready
      expect(document.body.textContent).toContain('ADMIN_USERS_SFC')
      usersMounted?.unmount()
    } finally {
      await browserRunner.close().catch(() => undefined)
    }
  }, 60_000)
})
