import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeSsrConfig } from '../../SsrConfigCompileRuntime'
import { serializeSsrProductionAssetMetadata } from '../../SsrAssetMetadata'
import { createDeploymentMetadata, type DeploymentMetadata } from '../DeploymentMetadata'
import { collectDeploymentStaticAssets } from '../DeploymentAssets'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })

const metadata = (overrides: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  version: 1, viteBase: '/', templates: ['index.html'], dynamicAssets: false,
  serverRouteMatchers: [], controlPaths: ['/healthz', '/readyz'], ...overrides,
})

const client = async () => {
  root = await mkdtemp(join(tmpdir(), 'ssr-deployment-assets-'))
  const files: Record<string, string> = {
    'index.html': 'private template', '.vue-ssr-lite/admin.html': 'private admin template',
    '.vite/manifest.json': JSON.stringify({ main: { file: 'assets/main-123.js', css: ['assets/main-123.css'] },
      lazy: { file: 'assets/lazy-456.js', css: ['assets/lazy-456.css'] } }),
    '.vite/ssr-manifest.json': '{}',
    '.vite/vue-ssr-lite-assets.json': serializeSsrProductionAssetMetadata(['assets/main-123.js', 'assets/main-123.css', 'assets/lazy-456.js', 'assets/lazy-456.css']),
    'assets/main-123.js': 'main', 'assets/main-123.css': 'main styles',
    'assets/lazy-456.js': 'lazy', 'assets/lazy-456.css': 'lazy styles',
    'favicon.ico': 'icon', 'public-image.png': 'image', 'assets/public-789.js': 'mutable public copy',
    'robots.txt': 'robots must enter Core', 'sitemap.xml': 'sitemap must enter Core',
    '.env': 'secret', 'server/SsrRuntime.js': 'private runtime', 'private.ts': 'private source',
    'assets/main-123.js.map': 'source map', '_redirects': 'provider directives',
    'nested/.vite/manifest.json': 'nested private metadata', 'guide.html': 'runtime-served document',
  }
  for (const [file, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), source)
  }
  return root
}

describe('static deployment boundary', () => {
  it('projects only public assets and preserves authoritative cache policy and Vite base', async () => {
    const assets = await collectDeploymentStaticAssets(await client(), metadata({ viteBase: '/app/' }))
    expect(assets.map((asset) => asset.pathname)).toEqual([
      '/app/assets/lazy-456.css', '/app/assets/lazy-456.js', '/app/assets/main-123.css',
      '/app/assets/main-123.js', '/app/assets/public-789.js', '/app/favicon.ico', '/app/public-image.png',
    ])
    expect(assets.find((asset) => asset.file === 'assets/main-123.js')?.cacheControl).toContain('immutable')
    expect(assets.find((asset) => asset.file === 'assets/public-789.js')?.cacheControl).not.toContain('immutable')
  })

  it('does not let static files shadow middleware, server routes, or framework controls', async () => {
    const directory = await client()
    const assets = await collectDeploymentStaticAssets(directory, metadata({
      serverRouteMatchers: ['^/assets/([^/]+)$'], controlPaths: ['/favicon.ico', '/readyz'],
    }))
    expect(assets.map((asset) => asset.file)).toEqual(['public-image.png'])
    expect(await collectDeploymentStaticAssets(directory, metadata({ dynamicAssets: true }))).toEqual([])
  })

  it('refuses links out of the build rather than publishing their targets', async () => {
    const directory = await client()
    await symlink(join(directory, '.env'), join(directory, 'secret.txt'))
    await expect(collectDeploymentStaticAssets(directory, metadata())).rejects.toThrow(/symbolic links/)
  })

  it('derives dynamic ownership with Core and never serializes handlers or private config', () => {
    const config = normalizeSsrConfig({
      publicConfig: { safe: true },
      serverRoutes: [{ prefix: '/api', routes: { '/:id': { GET: () => new Response('private-secret') } } }],
    })
    const projection = createDeploymentMetadata(config, '/')
    expect(projection.serverRouteMatchers).toHaveLength(1)
    expect(new RegExp(projection.serverRouteMatchers[0]!).test('/api/example')).toBe(true)
    expect(projection.dynamicAssets).toBe(false)
    expect(JSON.stringify(projection)).not.toMatch(/private-secret|publicConfig|GET/)
  })
})
