import { describe, expect, it } from 'vitest'
import {
  assertSupportedSsrViteBase,
  createSsrRenderedAssetResolver,
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
        moduleIds: ['src/Home.vue', 'src/Product.vue?vue&type=script&setup=true&lang.ts'],
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

  it('resolves tree-shaken TypeScript SFC facades from their authoritative script/block entries', () => {
    // Vite 7 + plugin-vue emits this shape for an inlined <script setup lang="ts">
    // component whose forwarding .vue facade has disappeared from the client.
    const manifest = {
      'src/App.vue?vue&type=script&setup=true&lang.ts': [],
      'src/Page.vue': [],
      'src/Page.vue?vue&type=script&setup=true&lang.ts': ['/assets/page.js', '/assets/shared.css'],
      'src/Page.vue?vue&type=template&id=abc&lang.js': ['/assets/page.js'],
      'src/Page.vue?vue&type=style&index=0&scoped=abc&lang.css': ['/assets/page.css'],
      'src/Other.vue?vue&type=script&setup=true&lang.ts': ['/assets/other.css'],
    }
    const resolve = createSsrRenderedAssetResolver(manifest, '/', '/build/project')
    expect(resolve('app', ['src/App.vue', '/build/project/src/Page.vue'])).toEqual([
      { applicationId: 'app', href: '/assets/page.js', rel: 'modulepreload' },
      { applicationId: 'app', href: '/assets/shared.css', rel: 'stylesheet' },
      { applicationId: 'app', href: '/assets/page.css', rel: 'stylesheet' },
    ])
    expect(() => resolve('app', ['src/Absent.vue'])).toThrow('rendered-assets.module-not-in-manifest')
    expect(resolve('other', ['src/Other.vue'])).toEqual([
      { applicationId: 'other', href: '/assets/other.css', rel: 'stylesheet' },
    ])
  })

  it.each([
    { root: '/build/project', absolute: '/build/project/src/Page.vue', key: 'src/Page.vue' },
    { root: '/build/project', absolute: '/build/ui/src/Page.vue', key: '../ui/src/Page.vue' },
    { root: '/build/project', absolute: '/build/project/node_modules/ui/Page.vue', key: 'node_modules/ui/Page.vue' },
    { root: 'C:\\build\\project', absolute: 'C:\\build\\project\\src\\Page.vue', key: 'src/Page.vue' },
    { root: 'C:/build/project', absolute: 'C:/build/ui/src/Page.vue', key: '../ui/src/Page.vue' },
    { root: 'C:/build/project', absolute: 'D:/ui/src/Page.vue', key: 'D:/ui/src/Page.vue' },
  ])('uses the original build root for $absolute without suffix guessing', ({ root, absolute, key }) => {
    const manifest = { [`${key}?vue&type=script&lang.ts`]: ['/assets/page.css'] }
    const cached = createSsrRenderedAssetResolver(manifest, '/', root)
    expect(cached('app', [absolute])).toEqual([
      { applicationId: 'app', href: '/assets/page.css', rel: 'stylesheet' },
    ])
    expect(resolveRenderedApplicationAssets({ applicationId: 'app', moduleIds: [absolute], manifest, base: '/', root }))
      .toEqual(cached('app', [absolute]))
  })

  it('preserves virtual identities and arbitrary queries instead of collapsing them', () => {
    const resolve = createSsrRenderedAssetResolver({
      '\0virtual:generated/Page.vue?vue&type=script&lang.ts': ['/assets/generated.css'],
      'src/Page.vue': ['/assets/page.css'],
      'src/Page.vue?variant=mobile': ['/assets/mobile.css'],
      'src/Page.vue?vue&type=script&variant=mobile&lang.ts': ['/assets/mobile-block.css'],
      'src/Page.vue?raw': [],
      'src/Page.vue?vue&type=script&src=true&lang.ts': ['/assets/external.css'],
      'node_modules/ui/Page.vue?vue&type=script&lang.ts': ['/assets/package.css'],
      '../ui/src/Page.vue?vue&type=script&lang.ts': ['/assets/workspace.css'],
    }, '/', '/build/project')
    expect(resolve('app', ['\0virtual:generated/Page.vue']).map((asset) => asset.href)).toEqual(['/assets/generated.css'])
    expect(resolve('app', ['src\\Page.vue']).map((asset) => asset.href)).toEqual(['/assets/page.css'])
    expect(resolve('app', ['src/Page.vue?variant=mobile']).map((asset) => asset.href)).toEqual(['/assets/mobile.css'])
    expect(resolve('app', ['src/Page.vue?vue&type=script&variant=mobile&lang.ts']).map((asset) => asset.href)).toEqual(['/assets/mobile-block.css'])
    for (const id of ['virtual:generated/Page.vue', 'src/Page.vue?unknown', '/other/project/src/Page.vue', 'ui/Page.vue']) {
      expect(() => resolve('app', [id])).toThrow('rendered-assets.module-not-in-manifest')
    }
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
