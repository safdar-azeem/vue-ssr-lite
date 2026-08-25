// @vitest-environment jsdom
import { createSSRApp, defineComponent, h, Teleport } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import { injectSsrHtml, prepareSsrHtmlTemplate } from './server/SsrHtmlRuntime'
import { createTestDomain } from './SsrTestFixtures'

describe('native Vue Teleport SSR integration', () => {
  it('injects dedicated and shared targets that hydrate without mismatch', async () => {
    const Root = defineComponent({
      setup: () => () =>
        h('main', { id: 'shell' }, [
          h('h1', 'Teleport shell'),
          h(Teleport, { to: '#modals' }, [
            h('div', { id: 'modal-one' }, 'First modal'),
            h('div', { id: 'modal-two' }, 'Second modal'),
          ]),
          h(Teleport, { to: '#modals' },
            h('div', { id: 'modal-three' }, 'Third modal')
          ),
          h(Teleport, { to: '#toasts' },
            h('div', { id: 'toast-one' }, 'Toast')
          ),
        ]),
    })

    const ssrContext: Record<string, unknown> = {}
    const rendered = await renderToString(createSSRApp(Root), ssrContext)
    const teleports = ssrContext.teleports as Record<string, string>
    expect(Object.keys(teleports)).toEqual(
      expect.arrayContaining(['#modals', '#toasts'])
    )

    const template = prepareSsrHtmlTemplate(
      '<!doctype html><html><head></head><body><div id="app"></div><div id="modals"></div><div id="toasts"></div></body></html>'
    )
    const documentHtml = injectSsrHtml(template, {
      applicationId: 'teleport-integration',
      html: rendered,
      teleports,
      head: { tags: [] },
      state: {
        version: 1,
        applicationId: 'teleport-integration',
        publicConfig: {},
        domain: createTestDomain('teleport.test'),
        application: {},
      },
    })

    document.open()
    document.write(documentHtml)
    document.close()

    const modalTarget = document.querySelector('#modals')
    expect([...modalTarget!.children].map((child) => child.id)).toEqual([
      'modal-one',
      'modal-two',
      'modal-three',
    ])
    expect(document.querySelector('#toasts > #toast-one')).not.toBeNull()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const clientApp = createSSRApp(Root)
      clientApp.mount('#app')
      await Promise.resolve()
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      clientApp.unmount()
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
