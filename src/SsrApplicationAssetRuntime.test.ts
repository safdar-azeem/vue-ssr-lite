import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { generateSsrDevelopmentStylesheetHandoff } from './SsrApplicationAssetRuntime'

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
})
