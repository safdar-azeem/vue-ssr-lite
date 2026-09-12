import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { SSR_CONFLICTING_CONFIG_IDENTITY, SSR_RUNTIME_VIRTUAL_ID } from '../SsrConfigCompileRuntime'
import { closeViteDevServer, provisionHostVuePeers } from '../SsrTestFixtures'
import { createSsrManagedServer, type SsrManagedServer } from '../server/SsrServerRuntime'
import { importSsrViteModule } from '../vite/SsrViteModuleRuntime'
import { readSsrViteResolvedConfigPath } from '../vite/SsrViteResolvedConfigPath'
import { resolveSsrCliHmrPort } from './SsrCliHmrPort'
import { parseSsrCliArguments } from './SsrCliOptions'
import { createSsrCliDevelopmentViteConfig } from './SsrCliVite'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const PLUGIN_HREF = pathToFileURL(join(REPO_ROOT, 'src/vite/SsrVitePlugin.ts')).href
const HOME = 'src/modules/website/Home.vue'

let root = ''
let vite: ViteDevServer | undefined
let managed: SsrManagedServer | undefined

afterEach(async () => {
  await managed?.close()
  managed = undefined
  await closeViteDevServer(vite)
  vite = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const linkPackage = async (name: string, from = join(REPO_ROOT, 'node_modules', name)) => {
  const target = join(root, 'node_modules', name)
  await mkdir(dirname(target), { recursive: true })
  try {
    await symlink(from, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

const writeConsumerProject = async (pluginConfig = '') => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-cli-dev-config-'))
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'src/modules/website'), { recursive: true })
  await mkdir(join(root, 'node_modules/vue-ssr-lite'), { recursive: true })
  await provisionHostVuePeers(root)
  await linkPackage('vite')
  await linkPackage('@vitejs/plugin-vue')
  await writeFile(
    join(root, 'node_modules/vue-ssr-lite/package.json'),
    '{"name":"vue-ssr-lite","type":"module","exports":{".":"./index.js","./client":"./client.js"}}\n'
  )
  await writeFile(
    join(root, 'node_modules/vue-ssr-lite/index.js'),
    'export const defineApplication = (config) => config\n'
  )
  await writeFile(
    join(root, 'node_modules/vue-ssr-lite/client.js'),
    'export const hydrateSsrApplication = () => {}\nexport const mountSpaApplication = () => {}\n'
  )
  await writeFile(join(root, 'package.json'), '{"private":true,"type":"module"}\n')
  await writeFile(
    join(root, 'vite.config.ts'),
    [
      "import { defineConfig } from 'vite'",
      "import vue from '@vitejs/plugin-vue'",
      `import { vueSsrLite } from ${JSON.stringify(PLUGIN_HREF)}`,
      'export default defineConfig({',
      `  plugins: [vueSsrLite(${pluginConfig}), vue()],`,
      '})',
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'index.html'),
    '<html><head></head><body><div id="app"></div></body></html>\n'
  )
  await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
  await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
  await writeFile(
    join(root, HOME),
    '<template><div>home</div></template>\n<template><div>duplicate</div></template>\n'
  )
  await writeFile(
    join(root, 'src/modules/website/routes.ts'),
    "import Home from './Home.vue'\nexport default [{ path: '/', component: Home }]\n"
  )
  await writeFile(
    join(root, 'src/modules/website/app.ts'),
    [
      "import { defineApplication } from 'vue-ssr-lite'",
      "import routes from './routes'",
      "export default defineApplication({ name: 'website', routes })",
      '',
    ].join('\n')
  )
  await writeFile(
    join(root, 'server.ts'),
    'export default { server: { host: "0.0.0.0", port: 4173, diagnostics: true } }\n'
  )
  await writeFile(
    join(root, 'config/platform.ts'),
    [
      "import website from '../src/modules/website/app'",
      'export default {',
      "  server: { host: '127.0.0.1', port: 0, diagnostics: true },",
      '  applications: [website],',
      '}',
      '',
    ].join('\n')
  )
}

const exchange = (path = '/') =>
  new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port: managed!.address().port,
      path,
      method: 'GET',
      agent: false,
      headers: { accept: 'text/html' },
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('error', reject)
      response.on('end', () => resolveResponse({
        status: response.statusCode!,
        body,
      }))
    })
    req.on('error', reject)
    req.end()
  })

describe('vue-ssr-lite dev --config', () => {
  it('makes the CLI config authoritative for the Vite runtime and failed-startup control plane', async () => {
    await writeConsumerProject()
    const cli = await parseSsrCliArguments([
      'dev',
      '--root',
      root,
      '--config',
      'config/platform.ts',
    ])
    const platform = resolve(cli.root, 'config/platform.ts')
    expect(cli.cliConfig).toBe(platform)
    const hmrPort = await resolveSsrCliHmrPort()
    vite = await createServer({
      ...createSsrCliDevelopmentViteConfig(cli, hmrPort),
      configFile: join(cli.root, 'vite.config.ts'),
      logLevel: 'silent',
    })
    expect(readSsrViteResolvedConfigPath(vite)).toBe(platform)
    const runtime = await vite.environments.ssr.pluginContainer.load(
      `\0${SSR_RUNTIME_VIRTUAL_ID}`
    )
    const code = typeof runtime === 'string' ? runtime : runtime && 'code' in runtime
      ? runtime.code
      : ''
    expect(code).toContain('config/platform.ts')
    expect(code).not.toMatch(/from ["'][^"']+\/server\.ts["']/)
    managed = await createSsrManagedServer({
      production: false,
      root: cli.root,
      config: cli.config,
      vite,
      loadRuntime: () => importSsrViteModule(vite!, SSR_RUNTIME_VIRTUAL_ID),
    })
    await managed.listen()
    expect(managed.address().host).toBe('127.0.0.1')
    const port = managed.address().port
    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(4173)
    const failed = await exchange('/')
    expect(failed.status).toBe(500)
    expect(failed.body).toContain('Application error')
    await writeFile(
      join(cli.root, HOME),
      '<template><div>home</div></template>\n'
    )
    const graph = vite.environments.ssr.moduleGraph
    for (const module of graph.urlToModuleMap.values()) {
      if (module.file?.includes('Home.vue') || module.id.includes('Home.vue')) {
        graph.invalidateModule(module)
      }
    }
    await expect.poll(async () => (await exchange('/')).status, {
      timeout: 8_000,
      interval: 150,
    }).toBe(200)
    expect(managed.address().port).toBe(port)
  }, 20_000)

  it('rejects conflicting explicit CLI and plugin config paths during Vite startup', async () => {
    await writeConsumerProject("{ config: './server.ts' }")
    const cli = await parseSsrCliArguments([
      'dev',
      '--root',
      root,
      '--config',
      'config/platform.ts',
    ])
    const hmrPort = await resolveSsrCliHmrPort()
    await expect(
      createServer({
        ...createSsrCliDevelopmentViteConfig(cli, hmrPort),
        configFile: join(cli.root, 'vite.config.ts'),
        logLevel: 'silent',
      })
    ).rejects.toThrow(SSR_CONFLICTING_CONFIG_IDENTITY)
  }, 20_000)
})
