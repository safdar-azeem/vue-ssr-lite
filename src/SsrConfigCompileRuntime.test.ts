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

  it('rejects missing production runtime and API configuration', async () => {
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
                publicConfig: { api: { endpoint: 'http://localhost/graphql' } },
              },
            },
          }),
        },
        { development: false }
      )
    ).rejects.toThrow(/requires `runtime`/)
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
    expect(runtime).toContain(
      'import { createErpApplication as __ssrApp0 } from "/app/src/ErpBootstrap.ts"'
    )
    expect(runtime).toContain(
      'import { shopSsrApplication as __ssrApp1 } from "/app/src/ShopSsrApplication.ts"'
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
