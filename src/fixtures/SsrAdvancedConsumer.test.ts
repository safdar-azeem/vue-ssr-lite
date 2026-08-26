import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { RouterView } from 'vue-router'
import { analyticsExtension } from '../../fixtures/advanced-consumer/src/extensions/custom-analytics'
import { defineApplication } from '../index'
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
      defineApplication({
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
    expect(main).toContain('extensions:')
    expect(main).not.toContain('seoExtension')
  })
})
