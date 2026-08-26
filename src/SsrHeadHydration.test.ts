// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { RouterView } from 'vue-router'
import { useSeo } from './extensions/seo/useSeo'
import { hydrateSsrApplication } from './SsrBrowserRuntime'
import { getSsrStateElementId } from './SsrSerialization'
import { createTestDomain } from './SsrTestFixtures'

describe('client head hydration', () => {
  it('adopts SSR-marked tags without duplicating them', async () => {
    document.documentElement.setAttribute('lang', 'en')
    document.documentElement.setAttribute('dir', 'ltr')
    document.documentElement.setAttribute('data-theme', 'dark')
    document.head.innerHTML = `
      <title data-vue-ssr-lite-head="title">About</title>
      <meta name="description" content="Learn" data-vue-ssr-lite-head="description">
      <link rel="icon" href="/favicon.ico">
    `
    document.body.innerHTML = '<div id="app"></div>'
    const state = document.createElement('script')
    state.id = getSsrStateElementId('hydrate-head')
    state.type = 'application/json'
    state.textContent = JSON.stringify({
      version: 1,
      applicationId: 'hydrate-head',
      publicConfig: {},
      siteOrigin: 'https://ex.test',
      domain: createTestDomain('ex.test'),
      application: {},
    })
    document.body.append(state)
    window.history.replaceState({}, '', '/')

    await hydrateSsrApplication({
      id: 'hydrate-head',
      root: defineComponent({ setup: () => () => h(RouterView) }),
      routes: [
        {
          path: '/',
          component: defineComponent({
            setup() {
              useSeo({
                title: 'About',
                description: 'Learn',
                htmlAttributes: { lang: 'en', dir: 'ltr' },
              })
              return () => h('main', 'About')
            },
          }),
        },
      ],
      seo: { siteUrl: 'https://ex.test' },
    })

    expect(document.querySelectorAll('title')).toHaveLength(1)
    expect(document.querySelectorAll('meta[name="description"]')).toHaveLength(1)
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
      '/favicon.ico'
    )
    expect(document.title).toBe('About')
    expect(document.documentElement.getAttribute('lang')).toBe('en')
    expect(document.documentElement.getAttribute('dir')).toBe('ltr')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    document.documentElement.removeAttribute('lang')
    document.documentElement.removeAttribute('dir')
    document.documentElement.removeAttribute('data-theme')
  })
})
