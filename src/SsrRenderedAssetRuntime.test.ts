import { describe, expect, it } from 'vitest'
import {
  assertSupportedSsrViteBase,
  parseSsrViteManifest,
  resolveRenderedApplicationAssets,
} from './SsrRenderedAssetRuntime'

describe('request-aware SSR assets', () => {
  it('maps only rendered modules and deduplicates shared CSS and chunks', () => {
    const manifest = {
      'src/Home.vue': ['/base/assets/home.js', '/base/assets/shared.css'],
      'src/Product.vue': [
        '/base/assets/product.js',
        '/base/assets/shared.css',
        '/base/assets/product.css',
      ],
      'src/Admin.vue': ['/base/assets/admin.js', '/base/assets/admin.css'],
    }
    expect(
      resolveRenderedApplicationAssets({
        applicationId: 'website',
        moduleIds: ['src/Home.vue', 'src/Product.vue?used'],
        base: '/base/',
        manifest,
      })
    ).toEqual([
      { applicationId: 'website', href: '/base/assets/home.js', rel: 'modulepreload' },
      { applicationId: 'website', href: '/base/assets/shared.css', rel: 'stylesheet' },
      { applicationId: 'website', href: '/base/assets/product.js', rel: 'modulepreload' },
      { applicationId: 'website', href: '/base/assets/product.css', rel: 'stylesheet' },
    ])
  })

  it('uses the resolved Vite base rather than inferring one from HTML', () => {
    const manifest = { 'src/Page.vue': ['assets/page.js', 'assets/page.css'] }
    expect(
      resolveRenderedApplicationAssets({
        applicationId: 'shop',
        moduleIds: ['src/Page.vue'],
        base: '/shop/',
        manifest,
      }).map(({ href }) => href)
    ).toEqual(['/shop/assets/page.js', '/shop/assets/page.css'])
  })

  it('preserves Vite-generated CDN URLs and rejects relative SSR bases', () => {
    const manifest = {
      'src/Page.vue': [
        'https://cdn.example.com/products/assets/page.js',
        'https://cdn.example.com/products/assets/page.css',
      ],
    }
    expect(
      resolveRenderedApplicationAssets({
        applicationId: 'shop',
        moduleIds: ['src/Page.vue'],
        base: 'https://cdn.example.com/products/',
        manifest,
      }).map(({ href }) => href)
    ).toEqual(manifest['src/Page.vue'])
    expect(() => assertSupportedSsrViteBase('./')).toThrow(
      'does not support Vite relative base'
    )
  })

  it('fails clearly for malformed metadata and unresolved rendered modules', () => {
    expect(() => parseSsrViteManifest('{')).toThrow('could not parse')
    expect(() => parseSsrViteManifest('{"page": "page.js"}')).toThrow(
      'contain only asset filenames'
    )
    expect(() =>
      resolveRenderedApplicationAssets({
        applicationId: 'app',
        moduleIds: ['src/Missing.vue'],
        base: '/',
        manifest: {},
      })
    ).toThrow('could not resolve rendered module')
  })
})
