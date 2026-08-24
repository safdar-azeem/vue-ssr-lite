import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

const SERVER_ONLY_MARKERS = [
  'SeoEndpoints',
  'createSeoEndpoints',
  'SsrSitemapConfig',
  'SsrSiteOriginRuntime',
  'defineSitemap',
  'node:fs',
  'node:path',
  'node:url',
  'from "fs"',
  "from 'fs'",
  'sitemap.config',
  '__vite-browser-external',
]

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'constants',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'querystring',
  'stream',
  'tls',
  'tty',
  'url',
  'util',
  'vm',
  'worker_threads',
  'zlib',
])

let productionOutDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    productionOutDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  )
  productionOutDirs = []
})

const collectJsFiles = async (root: string): Promise<string[]> => {
  const files: string[] = []
  const walk = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        files.push(path)
      }
    }
  }
  await walk(root)
  return files
}

const normalizeModuleId = (id: string): string => id.replace(/\\/g, '/')

const stripVirtualPrefix = (id: string): string =>
  normalizeModuleId(id).replace(/^\0+/, '')

const isViteBrowserExternalId = (id: string): boolean => {
  const normalized = stripVirtualPrefix(id)
  return (
    normalized.includes('__vite-browser-external') ||
    normalized.includes('vite-browser-external') ||
    normalized.includes('browser-external')
  )
}

const isNodeBuiltinId = (id: string): boolean => {
  const normalized = stripVirtualPrefix(id)
  const bare = normalized.replace(/^node:/, '').split('?', 1)[0] || ''
  return (
    normalized.startsWith('node:') ||
    NODE_BUILTINS.has(normalized) ||
    NODE_BUILTINS.has(bare) ||
    /polyfill-node|node-stdlib-browser|vite-plugin-node-polyfills/.test(
      normalized
    )
  )
}

const isServerOnlyModuleId = (id: string): boolean => {
  const normalized = stripVirtualPrefix(id)
  return (
    normalized.includes('/src/server/') ||
    normalized.includes('/extensions/seo/SeoEndpoints') ||
    normalized.includes('SsrSitemapConfig') ||
    normalized.includes('SsrSiteOriginRuntime') ||
    /SeoEndpoints/.test(normalized)
  )
}

const isForbiddenClientModuleId = (id: string): boolean =>
  isServerOnlyModuleId(id) || isNodeBuiltinId(id) || isViteBrowserExternalId(id)

type BuiltClientOutput = {
  output: Array<{
    type: string
    moduleIds?: string[]
    modules?: Record<string, unknown>
    imports: string[]
    dynamicImports: string[]
  }>
}

const collectClientGraph = (result: unknown) => {
  const outputs = (Array.isArray(result) ? result : [result]).filter(
    (item): item is BuiltClientOutput =>
      Boolean(item && typeof item === 'object' && item !== null && 'output' in item)
  )
  const moduleIds: string[] = []
  const imports: string[] = []
  for (const output of outputs) {
    for (const item of output.output) {
      if (item.type !== 'chunk') continue
      moduleIds.push(...(item.moduleIds ?? Object.keys(item.modules ?? {})))
      imports.push(...item.imports, ...item.dynamicImports)
    }
  }
  return { moduleIds, imports }
}

const buildClientBundle = async (fixtureName: string) => {
  const fixtureRoot = join(fixturesRoot, fixtureName)
  const outDir = await mkdtemp(join(tmpdir(), `vue-ssr-lite-${fixtureName}-`))
  productionOutDirs.push(outDir)
  const result = await build({
    root: fixtureRoot,
    configFile: join(fixtureRoot, 'vite.config.ts'),
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
    },
    logLevel: 'error',
  })
  const files = await collectJsFiles(outDir)
  expect(files.length).toBeGreaterThan(0)
  const bundle = (
    await Promise.all(files.map((file) => readFile(file, 'utf8')))
  ).join('\n')
  return { outDir, bundle, files, graph: collectClientGraph(result) }
}

describe('consumer client bundle boundaries', () => {
  it('keeps server-only modules and Node built-ins out of basic and advanced client graphs', async () => {
    const [basic, advanced] = await Promise.all([
      buildClientBundle('basic-consumer'),
      buildClientBundle('advanced-consumer'),
    ])

    for (const { bundle, graph } of [basic, advanced]) {
      expect(graph.moduleIds.length).toBeGreaterThan(0)
      for (const marker of SERVER_ONLY_MARKERS) {
        expect(bundle).not.toContain(marker)
      }
      for (const id of [...graph.moduleIds, ...graph.imports]) {
        expect(isForbiddenClientModuleId(id)).toBe(false)
      }
    }

    expect(advanced.bundle).toContain('x-analytics-id')
    expect(advanced.bundle).toContain('UA-123456')
    expect(advanced.bundle).not.toMatch(/vue-ssr-lite\/server/)
  }, 120_000)
})

describe('client bundle boundary detector', () => {
  it('rejects Vite browser-external virtual module IDs', () => {
    expect(isForbiddenClientModuleId('__vite-browser-external')).toBe(true)
    expect(isForbiddenClientModuleId('\0__vite-browser-external:fs')).toBe(true)
    expect(isForbiddenClientModuleId('\0__vite-browser-external:node:fs')).toBe(
      true
    )
    expect(isForbiddenClientModuleId('browser-external:fs')).toBe(true)
    expect(isForbiddenClientModuleId('/@id/__vite-browser-external:path')).toBe(
      true
    )
  })

  it('still rejects Node built-ins, polyfills, and server-only modules', () => {
    expect(isForbiddenClientModuleId('node:fs')).toBe(true)
    expect(isForbiddenClientModuleId('fs')).toBe(true)
    expect(isForbiddenClientModuleId('polyfill-node/fs')).toBe(true)
    expect(
      isForbiddenClientModuleId('/repo/src/server/SsrSitemapConfig.ts')
    ).toBe(true)
    expect(isForbiddenClientModuleId('/repo/src/extensions/seo/SeoEndpoints.ts')).toBe(
      true
    )
  })

  it('accepts ordinary browser modules', () => {
    expect(isForbiddenClientModuleId('/repo/src/index.ts')).toBe(false)
    expect(isForbiddenClientModuleId('/repo/src/extensions/seo/useSeo.ts')).toBe(
      false
    )
    expect(isForbiddenClientModuleId('vue')).toBe(false)
  })
})
