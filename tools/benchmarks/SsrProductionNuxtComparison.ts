import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync, brotliCompressSync } from 'node:zlib'

const execFileAsync = promisify(execFile)

export const TASK_011_NUXT_INITIAL_JS = {
  source: 'Task 011 Nuxt landing reference',
  metric: 'transferred' as const,
  bytes: 49_300,
  approximate: true,
  note: 'Nuxt implementation initial JS from the same Task 011 comparison. Not a raw fixture size. This audit does not claim which local Nuxt files that transfer included.',
}

export type NuxtJsRole =
  | 'nuxt-client-entry'
  | 'home-page'
  | 'shared-app-chrome'
  | 'contact-form'
  | 'nuxt-link'
  | 'vue-helper'
  | 'deferred-page'
  | 'nuxt-error-page'
  | 'unknown'

type Sizes = { bytes: number; gzip: number; brotli: number }

const sizes = (source: Uint8Array): Sizes => ({
  bytes: source.byteLength,
  gzip: gzipSync(source).byteLength,
  brotli: brotliCompressSync(source).byteLength,
})

const emptySizes = (): Sizes => ({ bytes: 0, gzip: 0, brotli: 0 })

const addSizes = (left: Sizes, right: Sizes): Sizes => ({
  bytes: left.bytes + right.bytes,
  gzip: left.gzip + right.gzip,
  brotli: left.brotli + right.brotli,
})

const walkFiles = async (root: string, suffix: string): Promise<string[]> => {
  const found: string[] = []
  const visit = async (dir: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith(suffix)) found.push(path)
    }
  }
  await visit(root)
  return found.sort()
}

const readJson = async (path: string) => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

const componentNames = (source: string) =>
  [...new Set([...source.matchAll(/__name:"([^"]+)"/g)].map((match) => match[1]!))]

const STATIC_RELATIVE_JS = /from\s*["'](\.\/[^"']+\.js)["']/g

export const classifyNuxtClientJs = (file: string, source: string) => {
  const names = componentNames(source)
  const importsEntry = /from\s*["']#entry["']/.test(source)
  if (source.includes('__vite__mapDeps') && !importsEntry) {
    return {
      role: 'nuxt-client-entry' as const satisfies NuxtJsRole,
      evidence: 'Contains Vite `__vite__mapDeps` and the Nuxt client runtime (`nuxt-root` / Vue shared). Other chunks import this graph as `#entry`. This file does not import `#entry`.',
      componentNames: names,
    }
  }
  if (names.includes('error-404') || names.includes('error-500')) {
    return {
      role: 'nuxt-error-page' as const satisfies NuxtJsRole,
      evidence: `Nuxt error page (${names.filter((name) => name.startsWith('error-')).join(', ') || names.join(', ')}).`,
      componentNames: names,
    }
  }
  if (names.includes('Home')) {
    return {
      role: 'home-page' as const satisfies NuxtJsRole,
      evidence: 'Lazy `/` page chunk: Home plus Home* sections. Imports `#entry` and shared chrome.',
      componentNames: names,
    }
  }
  const deferred = (['Solutions', 'Industries', 'Resources', 'Company', 'AppDetails'] as const)
    .find((name) => names.includes(name))
  if (deferred) {
    return {
      role: 'deferred-page' as const satisfies NuxtJsRole,
      evidence: `Lazy ${deferred} page. Sibling of Home; not on the \`/\` import graph.`,
      componentNames: names,
    }
  }
  if (names.includes('ContactForm') && !names.includes('Header')) {
    return {
      role: 'contact-form' as const satisfies NuxtJsRole,
      evidence: 'ContactForm async chunk imported by Home (and other pages). Imports `#entry`.',
      componentNames: names,
    }
  }
  if (
    names.includes('Header')
    || names.includes('Icon')
    || /IconifyId|api\.iconify\.design/.test(source)
  ) {
    return {
      role: 'shared-app-chrome' as const satisfies NuxtJsRole,
      evidence: 'Shared Header/Footer/Icon chunk. Contains `@iconify/vue` (IconifyId / api.iconify.design). Page chunks import this; the Nuxt entry does not.',
      componentNames: names,
    }
  }
  if (source.includes('NuxtLink') || source.includes('componentName||"NuxtLink"')) {
    return {
      role: 'nuxt-link' as const satisfies NuxtJsRole,
      evidence: 'NuxtLink helper imported by page/chrome chunks.',
      componentNames: names,
    }
  }
  if (source.includes('__vccOpts') && source.length < 400) {
    return {
      role: 'vue-helper' as const satisfies NuxtJsRole,
      evidence: 'Tiny Vue SFC helper (`__vccOpts`).',
      componentNames: names,
    }
  }
  return {
    role: 'unknown' as const satisfies NuxtJsRole,
    evidence: `No entry/page/chrome signature in ${basename(file)}.`,
    componentNames: names,
  }
}

const collectStaticRelativeGraph = (
  startFiles: readonly string[],
  sources: ReadonlyMap<string, string>,
) => {
  const files = new Set<string>()
  const queue = [...startFiles]
  while (queue.length) {
    const file = queue.pop()
    if (!file || files.has(file)) continue
    files.add(file)
    const source = sources.get(file)
    if (!source) continue
    const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''
    for (const match of source.matchAll(STATIC_RELATIVE_JS)) {
      const specifier = match[1]
      if (!specifier) continue
      queue.push(`${directory}${specifier.slice(2)}`)
    }
  }
  return [...files]
}

const measureJsonFiles = async (paths: readonly string[], publicRoot: string) => {
  const measured = await Promise.all(paths.map(async (path) => {
    const source = await readFile(path)
    return {
      file: path.startsWith(publicRoot) ? path.slice(publicRoot.length).replace(/^\//, '') : path,
      ...sizes(source),
    }
  }))
  measured.sort((left, right) => right.bytes - left.bytes)
  return measured
}

const measureExistingFiles = async (paths: readonly string[]) => {
  const measured: Array<{ file: string; bytes: number; gzip: number; brotli: number }> = []
  for (const path of paths) {
    try {
      const source = await readFile(path)
      measured.push({ file: path, ...sizes(source) })
    } catch {
      // Sibling landing catalogs are optional evidence, not required for the Nuxt inspect.
    }
  }
  return measured
}

export const inspectNuxtLandingProduction = async (nuxtRoot: string) => {
  let buildError: string | undefined
  try {
    await execFileAsync('yarn', ['build'], {
      cwd: nuxtRoot,
      timeout: 300_000,
      env: { ...process.env, NITRO_PRESET: process.env.NITRO_PRESET },
    })
  } catch (error) {
    buildError = error instanceof Error ? error.message : String(error)
  }
  const publicRoot = join(nuxtRoot, '.output/public')
  const nuxtDir = join(publicRoot, '_nuxt')
  const jsPaths = await walkFiles(publicRoot, '.js')
  const sources = new Map<string, string>()
  const measured = await Promise.all(jsPaths.map(async (path) => {
    const source = await readFile(path)
    const relative = path.slice(publicRoot.length).replace(/^\//, '')
    const text = source.toString('utf8')
    sources.set(relative, text)
    const classified = classifyNuxtClientJs(relative, text)
    return {
      file: relative,
      ...sizes(source),
      bytesOnDisk: (await stat(path)).size,
      role: classified.role,
      evidence: classified.evidence,
      componentNames: classified.componentNames,
      importsEntry: /from\s*["']#entry["']/.test(text),
      containsIconify: /IconifyId|api\.iconify\.design/.test(text),
      containsTranslationPath: /\/translations\/|_locales\//.test(text),
    }
  }))
  measured.sort((left, right) => right.bytes - left.bytes)
  const entryFiles = measured.filter((item) => item.role === 'nuxt-client-entry')
  const homePage = measured.find((item) => item.role === 'home-page')
  const homeGraphFiles = homePage
    ? collectStaticRelativeGraph(
      [...entryFiles.map((item) => item.file), homePage.file],
      sources,
    )
    : []
  const homeInitialFiles = measured.filter((item) => homeGraphFiles.includes(item.file))
  const homeInitialJs = homeInitialFiles.reduce((total, item) => addSizes(total, item), emptySizes())
  const jsonPaths = await walkFiles(publicRoot, '.json')
  const localeJson = await measureJsonFiles(
    jsonPaths.filter((path) => path.includes('/translations/') || path.includes('/_locales/')),
    publicRoot,
  )
  const landingTranslationsRoot = join(dirname(nuxtRoot), 'landing/translations')
  const liteLocaleSource = await measureExistingFiles([
    join(landingTranslationsRoot, 'en.json'),
    join(landingTranslationsRoot, 'ar.json'),
  ])
  const manifest = await readJson(join(nuxtDir, 'manifest.json'))
    ?? await readJson(join(nuxtRoot, '.nuxt/dist/client/manifest.json'))
    ?? await readJson(join(nuxtRoot, '.nuxt/dist/client/_nuxt/manifest.json'))
  return {
    nuxtRoot,
    buildError,
    publicRoot,
    files: measured,
    entryFiles,
    homeInitialFiles,
    homeInitialJs,
    homeInitialClaim: homePage && entryFiles.length
      ? 'structural-local' as const
      : 'not-claimed' as const,
    localeJson,
    liteLocaleSource,
    manifestKeys: manifest && typeof manifest === 'object' && !Array.isArray(manifest)
      ? Object.keys(manifest).slice(0, 40)
      : [],
    totalJs: measured.reduce((total, item) => addSizes(total, item), emptySizes()),
    networkTrace: TASK_011_NUXT_INITIAL_JS,
  }
}

const sizeLine = (label: string, value: Sizes) =>
  `- ${label}: raw ${value.bytes.toLocaleString()} B · gzip ${value.gzip.toLocaleString()} B · brotli ${value.brotli.toLocaleString()} B`

export const renderNuxtComparisonMarkdown = (
  nuxt: Awaited<ReturnType<typeof inspectNuxtLandingProduction>>,
) => {
  const entry = nuxt.entryFiles
  const home = nuxt.files.find((item) => item.role === 'home-page')
  const chrome = nuxt.files.find((item) => item.role === 'shared-app-chrome')
  const deferred = nuxt.files.filter((item) => item.role === 'deferred-page')
  const localeTotal = nuxt.localeJson.reduce((total, item) => addSizes(total, item), emptySizes())
  const liteLocaleTotal = nuxt.liteLocaleSource.reduce((total, item) => addSizes(total, item), emptySizes())
  return `The Nuxt implementation lives at \`${nuxt.nuxtRoot}\`. It was not modified. Task 011's **~49.3 KB** Nuxt figure is a **transferred / network** reference, not a raw fixture size, and is **not** reconciled to the local files below.

${nuxt.buildError
    ? `- Nuxt production build did not complete in this audit: ${nuxt.buildError.split('\n')[0]}
- Structural comparison below uses the application source and any files that were already present.`
    : `- Nuxt production build completed. JS files under \`.output/public\`: ${nuxt.files.length}.`}

Task 011 Nuxt initial JS: ${nuxt.networkTrace.bytes.toLocaleString()} B [${nuxt.networkTrace.metric}] — ${nuxt.networkTrace.note}

Entry identification is **not** "the three largest files". A file is the Nuxt client entry only when it emits Vite \`__vite__mapDeps\` and other chunks import \`#entry\`.

${entry.length
    ? entry.map((item) => `- Nuxt client entry \`${item.file}\`: raw ${item.bytes.toLocaleString()} B · gzip ${item.gzip.toLocaleString()} B · brotli ${item.brotli.toLocaleString()} B
  ${item.evidence}
  Iconify in this file: ${item.containsIconify ? 'yes' : 'no'}. Translation URL/path strings: ${item.containsTranslationPath ? 'yes' : 'no'}.`).join('\n')
    : '- No Nuxt client entry was identified (`__vite__mapDeps` without `#entry` import).'}

${home
    ? `- Home page chunk \`${home.file}\`: raw ${home.bytes.toLocaleString()} B · gzip ${home.gzip.toLocaleString()} B · brotli ${home.brotli.toLocaleString()} B
  ${home.evidence}`
    : '- No Home page chunk was identified.'}

${chrome
    ? `- Shared app chrome \`${chrome.file}\`: raw ${chrome.bytes.toLocaleString()} B · gzip ${chrome.gzip.toLocaleString()} B · brotli ${chrome.brotli.toLocaleString()} B
  ${chrome.evidence}
  Iconify in this file: ${chrome.containsIconify ? 'yes' : 'no'}.`
    : '- No shared Header/Icon chrome chunk was identified.'}

${nuxt.homeInitialClaim === 'structural-local'
    ? `Structural local JS graph for Nuxt \`/\` (Home static relative imports + the Nuxt entry). This is **not** transferred and is **not** claimed as the Task 011 49.3 KB figure:
${sizeLine('sum of those whole files', nuxt.homeInitialJs)}
${nuxt.homeInitialFiles.map((item) => `- \`${item.file}\` (${item.role}): raw ${item.bytes.toLocaleString()} B · gzip ${item.gzip.toLocaleString()} B · brotli ${item.brotli.toLocaleString()} B`).join('\n')}`
    : '- Structural local JS graph for Nuxt `/` is **not claimed** (missing entry or Home chunk).'}

Deferred page chunks (not on the Home static graph):
${deferred.length
    ? deferred.map((item) => `- \`${item.file}\` (${item.componentNames.filter((name) => ['Solutions', 'Industries', 'Resources', 'Company', 'AppDetails'].includes(name)).join(', ') || item.role}): raw ${item.bytes.toLocaleString()} B`).join('\n')
    : '- (none identified)'}

All emitted Nuxt JS files (whole-file raw / gzip / Brotli; not transferred):
${nuxt.files.map((item) => `- \`${item.file}\` — ${item.role}: raw ${item.bytes.toLocaleString()} B · gzip ${item.gzip.toLocaleString()} B · brotli ${item.brotli.toLocaleString()} B`).join('\n') || '- No Nuxt JS artifacts were found under `.output/public`.'}

Locale catalogs are **HTTP JSON**, not JS modules in the Nuxt entry:
${nuxt.localeJson.length
    ? `${sizeLine('sum of published translation/_locales JSON', localeTotal)}
${nuxt.localeJson.map((item) => `- \`${item.file}\`: raw ${item.bytes.toLocaleString()} B · gzip ${item.gzip.toLocaleString()} B · brotli ${item.brotli.toLocaleString()} B`).join('\n')}`
    : '- No `translations/` or `_locales/` JSON was found under `.output/public`.'}

${nuxt.liteLocaleSource.length
    ? `Sibling vue-ssr-lite landing source catalogs (uncompressed JSON on disk; these are statically imported by \`landing/src/i18n/index.ts\`, not served as separate JS):
${sizeLine('en.json + ar.json source', liteLocaleTotal)}
${nuxt.liteLocaleSource.map((item) => `- \`${item.file}\`: raw ${item.bytes.toLocaleString()} B`).join('\n')}`
    : ''}

Structural reasons the Nuxt **entry** JS can be smaller than the vue-ssr-lite \`app.js\`, where source/build evidence supports it:

1. **The two apps split pages the same way in source.** Both register \`/\`, \`/solutions\`, \`/industries\`, \`/resources\`, \`/company\`, and \`/apps/:slug\` as lazy \`import()\` routes. Home/Header/ContactForm are not statically imported from the vue-ssr-lite \`App.vue\` or the Nuxt \`app.vue\` (which only wraps \`<NuxtPage />\`). A smaller Nuxt *entry* is therefore not explained by extra eager page imports on the vue-ssr-lite side.
2. **vue-ssr-lite \`main.ts\` eagerly installs i18n with both catalogs.** \`createI18n()\` statically imports \`translations/en.json\` and \`translations/ar.json\`. Those JSON modules stay on the vue-ssr-lite entry-static closure (see section 5). Nuxt uses \`nuxt-i18n-micro\` (\`translationDir: 'translations'\`, \`strategy: 'no_prefix'\`) and publishes catalogs as \`.output/public/translations/*\` and \`_locales/*\` JSON. The identified Nuxt entry file does **not** contain \`/translations/\` or \`_locales/\` strings.
3. **vue-ssr-lite \`main.ts\` globally registers Icon.** \`app.component('Icon', Icon)\` statically imports \`@iconify/vue\` onto the vue-ssr-lite entry. Nuxt's matching \`Icon.vue\` also imports \`@iconify/vue\`, but Icon is used from Header, which is imported by the **page** chunks. Iconify signatures are in the shared chrome chunk, not in the Nuxt entry.
4. **Nuxt's first JS is a client runtime.** The identified entry contains Vue shared / Nuxt \`nuxt-root\` / router-style URL encoding and a Vite dependency map. The Home tree (Header, HomeHero, Carousel/\`vue-carousel-lite\`, ContactForm, Footer, Iconify) loads with the Home/chrome chunks. That matches the lazy Home chunk on the vue-ssr-lite side — except Iconify and both locale catalogs have already been pulled into the vue-ssr-lite **entry**.
5. **Different framework runtimes.** vue-ssr-lite's entry includes Vue, Vue Router, and vue-ssr-lite hydration/capability hosts. Nuxt's entry is Nuxt's own client runtime (unhead/payload/island wiring plus Vue). These are not like-for-like raw sizes against the Task 011 49.3 KB transfer. Local Nuxt entry Brotli is also not that transfer.
6. **Do not treat Builto Apollo/vlite3 numbers as this benchmark.** This comparison repository has neither dependency.

What this comparison does **not** prove:

- That Task 011's ~49.3 KB transferred figure equals this local Nuxt entry, or equals the structural \`/\` JS graph above.
- That Nuxt's first paint transfers only the entry (locale JSON and page/chrome chunks may be additional requests).
- That either landing should be changed. These points explain structure only.

These points are not an optimization plan and do not change either landing.`
}
