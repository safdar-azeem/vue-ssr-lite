import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, readdir, rm, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const assert = (condition, message) => {
  if (!condition) throw new Error(`[vue-ssr-lite] package smoke: ${message}`)
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const readMjsTree = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const contents = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      contents.push(await readMjsTree(path))
    } else if (entry.name.endsWith('.mjs')) {
      contents.push(await readFile(path, 'utf8'))
    }
  }
  return contents.join('\n')
}

const assertDependencyOwnership = (manifest, options = {}) => {
  const dependencies = manifest.dependencies || {}
  const peerDependencies = manifest.peerDependencies || {}
  const devDependencies = manifest.devDependencies || {}

  assert(dependencies['vue-router'], 'vue-router must be a runtime dependency.')
  assert(!dependencies.vue, 'vue must not be bundled as a normal dependency.')
  assert(!dependencies.vite, 'vite must not be bundled as a normal dependency.')
  assert(
    !dependencies['@vitejs/plugin-vue'],
    '@vitejs/plugin-vue must not be a runtime dependency.'
  )
  assert(
    !dependencies['@vue/server-renderer'],
    '@vue/server-renderer must not be a direct dependency.'
  )
  assert(
    !peerDependencies['@vue/server-renderer'],
    '@vue/server-renderer must not be a peer dependency.'
  )
  assert(peerDependencies.vue, 'vue must remain a host peer dependency.')
  assert(peerDependencies.vite, 'vite must remain a host peer dependency.')
  if (options.requireDevelopmentTooling) {
    assert(
      devDependencies['@vitejs/plugin-vue'],
      '@vitejs/plugin-vue must remain available for repository development.'
    )
  }
}

const writeConsumerSmoke = async (consumerRoot) => {
  const smokeFile = join(consumerRoot, 'smoke.mjs')
  await writeFile(
    smokeFile,
    `import { defineApplication } from 'vue-ssr-lite'
import { renderSsrApplication } from 'vue-ssr-lite/server'
import { vueSsrLite } from 'vue-ssr-lite/vite'
import { renderToString } from 'vue/server-renderer'
import { defineComponent, h } from 'vue'

if (typeof defineApplication !== 'function') throw new Error('defineApplication is unavailable')
if (typeof vueSsrLite !== 'function') throw new Error('vueSsrLite is unavailable')
if (typeof renderToString !== 'function') throw new Error('host Vue server renderer is unavailable')

const Root = defineComponent({
  setup() {
    return () => h('main', 'isolated-routes-ok')
  },
})

const application = defineApplication({
  root: Root,
  routes: [{ path: '/', component: Root }],
})

const rendered = await renderSsrApplication(
  { ...application, id: 'isolated-smoke' },
  {
    requestId: 'isolated-smoke',
    url: 'http://smoke.test/',
    host: 'smoke.test',
    protocol: 'http',
    method: 'GET',
    headers: {},
    publicConfig: {},
    domain: {
      entry: 'isolated-smoke',
      hostname: 'smoke.test',
      baseDomain: 'smoke.test',
      subdomain: null,
      isCustomDomain: false,
      development: true,
      params: {},
    },
    signal: new AbortController().signal,
  },
)

if (!rendered.html.includes('isolated-routes-ok')) {
  throw new Error('routes API did not render through the installed package')
}
`,
    'utf8'
  )
  return smokeFile
}

const main = async () => {
  const repositoryManifest = await readJson(join(repositoryRoot, 'package.json'))
  assertDependencyOwnership(repositoryManifest, { requireDevelopmentTooling: true })

  const builtServer = await readMjsTree(join(repositoryRoot, 'dist'))
  assert(
    /vue\/server-renderer/.test(builtServer),
    'the built server entry must keep vue/server-renderer external.'
  )
  assert(
    !/@vue\/server-renderer/.test(builtServer),
    'the built server entry must not reference the obsolete renderer package.'
  )

  const temporaryRoot = await mkdtemp(join(repositoryRoot, '.package-smoke-'))
  try {
    const packed = await execFile(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot],
      { cwd: repositoryRoot }
    )
    const records = JSON.parse(packed.stdout)
    const tarball = join(temporaryRoot, records[0].filename)
    const consumerRoot = join(temporaryRoot, 'consumer')
    await mkdir(consumerRoot, { recursive: true })
    await writeFile(
      join(consumerRoot, 'package.json'),
      JSON.stringify(
        {
          private: true,
          type: 'module',
          dependencies: {
            vue: '3.5.40',
            vite: '7.3.6',
            'vue-ssr-lite': `file:${tarball}`,
          },
        },
        null,
        2
      ),
      'utf8'
    )
    await execFile(
      'npm',
      ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'],
      { cwd: consumerRoot }
    )
    await execFile('node', [await writeConsumerSmoke(consumerRoot)], {
      cwd: consumerRoot,
    })

    const installedManifest = await readJson(
      join(consumerRoot, 'node_modules/vue-ssr-lite/package.json')
    )
    assertDependencyOwnership(installedManifest)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }

  console.log('[vue-ssr-lite] isolated package dependency smoke passed')
}

await main()
