import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const reportRoot = process.env.SSR_AUDIT_DIR || join(repositoryRoot, 'node_modules/.cache/vue-ssr-lite/task-012')
const playgroundRoot = process.env.SSR_PLAYGROUND_ROOT || join(repositoryRoot, '../../Playground/nuxt-vue-ssr')
const landingRoot = process.env.SSR_LANDING_ROOT || join(playgroundRoot, 'landing')
const nuxtRoot = process.env.SSR_NUXT_ROOT || join(playgroundRoot, 'nuxt-landing')
// Emit under the landing tree so Node resolves vue / vue-router from that app,
// matching ssrLoadModule. The report stays in reportRoot.
const helper = join(landingRoot, 'node_modules/.cache/vue-ssr-lite/task-012/audit-helper.mjs')

await mkdir(reportRoot, { recursive: true })
await mkdir(dirname(helper), { recursive: true })
await build({
  entryPoints: [join(repositoryRoot, 'src/fixtures/SsrProductionRetentionAudit.ts')],
  outfile: helper,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
const { runTask012ProductionRetentionAudit } = await import(pathToFileURL(helper).href)
const result = await runTask012ProductionRetentionAudit({
  frameworkRoot: repositoryRoot,
  landingRoot,
  nuxtRoot,
  reportRoot,
})
console.log('[vue-ssr-lite] Task 012 production retention report:', result.markdownPath)
console.log('[vue-ssr-lite] app.js raw/gzip/brotli', JSON.stringify(result.landing.appSizes))
console.log('[vue-ssr-lite] complete initial claim', result.completeInitialClaim)
if (result.completeInitialClaim === 'exact') {
  console.log('[vue-ssr-lite] complete initial JS raw/gzip/brotli', JSON.stringify(result.landing.totals['complete initial JS']))
}
console.log('[vue-ssr-lite] / request', JSON.stringify(result.capabilityAccounting.request))
console.log('[vue-ssr-lite] / render loader', JSON.stringify(result.capabilityAccounting.renderLoader))
console.log('[vue-ssr-lite] / capability keys', JSON.stringify(result.capabilityAccounting.selectedKeys))
console.log('[vue-ssr-lite] / capability files', JSON.stringify(result.capabilityAccounting.selectedFiles))
console.log('[vue-ssr-lite] app.js ownership', JSON.stringify(result.landing.appOwnership))
