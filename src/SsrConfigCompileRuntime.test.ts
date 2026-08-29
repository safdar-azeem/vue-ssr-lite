import { describe, expect, it } from 'vitest'
import {
  compileSsrConfig,
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  normalizeSsrConfig,
} from './SsrConfigCompileRuntime'
import { defineApplication, defineServer } from './index'
import { resolveSsrDomainContext } from './SsrDomainRuntime'
import { resolveSsrHostEntry } from './server/SsrHostRuntime'
import { withSsrShells } from './SsrTestFixtures'
import { defineComponent, h } from 'vue'

const Root = defineComponent({ setup: () => () => h('div') })

describe('defineServer application architecture', () => {
  it('uses fixed bounded SSR admission defaults', async () => {
    const compiled = await compileSsrConfig(
      { default: defineServer({ render: 'spa' }) },
      { development: true, root: '/workspace/my-app' }
    )

    expect(compiled.server.maxConcurrentSsrRequests).toBe(8)
    expect(compiled.server.maxQueuedSsrRequests).toBe(32)
  })

  it.each([
    ['maxConcurrentSsrRequests', 0],
    ['maxConcurrentSsrRequests', -1],
    ['maxConcurrentSsrRequests', 1.5],
    ['maxConcurrentSsrRequests', Number.NaN],
    ['maxConcurrentSsrRequests', Number.POSITIVE_INFINITY],
    ['maxQueuedSsrRequests', -1],
    ['maxQueuedSsrRequests', 1.5],
    ['maxQueuedSsrRequests', Number.NaN],
    ['maxQueuedSsrRequests', Number.POSITIVE_INFINITY],
  ] as const)('rejects invalid server.%s capacity %s', async (field, value) => {
    await expect(
      compileSsrConfig(
        {
          default: defineServer({
            render: 'spa',
            server: { [field]: value },
          }),
        },
        { development: true, root: '/workspace/my-app' }
      )
    ).rejects.toThrow(`server.${field}`)
  })

  it('supports an explicit zero-length SSR admission queue', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          render: 'spa',
          server: { maxConcurrentSsrRequests: 3, maxQueuedSsrRequests: 0 },
        }),
      },
      { development: true, root: '/workspace/my-app' }
    )

    expect(compiled.server.maxConcurrentSsrRequests).toBe(3)
    expect(compiled.server.maxQueuedSsrRequests).toBe(0)
  })

  it('normalizes conventions without a config file', () => {
    const normalized = normalizeSsrConfig({}, { root: '/workspace/my-app' })
    expect(normalized.name).toBe('my-app')
    expect(normalized.applications.app).toMatchObject({
      id: 'app',
      render: 'ssr',
      shell: { main: './src/main.ts', root: './src/App.vue' },
      template: './index.html',
      mountSelector: '#app',
      hosts: ['*'],
    })
  })

  it('applies global shell and SEO overrides without repeating defaults', () => {
    const site = { title: 'Tenant' }
    const robots = {
      resolve: async () => ({ status: 'resolved' as const, config: {} }),
    }
    const normalized = normalizeSsrConfig(
      defineServer({
        app: { main: './src/platform/main.ts', root: './src/platform/App.vue' },
        mount: '#website',
        server: { trustProxy: true },
        seo: { site, robots },
      }),
      { root: '/workspace/my-app' }
    )
    expect(normalized.applications.app).toMatchObject({
      shell: {
        main: './src/platform/main.ts',
        root: './src/platform/App.vue',
      },
      template: './index.html',
      mountSelector: '#website',
      render: 'ssr',
    })
    expect(normalized.server?.trustProxy).toBe(true)
    expect(normalized.applications.app.seo?.site).toEqual(site)
    expect(normalized.applications.app.seo?.robots).toBe(robots)
  })

  it('uses defineApplication names as identity and requires routing for multiple apps', () => {
    const normalized = normalizeSsrConfig({
      applications: [
        defineApplication({
          name: 'website',
          host: 'example.com',
        }),
        defineApplication({
          name: 'store',
          host: '*.shop.example.com',
        }),
      ],
    })
    expect(normalized.applications.website.id).toBe('website')
    expect(normalized.applications.store.hosts).toEqual(['*.shop.example.com'])
    expect(() =>
      normalizeSsrConfig({
        applications: [
          defineApplication({ name: 'website' }),
          defineApplication({ name: 'store' }),
        ],
      })
    ).toThrow(/needs host routing/)
  })

  it('rejects duplicate application names', () => {
    expect(() =>
      normalizeSsrConfig({
        applications: [
          defineApplication({ name: 'website', host: 'example.com' }),
          defineApplication({ name: 'website', host: 'other.example.com' }),
        ],
      })
    ).toThrow('Duplicate application name "website"')
  })

  it('rejects application ports and mixed single/multi-app fields', () => {
    expect(() =>
      defineApplication({
        name: 'admin',
        port: 3000,
      } as never)
    ).toThrow(/cannot declare a port/)
    expect(() =>
      normalizeSsrConfig({
        render: 'ssr',
        applications: [
          defineApplication({ name: 'website', host: 'example.com' }),
        ],
      } as never)
    ).toThrow(/single-application field `render` with applications/)
    expect(() =>
      normalizeSsrConfig({
        seo: { site: { title: 'Tenant' } },
        applications: [
          defineApplication({ name: 'website', host: 'example.com' }),
        ],
      } as never)
    ).toThrow(/single-application field `seo` with applications/)
  })

  it('rejects object-map application config', () => {
    expect(() =>
      normalizeSsrConfig({
        applications: {
          website: { name: 'website', host: 'example.com' },
        },
      } as never)
    ).toThrow(/must be an array of defineApplication\(\) results/)
  })

  it('resolves application shell paths relative to the application module', () => {
    const normalized = normalizeSsrConfig(
      {
        applications: [
          defineApplication({
            name: 'docs',
            host: 'docs.example.com',
            app: { main: './main.ts', root: './App.vue' },
          }),
        ],
      },
      {
        root: '/workspace/project',
        applicationFiles: new Map([
          ['docs', '/workspace/project/src/modules/docs/app.ts'],
        ]),
      }
    )
    expect(normalized.applications.docs.shell).toMatchObject({
      main: './src/modules/docs/main.ts',
      root: './src/modules/docs/App.vue',
    })
  })

  it('rejects shell paths that escape the project root', () => {
    expect(() =>
      normalizeSsrConfig(
        defineServer({
          app: { main: '../outside/main.ts' },
        }),
        { root: '/workspace/project' }
      )
    ).toThrow(/resolves outside the project root/)
  })

  it('does not inherit shared main.ts routes onto explicit applications', async () => {
    const compiled = await compileSsrConfig(
      withSsrShells(
        defineServer({
          applications: [
            defineApplication({
              name: 'admin',
              render: 'spa',
              host: 'admin.example.com',
              routes: [{ path: '/users', component: Root }],
            }),
          ],
        }),
        {
          admin: {
            root: Root,
            main: {
              default: () => undefined,
              routes: [{ path: '/from-shared-main', component: Root }],
            },
          },
        }
      ),
      {
        root: '/workspace/project',
        applicationFiles: new Map([
          ['admin', '/workspace/project/src/modules/admin/app.ts'],
        ]),
      }
    )
    expect(compiled.applications[0]?.application?.routes).toEqual([
      { path: '/users', component: Root },
    ])
  })

  it('compiles app-centric domains and resolves context params', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          name: 'demo',
          runtime: 'unified',
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              roles: ['unified', 'erp'],
              domain: {
                development: 'localhost',
                production: 'app.example.com',
                mode: 'root-and-subdomains',
                localAliases: true,
                params: {
                  workspace: { source: 'last-subdomain-label' },
                },
              },
              publicConfig: {
                api: { endpoint: 'http://localhost:4300/graphql', timeout: 8000 },
              },
            }),
            defineApplication({
              name: 'storefront',
              render: 'ssr',
              roles: ['unified', 'storefront'],
              domain: {
                development: 'shop.localhost',
                production: 'shop.example.com',
                mode: 'root-and-subdomains',
                customDomains: true,
                params: {
                  storeDomain: { source: 'subdomain-or-hostname' },
                },
              },
              publicConfig: {
                api: { endpoint: 'http://localhost:4300/graphql', timeout: 8000 },
              },
            }),
          ],
        }),
      },
      { development: true }
    )

    expect(compiled.applications.find((app) => app.id === 'storefront')?.id).toBe(
      'storefront'
    )

    const matrix = [
      ['localhost', 'erp', ''],
      ['company1.localhost', 'erp', 'company1'],
      ['shop.localhost', 'storefront', ''],
      ['store1.shop.localhost', 'storefront', 'store1'],
      ['custom-store.com', 'storefront', 'custom-store.com'],
    ] as const

    for (const [host, entryId, expectedParam] of matrix) {
      const matched = resolveSsrHostEntry(
        compiled.applications,
        host,
        compiled.defaultApplicationId
      )
      expect(matched?.entry.id).toBe(entryId)
      const domain = resolveSsrDomainContext(host, matched!.entry, true)
      if (entryId === 'erp') {
        expect(domain.params.workspace || '').toBe(expectedParam)
      } else {
        expect(domain.params.storeDomain || '').toBe(expectedParam)
      }
    }

    expect(
      resolveSsrHostEntry(
        [...compiled.applications].reverse(),
        'store1.shop.localhost'
      )?.entry.id
    ).toBe('storefront')
  })

  it('defaults the production runtime to unified', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          name: 'demo',
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
              },
            }),
          ],
        }),
      },
      { development: false }
    )
    expect(compiled.server.role).toBe('unified')
  })

  it('lets a single production application serve the incoming host', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          name: 'demo',
          runtime: 'unified',
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              domain: {
                development: 'localhost',
                production: '',
              },
            }),
          ],
        }),
      },
      { development: false }
    )
    expect(compiled.applications[0]?.hosts).toEqual(['*'])
  })

  it('does not require publicConfig.api.endpoint in production', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          name: 'demo',
          runtime: 'unified',
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
              },
              publicConfig: { featureFlags: { darkMode: true } },
            }),
          ],
        }),
      },
      { development: false }
    )
    expect(compiled.applications[0]?.publicConfig).toEqual({
      featureFlags: { darkMode: true },
    })
  })

  it('allows localAliases on root and subdomain apps without host collision', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          name: 'demo',
          runtime: 'unified',
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
                mode: 'root-and-subdomains',
                localAliases: true,
              },
            }),
            defineApplication({
              name: 'storefront',
              render: 'ssr',
              domain: {
                development: 'shop.localhost',
                production: 'shop.example.com',
                mode: 'root-and-subdomains',
                localAliases: true,
              },
            }),
          ],
        }),
      },
      { development: true }
    )

    const erp = compiled.applications.find((app) => app.id === 'erp')!
    const storefront = compiled.applications.find((app) => app.id === 'storefront')!
    expect(erp.hosts).toEqual(
      expect.arrayContaining(['localhost', '127.0.0.1', '*.localhost'])
    )
    expect(storefront.hosts).toContain('shop.localhost')
    expect(storefront.hosts).toContain('*.shop.localhost')
    expect(storefront.hosts).not.toContain('localhost')
    expect(storefront.hosts).not.toContain('127.0.0.1')
  })

  it('passes renderError and onMetrics through compile', async () => {
    const onMetrics = () => undefined
    const renderError = () => null
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          name: 'demo',
          runtime: 'unified',
          server: { onMetrics, renderError },
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
              },
            }),
          ],
        }),
      },
      { development: true }
    )
    expect(compiled.server.onMetrics).toBe(onMetrics)
    expect(compiled.server.renderError).toBe(renderError)
  })

  it('extracts Vite entries and generates virtual modules without importing server-only app.ts', () => {
    const config = defineServer({
      name: 'demo',
      applications: [
        defineApplication({
          name: 'erp',
          render: 'spa',
          domain: {
            development: 'localhost',
            production: 'app.example.com',
          },
        }),
        defineApplication({
          name: 'storefront',
          render: 'ssr',
          domain: {
            development: 'shop.localhost',
            production: 'shop.example.com',
            customDomains: true,
          },
        }),
      ],
    })
    const entries = extractSsrViteEntries(config, {
      root: '/app',
      applicationFiles: new Map([
        ['erp', '/app/src/modules/erp/app.ts'],
        ['storefront', '/app/src/modules/storefront/app.ts'],
      ]),
    })
    expect(entries.applications.map((app) => app.id)).toEqual([
      'erp',
      'storefront',
    ])
    expect(entries.applications[0]).toMatchObject({
      id: 'erp',
      kind: 'spa',
      main: './src/main.ts',
      root: './src/App.vue',
      routesFromMain: false,
    })

    const runtime = generateSsrRuntimeModule(
      '/app',
      '/app/server.ts',
      entries.applications
    )
    expect(runtime).toContain('import __ssrUserConfig from "/app/server.ts"')
    expect(runtime).toContain('__vueSsrLiteApplicationFiles')
    expect(runtime).toContain('/app/src/modules/erp/app.ts')
    expect(runtime).not.toContain('ssr.config')
    expect(runtime).not.toMatch(/ssr\s*:\s*\(\)\s*=>\s*import/)
    expect(runtime).toContain('const viteBase = "/"')
    expect(runtime).toContain('/app/src/App.vue')
    expect(runtime).toContain('/app/src/main.ts')

    const spaClient = generateSsrClientModule('/app', entries.applications[0])
    expect(spaClient).toContain('mountSpaApplication')
    expect(spaClient).toContain('id: "erp"')
    expect(spaClient).toContain('from "/app/src/App.vue"')
    expect(spaClient).toContain('from "/app/src/main.ts"')
    expect(spaClient).toContain('const routes = undefined')
    expect(spaClient).toContain('export const definition')
    expect(spaClient).not.toContain('src/modules/erp/app.ts')

    const ssrClient = generateSsrClientModule('/app', entries.applications[1])
    expect(ssrClient).toContain('hydrateSsrApplication')
    expect(ssrClient).toContain('id: "storefront"')
    expect(ssrClient).not.toContain('src/modules/storefront/app.ts')
  })

  it('projects universal runtime fields into the generated client', () => {
    const client = generateSsrClientModule('/app', {
      id: 'app',
      kind: 'ssr',
      main: './src/main.ts',
      root: './src/App.vue',
      template: './index.html',
      mountSelector: '#app',
      routesFromMain: true,
      universalProjection: {
        imports: [
          'import { analyticsExtension } from "/app/src/extensions/custom-analytics"',
        ],
        fields: {
          extensions: '[analyticsExtension({ propertyId: "UA-123456" })]',
          createInitialState: '() => ({ marker: "ADVANCED_INITIAL_STATE" })',
          scrollBehavior: '(to) => ({ el: to.hash })',
        },
      },
    })
    expect(client).toContain('UA-123456')
    expect(client).toContain('extensions:')
    expect(client).toContain('createInitialState:')
    expect(client).toContain('scrollBehavior:')
    expect(client).not.toContain('server.ts')
  })

  it('uses main.ts routes for the single-app client module', () => {
    const entries = extractSsrViteEntries(defineServer({ render: 'ssr' }), {
      root: '/app',
    })
    expect(entries.applications[0]?.routesFromMain).toBe(true)
    const client = generateSsrClientModule('/app', entries.applications[0])
    expect(client).toContain('const routes = __ssrMain.routes')
  })
})
