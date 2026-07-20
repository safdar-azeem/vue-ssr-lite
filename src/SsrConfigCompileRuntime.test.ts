import { describe, expect, it } from 'vitest'
import {
  compileSsrConfig,
  extractSsrViteEntries,
  generateSsrClientModule,
  generateSsrRuntimeModule,
} from './SsrConfigCompileRuntime'
import { defineSsrConfig } from './SsrConfigRuntime'
import { resolveSsrDomainContext } from './SsrDomainRuntime'
import { resolveSsrHostEntry } from './server/SsrHostRuntime'

describe('defineSsrConfig application domains', () => {
  it('compiles app-centric domains and resolves context params', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineSsrConfig({
          name: 'demo',
          runtime: 'unified',
          applications: {
            erp: {
              render: 'spa',
              application: {
                module: './src/ErpBootstrap.ts',
                exportName: 'createErpApplication',
              },
              template: 'index.html',
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
            },
            storefront: {
              render: 'ssr',
              application: {
                id: 'ignored-legacy-id',
                rootComponent: {} as any,
              },
              template: 'site.html',
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
            },
          },
        }),
      },
      { development: true }
    )

    expect(compiled.applications.find((app) => app.id === 'storefront')?.application?.id).toBe(
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

  it('rejects missing production runtime', async () => {
    await expect(
      compileSsrConfig(
        {
          default: defineSsrConfig({
            name: 'demo',
            applications: {
              erp: {
                render: 'spa',
                application: {
                  module: './src/Erp.ts',
                  exportName: 'createErpApplication',
                },
                template: 'index.html',
                domain: {
                  development: 'localhost',
                  production: 'app.example.com',
                },
              },
            },
          }),
        },
        { development: false }
      )
    ).rejects.toThrow(/requires `runtime`/)
  })

  it('rejects missing domain.production in production', async () => {
    await expect(
      compileSsrConfig(
        {
          default: defineSsrConfig({
            name: 'demo',
            runtime: 'unified',
            applications: {
              erp: {
                render: 'spa',
                application: {
                  module: './src/Erp.ts',
                  exportName: 'createErpApplication',
                },
                template: 'index.html',
                domain: {
                  development: 'localhost',
                  production: '',
                },
              },
            },
          }),
        },
        { development: false }
      )
    ).rejects.toThrow(/requires domain.production/)
  })

  it('does not require publicConfig.api.endpoint in production', async () => {
    const compiled = await compileSsrConfig(
      {
        default: defineSsrConfig({
          name: 'demo',
          runtime: 'unified',
          applications: {
            erp: {
              render: 'spa',
              application: {
                module: './src/Erp.ts',
                exportName: 'createErpApplication',
              },
              template: 'index.html',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
              },
              publicConfig: { featureFlags: { darkMode: true } },
            },
          },
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
        default: defineSsrConfig({
          name: 'demo',
          runtime: 'unified',
          applications: {
            erp: {
              render: 'spa',
              application: {
                module: './src/ErpBootstrap.ts',
                exportName: 'createErpApplication',
              },
              template: 'index.html',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
                mode: 'root-and-subdomains',
                localAliases: true,
              },
            },
            storefront: {
              render: 'ssr',
              application: {
                id: 'storefront',
                rootComponent: {} as any,
              },
              template: 'site.html',
              domain: {
                development: 'shop.localhost',
                production: 'shop.example.com',
                mode: 'root-and-subdomains',
                localAliases: true,
              },
            },
          },
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
        default: defineSsrConfig({
          name: 'demo',
          runtime: 'unified',
          server: { onMetrics, renderError },
          applications: {
            erp: {
              render: 'spa',
              application: {
                module: './src/Erp.ts',
                exportName: 'createErpApplication',
              },
              template: 'index.html',
              domain: {
                development: 'localhost',
                production: 'app.example.com',
              },
            },
          },
        }),
      },
      { development: true }
    )
    expect(compiled.server.onMetrics).toBe(onMetrics)
    expect(compiled.server.renderError).toBe(renderError)
  })

  it('extracts Vite entries and generates virtual modules without regex rewrites', () => {
    const config = defineSsrConfig({
      name: 'demo',
      applications: {
        erp: {
          render: 'spa',
          application: {
            module: './src/ErpBootstrap.ts',
            exportName: 'createErpApplication',
          },
          template: 'index.html',
          domain: {
            development: 'localhost',
            production: 'app.example.com',
          },
        },
        storefront: {
          render: 'ssr',
          application: {
            module: './src/ShopSsrApplication.ts',
            exportName: 'shopSsrApplication',
          },
          template: 'site.html',
          mountSelector: '#app',
          domain: {
            development: 'shop.localhost',
            production: 'shop.example.com',
            customDomains: true,
          },
        },
      },
    })
    const entries = extractSsrViteEntries(config)
    expect(entries.applications.map((app) => app.id)).toEqual([
      'erp',
      'storefront',
    ])

    const runtime = generateSsrRuntimeModule(
      '/app',
      '/app/ssr.config.ts',
      entries.applications
    )
    expect(runtime).toContain('import __ssrUserConfig from "/app/ssr.config.ts"')
    expect(runtime).not.toContain('ErpBootstrap')
    expect(runtime).toContain(
      'import { shopSsrApplication as __ssrApp0 } from "/app/src/ShopSsrApplication.ts"'
    )
    expect(runtime).not.toMatch(/ssr\s*:\s*\(\)\s*=>\s*import/)

    const spaClient = generateSsrClientModule('/app', entries.applications[0])
    expect(spaClient).toContain('mountSpaApplication')
    expect(spaClient).toContain('id: "erp"')
    expect(spaClient).toContain('from "/app/src/ErpBootstrap.ts"')

    const ssrClient = generateSsrClientModule('/app', entries.applications[1])
    expect(ssrClient).toContain('hydrateSsrApplication')
    expect(ssrClient).toContain('id: "storefront"')
    expect(ssrClient).toContain('from "/app/src/ShopSsrApplication.ts"')
  })
})
