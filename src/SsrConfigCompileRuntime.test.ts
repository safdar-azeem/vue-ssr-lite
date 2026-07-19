import { describe, expect, it } from 'vitest'
import {
  compileSsrConfig,
  extractSsrViteEntries,
  transformSsrModuleRefs,
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
              spa: {
                id: 'erp',
                rootComponent: {} as any,
              },
              template: 'index.html',
              roles: ['unified', 'erp'],
              domain: {
                development: 'localhost',
                production: 'app.example.com',
                mode: 'root-and-subdomains',
                localAliases: true,
                expose: { subdomainAs: 'workspace' },
              },
            },
            storefront: {
              ssr: {
                id: 'shop',
                rootComponent: {} as any,
              },
              template: 'site.html',
              roles: ['unified', 'storefront'],
              domain: {
                development: 'shop.localhost',
                production: 'shop.example.com',
                mode: 'root-and-subdomains',
                customDomains: true,
                expose: { subdomainOrHostnameAs: 'storeDomain' },
              },
            },
          },
        }),
      },
      { development: true }
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
      const domain = resolveSsrDomainContext(
        host,
        matched!.entry,
        true
      )
      if (entryId === 'erp') {
        expect(domain.params.workspace || '').toBe(expectedParam)
      } else {
        expect(domain.params.storeDomain || '').toBe(expectedParam)
      }
    }

    // Specificity: shop subdomain beats portal wildcard regardless of order.
    expect(
      resolveSsrHostEntry(
        [...compiled.applications].reverse(),
        'store1.shop.localhost'
      )?.entry.id
    ).toBe('storefront')
  })

  it('extracts Vite entries from module-ref SSR apps and SPA shells', () => {
    const entries = extractSsrViteEntries(
      defineSsrConfig({
        name: 'demo',
        applications: {
          erp: {
            spa: true,
            template: 'index.html',
            domain: {
              development: 'localhost',
              production: 'app.example.com',
            },
          },
          storefront: {
            ssr: {
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
    )

    expect(entries.spaEntries).toEqual({ erp: 'index.html' })
    expect(entries.applications).toEqual([
      {
        id: 'storefront',
        definition: './src/ShopSsrApplication.ts',
        exportName: 'shopSsrApplication',
        template: 'site.html',
        mountSelector: '#app',
      },
    ])
  })

  it('rewrites ssr module refs into analyzable dynamic imports', () => {
    const source = `
      storefront: {
        ssr: {
          module: './src/ShopSsrApplication.ts',
          exportName: 'shopSsrApplication',
        },
        template: 'site.html',
      },
    `
    const transformed = transformSsrModuleRefs(source, '/app/ssr.config.ts')
    expect(transformed).toContain(
      'ssr: () => import("./src/ShopSsrApplication.ts").then((m) => m["shopSsrApplication"])'
    )
  })
})
