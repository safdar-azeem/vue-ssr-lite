import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { RouterView } from 'vue-router'
import { analyticsExtension } from '../../fixtures/advanced-consumer/src/extensions/custom-analytics'
import { createTestApplication } from '../SsrTestFixtures'
import { renderSsrApplication } from '../SsrRenderRuntime'
import { serializeManagedHead } from '../SsrManagedHead'
import { createTestRenderRequest } from '../SsrTestFixtures'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/advanced-consumer'
)

describe('advanced consumer fixture', () => {
  it('contributes typed extension state to the managed head', async () => {
    const Home = defineComponent({
      setup: () => () => h('main', 'advanced'),
    })
    const rendered = await renderSsrApplication(
      createTestApplication({
        id: 'advanced',
        root: defineComponent({ setup: () => () => h(RouterView) }),
        routes: [{ path: '/', component: Home }],
        seo: { siteUrl: 'https://ex.test' },
        extensions: [analyticsExtension({ propertyId: 'UA-123456' })],
      }),
      createTestRenderRequest('ex.test', {
        url: 'https://ex.test/',
        siteOrigin: 'https://ex.test',
        siteSeo: { title: 'Advanced tenant', siteName: 'Advanced' },
      })
    )
    expect(rendered.head.title).toBe('Advanced tenant')
    expect(serializeManagedHead(rendered.head)).toContain('x-analytics-id')
    expect(serializeManagedHead(rendered.head)).toContain('UA-123456')
  })

  it('does not import server modules from the public extension', async () => {
    const source = await readFile(
      join(fixtureRoot, 'src/extensions/custom-analytics.ts'),
      'utf8'
    )
    expect(source).not.toMatch(/node:fs|process\.env|vue-ssr-lite\/server/)
    const main = await readFile(join(fixtureRoot, 'src/main.ts'), 'utf8')
    expect(main).not.toContain('extensions:')
    expect(main).not.toContain('seoExtension')
    const server = await readFile(join(fixtureRoot, 'server.ts'), 'utf8')
    expect(server).toContain('extensions:')
    expect(server).toContain('defineServer')
  })
})

describe('advanced consumer browser projection', () => {
  it('projects server-registered extensions into the generated client without importing server.ts', async () => {
    const { loadSsrConfigFile, extractSsrViteEntries, generateSsrClientModule } =
      await import('../SsrConfigCompileRuntime')
    const config = await loadSsrConfigFile(fixtureRoot)
    const entries = extractSsrViteEntries(config, { root: fixtureRoot })
    const client = generateSsrClientModule(fixtureRoot, entries.applications[0])
    expect(client).toContain('UA-123456')
    expect(client).toContain('extensions:')
    expect(client).toContain('custom-analytics')
    expect(client).not.toMatch(/from ["'].*server\.ts["']/)
    expect(client).not.toContain('SeoEndpoints')
  })
})
