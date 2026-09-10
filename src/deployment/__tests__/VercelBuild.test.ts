import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { nodeFileTrace } from '@vercel/nft'
import { buildVercelDeployment, createVercelRouting } from '../vercel/VercelBuild'
import { deploymentFiles } from '../DeploymentAssets'
import { DEPLOYMENT_METADATA_PATH } from '../DeploymentMetadata'

// Projection tests exercise filesystem/routing assembly without invoking a
// compiler or repeating Vite's consumer-build test suite.
vi.mock('esbuild', () => ({ build: vi.fn() }))
vi.mock('@vercel/nft', () => ({ nodeFileTrace: vi.fn() }))

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ''; vi.clearAllMocks() })

describe('Vercel Build Output API projection', () => {
  it.each([false, true])('preserves Core runtime files and respects CDN ownership with dynamicAssets=%s', async (dynamicAssets) => {
    root = await mkdtemp(join(tmpdir(), 'ssr-vercel-build-'))
    const clientRoot = join(root, 'dist/client')
    const serverOutput = join(root, 'dist/server/SsrRuntime.js')
    const files: Record<string, string> = {
      'package.json': '{"type":"module"}',
      'dist/server/SsrRuntime.js': 'import data from "../client/runtime-shared.json" with { type: "json" }; export default () => ({ data })',
      'dist/server/chunks/lazy.js': 'export const lazy = true',
      'dist/client/index.html': '<div id="app">private template</div>',
      'dist/client/assets/main.js': 'client javascript',
      'dist/client/assets/lazy.js': 'lazy browser chunk',
      'dist/client/assets/main.css': 'body {}',
      'dist/client/images/logo.svg': '<svg/>',
      'dist/client/favicon.ico': 'icon',
      'dist/client/runtime-shared.json': '{"serverReadsThis":true}',
      'dist/client/.vue-ssr-lite/dashboard.html': '<div id="app">dashboard shell</div>',
      'dist/client/robots.txt': 'User-agent: *\nDisallow: /private\n',
      'dist/client/sitemap.xml': '<urlset/>',
      'dist/client/api/owned.js': 'route-owned asset',
      'dist/client/.vite/manifest.json': '{"main":{"file":"assets/main.js"}}',
      'dist/client/.vite/ssr-manifest.json': '{}',
      'dist/client/.vite/vue-ssr-lite-assets.json': '{"version":1,"immutable":["assets/main.js"]}',
      [`dist/client/${DEPLOYMENT_METADATA_PATH}`]: JSON.stringify({
        version: 1, viteBase: '/', templates: ['index.html'], dynamicAssets,
        serverRouteMatchers: ['^/api/owned\\.js$'], controlPaths: ['/healthz', '/readyz'],
      }),
      'node_modules/runtime-dependency/package.json': '{"type":"module"}',
      'node_modules/runtime-dependency/data.bin': 'runtime data',
    }
    for (const [file, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), source)
    }
    vi.mocked(build).mockImplementation(async (options) => {
      await writeFile(options.outfile!, options.stdin!.contents)
      return { errors: [], warnings: [] }
    })
    vi.mocked(nodeFileTrace).mockImplementation(async (entries) => ({
      fileList: new Set([...entries, join(root, 'package.json'),
        join(root, 'dist/client/runtime-shared.json'),
        join(root, 'node_modules/runtime-dependency/package.json'),
        join(root, 'node_modules/runtime-dependency/data.bin'),
      ].map((file) => relative(parse(root).root, file))),
      esmFileList: new Set(), warnings: new Set(), reasons: new Map(),
    }))
    await buildVercelDeployment({ root, clientRoot, serverOutput })
    const output = join(root, '.vercel/output')
    const cdnFiles = ['assets/lazy.js', 'assets/main.css', 'assets/main.js', 'favicon.ico', 'images/logo.svg', 'runtime-shared.json']
    expect(await deploymentFiles(join(output, 'static'))).toEqual(dynamicAssets ? [] : cdnFiles)
    expect(await readFile(serverOutput, 'utf8')).toBe(files['dist/server/SsrRuntime.js'])
    expect(await readFile(join(clientRoot, 'index.html'), 'utf8')).toContain('private template')
    const functionRoot = join(output, 'functions/__vue_ssr_lite.func')
    const payload = await deploymentFiles(join(functionRoot, 'payload'))
    for (const file of [
      'dist/server/SsrRuntime.js', 'dist/server/chunks/lazy.js',
      'dist/client/index.html', 'dist/client/.vue-ssr-lite/dashboard.html',
      'dist/client/.vite/manifest.json', 'dist/client/.vite/ssr-manifest.json',
      'dist/client/.vite/vue-ssr-lite-assets.json', `dist/client/${DEPLOYMENT_METADATA_PATH}`,
      'dist/client/robots.txt', 'dist/client/sitemap.xml', 'dist/client/api/owned.js',
      'node_modules/runtime-dependency/package.json', 'node_modules/runtime-dependency/data.bin',
    ]) {
      expect(payload, file).toContain(file)
      expect(await readFile(join(functionRoot, 'payload', file), 'utf8')).toBe(files[file])
    }
    for (const file of cdnFiles.filter((file) => file !== 'runtime-shared.json')) {
      expect(payload.includes(`dist/client/${file}`), file).toBe(dynamicAssets)
      expect(await readFile(join(clientRoot, file), 'utf8')).toBe(files[`dist/client/${file}`])
    }
    // A real server import still needs its bytes, even if the same file is public.
    expect(payload).toContain('dist/client/runtime-shared.json')
    const config = JSON.parse(await readFile(join(functionRoot, '.vc-config.json'), 'utf8'))
    expect(config).toMatchObject({ handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true })
    expect(await readFile(join(functionRoot, 'index.mjs'), 'utf8')).not.toContain(root)
    expect(await readdir(root)).not.toContain('vercel.json')
    expect(await readdir(join(root, '.vercel'))).not.toContain('vue-ssr-lite-stage')
    expect(vi.mocked(nodeFileTrace).mock.calls[0]![0]).toContain(join(root, 'dist/server/chunks/lazy.js'))
  })

  it('routes known GET/HEAD files to static and every other path/method to Core', () => {
    const config = createVercelRouting([{ file: 'assets/a+b.js', pathname: '/base/assets/a+b.js', cacheControl: 'public, max-age=31536000, immutable', contentType: 'text/javascript' }])
    const staticRoute = config.routes[0]!
    expect('methods' in staticRoute && staticRoute.methods).toEqual(['GET', 'HEAD'])
    expect(new RegExp(staticRoute.src).test('/base/assets/a+b.js')).toBe(true)
    expect(new RegExp(staticRoute.src).test('/base/assets/abxjs')).toBe(false)
    const fallback = config.routes.at(-1)!
    for (const path of ['/', '/about', '/dashboard', '/unknown', '/api/items', '/robots.txt', '/sitemap.xml', '/redirect', '/.vite/manifest.json']) {
      expect(new RegExp(fallback.src).test(path)).toBe(true)
      expect(fallback.dest).toBe('/__vue_ssr_lite')
    }
    expect('methods' in fallback).toBe(false)
  })
})
