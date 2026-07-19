import { describe, expect, it } from 'vitest'
import { vueSsrLite } from './SsrVitePlugin'

const runConfig = async (
  options: Parameters<typeof vueSsrLite>[0],
  command: 'serve' | 'build' = 'serve'
) => {
  const plugin = vueSsrLite(options)
  const configHook = plugin.config
  if (typeof configHook !== 'function') {
    throw new Error('vueSsrLite must expose a Vite config hook.')
  }
  return (await configHook.call(
    {} as never,
    {},
    {
      command,
      mode: 'test',
      isSsrBuild: command === 'build',
      isPreview: false,
    }
  )) as {
    resolve?: { dedupe?: string[] }
    ssr?: {
      external?: string[]
      noExternal?: Array<string | RegExp>
    }
  }
}

describe('SSR Vite package identity', () => {
  it('deduplicates Vue and externalizes vue-ssr-lite by default', async () => {
    const config = await runConfig({
      applications: [
        { id: 'storefront', definition: 'src/SsrApplication.ts', template: 'site.html' },
      ],
    })

    expect(config.resolve?.dedupe).toContain('vue')
    expect(config.resolve?.dedupe).toContain('vue-router')
    expect(config.resolve?.dedupe).toContain('vue-ssr-lite')
    expect(config.ssr?.external).toContain('vue-ssr-lite')
    expect(config.ssr?.noExternal).not.toContain('vue-ssr-lite')
  })

  it('uses the same package externalization contract in development and production', async () => {
    const options = {
      applications: [
        { id: 'storefront', definition: 'src/SsrApplication.ts', template: 'site.html' },
      ],
    }
    const [development, production] = await Promise.all([
      runConfig(options, 'serve'),
      runConfig(options, 'build'),
    ])

    expect(development.ssr?.external).toContain('vue-ssr-lite')
    expect(production.ssr?.external).toContain('vue-ssr-lite')
  })

  it('stays API-client neutral: no Apollo or GraphQL packages by default', async () => {
    const config = await runConfig({
      applications: [
        { id: 'storefront', definition: 'src/SsrApplication.ts', template: 'site.html' },
      ],
    })

    expect(config.resolve?.dedupe).not.toContain('@apollo/client')
    expect(config.resolve?.dedupe).not.toContain('vue-apollo-client')
    expect(config.ssr?.external).not.toContain('@apollo/client')
    expect(config.ssr?.noExternal).not.toContain('@apollo/client')
    expect(config.ssr?.noExternal).not.toContain('vue-apollo-client')
  })

  it('lets the consumer supply its own dedupe and SSR-inlined client packages', async () => {
    const config = await runConfig({
      applications: [
        { id: 'storefront', definition: 'src/SsrApplication.ts', template: 'site.html' },
      ],
      dedupe: ['@apollo/client', 'graphql'],
      ssrNoExternal: ['vue-apollo-client', '@vue/apollo-composable', /^@wry\//],
    })

    expect(config.resolve?.dedupe).toContain('@apollo/client')
    expect(config.ssr?.noExternal).toContain('vue-apollo-client')
    expect(config.ssr?.noExternal).toContain('@vue/apollo-composable')
  })

  it('accepts spa-only explicit entries without an SSR application list', async () => {
    const config = await runConfig({
      spaEntries: { erp: 'index.html' },
    })
    expect(config.ssr?.external).toContain('vue-ssr-lite')
  })
})
