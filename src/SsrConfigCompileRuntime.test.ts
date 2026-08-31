import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import {
  DEFINE_SERVER_ROUTES_ERROR,
  compileSsrConfig,
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
  loadSsrConfigFile,
  normalizeRobotsConfig,
  normalizeSsrConfig,
} from './SsrConfigCompileRuntime'
import { sourceDeclaresServerConfigRoutes } from './SsrUniversalProjection'
import { defineApplication, defineMiddleware, defineServer } from './index'
import type { ApplicationConfig, ServerConfig } from './SsrConfigTypes'
import { resolveSsrDomainContext } from './SsrDomainRuntime'
import { resolveSsrHostEntry } from './server/SsrHostRuntime'
import { withSsrShells } from './SsrTestFixtures'
import { defineComponent, h } from 'vue'

const Root = defineComponent({ setup: () => () => h('div') })

describe('defineServer application architecture', () => {
  it('accepts a direct static robots policy while preserving dynamic resolvers', async () => {
    const staticRobots = normalizeRobotsConfig({
      groups: [{ userAgents: '*', allow: ['/'] }],
    })!
    await expect(staticRobots.resolve({
      applicationId: 'app', siteOrigin: 'https://example.test',
      domain: {} as any, signal: new AbortController().signal, pathname: '/robots.txt', search: '',
    })).resolves.toEqual({
      status: 'resolved', config: { groups: [{ userAgents: '*', allow: ['/'] }] },
    })

    const resolve = async () => ({ status: 'resolved' as const, config: { sitemaps: [] } })
    expect(normalizeRobotsConfig({ resolve })?.resolve).toBe(resolve)
  })

  it('excludes default fallback routing from the public server contract', () => {
    expectTypeOf<
      'defaultApplicationId' extends keyof ServerConfig ? true : false
    >().toEqualTypeOf<false>()
  })

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

  it('treats host and domain as mutually exclusive routing models', () => {
    expectTypeOf<
      {
        name: 'broken'
        host: 'a.example.com'
        domain: { production: 'b.example.com' }
      } extends ApplicationConfig
        ? true
        : false
    >().toEqualTypeOf<false>()

    expect(() =>
      defineApplication({
        name: 'broken',
        host: 'a.example.com',
        domain: { production: 'b.example.com' },
      } as never)
    ).toThrow(
      'Application "broken" cannot declare both "host" and "domain". Use "host" for simple static host matching or "domain" for environment-aware domain routing.'
    )

    expect(() =>
      normalizeSsrConfig({
        applications: [
          {
            name: 'broken',
            host: 'a.example.com',
            domain: { production: 'b.example.com' },
          },
        ],
      } as never)
    ).toThrow(/cannot declare both "host" and "domain"/)
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
    const middleware = defineMiddleware(() => undefined)
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
    expect(() =>
      normalizeSsrConfig({
        middleware: [middleware],
        applications: [
          defineApplication({ name: 'website', host: 'example.com' }),
        ],
      } as never)
    ).toThrow(/single-application field `middleware` with applications/)
  })

  it('keeps global middleware application-scoped in single and multi-app configs', () => {
    const websiteMiddleware = defineMiddleware(() => undefined)
    const adminMiddleware = defineMiddleware(() => undefined)
    const single = normalizeSsrConfig(
      defineServer({ middleware: [websiteMiddleware] })
    )
    expect(single.applications.app.middleware).toEqual([websiteMiddleware])

    const multi = normalizeSsrConfig({
      applications: [
        defineApplication({
          name: 'website',
          host: 'example.com',
          middleware: [websiteMiddleware],
        }),
        defineApplication({
          name: 'admin',
          host: 'admin.example.com',
          middleware: [adminMiddleware],
        }),
      ],
    })
    expect(multi.applications.website.middleware).toEqual([websiteMiddleware])
    expect(multi.applications.admin.middleware).toEqual([adminMiddleware])
  })

  it('binds normalized middleware into the server application definition', async () => {
    const middleware = defineMiddleware(() => undefined)
    const compiled = await compileSsrConfig(
      withSsrShells(defineServer({ middleware: [middleware] }), {
        app: { root: Root },
      }),
      { development: true, root: '/workspace/middleware-app' }
    )
    expect(compiled.applications[0]?.application?.middleware).toEqual([
      middleware,
    ])
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
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
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
      const matched = resolveSsrHostEntry(compiled.applications, host)
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

  it('lets a single production application serve the incoming host', async () => {
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
    expect(runtime).toContain('virtual:vue-ssr-lite/internal/ssr-renderer')
    expect(runtime).toContain('__vueSsrLiteRenderApplication')
    expect(runtime).toContain('/app/src/App.vue')
    expect(runtime).toContain('/app/src/main.ts')

    const spaClient = generateSsrClientModule('/app', entries.applications[0])
    expect(spaClient).toContain('mountSpaApplication')
    expect(spaClient).toContain('id: "erp"')
    expect(spaClient).toContain('from "/app/src/App.vue"')
    expect(spaClient).toContain('from "/app/src/main.ts"')
    expect(spaClient).toContain('const routes = undefined')
    expect(spaClient).toContain('export const definition')
    expect(spaClient).toContain(
      '__vueSsrLiteDevelopment: import.meta.env.DEV'
    )
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
          middleware: '[() => undefined]',
          createInitialState: '() => ({ marker: "ADVANCED_INITIAL_STATE" })',
          scrollBehavior: '(to) => ({ el: to.hash })',
        },
      },
    })
    expect(client).toContain('UA-123456')
    expect(client).toContain('extensions:')
    expect(client).toContain('middleware:')
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

  it('binds single-app routes exclusively from main.ts', async () => {
    const compiled = await compileSsrConfig(
      withSsrShells(
        defineServer({ render: 'ssr' }),
        {
          app: {
            root: Root,
            main: {
              default: () => undefined,
              routes: [{ path: '/from-main', component: Root }],
            },
          },
        }
      ),
      { root: '/workspace/project' }
    )
    expect(compiled.applications[0]?.application?.routes).toEqual([
      { path: '/from-main', component: Root },
    ])
  })

  it('supports callable routes exported from main.ts', async () => {
    const compiled = await compileSsrConfig(
      withSsrShells(
        defineServer({ render: 'ssr' }),
        {
          app: {
            root: Root,
            main: {
              default: () => undefined,
              routes: () => [{ path: '/callable', component: Root }],
            },
          },
        }
      ),
      { root: '/workspace/project' }
    )
    expect(compiled.applications[0]?.application?.routes).toEqual([
      { path: '/callable', component: Root },
    ])
  })

  it('rejects defineServer({ routes }) for single applications', () => {
    expect(() =>
      normalizeSsrConfig({
        render: 'ssr',
        routes: [{ path: '/', component: Root }],
      } as never)
    ).toThrow(/defineServer\(\{ routes \}\) is not supported for single applications/)
    expect(() =>
      normalizeSsrConfig({
        routes: [{ path: '/', component: Root }],
      } as never)
    ).toThrow(/Export routes from src\/main\.ts/)
    expect(() =>
      normalizeSsrConfig({
        routes: [{ path: '/', component: Root }],
      } as never)
    ).toThrow(/defineApplication\(\{ routes \}\)/)
  })

  it('rejects plain-object defineServer({ routes }) at compile time', async () => {
    await expect(
      compileSsrConfig(
        {
          default: {
            render: 'ssr',
            routes: [{ path: '/', component: Root }],
          },
        } as never,
        { development: true, root: '/workspace/project' }
      )
    ).rejects.toThrow(/defineServer\(\{ routes \}\) is not supported for single applications/)
  })

  it('still rejects mixed single/multi fields after removing defineServer routes', () => {
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
        routes: [{ path: '/', component: Root }],
        applications: [
          defineApplication({ name: 'website', host: 'example.com' }),
        ],
      } as never)
    ).toThrow(/defineServer\(\{ routes \}\) is not supported for single applications/)
  })

  it('keeps defineApplication({ routes }) for explicit applications', () => {
    const routes = [{ path: '/users', component: Root }]
    const normalized = normalizeSsrConfig(
      defineServer({
        applications: [
          defineApplication({
            name: 'admin',
            host: 'admin.example.com',
            routes,
          }),
        ],
      })
    )
    expect(normalized.applications.admin.routes).toBe(routes)
  })

  it('keeps SPA private SEO mode without a bound server shell', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineServer({
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              host: 'admin.example.com',
              seo: { mode: 'private' },
            }),
          ],
        }),
      },
      { development: true, root: '/workspace/project' }
    )
    const ids = compiled.applications[0]?.endpoints.map((endpoint) => endpoint.id) ?? []
    expect(ids).toContain('erp-robots')
    expect(ids).not.toContain('erp-sitemap')
  })

  it('lets application endpoints own SEO paths instead of conflicting', async () => {
    const compiled = await compileSsrConfig(
      withSsrShells(
        defineServer({
          applications: [
            defineApplication({
              name: 'erp',
              render: 'spa',
              host: 'admin.example.com',
              seo: { mode: 'private' },
              endpoints: [
                {
                  id: 'erp-seo-boundary',
                  ownedPaths: ['/robots.txt', '/sitemap.xml'],
                  match: ({ entryId, pathname }) =>
                    entryId === 'erp' &&
                    (pathname === '/robots.txt' || pathname.startsWith('/sitemap')),
                  handle: () => ({ statusCode: 404 }),
                },
              ],
            }),
            defineApplication({
              name: 'storefront',
              render: 'ssr',
              host: 'shop.example.com',
              endpoints: [
                {
                  id: 'storefront-seo',
                  ownedPaths: ['/robots.txt', '/sitemap.xml'],
                  match: ({ entryId, pathname }) =>
                    entryId === 'storefront' &&
                    (pathname === '/robots.txt' || pathname === '/sitemap.xml'),
                  handle: () => ({ statusCode: 200 }),
                },
              ],
            }),
          ],
        }),
        {
          storefront: { root: Root, main: { default: () => undefined } },
        }
      ),
      { development: true, root: '/workspace/project' }
    )
    const erpIds =
      compiled.applications.find((app) => app.id === 'erp')?.endpoints.map((endpoint) => endpoint.id) ??
      []
    const shopIds =
      compiled.applications
        .find((app) => app.id === 'storefront')
        ?.endpoints.map((endpoint) => endpoint.id) ?? []
    expect(erpIds).toContain('erp-seo-boundary')
    expect(erpIds).not.toContain('erp-sitemap')
    expect(erpIds).not.toContain('erp-robots')
    expect(shopIds).toContain('storefront-seo')
    expect(shopIds).not.toContain('storefront-sitemap')
    expect(shopIds).not.toContain('storefront-robots')
  })

  it('keeps multi-app route-module discovery on the generated client', () => {
    const entries = extractSsrViteEntries(
      defineServer({
        applications: [
          defineApplication({
            name: 'admin',
            host: 'admin.example.com',
            routes: [{ path: '/users', component: Root }],
          }),
        ],
      }),
      {
        root: '/app',
        applicationFiles: new Map([['admin', '/app/src/modules/admin/app.ts']]),
        routesModules: new Map([['admin', './src/modules/admin/routes.ts']]),
      }
    )
    expect(entries.applications[0]).toMatchObject({
      id: 'admin',
      routesModule: './src/modules/admin/routes.ts',
      routesFromMain: false,
    })
    const client = generateSsrClientModule('/app', entries.applications[0])
    expect(client).toContain('modules/admin/routes.ts')
    expect(client).not.toContain('const routes = __ssrMain.routes')
  })

  it('imports a named routes export instead of assuming default', () => {
    const named = generateSsrClientModule('/app', {
      id: 'erp',
      kind: 'spa',
      main: './src/runtime/ErpBootstrap.ts',
      root: './src/runtime/ErpApp.vue',
      routesModule: './src/router/routes.ts',
      routesExport: 'routes',
      template: './index.html',
      mountSelector: '#app',
      routesFromMain: false,
    })
    expect(named).toContain('import { routes as applicationRoutes } from "/app/src/router/routes.ts"')
    expect(named).toContain('const routes = applicationRoutes')
    expect(named).not.toContain('import applicationRoutes from "/app/src/router/routes.ts"')

    const fallback = generateSsrClientModule('/app', {
      id: 'erp',
      kind: 'spa',
      main: './src/runtime/ErpBootstrap.ts',
      root: './src/runtime/ErpApp.vue',
      routesModule: './src/router/routes.ts',
      template: './index.html',
      mountSelector: '#app',
      routesFromMain: false,
    })
    expect(fallback).toContain('import * as applicationRoutes from "/app/src/router/routes.ts"')
    expect(fallback).toContain('const routes = applicationRoutes.default ?? applicationRoutes.routes')
  })
})

describe('defineServer({ routes }) config loading', () => {
  let root = ''

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
  })

  it('recognizes the removed routes property on direct server config exports', async () => {
    await expect(
      sourceDeclaresServerConfigRoutes(
        `import { defineServer } from 'vue-ssr-lite'\nimport { routes } from './src/routes'\nexport default defineServer({\n  render: 'ssr',\n  routes,\n})\n`,
        '/app/server.ts'
      )
    ).resolves.toBe(true)
    await expect(
      sourceDeclaresServerConfigRoutes(
        `import { routes } from './src/routes'\nexport default {\n  render: 'ssr',\n  routes,\n}\n`,
        '/app/server.ts'
      )
    ).resolves.toBe(true)
    await expect(
      sourceDeclaresServerConfigRoutes(
        `import { defineServer } from 'vue-ssr-lite'\nexport default defineServer({ render: 'ssr' })\n`,
        '/app/server.ts'
      )
    ).resolves.toBe(false)
    await expect(
      sourceDeclaresServerConfigRoutes(
        `import { defineServer } from 'vue-ssr-lite'\nimport website from './src/website/app'\nexport default defineServer({ applications: [website] })\n`,
        '/app/server.ts'
      )
    ).resolves.toBe(false)
  })

  it('rejects a loaded plain server.ts that still supplies routes', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-define-server-routes-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'server.ts'),
      "export default { render: 'ssr', routes: [{ path: '/' }] }\n"
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /defineServer\(\{ routes \}\) is not supported for single applications[\s\S]*Export routes from src\/main\.ts[\s\S]*defineApplication\(\{ routes \}\)/
    )
  })

  it('rejects defineServer({ routes }) before aliased route imports enter the config bundle', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-legacy-server-routes-alias-'))
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
      `import { HOME_PATH } from '@/constants'\nimport Home from './Home.vue'\nexport const routes = [{ path: HOME_PATH, component: Home }]\n`
    )
    await writeFile(
      join(root, 'src/main.ts'),
      `import { routes } from './routes'\nexport { routes }\nexport default () => {}\n`
    )
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineServerPath)}\nimport { routes } from './src/routes'\nexport default defineServer({\n  render: 'ssr',\n  routes,\n})\n`
    )
    let rejected: unknown
    try {
      await loadSsrConfigFile(root)
    } catch (error) {
      rejected = error
    }
    expect(rejected).toBeInstanceOf(Error)
    const message = (rejected as Error).message
    expect(message).toBe(DEFINE_SERVER_ROUTES_ERROR)
    expect(message).not.toMatch(/ERR_MODULE_NOT_FOUND/)
    expect(message).not.toMatch(/Cannot find package '@\/constants'/)
  })
})
