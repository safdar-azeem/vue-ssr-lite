import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleSsrConfigModule,
  extractSsrViteEntries,
  generateSsrClientModule,
  loadSsrConfigFile,
} from '../SsrConfigCompileRuntime'
import {
  resolveApplicationRoutesImportBindings,
  resolveApplicationRoutesImportSpecifiers,
} from '../SsrUniversalProjection'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/config-routes-css-boundary'
)

const defineFrom = join(dirname(fileURLToPath(import.meta.url)), '../index.ts')

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const materializeFixture = async () => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-routes-css-'))
  await cp(fixtureRoot, root, { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await cp(join(root, 'vendor/style-package'), join(root, 'node_modules/style-package'), {
    recursive: true,
  })
  return root
}

describe('multi-app defineApplication({ routes }) config boundary', () => {
  it('extracts the dedicated routes specifier from defineApplication modules', async () => {
    await expect(
      resolveApplicationRoutesImportSpecifiers(
        `import { defineApplication } from ${JSON.stringify(defineFrom)}\nimport { routes } from '../router/routes'\nexport default defineApplication({ name: 'erp', routes })\n`,
        '/app/src/runtime/app.ts'
      )
    ).resolves.toEqual(['../router/routes'])
    await expect(
      resolveApplicationRoutesImportSpecifiers(
        `import { defineApplication } from ${JSON.stringify(defineFrom)}\nimport adminRoutes from './routes'\nexport default defineApplication({ name: 'admin', routes: adminRoutes })\n`,
        '/app/src/admin/app.ts'
      )
    ).resolves.toEqual(['./routes'])
    await expect(
      resolveApplicationRoutesImportSpecifiers(
        `import { defineServer } from ${JSON.stringify(defineFrom)}\nimport website from './src/website/app'\nexport default defineServer({ applications: [website] })\n`,
        '/app/server.ts'
      )
    ).resolves.toEqual([])
  })

  it('records named versus default routes bindings from defineApplication modules', async () => {
    await expect(
      resolveApplicationRoutesImportBindings(
        `import { defineApplication } from ${JSON.stringify(defineFrom)}\nimport { routes } from '../router/routes'\nexport default defineApplication({ name: 'erp', routes })\n`,
        '/app/src/runtime/app.ts'
      )
    ).resolves.toEqual([{ specifier: '../router/routes', imported: 'routes' }])
    await expect(
      resolveApplicationRoutesImportBindings(
        `import { defineApplication } from ${JSON.stringify(defineFrom)}\nimport adminRoutes from './routes'\nexport default defineApplication({ name: 'admin', routes: adminRoutes })\n`,
        '/app/src/admin/app.ts'
      )
    ).resolves.toEqual([{ specifier: './routes', imported: 'default' }])
  })

  it('recognizes static callable routes on the exported application only', async () => {
    await expect(
      resolveApplicationRoutesImportBindings(
        `import { defineApplication } from ${JSON.stringify(defineFrom)}\nimport realRoutes from './routes'\nimport telemetryRoutes from './telemetry'\nconst unrelated = { routes: telemetryRoutes }\nexport default defineApplication({ name: 'admin', routes: () => realRoutes })\n`,
        '/app/src/admin/app.ts'
      )
    ).resolves.toEqual([{ specifier: './routes', imported: 'default' }])

    await expect(
      resolveApplicationRoutesImportBindings(
        `import * as routeModule from './routes'\nimport { defineApplication } from ${JSON.stringify(defineFrom)}\nexport default defineApplication({ name: 'admin', routes: () => routeModule.routes })\n`,
        '/app/src/admin/app.ts'
      )
    ).resolves.toEqual([{ specifier: './routes', imported: 'routes' }])
  })

  it('stubs the exact default, named, aliased, and callable route exports', async () => {
    const project = await materializeFixture()
    const cases = [
      {
        declaration: "import routes from './routes'",
        routes: 'routes',
        exported: 'default',
        clientImport: 'import applicationRoutes from',
      },
      {
        declaration: "import { routes } from './routes'",
        routes: 'routes',
        exported: 'routes',
        clientImport: 'import { routes as applicationRoutes } from',
      },
      {
        declaration: "import { adminRoutes } from './routes'",
        routes: 'adminRoutes',
        exported: 'adminRoutes',
        clientImport: 'import { adminRoutes as applicationRoutes } from',
      },
      {
        declaration: "import { adminRoutes as routes } from './routes'",
        routes: 'routes',
        exported: 'adminRoutes',
        clientImport: 'import { adminRoutes as applicationRoutes } from',
      },
      {
        declaration: "import { adminRoutes } from './routes'",
        routes: '() => adminRoutes',
        exported: 'adminRoutes',
        clientImport: 'import { adminRoutes as applicationRoutes } from',
      },
    ] as const

    for (const item of cases) {
      await writeFile(
        join(project, 'src/admin/app.ts'),
        `import { defineApplication } from '../../../src/index'\n${item.declaration}\nexport default defineApplication({ name: 'admin', render: 'spa', host: ['admin.localhost', 'admin.test'], routes: ${item.routes} })\n`
      )
      const { code } = await bundleSsrConfigModule(project, join(project, 'server.ts'))
      expect(code).not.toContain('style-package')
      expect(code).not.toContain('style.css')
      expect(code).not.toContain('AdminPage.vue')
      const config = await loadSsrConfigFile(project)
      const admin = extractSsrViteEntries(config, { root: project }).applications
        .find((application) => application.id === 'admin')!
      expect(admin).toMatchObject({
        routesModule: './src/admin/routes.ts',
        routesExport: item.exported,
        routesFromMain: false,
      })
      expect(generateSsrClientModule(project, admin)).toContain(item.clientImport)
    }
  })

  it('loads multi-app configuration without executing package/style.css or Vite aliases', async () => {
    const project = await materializeFixture()
    const { code, graph } = await bundleSsrConfigModule(project, join(project, 'server.ts'))
    expect(code).not.toContain('style-package')
    expect(code).not.toContain('STYLE_PACKAGE_TOKEN')
    expect(code).not.toContain('style.css')
    expect(code).not.toContain('@/components/Something.vue')
    expect(code).not.toContain('ALIASED_COMPONENT')
    expect(code).not.toContain('ADMIN_PAGE')
    expect(code).not.toContain('WEBSITE_HOME')
    expect(code).not.toMatch(/ERR_UNKNOWN_FILE_EXTENSION/)
    expect(graph.applicationRoutesModules?.size).toBeGreaterThan(0)

    const config = await loadSsrConfigFile(project)
    expect(Array.isArray(config.applications)).toBe(true)
    expect(config.applications?.map((application) => application.name).sort()).toEqual([
      'admin',
      'website',
    ])
    expect((config as { routes?: unknown }).routes).toBeUndefined()

    const routes = (config as { __vueSsrLiteRoutesModules?: Map<string, string> })
      .__vueSsrLiteRoutesModules
    expect(routes?.get('admin')).toBe('./src/admin/routes.ts')
    expect(routes?.get('website')).toBe('./src/website/routes.ts')

    const entries = extractSsrViteEntries(config, { root: project })
    expect(entries.applications.map((application) => application.id)).toEqual([
      'website',
      'admin',
    ])
    expect(entries.applications[0]).toMatchObject({
      routesModule: './src/website/routes.ts',
      routesExport: 'default',
      routesFromMain: false,
    })
    expect(entries.applications[1]).toMatchObject({
      routesModule: './src/admin/routes.ts',
      routesExport: 'routes',
      routesFromMain: false,
    })
    const websiteClient = generateSsrClientModule(project, entries.applications[0])
    const adminClient = generateSsrClientModule(project, entries.applications[1])
    expect(websiteClient).toContain('import applicationRoutes from')
    expect(adminClient).toContain('import { routes as applicationRoutes } from')
    expect(adminClient).not.toContain('import applicationRoutes from')
  })

  it('fails closed if Node would have to interpret the CSS package', async () => {
    const project = await materializeFixture()
    await writeFile(
      join(project, 'src/admin/app.ts'),
      `import { defineApplication } from ${JSON.stringify(defineFrom)}\nimport { token } from 'style-package'\nexport default defineApplication({ name: 'admin', host: 'admin.test', createInitialState: () => ({ token }) })\n`
    )
    await expect(loadSsrConfigFile(project)).rejects.toThrow(/ERR_UNKNOWN_FILE_EXTENSION|\.css/)
  })
})
