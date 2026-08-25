import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  activateSsrDevelopmentRenderedStylesheets,
  generateSsrDevelopmentStylesheetHandoff,
} from './SsrApplicationAssetRuntime'

describe('application stylesheet ownership handoff', () => {
  it('removes only the selected application temporary links', () => {
    const dom = new JSDOM(`<html><head>
      <link rel="stylesheet" href="/app.css" data-vue-ssr-lite-style="app">
      <link rel="stylesheet" href="/admin.css" data-vue-ssr-lite-style="admin">
      <link rel="stylesheet" href="/vendor.css">
      <style>body { margin: 0 }</style>
    </head></html>`)
    const runHandoff = new Function(
      'document',
      generateSsrDevelopmentStylesheetHandoff('app').join('\n')
    )

    runHandoff(dom.window.document)

    expect(dom.window.document.querySelector('link[href="/app.css"]')).toBeNull()
    expect(dom.window.document.querySelector('link[href="/admin.css"]')).not.toBeNull()
    expect(dom.window.document.querySelector('link[href="/vendor.css"]')).not.toBeNull()
    expect(dom.window.document.querySelector('style')).not.toBeNull()
  })

  it('keeps each rendered stylesheet until its Vite CSS module is active', async () => {
    const dom = new JSDOM(`<html><head>
      <link rel="stylesheet" href="/bootstrap.css" data-vue-ssr-lite-style="app">
      <link rel="stylesheet" href="/route.css" data-vue-ssr-lite-rendered-style="app">
      <link rel="stylesheet" href="/admin.css" data-vue-ssr-lite-rendered-style="admin">
    </head></html>`)
    const runBootstrapHandoff = new Function(
      'document',
      generateSsrDevelopmentStylesheetHandoff('app').join('\n')
    )
    runBootstrapHandoff(dom.window.document)
    expect(dom.window.document.querySelector('link[href="/bootstrap.css"]')).toBeNull()
    expect(dom.window.document.querySelector('link[href="/route.css"]')).not.toBeNull()

    let activateRoute: (() => void) | undefined
    let activateAdmin: (() => void) | undefined
    const routeActivation = new Promise<void>((resolve) => {
      activateRoute = resolve
    })
    const adminActivation = new Promise<void>((resolve) => {
      activateAdmin = resolve
    })
    const handoff = activateSsrDevelopmentRenderedStylesheets(
      'app',
      dom.window.document as unknown as Document,
      (href) => (href === '/route.css' ? routeActivation : adminActivation)
    )
    // Neither style is removed by unrelated router timing; only a successful
    // activation of this application's logical Vite CSS module can release it.
    expect(dom.window.document.querySelector('link[href="/route.css"]')).not.toBeNull()
    activateRoute!()
    await Promise.resolve()
    expect(dom.window.document.querySelector('link[href="/route.css"]')).toBeNull()
    expect(dom.window.document.querySelector('link[href="/admin.css"]')).not.toBeNull()
    await handoff
    activateAdmin!()
  })

  it('retains a rendered stylesheet when Vite CSS activation fails', async () => {
    const dom = new JSDOM(`<html><head>
      <link rel="stylesheet" href="/async-card.css" data-vue-ssr-lite-rendered-style="app">
    </head></html>`)
    const warning = console.warn
    console.warn = () => undefined
    try {
      await activateSsrDevelopmentRenderedStylesheets(
        'app',
        dom.window.document as unknown as Document,
        async () => Promise.reject(new Error('not loaded yet'))
      )
    } finally {
      console.warn = warning
    }
    expect(dom.window.document.querySelector('link[href="/async-card.css"]')).not.toBeNull()
  })
})
