import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { normalizePath } from 'vite'
import { prepareSsrHtmlTemplate } from '../server/SsrHtmlRuntime'

export interface SsrViteApplicationEntry {
  id: string
  definition: string
  exportName?: string
  template: string
  mountSelector?: string
}

export interface SsrVitePluginOptions {
  applications: SsrViteApplicationEntry[]
  spaEntries?: Record<string, string>
  root?: string
  /**
   * Additional packages to deduplicate. `vue-ssr-lite` always dedupes the Vue
   * framework packages it renders with; API clients or other identity-sensitive
   * dependencies are supplied by the consumer.
   */
  dedupe?: string[]
  /**
   * Additional dependencies to keep in the SSR bundle (`ssr.noExternal`). The
   * package is API-client neutral, so callers list their own client packages
   * (for example an Apollo/GraphQL stack) here. `vue-ssr-lite` itself remains
   * external so the managed server and consumer use the same Node module.
   */
  ssrNoExternal?: (string | RegExp)[]
}

// The framework packages the renderer itself depends on. Kept generic: no API
// client, GraphQL, or transport package appears here.
const FRAMEWORK_DEDUPE = [
  '@vue/server-renderer',
  'vue',
  'vue-router',
  'vue-ssr-lite',
]

const VIRTUAL_PREFIX = 'virtual:vue-ssr-lite/client/'
const RESOLVED_VIRTUAL_PREFIX = `\0${VIRTUAL_PREFIX}`

export const vueSsrLite = (options: SsrVitePluginOptions): Plugin => {
  if (!options.applications?.length) {
    throw new Error('vueSsrLite requires at least one SSR application entry.')
  }
  let root = resolve(options.root || process.cwd())
  const virtualEntries = new Map(
    options.applications.map((application) => [
      `${VIRTUAL_PREFIX}${application.id}`,
      application,
    ])
  )

  return {
    name: 'vue-ssr-lite',
    enforce: 'pre',
    config(_currentConfig, environment) {
      const input = {
        ...Object.fromEntries(
          options.applications.map((entry) => [
            entry.id,
            resolve(root, entry.template),
          ])
        ),
        ...Object.fromEntries(
          Object.entries(options.spaEntries ?? {}).map(([id, template]) => [
            id,
            resolve(root, template),
          ])
        ),
      }
      return {
        resolve: {
          dedupe: [...new Set([...FRAMEWORK_DEDUPE, ...(options.dedupe ?? [])])],
        },
        ssr: {
          // The managed server imports vue-ssr-lite through Node. Explicitly
          // externalize the package so Vite's development module runner and
          // production SSR bundle reuse that same native module evaluation.
          // Vite gives `external` precedence if a broader consumer
          // `noExternal` filter also happens to match this package.
          external: ['vue-ssr-lite'],
          // API-client and browser-oriented packages remain consumer-owned.
          noExternal: [...new Set(options.ssrNoExternal ?? [])],
        },
        build: environment.isSsrBuild
          ? undefined
          : { manifest: true, rollupOptions: { input } },
      }
    },
    configResolved(config) {
      root = config.root
    },
    resolveId(id) {
      return virtualEntries.has(id) ? `${RESOLVED_VIRTUAL_PREFIX}${id.slice(VIRTUAL_PREFIX.length)}` : undefined
    },
    load(id) {
      if (!id.startsWith(RESOLVED_VIRTUAL_PREFIX)) return
      const applicationId = id.slice(RESOLVED_VIRTUAL_PREFIX.length)
      const entry = options.applications.find(({ id: candidate }) => candidate === applicationId)
      if (!entry) return
      const definitionPath = normalizePath(resolve(root, entry.definition))
      const importStatement = entry.exportName
        ? `import { ${entry.exportName} as application } from ${JSON.stringify(definitionPath)}`
        : `import application from ${JSON.stringify(definitionPath)}`
      return [
        importStatement,
        `import { hydrateSsrApplication } from 'vue-ssr-lite/client'`,
        `hydrateSsrApplication(application, ${JSON.stringify({
          mountSelector: entry.mountSelector || '#app',
        })}).catch((error) => {`,
        `  console.error('[vue-ssr-lite] hydration failed', error)`,
        `  throw error`,
        `})`,
      ].join('\n')
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const filename = normalizePath(context.filename)
        const entry = options.applications.find(
          (candidate) =>
            filename === normalizePath(resolve(root, candidate.template))
        )
        if (!entry) return html
        const virtualId = `${VIRTUAL_PREFIX}${entry.id}`
        const prepared = prepareSsrHtmlTemplate(
          html,
          entry.mountSelector || '#app'
        )
        if (prepared.includes(`import ${JSON.stringify(virtualId)}`)) return prepared
        return {
          html: prepared,
          tags: [
            {
              tag: 'script',
              attrs: { type: 'module' },
              children: `import ${JSON.stringify(virtualId)}`,
              injectTo: 'body',
            },
          ],
        }
      },
    },
  }
}
