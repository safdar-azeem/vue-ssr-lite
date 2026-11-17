import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build as viteBuild } from 'vite'
import {
  createCloudflareAssetHeaders,
  createCloudflareWranglerConfig,
  isCloudflareEmbeddedClientFile,
  promoteCloudflareOutput,
  resolveCloudflareAssetRouting,
} from '../../../src/deployment/cloudflare/CloudflareBuild'
import { assertSupportedDeploymentEnvironment, resolveDeploymentTarget } from '../../../src/deployment/DeploymentEnvironment'
import { createDeploymentBuild, readExplicitDeploymentTarget } from '../../../src/deployment/DeploymentRuntime'
import { parseSsrCliArguments } from '../../../src/cli/SsrCliOptions'
import type { DeploymentMetadata } from '../../../src/deployment/DeploymentMetadata'

const execFileAsync = promisify(execFile)
const repository = resolve(__dirname, '../../..')
const example = resolve(repository, 'examples/5-cloudflare-workers')

const metadata = (dynamicAssets: boolean): DeploymentMetadata => ({
  version: 1, viteBase: '/', templates: ['index.html'], dynamicAssets, serverRouteMatchers: [], controlPaths: ['/healthz', '/readyz'],
})
const asset = (pathname: string, seo = false) => ({
  file: pathname.slice(1), pathname, seo,
  cacheControl: pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  contentType: 'text/javascript; charset=utf-8',
})

describe('Cloudflare target selection', () => {
  it('is explicit and never inferred from the environment', () => {
    expect(resolveDeploymentTarget(undefined, {})).toBe('node')
    expect(resolveDeploymentTarget(undefined, { CF_PAGES: '1', WORKERS_CI: '1' })).toBe('node')
    expect(resolveDeploymentTarget(undefined, { VERCEL: '1', VERCEL_ENV: 'production' })).toBe('vercel')
    expect(resolveDeploymentTarget('cloudflare', { VERCEL: '1', VERCEL_ENV: 'production' })).toBe('cloudflare')
  })

  it('lets an explicit target override Netlify detection while ordinary Netlify builds stay blocked', () => {
    const netlify = { NETLIFY: 'true' }
    expect(() => assertSupportedDeploymentEnvironment(resolveDeploymentTarget(undefined, netlify))).toThrow(/Netlify deployment is not supported/)
    const explicit = createDeploymentBuild('/app', netlify, 'cloudflare')
    expect(readExplicitDeploymentTarget(explicit.plugins)).toBe('cloudflare')
    // The SSR Vite build carries the same explicit target.
    expect(readExplicitDeploymentTarget([[explicit.serverPlugins]])).toBe('cloudflare')
    expect(() => assertSupportedDeploymentEnvironment(resolveDeploymentTarget(
      readExplicitDeploymentTarget(explicit.serverPlugins), netlify
    ))).not.toThrow()
    // Ordinary builds add no plugin and keep provider detection.
    const ordinary = createDeploymentBuild('/app', {})
    expect(ordinary.serverPlugins).toEqual([])
    expect(readExplicitDeploymentTarget(ordinary.plugins)).toBeUndefined()
  })

  it('parses --target only for build and rejects unknown or conflicting targets', async () => {
    const root = resolve(repository, 'examples/5-cloudflare-workers')
    await expect(parseSsrCliArguments(['build', '--root', root, '--target', 'cloudflare'])).resolves.toMatchObject({ target: 'cloudflare' })
    await expect(parseSsrCliArguments(['build', '--root', root, '--target=cloudflare'])).resolves.toMatchObject({ target: 'cloudflare' })
    const ordinary = await parseSsrCliArguments(['build', '--root', root])
    expect(ordinary).not.toHaveProperty('target')
    await expect(parseSsrCliArguments(['build', '--root', root, '--target', 'netlify'])).rejects.toThrow(/Unsupported deployment target/)
    await expect(parseSsrCliArguments(['build', '--root', root, '--target', 'cloudflare', '--target', 'vercel'])).rejects.toThrow(/Conflicting deployment targets/)
    await expect(parseSsrCliArguments(['dev', '--root', root, '--target', 'cloudflare'])).rejects.toThrow(/only supported by `vue-ssr-lite build`/)
  })
})

describe('Cloudflare artifact projection', () => {
  it('embeds only private templates and build metadata', () => {
    expect(isCloudflareEmbeddedClientFile('index.html')).toBe(true)
    expect(isCloudflareEmbeddedClientFile('.vite/manifest.json')).toBe(true)
    expect(isCloudflareEmbeddedClientFile('.vue-ssr-lite/app.html')).toBe(true)
    expect(isCloudflareEmbeddedClientFile('assets/app.js')).toBe(false)
    expect(isCloudflareEmbeddedClientFile('assets/app.js.map')).toBe(false)
  })

  it('routes everything through the Worker when middleware can intercept assets', () => {
    expect(resolveCloudflareAssetRouting(metadata(true), [asset('/assets/a.js')])).toEqual({ runWorkerFirst: true, directAssets: [] })
  })

  it('serves static files directly with Core cache headers and keeps SEO files Worker-owned', () => {
    const routing = resolveCloudflareAssetRouting(metadata(false), [asset('/assets/a.js'), asset('/robots.txt', true)])
    expect(routing.runWorkerFirst).toEqual(['/robots.txt'])
    expect(routing.directAssets.map((item) => item.pathname)).toEqual(['/assets/a.js'])
    expect(createCloudflareAssetHeaders(routing.directAssets)).toBe(
      '/assets/a.js\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n'
    )
  })

  it('falls back to Worker-first routing beyond the _headers rule limit', () => {
    const many = Array.from({ length: 101 }, (_, index) => asset(`/assets/${index}.js`))
    expect(resolveCloudflareAssetRouting(metadata(false), many).runWorkerFirst).toBe(true)
  })

  it('never lets Cloudflare substitute an SPA fallback for unknown paths', () => {
    const config = createCloudflareWranglerConfig({ name: 'demo', runWorkerFirst: false })
    expect(config.assets).toMatchObject({ not_found_handling: 'none', html_handling: 'none', binding: 'ASSETS', directory: 'assets' })
    expect(config.compatibility_flags).toContain('nodejs_compat')
    expect(config.no_bundle).toBe(true)
  })
})

describe('Cloudflare output promotion', () => {
  it('restores the previous valid output when promotion fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-cloudflare-promote-'))
    try {
      const output = join(workspace, 'cloudflare')
      const stage = join(workspace, 'stage')
      await mkdir(output); await writeFile(join(output, 'worker.mjs'), 'previous')
      await mkdir(stage); await writeFile(join(stage, 'worker.mjs'), 'next')
      const failing = async (from: string, to: string) => {
        if (from === stage) throw Object.assign(new Error('EIO'), { code: 'EIO' })
        await rename(from, to)
      }
      await expect(promoteCloudflareOutput(stage, output, failing)).rejects.toThrow('EIO')
      expect(await readFile(join(output, 'worker.mjs'), 'utf8')).toBe('previous')
      await promoteCloudflareOutput(stage, output)
      expect(await readFile(join(output, 'worker.mjs'), 'utf8')).toBe('next')
      expect((await readdir(workspace)).sort()).toEqual(['cloudflare'])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

// Required, never skipped: builds the package from source and links only root
// dependencies, so a fresh `npm install && npm test` exercises the real Worker.
describe('generated Worker (examples/5-cloudflare-workers sources)', () => {
  let workspace = ''
  let consumer = ''
  let packageRoot = ''
  beforeAll(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'vue-ssr-lite-cloudflare-worker-')))
    consumer = join(workspace, 'consumer')
    packageRoot = join(workspace, 'vue-ssr-lite')
    await mkdir(packageRoot, { recursive: true })
    await cp(join(repository, 'package.json'), join(packageRoot, 'package.json'))
    await viteBuild({
      root: repository, configFile: join(repository, 'vite.config.ts'), logLevel: 'silent',
      build: { outDir: join(packageRoot, 'dist'), emptyOutDir: true },
    })
    await symlink(join(repository, 'node_modules'), join(packageRoot, 'node_modules'), 'junction')
    await cp(example, consumer, {
      recursive: true,
      filter: (source) => !/[\\/](?:node_modules|dist)(?:[\\/]|$)/.test(relative(example, source)) &&
        !/^(?:node_modules|dist)$/.test(relative(example, source)),
    })
    const link = async (name: string, source: string) => {
      const destination = join(consumer, 'node_modules', ...name.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await symlink(source, destination, 'junction')
    }
    for (const name of ['vue', 'vue-router', 'vite', '@vitejs/plugin-vue', '@vue']) {
      await link(name, join(repository, 'node_modules', name))
    }
    await link('vue-ssr-lite', packageRoot)
  }, 240_000)
  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true })
  })

  it('builds a self-contained Worker and serves SSR, APIs, assets and isolation', async () => {
    await execFileAsync(process.execPath, [join(packageRoot, 'dist/cli.mjs'), 'build', '--root', consumer, '--target', 'cloudflare'], {
      // A detected Netlify environment must not block an explicit Cloudflare target (N-2).
      cwd: consumer, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NETLIFY: 'true' },
    })
    const output = join(consumer, 'dist/cloudflare')
    const config = JSON.parse(await readFile(join(output, 'wrangler.json'), 'utf8'))
    expect(config.main).toBe('worker.mjs')

    // No private artifact is uploaded as a public asset.
    const walk = async (directory: string): Promise<string[]> => (await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) => entry.isDirectory()
        ? walk(join(directory, entry.name)) : [join(directory, entry.name)])
    )).flat()
    const uploaded = (await walk(join(output, 'assets'))).map((file) => relative(join(output, 'assets'), file))
    expect(uploaded.some((file) => /\.(?:html|map)$|^\.vite\/|^server\//.test(file))).toBe(false)
    expect(uploaded).toContain('logo.svg')

    // The only non-relative imports left are Workers-provided node: modules.
    const source = await readFile(join(output, 'worker.mjs'), 'utf8')
    const imports = [...source.matchAll(/(?:^|[;}\n])import\s*(?:[\w$*{][^;"]*?from\s*)?"([^"]+)"/g)].map((match) => match[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter((specifier) => !specifier!.startsWith('node:'))).toEqual([])

    const worker = (await import(`${pathToFileURL(join(output, 'worker.mjs')).href}?t=${Date.now()}`)).default
    const files = new Map(uploaded.map((file) => [`/${file}`, join(output, 'assets', file)]))
    const env = {
      DEMO_GREETING: 'from-test',
      ASSETS: {
        async fetch(request: Request) {
          const file = files.get(new URL(request.url).pathname)
          return file ? new Response(await readFile(file)) : new Response(null, { status: 404 })
        },
      },
    }
    const ctx = { waitUntil() {} }
    const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://demo.example.com${path}`, init), env, ctx)

    const home = await get('/', { headers: { 'x-forwarded-host': 'evil.example', forwarded: 'host=evil.example' } })
    const html = await home.text()
    expect(home.status).toBe(200)
    expect(home.headers.get('x-demo-middleware')).toBe('global')
    expect(html).toContain('Hello from a server route (cloudflare)')
    expect(html).toContain('Greeting binding: from-test')
    expect(html).toContain('href="https://demo.example.com/"')
    expect(html).not.toContain('evil.example')

    expect((await get('/posts/hello-workers')).status).toBe(200)
    const missing = await get('/posts/missing')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('Post not found')
    // An upstream failure is a service error, never a not-found page.
    const outage = await get('/posts/simulate-outage')
    expect(outage.status).toBe(503)
    const outageHtml = await outage.text()
    expect(outageHtml).toContain('Post unavailable')
    expect(outageHtml).not.toContain('Post not found')
    expect((await get('/nope')).status).toBe(404)
    const spa = await get('/dashboard/settings')
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('<!--vue-ssr-lite:html-->')
    const redirect = await get('/old-home')
    expect(redirect.status).toBe(301)
    expect(redirect.headers.get('location')).toBe('https://demo.example.com/')

    const logo = await get('/logo.svg')
    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toMatch(/image\/svg\+xml/)
    for (const path of ['/index.html', '/.vite/manifest.json', '/assets/missing.js']) {
      const response = await get(path)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).not.toMatch(/text\/html/)
    }

    const cookies = await get('/api/cookies')
    expect(cookies.headers.getSetCookie()).toHaveLength(2)
    const echo = await get('/api/echo', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
    expect(await echo.json()).toEqual({ received: { a: 1 }, method: 'POST' })
    expect((await get('/api/echo', { method: 'POST', body: 'not json' })).status).toBe(400)
    expect((await get('/robots.txt')).status).toBe(200)
    expect(await (await get('/sitemap.xml')).text()).toContain('<loc>https://demo.example.com/posts/hello-workers</loc>')

    const ids = Array.from({ length: 24 }, (_, index) => `user-${index}`)
    const pages = await Promise.all(ids.map(async (id) => (await get(`/isolation?id=${id}`)).text()))
    pages.forEach((page, index) => expect(page).toContain(`query=${ids[index]} fetched=${ids[index]}<`))
  }, 240_000)
})
