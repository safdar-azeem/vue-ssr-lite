import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const reportRoot = process.env.SSR_AUDIT_DIR || join(repositoryRoot, 'node_modules/.cache/vue-ssr-lite/task-013')
const playgroundRoot = process.env.SSR_PLAYGROUND_ROOT || join(repositoryRoot, '../../Playground/nuxt-vue-ssr')
const landingRoot = process.env.SSR_LANDING_ROOT || join(playgroundRoot, 'landing')
const nuxtRoot = process.env.SSR_NUXT_ROOT || join(playgroundRoot, 'nuxt-landing')
const helper = join(landingRoot, 'node_modules/.cache/vue-ssr-lite/task-013/benchmark-helper.mjs')

await mkdir(reportRoot, { recursive: true })
await mkdir(dirname(helper), { recursive: true })
await build({
  entryPoints: [join(repositoryRoot, 'tools/benchmarks/SsrLikeForLikeBenchmark.ts')],
  outfile: helper,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
})
const { runTask013LikeForLikeBenchmark } = await import(pathToFileURL(helper).href)
const result = await runTask013LikeForLikeBenchmark({
  frameworkRoot: repositoryRoot,
  landingRoot,
  nuxtRoot,
  reportRoot,
})
console.log('[vue-ssr-lite] Task 013 like-for-like report:', result.markdownPath)
console.log('[vue-ssr-lite] app.js raw/gzip/brotli', JSON.stringify(result.landing.appSizes))
console.log('[vue-ssr-lite] complete initial claim', result.completeInitialClaim)
if (result.completeInitialClaim === 'exact') {
  console.log('[vue-ssr-lite] entry+capability+route JS raw/gzip/brotli', JSON.stringify(result.landing.totals['complete initial JS']))
}
console.log('[vue-ssr-lite] first-startup claim', result.extras.firstStartupClaim)
if (result.extras.firstStartupClaim === 'exact') {
  console.log('[vue-ssr-lite] first-startup JS raw/gzip/brotli', JSON.stringify(result.extras.firstStartupJs))
  console.log('[vue-ssr-lite] install-awaited files', JSON.stringify(result.extras.installAwaited.files))
}
console.log('[vue-ssr-lite] entry normalized', result.extras.entryNormalized)
console.log('[vue-ssr-lite] iconify files', JSON.stringify(result.extras.iconify.files))
console.log('[vue-ssr-lite] locale files', JSON.stringify({
  english: result.extras.englishLocaleFiles,
  arabic: result.extras.arabicLocaleFiles,
  inEntry: result.extras.locales.inEntry,
}))
console.log('[vue-ssr-lite] / request', JSON.stringify(result.capabilityAccounting.request.kind === 'authoritative-render'
  ? result.capabilityAccounting.request.capabilities
  : result.capabilityAccounting.request))
console.log('[vue-ssr-lite] app.js ownership', JSON.stringify(result.landing.appOwnership))
