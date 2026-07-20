import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
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
    build?: {
      outDir?: string
      rollupOptions?: { input?: Record<string, string> }
    }
  }
}

describe('SSR Vite package identity', () => {
  it('resolves the runtime virtual id even when Vite path-resolves build.ssr', async () => {
    const pluginRoot = await writeMinimalConfig()
    const plugin = vueSsrLite({ root: pluginRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    await configHook.call(
      {} as never,
      { root: pluginRoot },
      {
        command: 'build',
        mode: 'test',
        isSsrBuild: true,
        isPreview: false,
      }
    )

    expect(plugin.resolveId?.call({} as never, 'virtual:vue-ssr-lite/runtime')).toBe(
      '\0virtual:vue-ssr-lite/runtime'
    )
    expect(
      plugin.resolveId?.call(
        {} as never,
        `${pluginRoot}/virtual:vue-ssr-lite/runtime`
      )
    ).toBe('\0virtual:vue-ssr-lite/runtime')
  })

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

  it('defaults client build.outDir to dist/client', async () => {
    const pluginRoot = await writeMinimalConfig()
    const config = await runConfig(pluginRoot, 'serve')
    expect(config.build?.outDir).toBe('dist/client')
  })

  it('respects an explicit consumer build.outDir', async () => {
    const pluginRoot = await writeMinimalConfig()
    const plugin = vueSsrLite({ root: pluginRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    const config = (await configHook.call(
      {} as never,
      { root: pluginRoot, build: { outDir: 'build/browser' } },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )) as { build?: { outDir?: string } }

    expect(config.build?.outDir).toBe('build/browser')
  })

  it('strips all module-src scripts from matched templates', async () => {
    const pluginRoot = await writeMinimalConfig()
    await writeFile(
      join(pluginRoot, 'site.html'),
      `<html><body>
        <div id="app"></div>
        <script type="module" src="/src/legacy-boot.ts"></script>
        <script src="/src/other.ts" type="module"></script>
      </body></html>`
    )
    const plugin = vueSsrLite({ root: pluginRoot })
    const configHook = plugin.config
    if (typeof configHook !== 'function') {
      throw new Error('vueSsrLite must expose a Vite config hook.')
    }
    await configHook.call(
      {} as never,
      { root: pluginRoot },
      {
        command: 'serve',
        mode: 'test',
        isSsrBuild: false,
        isPreview: false,
      }
    )
    const transform = plugin.transformIndexHtml
    if (!transform || typeof transform === 'function' || !transform.handler) {
      throw new Error('vueSsrLite must expose transformIndexHtml.')
    }
    const source = await readFile(join(pluginRoot, 'site.html'), 'utf8')
    const result = transform.handler.call(
      {} as never,
      source,
      {
        path: '/site.html',
        filename: join(pluginRoot, 'site.html'),
      } as never
    )
    const htmlOut =
      typeof result === 'string'
        ? result
        : result && typeof result === 'object' && 'html' in result
          ? String(result.html)
          : ''
    expect(htmlOut).not.toContain('legacy-boot')
    expect(htmlOut).not.toContain('other.ts')
    const tags =
      result && typeof result === 'object' && 'tags' in result
        ? result.tags
        : []
    expect(JSON.stringify(tags)).toContain('virtual:vue-ssr-lite/client/storefront')
  })
})
