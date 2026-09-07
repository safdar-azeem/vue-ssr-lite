import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleSsrConfigModule } from '../SsrConfigCompileBoundary'
import { compileSsrConfig, extractSsrViteEntries, generateSsrClientModule, loadSsrConfigFile } from '../SsrConfigCompileRuntime'
import { projectUniversalRuntimeSource, SSR_UNIVERSAL_RUNTIME_FIELDS } from '../SsrUniversalProjection'
import { provisionHostVuePeers } from '../SsrTestFixtures'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const helper = JSON.stringify(join(sourceRoot, 'index.ts'))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('server routes browser isolation', () => {
  it('keeps the universal projection allowlist unchanged', () => {
    expect(SSR_UNIVERSAL_RUNTIME_FIELDS).toEqual(['extensions', 'middleware', 'router', 'scrollBehavior', 'createInitialState', 'cleanup'])
  })

  it('projects navigation middleware without inline HTTP declarations or their Node imports', async () => {
    const source = `
import { defineServer, defineServerRoutes, defineServerMiddleware, defineMiddleware } from 'vue-ssr-lite'
import { readFileSync } from 'node:fs'
const navigation = defineMiddleware(() => {})
const logger = defineServerMiddleware((request, context, next) => { readFileSync('/private/HTTP_ONLY'); return next() })
const serverRoutes = [defineServerRoutes({ routes: { '/api': { GET() { return new Response(readFileSync('/private/HTTP_ONLY')) } } } })]
export default defineServer({ middleware: [navigation], serverMiddleware: [logger], serverRoutes })
`
    const projection = await projectUniversalRuntimeSource(source, '/virtual/server.ts')
    expect(projection?.fields.middleware).toBe('[navigation]')
    const emitted = JSON.stringify(projection)
    for (const value of ['node:fs', 'HTTP_ONLY', 'defineServerRoutes', 'defineServerMiddleware', 'serverRoutes', 'serverMiddleware']) {
      expect(emitted).not.toContain(value)
    }
    expect(emitted).toContain('defineMiddleware')
  })

  it.each([
    { mode: 'single', entry: 'source' },
    { mode: 'multi', entry: 'source' },
    { mode: 'single', entry: 'package' },
    { mode: 'multi', entry: 'package' },
  ])('loads $mode-app HTTP modules through the $entry entry and excludes their entire dependency closure from client projection', async ({ mode, entry }) => {
    const root = await mkdtemp(join(tmpdir(), 'ssr-http-boundary-')); roots.push(root)
    await provisionHostVuePeers(root)
    // Model an installed, external package without depending on an existing dist
    // build. Its public declarations have the same identity-helper behavior.
    // The source-entry cases above exercise the actual helper implementations.
    if (entry === 'package') {
      const packageRoot = join(root, 'node_modules/vue-ssr-lite')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'vue-ssr-lite', type: 'module', exports: './index.js',
      }))
      await writeFile(join(packageRoot, 'index.js'), `
export const defineServer = (config) => config
export const defineApplication = (config) => config
export const defineMiddleware = (middleware) => middleware
export const defineServerRoutes = (routes) => routes
export const defineServerMiddleware = (middleware) => middleware
`)
    }
    const configHelper = entry === 'package' ? "'vue-ssr-lite'" : helper
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'server'))
    await writeFile(join(root, 'index.html'), '<html><body><div id="app"></div></body></html>')
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>')
    await writeFile(join(root, 'src/Home.vue'), '<template><p>home</p></template>')
    await writeFile(join(root, 'src/routes.ts'), "import Home from './Home.vue'; export const routes = [{ path: '/', component: Home }]\n")
    await writeFile(join(root, 'src/main.ts'), "export { routes } from './routes'; export default () => {}\n")
    await writeFile(join(root, 'src/navigation.ts'), `import { defineMiddleware } from ${configHelper}; export const navigation = defineMiddleware(() => {})\n`)
    await writeFile(join(root, 'server/database.ts'), "import { basename } from 'node:path'; import { readFileSync } from 'node:fs'; export const database = { marker: basename('PRIVATE_DATABASE_SENTINEL'), read: readFileSync }\n")
    await writeFile(join(root, 'server/products.ts'), `import { defineServerRoutes } from ${configHelper}; import { database } from './database'; export const products = defineServerRoutes({ prefix: '/api', routes: { '/products': { GET() { return Response.json({ marker: database.marker }) } } } })\n`)
    await writeFile(join(root, 'server/logger.ts'), `import { defineServerMiddleware } from ${configHelper}; import { database } from './database'; export const logger = defineServerMiddleware(async (request, context, next) => { const response = await next(); response.headers.set('x-private-marker', database.marker); return response })\n`)
    const appFields = `render: 'ssr', serverRoutes: [products], middleware: [navigation]`
    if (mode === 'multi') {
      await writeFile(join(root, 'app.ts'), `import { defineApplication } from ${configHelper}; import { routes } from './src/routes'; import { navigation } from './src/navigation'; import { products } from './server/products'; export default defineApplication({ name: 'shop', host: 'shop.test', routes, ${appFields} })\n`)
      await writeFile(join(root, 'server.ts'), `import { defineServer } from ${configHelper}; import app from './app'; import { logger } from './server/logger'; export default defineServer({ applications: [app], serverMiddleware: [logger] })\n`)
    } else {
      await writeFile(join(root, 'server.ts'), `import { defineServer } from ${configHelper}; import { navigation } from './src/navigation'; import { products } from './server/products'; import { logger } from './server/logger'; export default defineServer({ ${appFields}, serverMiddleware: [logger] })\n`)
    }
    const { code, graph } = await bundleSsrConfigModule(root, join(root, 'server.ts'))
    expect(code).toContain('PRIVATE_DATABASE_SENTINEL')
    expect(code).toContain('node:fs')
    expect([...(graph.serverConfigModules ?? [])].some((file) => file.endsWith('/server/products.ts'))).toBe(true)
    expect([...(graph.applicationRoutesModules ?? [])].some((file) => file.endsWith('/server/products.ts'))).toBe(false)
    const config = await loadSsrConfigFile(root)
    const compiled = await compileSsrConfig(config, { root })
    expect(compiled.applications[0].serverRoutes?.ownedPaths).toEqual(['/api/products'])
    expect(compiled.serverMiddleware).toHaveLength(1)
    const entries = extractSsrViteEntries(config, { root }).applications
    expect(entries).toHaveLength(1)
    const client = generateSsrClientModule(root, entries[0])
    for (const value of ['server/products', 'server/logger', 'database', 'PRIVATE_DATABASE_SENTINEL', 'node:fs', 'serverRoutes', 'serverMiddleware']) expect(client).not.toContain(value)
    expect(client).toContain('navigation')
    if (mode === 'multi') expect(entries[0].routesModule).toBe('./src/routes.ts')
  })

  it('bundles public helper exports on the browser platform without any server runtime inputs', async () => {
    const result = await build({
      stdin: { contents: `export { defineServerRoutes, defineServerMiddleware } from ${helper}`, resolveDir: sourceRoot, loader: 'ts' },
      bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm', packages: 'external', logLevel: 'silent',
    })
    const output = result.outputFiles![0].text
    expect(output).toContain('defineServerRoutes')
    expect(output).toContain('defineServerMiddleware')
    for (const filename of Object.keys(result.metafile!.inputs)) {
      expect(filename).not.toMatch(/SsrServerRouteRuntime|SsrServerMiddlewareRuntime|SsrServerResponseRuntime|SsrServerRouteInternalTypes|SsrWebHttpRuntime|SsrRequestHandler|SsrConfigCompile/)
    }
    expect(output).not.toMatch(/node:|compileServerRoutes|executeServerMiddleware|createWebRequest/)
  })

  it('keeps public modules free of runtime/internal imports and compiled records', async () => {
    const server = await readFile(join(sourceRoot, 'server.ts'), 'utf8')
    expect(server).not.toMatch(/server-routes|defineServerRoutes|defineServerMiddleware/)
    for (const name of ['index.ts', 'defineServerRoutes.ts', 'defineServerMiddleware.ts', 'SsrServerRouteTypes.ts']) {
      const source = await readFile(join(sourceRoot, 'server-routes', name), 'utf8')
      expect(source).not.toMatch(/from ['"]node:|from ['"].*SsrServerRouteInternalTypes|from ['"].*SsrServerRouteRuntime|from ['"].*SsrServerMiddlewareRuntime|from ['"].*SsrServerResponseRuntime|from ['"].*SsrWebHttpRuntime/)
    }
  })
})
