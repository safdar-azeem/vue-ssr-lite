import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { vueSsrLite } from './SsrVitePlugin'

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const writeMinimalConfig = async () => {
  root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-vite-'))
  await writeFile(
    join(root, 'ssr.config.mjs'),
    `
export default {
  name: 'demo',
  applications: {
    storefront: {
      render: 'ssr',
      application: {
        module: './src/SsrApplication.ts',
        exportName: 'websiteApplication',
      },
      template: 'site.html',
      domain: {
        development: 'localhost',
        production: 'example.com',
        customDomains: true,
      },
      publicConfig: { api: { endpoint: 'http://localhost/graphql' } },
    },
  },
}
`,
    'utf8'
  )
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(
    join(root, 'src/SsrApplication.ts'),
    `export const websiteApplication = { id: 'storefront', rootComponent: {} }`,
    'utf8'
  )
  await writeFile(join(root, 'site.html'), '<html><body><div id="app"></div></body></html>')
  return root
}

const runConfig = async (
  pluginRoot: string,
  command: 'serve' | 'build' = 'serve'
) => {
  const plugin = vueSsrLite({ root: pluginRoot })
  const configHook = plugin.config
  if (typeof configHook !== 'function') {
    throw new Error('vueSsrLite must expose a Vite config hook.')
  }
  return (await configHook.call(
    {} as never,
    { root: pluginRoot },
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
    build?: { rollupOptions?: { input?: Record<string, string> } }
  }
}

describe('SSR Vite package identity', () => {
  it('deduplicates Vue and externalizes vue-ssr-lite by default', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot)

    expect(config.resolve?.dedupe).toContain('vue')
    expect(config.resolve?.dedupe).toContain('vue-router')
    expect(config.resolve?.dedupe).toContain('vue-ssr-lite')
    expect(config.ssr?.external).toContain('vue-ssr-lite')
    expect(config.ssr?.noExternal).not.toContain('vue-ssr-lite')
  })

  it('uses the same package externalization contract in development and production', async () => {
    const pluginRoot = await writeMinimalConfig()
    const [development, production] = await Promise.all([
      runConfig(pluginRoot, 'serve'),
      runConfig(pluginRoot, 'build'),
    ])

    expect(development.ssr?.external).toContain('vue-ssr-lite')
    expect(production.ssr?.external).toContain('vue-ssr-lite')
  })

  it('stays API-client neutral: no Apollo or GraphQL packages by default', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot)

    expect(config.resolve?.dedupe).not.toContain('@apollo/client')
    expect(config.resolve?.dedupe).not.toContain('vue-apollo-client')
    expect(config.ssr?.external).not.toContain('@apollo/client')
    expect(config.ssr?.noExternal).not.toContain('@apollo/client')
    expect(config.ssr?.noExternal).not.toContain('vue-apollo-client')
  })

  it('lets the consumer supply its own dedupe and SSR-inlined client packages', async () => {
    const pluginRoot = await writeMinimalConfig()
    const plugin = vueSsrLite({
      root: pluginRoot,
      dedupe: ['@apollo/client', 'graphql'],
      ssrNoExternal: ['vue-apollo-client', '@vue/apollo-composable', /^@wry\//],
    })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    const config = (await configHook.call(
      {} as never,
      { root: pluginRoot },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )) as {
      resolve?: { dedupe?: string[] }
      ssr?: { noExternal?: Array<string | RegExp> }
    }

    expect(config.resolve?.dedupe).toContain('@apollo/client')
    expect(config.ssr?.noExternal).toContain('vue-apollo-client')
    expect(config.ssr?.noExternal).toContain('@vue/apollo-composable')
  })
})
