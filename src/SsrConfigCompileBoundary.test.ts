import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleSsrConfigModule,
  bundleSsrConfigModules,
  collectApplicationDeclarationFiles,
  resolveSsrConfigGraphModule,
  resolveApplicationRoutesModule,
  type SsrConfigModuleGraph,
} from './SsrConfigCompileBoundary'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

describe('application source discovery contract', () => {
  it('accepts type-only modules that esbuild erases from a multi-entry build', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-type-only-discovery-'))
    const types = join(root, 'products.ts')
    const application = join(root, 'application.ts')
    await writeFile(types, 'export interface ProductsResponse { products: string[] }\n')
    await writeFile(application, 'export default { name: "shop" }\n')

    const bundled = await bundleSsrConfigModules(root, [types, application])

    expect(bundled.codes.get(types)).toBe('export {}\n')
    expect(bundled.codes.get(application)).toContain('name: "shop"')
  })

  it('records authoritative alias and external-package resolution identities', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-resolution-graph-'))
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@state': ['./state.ts'] } } })
    )
    await writeFile(join(root, 'state.ts'), 'export const state = {}\n')
    await writeFile(
      join(root, 'server.ts'),
      `import { state } from '@state'\nimport 'safe-package/subpath'\nexport default state\n`
    )
    const { graph } = await bundleSsrConfigModule(root, join(root, 'server.ts'))
    expect(resolveSsrConfigGraphModule(graph, join(root, 'server.ts'), '@state')).toMatchObject({
      identity: join(root, 'state.ts'),
      path: join(root, 'state.ts'),
      external: false,
    })
    expect(
      resolveSsrConfigGraphModule(graph, join(root, 'server.ts'), 'safe-package/subpath')
    ).toEqual({ identity: 'external:safe-package/subpath', external: true })
  })

  it('walks helper factories instead of stopping at defineApplication imports', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-discovery-'))
    await mkdir(join(root, 'src', 'website'), { recursive: true })
    await writeFile(
      join(root, 'src/factory.ts'),
      `import { defineApplication } from 'vue-ssr-lite'\nexport const createApp = (config) => defineApplication(config)\n`
    )
    await writeFile(
      join(root, 'src/website/app.ts'),
      `import { createApp } from '../factory'\nimport routes from './routes'\nexport default createApp({ name: 'website', routes })\n`
    )
    await writeFile(join(root, 'src/website/routes.ts'), 'export default []\n')
    await writeFile(
      join(root, 'server.ts'),
      `import website from './src/website/app'\nexport default { applications: [website] }\n`
    )
    const walked = await collectApplicationDeclarationFiles(
      join(root, 'server.ts'),
      0,
      new Set(),
      root
    )
    expect(walked.truncated).toBe(false)
    expect(walked.files.some((file) => file.endsWith('src/website/app.ts'))).toBe(true)
    expect(walked.files.some((file) => file.endsWith('src/factory.ts'))).toBe(true)
    expect(walked.files.some((file) => file.endsWith('src/website/routes.ts'))).toBe(false)
  })

  it('fails when an application imports more than one Vue-touching module', () => {
    const graph: SsrConfigModuleGraph = {
      imports: new Map([
        ['/app/src/website/app.ts', ['/app/src/website/routes.ts', '/app/src/website/pages.ts']],
      ]),
      universalImporters: new Set([
        '/app/src/website/routes.ts',
        '/app/src/website/pages.ts',
      ]),
    }
    expect(() =>
      resolveApplicationRoutesModule('/app/src/website/app.ts', graph, 'website')
    ).toThrow(/multiple Vue-touching modules/)
  })

  it('keeps single-app Vite aliases out of the server.ts config graph', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-single-app-alias-'))
    const defineServerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      'SsrConfigRuntime.ts'
    )
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/constants.ts'), "export const HOME_PATH = '/'\n")
    await writeFile(
      join(root, 'src/Home.vue'),
      '<template><div>HOME_PAGE</div></template>\n'
    )
    await writeFile(
      join(root, 'src/routes.ts'),
      `import { HOME_PATH } from '@/constants'\nimport Home from './Home.vue'\nexport default [{ path: HOME_PATH, component: Home }]\n`
    )
    await writeFile(
      join(root, 'src/main.ts'),
      `import routes from './routes'\nexport { routes }\nexport default () => {}\n`
    )
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineServerPath)}\nexport default defineServer({ render: 'ssr' })\n`
    )
    const { code, graph } = await bundleSsrConfigModule(root, join(root, 'server.ts'))
    expect(code).not.toContain('@/constants')
    expect(code).not.toContain('HOME_PATH')
    expect(code).not.toContain('HOME_PAGE')
    expect(
      graph.resolutions?.some((edge) => edge.specifier === '@/constants')
    ).toBe(false)
    const graphFiles = [
      ...graph.imports.keys(),
      ...[...graph.imports.values()].flat(),
    ]
    expect(graphFiles.some((file) => file.endsWith('src/routes.ts'))).toBe(false)
    expect(graphFiles.some((file) => file.endsWith('src/constants.ts'))).toBe(false)
    expect(graphFiles.some((file) => file.endsWith('src/Home.vue'))).toBe(false)
  })
})
