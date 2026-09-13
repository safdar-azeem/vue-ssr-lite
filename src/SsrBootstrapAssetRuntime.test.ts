import { describe, expect, it } from 'vitest'
import { createSsrBootstrapAssetResolver, parseSsrBootstrapAssetManifest, selectSsrBootstrapCapabilityFiles, selectSsrBootstrapCapabilityKeys } from './SsrBootstrapAssetRuntime'
import { injectSsrRenderedAssets } from './server/SsrHtmlRuntime'
import { isSsrPrivateProductionAssetPath } from './server/SsrAssetRuntime'
import { readSsrHtmlAttributes } from './SsrHtmlParsing'

const metadata = () => ({ version: 1, policy: 'enabled', applications: {
  website: { initial: ['navigation', 'seo', 'extensions'], capabilities: {
    navigation: ['nav.js'], seo: ['seo.js', 'shared.js'], extensions: ['shared.js'], middleware: ['mw.js'],
  } },
  admin: { initial: ['navigation'], capabilities: { navigation: ['nav.js'] } },
} })

describe('production bootstrap assets', () => {
  it('selects only initial ∪ request files and does not flatten the capability map', () => {
    const capabilities = metadata().applications.website.capabilities
    const keys = selectSsrBootstrapCapabilityKeys(['navigation', 'seo', 'extensions'], [])
    expect(keys).toEqual(['navigation', 'seo', 'extensions'])
    expect(selectSsrBootstrapCapabilityFiles(capabilities, keys).sort()).toEqual(['nav.js', 'seo.js', 'shared.js'])
    expect(selectSsrBootstrapCapabilityFiles(capabilities, keys)).not.toContain('mw.js')
    expect(selectSsrBootstrapCapabilityFiles(capabilities, selectSsrBootstrapCapabilityKeys(['navigation', 'seo', 'extensions'], ['middleware'])).sort())
      .toEqual(['mw.js', 'nav.js', 'seo.js', 'shared.js'])
  })

  it.each(['/', '/products/', 'https://cdn.example.test/products/'])('merges only the owning request under %s', (base) => {
    const resolve = createSsrBootstrapAssetResolver(parseSsrBootstrapAssetManifest(JSON.stringify(metadata())), base)
    expect(resolve('website').map((asset) => asset.href)).not.toContain(`${base}mw.js`)
    const assets = resolve('website', ['middleware'])
    expect(assets.map((asset) => asset.href).sort()).toEqual(
      ['nav.js', 'seo.js', 'shared.js', 'mw.js'].map((file) => `${base}${file}`).sort()
    )
    expect(assets.every((asset) => asset.applicationId === 'website' && asset.rel === 'modulepreload')).toBe(true)
    expect(resolve('admin').map((asset) => asset.href)).toEqual([`${base}nav.js`])
    expect(resolve('missing', ['seo'])).toEqual([])
    const template = `<html><head><link rel="modulepreload" href="${base}seo.js"></head><body><script type="module" src="${base}nav.js"></script></body></html>`
    const html = injectSsrRenderedAssets(template, [...assets, ...assets])
    const preloads = [...html.matchAll(/<link\b([^>]*)>/gi)].flatMap(([, attributes]) => {
      const values = new Map(readSsrHtmlAttributes(attributes!))
      return values.get('rel')?.split(/\s+/).includes('modulepreload') ? [values.get('href')] : []
    })
    // nav.js is already owned by the module script; seo.js is already preloaded.
    expect(preloads.sort()).toEqual(['seo.js', 'shared.js', 'mw.js'].map((file) => `${base}${file}`).sort())
    expect(html).toContain(`<script type="module" src="${base}nav.js"></script>`)
    expect(html.match(new RegExp('shared\\.js', 'g'))).toHaveLength(1)
    expect(html).not.toContain('rel="stylesheet"')
  })

  it('uses already-bound application routing facts for a hybrid SPA shell', () => {
    const value = metadata()
    value.applications.admin.initial = []
    const resolve = createSsrBootstrapAssetResolver(parseSsrBootstrapAssetManifest(JSON.stringify(value)), '/', new Map([['admin', ['navigation' as const]]]))
    expect(resolve('admin').map((asset) => asset.href)).toEqual(['/nav.js'])
  })

  it('validates version and schema and snapshots immutable lookup inputs', () => {
    expect(() => parseSsrBootstrapAssetManifest('{')).toThrow()
    expect(() => parseSsrBootstrapAssetManifest(JSON.stringify({ ...metadata(), version: 2 }))).toThrow()
    expect(() => parseSsrBootstrapAssetManifest(JSON.stringify({ ...metadata(), sourceRoot: '/secret' }))).toThrow()
    const manifest = parseSsrBootstrapAssetManifest(JSON.stringify(metadata()))
    expect(Object.isFrozen(manifest.applications.website!.capabilities.seo)).toBe(true)
    expect(Object.isFrozen(manifest.applications)).toBe(true)
  })

  it.each(['/root/a.js', '../a.js', 'assets/../a.js', 'https://secret/a.js', '.vite/a.js', 'assets/%2e%2e/a.js', 'a\\b.js', 'a.js?secret', 'a.css'])('rejects unsafe/private identity %s', (file) => {
    const value = metadata()
    value.applications.website.capabilities.seo = [file]
    expect(() => parseSsrBootstrapAssetManifest(JSON.stringify(value))).toThrow()
  })

  it.each(['', '.', './'])('leaves pure SPA relative base %s to normal imports', (base) => {
    const manifest = parseSsrBootstrapAssetManifest(JSON.stringify(metadata()))
    expect(createSsrBootstrapAssetResolver(manifest, base)('website')).toEqual([])
  })

  it('disables request additions as well as static hints when policy is disabled', () => {
    const manifest = parseSsrBootstrapAssetManifest(JSON.stringify({ version: 1, policy: 'disabled', applications: {
      website: { initial: ['seo'], capabilities: {} },
    } }))
    expect(createSsrBootstrapAssetResolver(manifest, '/')('website', ['middleware'])).toEqual([])
    expect(isSsrPrivateProductionAssetPath('/products/.vite/vue-ssr-lite-bootstrap.json', '/products/')).toBe(true)
    expect(isSsrPrivateProductionAssetPath('/products/%2evite/vue-ssr-lite-bootstrap.json', '/products/')).toBe(true)
  })
})
