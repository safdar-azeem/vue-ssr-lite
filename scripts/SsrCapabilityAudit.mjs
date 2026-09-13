import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { build } from 'esbuild'
import { init, parse } from 'es-module-lexer'

/** npm-smoke adapter for the same source-audit implementation used by Vitest. */
export const auditPackedCapabilities = async ({ repositoryRoot, consumerRoot, packedFiles, assert }) => {
  const reportRoot = process.env.SSR_AUDIT_DIR || join(repositoryRoot, 'node_modules/.cache/vue-ssr-lite/task-011')
  await mkdir(reportRoot, { recursive: true })
  const packageRoot = join(consumerRoot, 'node_modules/vue-ssr-lite')
  const provenance = JSON.parse(await readFile(join(packageRoot, 'dist/module-attribution.json'), 'utf8'))
  assert(provenance.version === 1, 'missing versioned package module provenance.')
  await init
  const modules = {}
  for (const [file, sources] of Object.entries(provenance.modules)) {
    assert(packedFiles.has(`dist/${file}`), `module provenance references an unpacked file: ${file}.`)
    assert(sources.length === 1, `opaque multi-module distribution chunk: ${file}.`)
    assert(sources.every(source => !source.startsWith('/') && !source.includes('..') && !source.includes('\\')),
      `non-portable package source identity: ${file}.`)
    const code = await readFile(join(packageRoot, 'dist', file), 'utf8')
    const [imports, exports] = parse(code)
    const dependency = (record) => record.n?.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), record.n)) : record.n
    modules[file] = {
      sources, imports: imports.filter(record => record.d === -1).map(dependency).filter(Boolean),
      dynamicImports: imports.filter(record => record.d >= 0).map(dependency).filter(Boolean),
      exports: exports.map(record => record.n),
      sizes: { bytes: Buffer.byteLength(code), gzip: gzipSync(code).byteLength, brotli: brotliCompressSync(code).byteLength },
    }
  }
  const roots = ['index.mjs', 'client.mjs', 'server.mjs', 'vite.mjs', 'cli.mjs', 'internal-ssr-renderer.mjs', 'internal-vercel.mjs']
  const closure = (entry, dynamic = false) => {
    const files = new Set()
    const external = new Set()
    const visit = file => {
      if (files.has(file) || external.has(file)) return
      const module = modules[file]
      if (!module) { external.add(file); return }
      files.add(file)
      for (const target of [...module.imports, ...(dynamic ? module.dynamicImports : [])]) visit(target)
    }
    visit(entry)
    return { files: [...files], external: [...external] }
  }
  const entries = Object.fromEntries(roots.map(root => [root, { static: closure(root), available: closure(root, true) }]))
  const sharing = Object.fromEntries(Object.keys(modules).map(file =>
    [file, roots.filter(root => entries[root].available.files.includes(file))]))
  await writeFile(join(reportRoot, 'installed-distribution-audit.json'), JSON.stringify({
    note: 'Library distribution ownership; sizes here are not production consumer transfer sizes.', modules, entries, sharing,
  }, null, 2))

  const fixtureRoot = join(consumerRoot, 'capability-consumer')
  await cp(join(repositoryRoot, 'fixtures/capability-consumer'), fixtureRoot, { recursive: true })
  const helper = join(consumerRoot, 'capability-audit-helper.mjs')
  await build({
    entryPoints: [join(repositoryRoot, 'src/fixtures/SsrCapabilityMatrix.ts')], outfile: helper,
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
  })
  const { buildSsrCapabilityMatrix, compareSsrCapabilityMatrices } = await import(pathToFileURL(helper).href)
  const source = await buildSsrCapabilityMatrix({
    frameworkRoot: repositoryRoot, consumerRoot, fixtureRoot, mode: 'source',
    reportPath: join(reportRoot, 'source-client-capabilities.json'),
  })
  const installed = await buildSsrCapabilityMatrix({
    frameworkRoot: repositoryRoot, consumerRoot, fixtureRoot, mode: 'installed',
    reportPath: join(reportRoot, 'packed-client-capabilities.json'),
  })
  const comparison = compareSsrCapabilityMatrices(source, installed)
  await writeFile(join(reportRoot, 'source-vs-packed-capabilities.json'), JSON.stringify(comparison, null, 2))
  console.log('[vue-ssr-lite] source/packed capability reports:', reportRoot)
  console.log('[vue-ssr-lite] source/packed critical JS comparison:', JSON.stringify(comparison))
}
