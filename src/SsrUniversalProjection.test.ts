import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertNoImportedUniversalConfigMutation,
  assertUniversalProjectionCoverage,
  projectUniversalRuntimeSource,
  type SsrUniversalRuntimeProjection,
} from './SsrUniversalProjection'
import { loadSsrConfigFile, extractSsrViteEntries, generateSsrClientModule } from './SsrConfigCompileRuntime'

const libraryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const defineServerPath = join(libraryRoot, 'src/SsrConfigRuntime.ts')
const defineConfigPath = join(libraryRoot, 'src/index.ts')

const compileProjectedModule = (projection: SsrUniversalRuntimeProjection) =>
  transformSync(
    [
      ...projection.imports,
      ...(projection.statements ?? []),
      'export const fields = {',
      ...Object.entries(projection.fields).map(([key, value]) => `  ${key}: ${value},`),
      '}',
    ].join('\n'),
    { loader: 'js', format: 'esm' }
  ).code

const siblingDeclarationSource = (
  order: 'browser-first' | 'private-first',
  defineFrom: string
) => {
  const declarations =
    order === 'browser-first'
      ? `const browserExtension = createExtension({ name: 'browser' }),
        privateValue = serverOnlyFunction()`
      : `const privateValue = serverOnlyFunction(),
        browserExtension = createExtension({ name: 'browser' })`
  return `
import { defineServer } from ${JSON.stringify(defineFrom)}
import { createExtension } from './src/browser-ext'
import { serverOnlyFunction } from './src/server-only'
${declarations}
export default defineServer({
  extensions: [browserExtension],
})
`
}

const expectSiblingProjection = (projection: SsrUniversalRuntimeProjection | undefined) => {
  const statements = projection?.statements?.join('\n') ?? ''
  const imports = projection?.imports.join('\n') ?? ''
  const serialized = `${imports}\n${statements}\n${JSON.stringify(projection?.fields)}`
  expect(projection?.fields.extensions).toBe('[browserExtension]')
  expect(statements).toContain('browserExtension = createExtension')
  expect(serialized).not.toContain('privateValue')
  expect(serialized).not.toContain('serverOnlyFunction')
  expect(imports).not.toContain('server-only')
  expect(imports).toContain('browser-ext')
  compileProjectedModule(projection!)
}

const arrayDestructureSource = (
  order: 'browser-first' | 'private-first',
  defineFrom: string
) => {
  const pattern = order === 'browser-first' ? '[browserExtension, privateValue]' : '[privateValue, browserExtension]'
  const values =
    order === 'browser-first'
      ? `[createExtension({ name: 'browser' }), serverOnlyFunction()]`
      : `[serverOnlyFunction(), createExtension({ name: 'browser' })]`
  return `
import { defineServer } from ${JSON.stringify(defineFrom)}
import { createExtension } from './src/browser-ext'
import { serverOnlyFunction } from './src/server-only'
const ${pattern} = ${values}
export default defineServer({
  extensions: [browserExtension],
})
`
}

const objectDestructureSource = (defineFrom: string) => `
import { defineServer } from ${JSON.stringify(defineFrom)}
import { createExtension } from './src/browser-ext'
import { serverOnlyFunction } from './src/server-only'
const {
  browserExtension,
  privateValue,
} = {
  browserExtension: createExtension({ name: 'browser' }),
  privateValue: serverOnlyFunction(),
}
export default defineServer({
  extensions: [browserExtension],
})
`

const nestedDestructureSource = (defineFrom: string) => `
import { defineServer } from ${JSON.stringify(defineFrom)}
import { createExtension } from './src/browser-ext'
import { serverOnlyFunction } from './src/server-only'
const {
  nested: { browserExtension, privateValue },
} = {
  nested: {
    browserExtension: createExtension({ name: 'browser' }),
    privateValue: serverOnlyFunction(),
  },
}
export default defineServer({
  extensions: [browserExtension],
})
`

const expectDestructureRejected = async (source: string) => {
  await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
    /Binding "browserExtension" comes from a destructuring pattern/
  )
}

const expectUntrustedConfigHelperRejected = async (source: string) => {
  const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
  expect(() =>
    assertUniversalProjectionCoverage(
      { extensions: [{ name: 'server-only' }] },
      projection,
      '/app/server.ts'
    )
  ).toThrow(/Cannot project universal field "extensions"/)
}

describe('browser-safe universal runtime projection', () => {
  it('extracts defineServer extensions without importing server-only fields', async () => {
    const filePath = '/workspace/app/server.ts'
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './src/extensions/custom-analytics'
import { siteSeo } from './src/seo/site'

export default defineServer({
  publicConfig: () => ({ feature: 'advanced' }),
  extensions: [analyticsExtension({ propertyId: 'UA-123456' })],
  createInitialState: () => ({ marker: 'ADVANCED_INITIAL_STATE' }),
  seo: { site: siteSeo },
})
`
    const projection = await projectUniversalRuntimeSource(source, filePath)
    expect(projection?.fields.extensions).toContain('UA-123456')
    expect(projection?.fields.createInitialState).toContain('ADVANCED_INITIAL_STATE')
    expect(projection?.imports.join('\n')).toContain('/workspace/app/src/extensions/custom-analytics')
    expect(projection?.imports.join('\n')).not.toContain('/seo/site')
    expect(JSON.stringify(projection?.fields)).not.toContain('siteSeo')
  })

  it('extracts defineApplication router and scrollBehavior from aliased helpers', async () => {
    const source = `
import { defineApplication as defineApp } from 'vue-ssr-lite'
import { createAppRouter } from './router'
import routes from './routes'

export default defineApp({
  name: 'admin',
  routes,
  router: createAppRouter,
  scrollBehavior: (to) => ({ el: to.hash }),
  cleanup: () => undefined,
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/src/modules/admin/app.ts')
    expect(projection?.fields.router).toBe('createAppRouter')
    expect(projection?.fields.scrollBehavior).toContain('to.hash')
    expect(projection?.fields.cleanup).toMatch(/\(\)\s*=>\s*(undefined|void 0)/)
    expect(projection?.imports.join('\n')).toContain('/app/src/modules/admin/router')
    expect(projection?.imports.join('\n')).not.toContain('/routes')
  })

  it('projects a locally declared extension', async () => {
    const source = `
import { defineServer, defineExtension } from 'vue-ssr-lite'
const analytics = defineExtension({ name: 'analytics' })
export default defineServer({
  extensions: [analytics],
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBe('[analytics]')
    expect(projection?.statements?.join('\n')).toContain('const analytics = defineExtension')
    expect(projection?.imports.join('\n')).toMatch(/defineExtension/)
  })

  it('does not project a server-only sibling declarator listed after the browser binding', async () => {
    const projection = await projectUniversalRuntimeSource(
      siblingDeclarationSource('browser-first', 'vue-ssr-lite'),
      '/app/server.ts'
    )
    expectSiblingProjection(projection)
  })

  it('does not project a server-only sibling declarator listed before the browser binding', async () => {
    const projection = await projectUniversalRuntimeSource(
      siblingDeclarationSource('private-first', 'vue-ssr-lite'),
      '/app/server.ts'
    )
    expectSiblingProjection(projection)
  })

  it('fails closed when array destructuring would omit an effectful sibling after the browser binding', async () => {
    await expectDestructureRejected(arrayDestructureSource('browser-first', 'vue-ssr-lite'))
  })

  it('fails closed when array destructuring would omit an effectful sibling before the browser binding', async () => {
    await expectDestructureRejected(arrayDestructureSource('private-first', 'vue-ssr-lite'))
  })

  it('fails closed when object destructuring would omit an effectful sibling call', async () => {
    await expectDestructureRejected(objectDestructureSource('vue-ssr-lite'))
  })

  it('fails closed when nested destructuring would omit an effectful sibling call', async () => {
    await expectDestructureRejected(nestedDestructureSource('vue-ssr-lite'))
  })

  it('fails closed when an omitted array sibling assignment can change retained evaluation', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { createExtension } from './src/browser-ext'
let mode = 'browser'
const [privateValue, browserExtension] = [
  (mode = 'server'),
  createExtension({ mode }),
]
export default defineServer({
  extensions: [browserExtension],
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('fails closed when an omitted later sibling assignment can change captured state', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { createExtension } from './src/browser-ext'
let mode = 'browser'
const [browserExtension, privateValue] = [
  createExtension({ read: () => mode }),
  (mode = 'server'),
]
export default defineServer({
  extensions: [browserExtension],
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('projects simple pure literal destructuring', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const { marker, unused } = { marker: 'PURE_STATE', unused: 0 }
export default defineServer({
  createInitialState: () => ({ marker }),
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.createInitialState).toContain('marker')
    expect(projection?.statements?.join('\n')).toContain('marker')
    expect(projection?.statements?.join('\n')).not.toContain('unused')
    compileProjectedModule(projection!)
  })

  it('projects nested pure literal destructuring', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const { nested: { marker, unused } } = { nested: { marker: 'NESTED_STATE', unused: 1 } }
export default defineServer({
  createInitialState: () => ({ marker }),
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.statements?.join('\n')).toContain('NESTED_STATE')
    expect(projection?.statements?.join('\n')).not.toContain('unused')
    compileProjectedModule(projection!)
  })

  it('fails closed when an omitted sibling uses unary coercion on an object', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { coerciveValue, createExtension } from './shared'
const [unused, browserExtension] = [
  +coerciveValue,
  createExtension(),
]
export default defineServer({
  extensions: [browserExtension],
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('fails closed when an omitted sibling uses binary coercion with an object', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { coerciveValue, createExtension } from './shared'
const [unused, browserExtension] = [
  coerciveValue + 1,
  createExtension(),
]
export default defineServer({
  extensions: [browserExtension],
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('fails closed when an omitted sibling interpolates an object in a template', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { coerciveValue, createExtension } from './shared'
const [unused, browserExtension] = [
  \`\${coerciveValue}\`,
  createExtension(),
]
export default defineServer({
  extensions: [browserExtension],
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('fails closed when object destructuring cannot isolate a browser binding', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { createValues } from './src/server-only'
const { browserExtension, privateValue } = createValues()
export default defineServer({
  extensions: [browserExtension],
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('projects an aliased defineServer helper', async () => {
    const source = `
import { defineServer as server } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
export default server({
  extensions: [analyticsExtension({ propertyId: 'UA-SERVER-ALIAS' })],
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toContain('UA-SERVER-ALIAS')
    expect(projection?.imports.join('\n')).toContain('/app/analytics')
  })

  it('projects a namespaced defineServer helper', async () => {
    const source = `
import * as ssr from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
export default ssr.defineServer({
  extensions: [analyticsExtension({ propertyId: 'UA-NS' })],
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toContain('UA-NS')
  })

  it('projects an immutable const alias of defineServer', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
const server = defineServer
export default server({
  extensions: [analyticsExtension({ propertyId: 'UA-CONST-ALIAS' })],
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toContain('UA-CONST-ALIAS')
  })

  it('projects immutable helper aliases inside supported function and async exports', async () => {
    const functionSource = `
import { defineServer } from 'vue-ssr-lite'
export default () => {
  const server = defineServer
  return server({
    extensions: [{ name: 'function-alias' }],
  })
}
`
    const asyncSource = `
import { defineServer } from 'vue-ssr-lite'
export default async () => {
  const server = defineServer
  return server({
    extensions: [{ name: 'async-alias' }],
  })
}
`
    const functionProjection = await projectUniversalRuntimeSource(functionSource, '/app/server.ts')
    const asyncProjection = await projectUniversalRuntimeSource(asyncSource, '/app/server.ts')
    expect(functionProjection?.fields.extensions).toContain('function-alias')
    expect(asyncProjection?.fields.extensions).toContain('async-alias')
  })

  it('fails closed when defineServer is shadowed inside a config export', async () => {
    await expectUntrustedConfigHelperRejected(`
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
export default () => {
  const defineServer = (config) => ({ ...config, extensions: [serverExtension] })
  return defineServer({ extensions: [browserExtension] })
}
`)
  })

  it('fails closed when an imported helper alias is shadowed', async () => {
    await expectUntrustedConfigHelperRejected(`
import { defineServer as server } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
export default () => {
  const server = (config) => ({ ...config, extensions: [serverExtension] })
  return server({ extensions: [browserExtension] })
}
`)
  })

  it('fails closed when a config-helper namespace is shadowed', async () => {
    await expectUntrustedConfigHelperRejected(`
import * as ssr from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
export default () => {
  const ssr = {
    defineServer: (config) => ({ ...config, extensions: [serverExtension] }),
  }
  return ssr.defineServer({ extensions: [browserExtension] })
}
`)
  })

  it.each(['let', 'var'])(
    'fails closed for a reassigned %s helper alias',
    async (declarationKind) => {
      await expectUntrustedConfigHelperRejected(`
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const wrapper = (config) => ({ ...config, extensions: [serverExtension] })
${declarationKind} server = defineServer
server = wrapper
export default server({ extensions: [browserExtension] })
`)
    }
  )

  it('fails closed for an assignment helper alias followed by reassignment', async () => {
    await expectUntrustedConfigHelperRejected(`
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const wrapper = (config) => ({ ...config, extensions: [serverExtension] })
let server
server = defineServer
server = wrapper
export default server({ extensions: [browserExtension] })
`)
  })

  it('fails closed for nested lexical shadowing of defineServer', async () => {
    await expectUntrustedConfigHelperRejected(`
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
export default () => {
  if (true) {
    const defineServer = (config) => ({ ...config, extensions: [serverExtension] })
    return defineServer({ extensions: [browserExtension] })
  }
  throw new Error('unreachable')
}
`)
  })

  it('projects a direct defineApplication helper', async () => {
    const source = `
import { defineApplication } from 'vue-ssr-lite'
import { createAppRouter } from './router'
export default defineApplication({
  name: 'admin',
  router: createAppRouter,
  cleanup: () => undefined,
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/src/modules/admin/app.ts')
    expect(projection?.fields.router).toBe('createAppRouter')
    expect(projection?.fields.cleanup).toMatch(/\(\)\s*=>\s*(undefined|void 0)/)
    expect(projection?.imports.join('\n')).toContain('/app/src/modules/admin/router')
  })

  it('projects shorthand extensions', async () => {
    const source = `
import { defineServer, defineExtension } from 'vue-ssr-lite'
const analytics = defineExtension({ name: 'analytics' })
const extensions = [analytics]
export default defineServer({ extensions })
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBe('extensions')
    expect(projection?.statements?.join('\n')).toContain('const extensions = [analytics]')
    expect(projection?.statements?.join('\n')).toContain('const analytics = defineExtension')
  })

  it('projects a locally declared createInitialState', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const createInitialState = () => ({ marker: 'LOCAL_STATE' })
export default defineServer({
  createInitialState: createInitialState,
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.createInitialState).toBe('createInitialState')
    expect(projection?.statements?.join('\n')).toContain('LOCAL_STATE')
  })

  it('projects shorthand createInitialState', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const createInitialState = () => ({ marker: 'SHORTHAND_STATE' })
export default defineServer({ createInitialState })
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.createInitialState).toBe('createInitialState')
    expect(projection?.statements?.join('\n')).toContain('SHORTHAND_STATE')
  })

  it('projects a config stored in a variable', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
const config = defineServer({
  extensions: [analyticsExtension({ propertyId: 'UA-VAR' })],
})
export default config
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toContain('UA-VAR')
    expect(projection?.imports.join('\n')).toContain('/app/analytics')
  })

  it('projects a function SsrConfigExport', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
export default () =>
  defineServer({
    extensions: [analyticsExtension({ propertyId: 'UA-FN' })],
  })
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toContain('UA-FN')
  })

  it('projects an async SsrConfigExport with inner locals', async () => {
    const source = `
import { defineServer, defineExtension } from 'vue-ssr-lite'
export default async () => {
  const analytics = defineExtension({ name: 'analytics' })
  return defineServer({
    extensions: [analytics],
  })
}
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBe('[analytics]')
    expect(projection?.statements?.join('\n')).toContain('const analytics = defineExtension')
  })

  it('fails coverage when evaluated universal fields cannot be projected', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
const createConfig = () => ({
  extensions: [analyticsExtension({ propertyId: 'UA-DYNAMIC' })],
})
export default defineServer(createConfig())
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBeUndefined()
    expect(() =>
      assertUniversalProjectionCoverage(
        { extensions: [{ name: 'analytics' }] },
        projection,
        '/app/server.ts'
      )
    ).toThrow(/Cannot project universal field "extensions"/)
  })

  it('fails closed for an arbitrary one-argument wrapper around the config object', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
const wrapper = (config) => config
export default defineServer(
  wrapper({
    extensions: [analyticsExtension({ propertyId: 'UA-WRAP' })],
  })
)
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBeUndefined()
    expect(() =>
      assertUniversalProjectionCoverage(
        { extensions: [{ name: 'analytics' }] },
        projection,
        '/app/server.ts'
      )
    ).toThrow(/Cannot project universal field "extensions"/)
  })

  it('fails closed for a default-exported one-argument factory', async () => {
    const source = `
import { analyticsExtension } from './analytics'
const factory = (config) => config
export default factory({
  extensions: [analyticsExtension({ propertyId: 'UA-FACTORY' })],
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBeUndefined()
    expect(() =>
      assertUniversalProjectionCoverage(
        { extensions: [{ name: 'analytics' }] },
        projection,
        '/app/server.ts'
      )
    ).toThrow(/Cannot project universal field "extensions"/)
  })

  it('fails closed when a wrapper replaces extensions with a server-only value', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const transform = (config) => ({
  ...config,
  extensions: [serverExtension],
})
export default defineServer(
  transform({
    extensions: [browserExtension],
  })
)
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection).toBeUndefined()
    expect(() =>
      assertUniversalProjectionCoverage(
        { extensions: [{ name: 'server-only' }] },
        projection,
        '/app/server.ts'
      )
    ).toThrow(/Cannot project universal field "extensions"/)
  })

  it('fails closed for a wrapper inside a function SsrConfigExport', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const wrapper = (config) => config
export default () =>
  defineServer(
    wrapper({
      extensions: [{ name: 'browser' }],
    })
  )
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBeUndefined()
    expect(() =>
      assertUniversalProjectionCoverage(
        { extensions: [{ name: 'browser' }] },
        projection,
        '/app/server.ts'
      )
    ).toThrow(/Cannot project universal field "extensions"/)
  })

  it('fails closed for a wrapper inside an async SsrConfigExport', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
export default async () => {
  const wrapper = (config) => ({
    ...config,
    extensions: [{ name: 'server-only' }],
  })
  return defineServer(
    wrapper({
      extensions: [{ name: 'browser' }],
    })
  )
}
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBeUndefined()
    expect(() =>
      assertUniversalProjectionCoverage(
        { extensions: [{ name: 'server-only' }] },
        projection,
        '/app/server.ts'
      )
    ).toThrow(/Cannot project universal field "extensions"/)
  })

  it('fails closed when a config variable mutates extensions after defineServer', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const config = defineServer({
  extensions: [browserExtension],
})
config.extensions = [serverExtension]
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions".*mutated|mutated.*universal field "extensions"/
    )
  })

  it('fails closed when Object.assign mutates a config variable', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const config = defineServer({
  extensions: [browserExtension],
})
Object.assign(config, {
  extensions: [serverExtension],
})
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutated after defineServer/
    )
  })

  it('fails closed when extensions is mutated with push', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const config = defineServer({
  extensions: [browserExtension],
})
config.extensions.push(serverExtension)
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"/
    )
  })

  it('fails closed when a function export mutates the config before returning', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
export default () => {
  const config = defineServer({
    extensions: [{ name: 'browser' }],
  })
  config.extensions = [{ name: 'server-only' }]
  return config
}
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutated after defineServer/
    )
  })

  it('fails closed when an async export mutates extensions with splice', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
export default async () => {
  const config = defineServer({
    extensions: [{ name: 'browser' }],
  })
  config.extensions.splice(0, 1, { name: 'server-only' })
  return config
}
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"/
    )
  })

  it('fails closed when a local extensions array is mutated before defineServer', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const extensions = [browserExtension]
extensions.push(serverExtension)
export default defineServer({
  extensions,
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails closed when a local extensions array is mutated after defineServer', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const extensions = [browserExtension]
const config = defineServer({
  extensions,
})
extensions.splice(0, 1, serverExtension)
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails closed when an assignment alias mutates config extensions', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
let alias
alias = config
alias.extensions.push({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|mutated after defineServer/
    )
  })

  it('fails closed when a member alias mutates extensions', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
const alias = config.extensions
alias.push({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "alias"|universal field "extensions"/
    )
  })

  it('fails closed when config is passed to an unknown function', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const mutate = (value) => value
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
mutate(config)
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /unknown function/
    )
  })

  it('fails closed when config.extensions is passed to an unknown function', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const mutate = (value) => value
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
mutate(config.extensions)
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /unknown function/
    )
  })

  it.each([
    ['member call with config', 'helper.mutate(config)'],
    ['member call with extensions', 'helper.mutate(config.extensions)'],
    ['computed member call with extensions', "helper['mutate'](config.extensions)"],
    [
      'Reflect.set with config',
      "Reflect.set(config, 'extensions', [{ name: 'server-only' }])",
    ],
    [
      'Array.prototype.push.call with extensions',
      "Array.prototype.push.call(config.extensions, { name: 'server-only' })",
    ],
    [
      'Array.prototype.splice.apply with extensions',
      "Array.prototype.splice.apply(config.extensions, [0, 0, { name: 'server-only' }])",
    ],
    ['constructor argument', 'new Wrapper(config.extensions)'],
    ['bound argument', 'helper.mutate.bind(helper, config.extensions)'],
    ['optional member call', 'helper?.mutate?.(config.extensions)'],
  ])('fails closed for an unsupported tracked escape through %s', async (_label, statement) => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const helper = { mutate: (value) => value }
class Wrapper { constructor(value) { this.value = value } }
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
${statement}
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|configuration object|unsupported (?:call|constructor)|unknown function/
    )
  })

  it.each([
    [
      'function returning config',
      `function getValue() { return config }
const alias = getValue()
alias.extensions.push({ name: 'server-only' })`,
    ],
    [
      'function returning extensions',
      `function getValue() { return config.extensions }
const alias = getValue()
alias.push({ name: 'server-only' })`,
    ],
    [
      'arrow returning config',
      `const getValue = () => config
const alias = getValue()
alias.extensions.push({ name: 'server-only' })`,
    ],
    [
      'arrow returning extensions',
      `const getValue = () => config.extensions
const alias = getValue()
alias.push({ name: 'server-only' })`,
    ],
  ])('fails closed for an unsupported %s', async (_label, statements) => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
${statements}
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /returned from an unsupported function|universal field "extensions"|configuration object/
    )
  })

  it.each([
    [
      'object wrapper',
      `const holder = { config }
holder.config.extensions.push({ name: 'server-only' })`,
    ],
    [
      'field wrapper',
      `const holder = { extensions: config.extensions }
holder.extensions.push({ name: 'server-only' })`,
    ],
    [
      'array wrapper',
      `const holder = [config.extensions]
holder[0].push({ name: 'server-only' })`,
    ],
    [
      'nested wrapper',
      `const holder = { nested: [{ extensions: config.extensions }] }
holder.nested[0].extensions.push({ name: 'server-only' })`,
    ],
    [
      'array spread wrapper',
      `const holder = [...config.extensions]
holder[0].name = 'server-only'`,
    ],
    [
      'object spread wrapper',
      `const holder = { ...config }
holder.extensions.push({ name: 'server-only' })`,
    ],
    [
      'destructuring through a wrapper',
      `const holder = { nested: { extensions: config.extensions } }
const { nested: { extensions: alias } } = holder
alias.push({ name: 'server-only' })`,
    ],
  ])('fails closed when a tracked reference escapes through an %s', async (_label, statements) => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
${statements}
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|configuration object|mutable binding/
    )
  })

  it('fails closed when a tracked reference is assigned into a wrapper member', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const holder = {}
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
holder.value = config.extensions
holder.value.push({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /stored in an unsupported location|universal field "extensions"/
    )
  })

  it.each([
    ['yield', 'function* expose() { yield config.extensions }'],
    ['class field', 'class Holder { value = config.extensions }'],
    ['tagged template', 'const value = helper`${config.extensions}`'],
    ['named export', 'export const exposed = config.extensions'],
    ['string coercion', 'const exposed = `${config.extensions}`'],
    ['numeric coercion', 'const exposed = +config.extensions'],
    ['iteration', 'for (const exposed of config.extensions) void exposed'],
    [
      'parameter default',
      'function expose(value = config.extensions) { return value }',
    ],
    ['dynamic import', 'const exposed = import(config.extensions)'],
  ])('fails closed when a tracked reference escapes through %s', async (_label, statement) => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const helper = (parts, value) => value
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
${statement}
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /unsupported|universal field "extensions"|configuration object|mutable binding/
    )
  })

  it('fails closed when a projected callback returns the config through a server-side call', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
function getConfig() {
  return config
}
const config = defineServer({
  extensions: [{ name: 'browser' }],
  cleanup: getConfig,
})
const alias = getConfig()
alias.extensions.push({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /returned from an unsupported function|configuration object/
    )
  })

  it('does not treat a shadowed config parameter as the projected configuration', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
function tap(config) {
  config.extensions = [{ name: 'shadowed' }]
  config.extensions.push({ name: 'also-shadowed' })
}
const config = defineServer({
  extensions: [analyticsExtension({ propertyId: 'UA-SHADOW' })],
})
export default config
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toContain('UA-SHADOW')
    expect(projection?.imports.join('\n')).toContain('/app/analytics')
  })

  it('fails closed when a closure declared before a tracked binding mutates it', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
function mutateLater() {
  extensions.push(serverExtension)
}
const extensions = [browserExtension]
mutateLater()
export default defineServer({
  extensions,
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails closed when an arrow closure declared before a tracked binding mutates it', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const mutateLater = () => {
  extensions.push(serverExtension)
}
const extensions = [browserExtension]
mutateLater()
export default defineServer({
  extensions,
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails closed when a computed push mutates config extensions', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
config.extensions['push']({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|unknown function|mutated after defineServer/
    )
  })

  it('fails closed when an arbitrary method is called on a tracked receiver', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
config.extensions.customMutate({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|unknown function|mutated after defineServer/
    )
  })

  it('fails closed when an object destructuring assignment aliases config', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
let alias
;({
  extensions: alias,
} = config)
alias.push({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "alias"|universal field "extensions"/
    )
  })

  it('fails closed when an array destructuring assignment aliases extensions', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
let alias
;[alias] = [config.extensions]
alias.push({ name: 'server-only' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "alias"|universal field "extensions"/
    )
  })

  it('fails closed when an imported extensions array is mutated with push', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { extensions } from './universal'
extensions.push({ name: 'server-only-extension' })
export default defineServer({
  extensions,
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails closed when an imported extensions array is mutated with splice', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { extensions } from './universal'
extensions.splice(0, 1, { name: 'server-only-extension' })
export default defineServer({
  extensions,
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails closed when an imported object used by createInitialState is mutated', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { runtimeState } from './universal'
runtimeState.mode = 'server'
export default defineServer({
  createInitialState: () => ({
    mode: runtimeState.mode,
  }),
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutated after defineServer|the configuration object|universal field/
    )
  })

  it('fails closed when an imported universal value is passed to an unknown function', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { runtimeState } from './universal'
const mutate = (value) => value
mutate(runtimeState)
export default defineServer({
  createInitialState: () => ({
    mode: runtimeState.mode,
  }),
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(/unknown function/)
  })

  it('fails closed when an alias of an imported extensions array is mutated', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { extensions } from './universal'
const alias = extensions
alias.push({ name: 'server-only-extension' })
export default defineServer({
  extensions,
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "alias"|universal field "extensions"/
    )
  })

  it('projects a read-only imported extensions array without unused imports', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { extensions } from './universal'
import { unusedServerOnly } from './server-only'
export default defineServer({
  extensions,
  seo: { site: unusedServerOnly },
})
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toBe('extensions')
    expect(projection?.imports.join('\n')).toContain('/app/universal')
    expect(projection?.imports.join('\n')).not.toContain('server-only')
    expect(projection?.statements?.join('\n') ?? '').not.toContain('push')
    compileProjectedModule(projection!)
  })

  it('fails closed when a var alias inside a nested if mutates config outside that block', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
function mutate() {
  if (true) {
    var alias = config
  }
  alias.extensions.push({
    name: 'server-only',
  })
}
mutate()
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|mutated after defineServer|mutable binding "alias"/
    )
  })

  it('fails closed when a var alias of config.extensions is mutated', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
function mutate() {
  if (true) {
    var alias = config.extensions
  }
  alias.push({ name: 'server-only' })
}
mutate()
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /mutable binding "alias"|universal field "extensions"/
    )
  })

  it('fails closed when a var alias is declared in a for loop and mutated outside it', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
function mutate() {
  for (var alias = config; false; ) {}
  alias.extensions.push({ name: 'server-only' })
}
mutate()
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|mutated after defineServer|mutable binding "alias"/
    )
  })

  it('fails closed when a var alias is declared in a nested block and mutated outside it', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
function mutate() {
  {
    {
      var alias = config
    }
  }
  alias.extensions.push({ name: 'server-only' })
}
mutate()
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /universal field "extensions"|mutated after defineServer|mutable binding "alias"/
    )
  })

  it('does not treat an unrelated var declaration as the projected configuration', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
import { analyticsExtension } from './analytics'
const config = defineServer({
  extensions: [analyticsExtension({ propertyId: 'UA-VAR-UNRELATED' })],
})
function unrelated() {
  if (true) {
    var alias = { extensions: [] }
  }
  alias.extensions.push({ name: 'unrelated' })
}
export default config
`
    const projection = await projectUniversalRuntimeSource(source, '/app/server.ts')
    expect(projection?.fields.extensions).toContain('UA-VAR-UNRELATED')
    expect(projection?.imports.join('\n')).toContain('/app/analytics')
    compileProjectedModule(projection!)
  })

  it('fails closed when an object spread can override a universal field', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const serverOnly = { extensions: [{ name: 'SERVER_ONLY_SPREAD' }] }
export default defineServer({
  extensions: [{ name: 'browser' }],
  ...serverOnly,
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /contains a spread/
    )
  })

  it.each([
    "['extensions']: [{ name: 'SERVER_ONLY_COMPUTED' }]",
    "[field]: [{ name: 'SERVER_ONLY_COMPUTED' }]",
  ])('fails closed when a computed property can override a universal field', async (override) => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const field = 'extensions'
export default defineServer({
  extensions: [{ name: 'browser' }],
  ${override},
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /contains a computed property/
    )
  })

  it('fails closed for a computed destructuring alias of config', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const config = defineServer({ extensions: [{ name: 'browser' }] })
const { ['extensions']: alias } = config
alias.push({ name: 'SERVER_ONLY_COMPUTED_ALIAS' })
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /destructured through a computed property/
    )
  })

  it('fails closed when a tracked universal function is invoked as a template tag', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const cleanup = () => undefined
const config = defineServer({ cleanup })
config.cleanup\`SERVER_ONLY_TAGGED_CALL\`
export default config
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /unsupported tagged template/
    )
  })

  it.each(['node:fs', 'fs'])(
    'fails closed when a universal dependency imports Node built-in %s',
    async (specifier) => {
      const source = `
import { defineServer } from 'vue-ssr-lite'
import { readFileSync } from ${JSON.stringify(specifier)}
export default defineServer({
  createInitialState: () => ({ value: readFileSync('/SERVER_ONLY_FILE', 'utf8') }),
})
`
      await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
        /Node built-in/
      )
    }
  )

  it.each(['vue-ssr-lite/server', 'vue-ssr-lite/vite'])(
    'fails closed when a universal dependency imports server-only package subpath %s',
    async (specifier) => {
      const source = `
import { defineServer } from 'vue-ssr-lite'
import * as serverOnly from ${JSON.stringify(specifier)}
export default defineServer({ createInitialState: () => ({ serverOnly }) })
`
      await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
        /server\/build-only vue-ssr-lite module/
      )
    }
  )

  it('fails closed when a universal dependency reads a server runtime global', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
export default defineServer({
  createInitialState: () => ({ secret: process.env.SERVER_ONLY_SECRET }),
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /server-only global "process"/
    )
  })

  it('fails closed when a universal dependency dynamically imports a Node built-in', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
export default defineServer({
  createInitialState: async () => ({ module: await import('node:fs') }),
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /dynamically imports Node built-in/
    )
  })

  it('fails closed when a literal dynamic import reaches a local Node-only module', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-dynamic-local-node-'))
    try {
      await writeFile(
        join(tempRoot, 'dynamic.ts'),
        `
import { readFileSync } from 'node:fs'
export const value = readFileSync('/SERVER_ONLY_FILE', 'utf8')
`
      )
      const source = `
import { defineServer } from 'vue-ssr-lite'
export default defineServer({
  createInitialState: async () => ({ module: await import('./dynamic') }),
})
`
      await expect(projectUniversalRuntimeSource(source, join(tempRoot, 'server.ts'))).rejects.toThrow(
        /references Node built-in/
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails closed for a non-literal dynamic import in a universal dependency', async () => {
    const source = `
import { defineServer } from 'vue-ssr-lite'
const modulePath = './browser-module'
export default defineServer({
  createInitialState: async () => ({ module: await import(modulePath) }),
})
`
    await expect(projectUniversalRuntimeSource(source, '/app/server.ts')).rejects.toThrow(
      /non-literal dynamic import/
    )
  })

  it('fails closed when a local universal import transitively uses a Node built-in', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-transitive-node-'))
    try {
      await writeFile(
        join(tempRoot, 'universal.ts'),
        `
import { readFileSync } from 'node:fs'
export const createInitialState = () => ({ value: readFileSync('/SERVER_ONLY_FILE', 'utf8') })
`
      )
      const source = `
import { defineServer } from 'vue-ssr-lite'
import { createInitialState } from './universal'
export default defineServer({ createInitialState })
`
      await expect(projectUniversalRuntimeSource(source, join(tempRoot, 'server.ts'))).rejects.toThrow(
        /Node built-in/
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when a projected local module has an unused Node built-in sibling import', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-unused-node-'))
    try {
      await writeFile(
        join(tempRoot, 'universal.ts'),
        `
import { readFileSync } from 'node:fs'
export const unusedServerOnly = () => readFileSync('/SERVER_ONLY_FILE', 'utf8')
export const extensions = [{ name: 'browser' }]
`
      )
      const source = `
import { defineServer } from 'vue-ssr-lite'
import { extensions } from './universal'
export default defineServer({ extensions })
`
      await expect(projectUniversalRuntimeSource(source, join(tempRoot, 'server.ts'))).rejects.toThrow(
        /references Node built-in/
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails closed through a barrel that re-exports a Node-only universal binding', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-barrel-node-'))
    try {
      await writeFile(
        join(tempRoot, 'node-only.ts'),
        `
import { readFileSync } from 'node:fs'
export const createInitialState = () => ({ value: readFileSync('/SERVER_ONLY_FILE', 'utf8') })
`
      )
      await writeFile(
        join(tempRoot, 'barrel.ts'),
        `export { createInitialState } from './node-only'\n`
      )
      const source = `
import { defineServer } from 'vue-ssr-lite'
import { createInitialState } from './barrel'
export default defineServer({ createInitialState })
`
      await expect(projectUniversalRuntimeSource(source, join(tempRoot, 'server.ts'))).rejects.toThrow(
        /Node built-in/
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when an imported universal module has an unrelated top-level side effect', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-import-side-effect-'))
    try {
      await writeFile(
        join(tempRoot, 'universal.ts'),
        `
console.log('SERVER_ONLY_IMPORT_SIDE_EFFECT')
export const extensions = [{ name: 'browser' }]
`
      )
      const source = `
import { defineServer } from 'vue-ssr-lite'
import { extensions } from './universal'
export default defineServer({ extensions })
`
      await expect(projectUniversalRuntimeSource(source, join(tempRoot, 'server.ts'))).rejects.toThrow(
        /top-level side effect/
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})

describe('universal projection compile coverage', () => {
  let root = ''

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__VUE_SSR_LITE_MUTATOR_EVALUATED__
    if (root) await rm(root, { recursive: true, force: true })
    root = ''
  })

  const writeShell = async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src/main.ts'), 'export default () => {}\n')
    await writeFile(join(root, 'src/App.vue'), '<template><div /></template>\n')
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div></body></html>\n'
    )
  }

  it('loads a function-export server.ts into the generated client', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-fn-'))
    await writeShell()
    await writeFile(
      join(root, 'src/analytics.ts'),
      `export const analyticsExtension = (options) => ({ name: 'analytics', options })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
import { analyticsExtension } from './src/analytics'
export default () =>
  defineServer({
    extensions: [analyticsExtension({ propertyId: 'UA-COMPILE' })],
  })
`
    )
    const config = await loadSsrConfigFile(root)
    const entries = extractSsrViteEntries(config, { root })
    const client = generateSsrClientModule(root, entries.applications[0])
    expect(client).toContain('UA-COMPILE')
    expect(client).toContain('extensions:')
    expect(client).not.toMatch(/from ["'].*server\.ts["']/)
  })

  it('fails config loading when universal fields cannot be projected', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-bad-'))
    await writeShell()
    await writeFile(
      join(root, 'src/analytics.ts'),
      `export const analyticsExtension = (options) => ({ name: 'analytics', options })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
import { analyticsExtension } from './src/analytics'
const createConfig = () => ({
  extensions: [analyticsExtension({ propertyId: 'UA-BAD' })],
})
export default defineServer(createConfig())
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /Cannot project universal field "extensions"/
    )
  })

  const writeSiblingModules = async () => {
    await writeFile(
      join(root, 'src/browser-ext.ts'),
      `export const createExtension = (options) => options\n`
    )
    await writeFile(
      join(root, 'src/server-only.ts'),
      `export const serverOnlyFunction = () => 'SERVER_ONLY_SECRET'\n`
    )
  }

  const expectSiblingClient = (client: string) => {
    expect(client).toContain('browserExtension')
    expect(client).toContain('createExtension')
    expect(client).toContain('browser-ext')
    expect(client).not.toContain('privateValue')
    expect(client).not.toContain('serverOnlyFunction')
    expect(client).not.toContain('SERVER_ONLY_SECRET')
    expect(client).not.toContain('server-only')
    transformSync(client, { loader: 'js', format: 'esm' })
  }

  it('keeps a trailing server-only sibling declarator out of the generated client', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-sib-a-'))
    await writeShell()
    await writeSiblingModules()
    await writeFile(join(root, 'server.ts'), siblingDeclarationSource('browser-first', defineServerPath))
    const config = await loadSsrConfigFile(root)
    const entries = extractSsrViteEntries(config, { root })
    expectSiblingClient(generateSsrClientModule(root, entries.applications[0]))
  })

  it('keeps a leading server-only sibling declarator out of the generated client', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-sib-b-'))
    await writeShell()
    await writeSiblingModules()
    await writeFile(join(root, 'server.ts'), siblingDeclarationSource('private-first', defineServerPath))
    const config = await loadSsrConfigFile(root)
    const entries = extractSsrViteEntries(config, { root })
    expectSiblingClient(generateSsrClientModule(root, entries.applications[0]))
  })

  it('fails config loading for a wrapper that changes extensions', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-wrap-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
const browserExtension = { name: 'browser' }
const serverExtension = { name: 'server-only' }
const transform = (config) => ({
  ...config,
  extensions: [serverExtension],
})
export default defineServer(
  transform({
    extensions: [browserExtension],
  })
)
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /Cannot project universal field "extensions"/
    )
  })

  it('fails config loading for a wrapper inside an async export', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-async-wrap-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
export default async () => {
  const wrapper = (config) => config
  return defineServer(
    wrapper({
      extensions: [{ name: 'browser' }],
    })
  )
}
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /Cannot project universal field "extensions"/
    )
  })

  it('fails config loading when array destructuring would omit an effectful sibling', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-arr-a-'))
    await writeShell()
    await writeSiblingModules()
    await writeFile(join(root, 'server.ts'), arrayDestructureSource('browser-first', defineServerPath))
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('fails config loading when array destructuring would omit a leading effectful sibling', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-arr-b-'))
    await writeShell()
    await writeSiblingModules()
    await writeFile(join(root, 'server.ts'), arrayDestructureSource('private-first', defineServerPath))
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('fails config loading when object destructuring would omit an effectful sibling', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-obj-'))
    await writeShell()
    await writeSiblingModules()
    await writeFile(join(root, 'server.ts'), objectDestructureSource(defineServerPath))
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('projects pure literal destructuring into the generated client', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-pure-des-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
const { marker, unused } = { marker: 'PURE_CLIENT', unused: 0 }
export default defineServer({
  createInitialState: () => ({ marker }),
})
`
    )
    const config = await loadSsrConfigFile(root)
    const entries = extractSsrViteEntries(config, { root })
    const client = generateSsrClientModule(root, entries.applications[0])
    expect(client).toContain('PURE_CLIENT')
    expect(client).not.toContain('unused')
    transformSync(client, { loader: 'js', format: 'esm' })
  })

  it('fails config loading when destructuring cannot isolate a browser binding', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-des-fail-'))
    await writeShell()
    await writeFile(
      join(root, 'src/server-only.ts'),
      `
export const createValues = () => ({
  browserExtension: { name: 'browser' },
  privateValue: 'SERVER_ONLY_SECRET',
})
`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
import { createValues } from './src/server-only'
const { browserExtension, privateValue } = createValues()
export default defineServer({
  extensions: [browserExtension],
})
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /Binding "browserExtension" comes from a destructuring pattern/
    )
  })

  it('fails config loading when extensions are assigned after defineServer', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-mut-assign-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
config.extensions = [{ name: 'server-only' }]
export default config
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /universal field "extensions".*mutated|mutated after defineServer/
    )
  })

  it('fails config loading when Object.assign mutates the config', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-mut-assign-obj-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
Object.assign(config, {
  extensions: [{ name: 'server-only' }],
})
export default config
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(/mutated after defineServer/)
  })

  it('fails config loading when a function export mutates extensions', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-mut-fn-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
export default () => {
  const config = defineServer({
    extensions: [{ name: 'browser' }],
  })
  config.extensions.push({ name: 'server-only' })
  return config
}
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(/universal field "extensions"/)
  })

  it('fails config loading when a local extensions array is mutated before defineServer', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-ext-push-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
const extensions = [{ name: 'browser' }]
extensions.push({ name: 'server-only' })
export default defineServer({
  extensions,
})
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails config loading when an assignment alias mutates config', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-alias-assign-'))
    await writeShell()
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineServerPath)}
const config = defineServer({
  extensions: [{ name: 'browser' }],
})
let alias
alias = config
alias.extensions.push({ name: 'server-only' })
export default config
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /universal field "extensions"|unknown function|mutated after defineServer/
    )
  })

  it('keeps a projected helper object supported in a single-app config', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-helper-single-'))
    await writeShell()
    await writeFile(
      join(root, 'helper.ts'),
      `export default { extensions: [{ name: 'SAFE_HELPER' }] }\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import helper from './helper'
export default defineServer({ extensions: helper.extensions })
`
    )
    const loaded = await loadSsrConfigFile(root)
    const client = generateSsrClientModule(root, extractSsrViteEntries(loaded, { root }).applications[0])
    expect(loaded.extensions).toEqual([{ name: 'SAFE_HELPER' }])
    expect(client).toContain('helper')
  })

  it('keeps a projected helper object supported through a tsconfig alias', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-helper-alias-'))
    await writeShell()
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@helper': ['./helper.ts'] } } })
    )
    await writeFile(
      join(root, 'helper.ts'),
      `export default { extensions: [{ name: 'SAFE_ALIAS_HELPER' }] }\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import helper from '@helper'
export default defineServer({ extensions: helper.extensions })
`
    )
    const loaded = await loadSsrConfigFile(root)
    const client = generateSsrClientModule(root, extractSsrViteEntries(loaded, { root }).applications[0])
    expect(loaded.extensions).toEqual([{ name: 'SAFE_ALIAS_HELPER' }])
    expect(client).toMatch(/from ["']@helper["']/)
  })

  it('keeps a projected helper protected from reachable server-only mutation', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-helper-mutation-'))
    await writeShell()
    await writeFile(
      join(root, 'helper.ts'),
      `export default { extensions: [{ name: 'browser' }] }\n`
    )
    await writeFile(
      join(root, 'mutator.ts'),
      `import helper from './helper'\nhelper.extensions.push({ name: 'SERVER_ONLY_HELPER' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import helper from './helper'
import './mutator'
export default defineServer({ extensions: helper.extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "helper"|universal field "extensions"/
    )
  })

  it('still classifies an imported defineApplication module as an application target', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-real-app-identity-'))
    await writeShell()
    await writeFile(
      join(root, 'app.ts'),
      `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
export default defineApplication({ name: 'app', extensions: [{ name: 'browser' }] })
`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import application from './app'
export default defineServer({ extensions: application.extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /defineServer\(\{ applications \}\)|applications.*direct static property/
    )
  })

  it('fails config loading when server.ts mutates an imported application projection', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-imported-app-mutation-'))
    await writeShell()
    await writeFile(
      join(root, 'app.ts'),
      `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
export default defineApplication({
  name: 'app',
  extensions: [{ name: 'browser' }],
})
`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import application from './app'
application.extensions.push({ name: 'SERVER_ONLY_IMPORTED_APP_MUTATION' })
export default defineServer({ applications: [application] })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /configuration object|universal field "extensions"|mutated after/
    )
  })

  it('fails config loading when server.ts clones and overrides an imported application projection', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-imported-app-clone-'))
    await writeShell()
    await writeFile(
      join(root, 'app.ts'),
      `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
export default defineApplication({
  name: 'app',
  extensions: [{ name: 'browser' }],
})
`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import application from './app'
const overridden = {
  ...application,
  extensions: [{ name: 'SERVER_ONLY_IMPORTED_APP_OVERRIDE' }],
}
export default defineServer({ applications: [overridden] })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /direct imported defineApplication|Clones, spreads/
    )
  })

  it('fails config loading when server.ts mutates an imported application dependency', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-imported-dependency-mutation-'))
    await writeShell()
    await writeFile(
      join(root, 'universal.ts'),
      `export const extensions = [{ name: 'browser' }]\n`
    )
    await writeFile(
      join(root, 'barrel.ts'),
      `export { extensions } from './universal'\n`
    )
    await writeFile(
      join(root, 'mutation-barrel.ts'),
      `export { extensions } from './universal'\n`
    )
    await writeFile(
      join(root, 'app.ts'),
      `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './barrel'
export default defineApplication({ name: 'app', extensions })
`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import application from './app'
import { extensions } from './mutation-barrel'
extensions.push({ name: 'SERVER_ONLY_IMPORTED_DEPENDENCY_MUTATION' })
export default defineServer({ applications: [application] })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails config loading when an application is re-exported through a barrel then mutated', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-app-barrel-mutation-'))
    await writeShell()
    await writeFile(
      join(root, 'app.ts'),
      `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
export default defineApplication({
  name: 'app',
  extensions: [{ name: 'browser' }],
})
`
    )
    await writeFile(
      join(root, 'apps.ts'),
      `export { default as application } from './app'\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { application } from './apps'
application.extensions.push({ name: 'SERVER_ONLY_APP_BARREL_MUTATION' })
export default defineServer({ applications: [application] })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /configuration object|universal field "extensions"|mutated after/
    )
  })

  it('fails config loading when an intermediary side-effect module mutates protected state', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-side-effect-mutator-'))
    await writeShell()
    await writeFile(
      join(root, 'universal.ts'),
      `export const extensions = [{ name: 'browser' }]\n`
    )
    await writeFile(
      join(root, 'mutator.ts'),
      `
import { extensions } from './universal'
extensions.push({ name: 'SERVER_ONLY_INTERMEDIARY_MUTATION' })
`
    )
    await writeFile(
      join(root, 'app.ts'),
      `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
export default defineApplication({ name: 'app', extensions })
`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import application from './app'
import './mutator'
export default defineServer({ applications: [application] })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails single-app config loading when an intermediary module mutates protected state', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-single-side-effect-mutator-'))
    await writeShell()
    await writeFile(
      join(root, 'universal.ts'),
      `export const extensions = [{ name: 'browser' }]\n`
    )
    await writeFile(
      join(root, 'mutator.ts'),
      `
import { extensions } from './universal'
extensions.push({ name: 'SERVER_ONLY_SINGLE_APP_MUTATION' })
`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
import './mutator'
export default defineServer({ extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails single-app config loading when a dynamic import acquires protected state', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-single-dynamic-mutator-'))
    await writeShell()
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(
      join(root, 'mutator.ts'),
      `const universal = await import('./universal')\nuniversal.extensions.push({ name: 'SERVER_ONLY_DYNAMIC_MUTATION' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
import './mutator'
export default defineServer({ extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(/dynamic import.*protected universal state/)
  })

  it('fails multi-app config loading when a dynamic import acquires protected state', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-multi-dynamic-mutator-'))
    await writeShell()
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(
      join(root, 'mutator.ts'),
      `const universal = await import('./universal')\nuniversal.extensions.push({ name: 'SERVER_ONLY_DYNAMIC_MUTATION' })\n`
    )
    await writeFile(
      join(root, 'app.ts'), `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
export default defineApplication({ name: 'app', extensions })
`)
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import application from './app'
import './mutator'
export default defineServer({ applications: [application] })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(/dynamic import.*protected universal state/)
  })

  it('fails dynamic imports of protected state re-exported through a barrel', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-dynamic-barrel-mutator-'))
    await writeShell()
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(join(root, 'barrel.ts'), `export { extensions } from './universal'\n`)
    await writeFile(
      join(root, 'mutator.ts'),
      `const universal = await import('./barrel')\nuniversal.extensions.push({ name: 'SERVER_ONLY_DYNAMIC_BARREL_MUTATION' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
import './mutator'
export default defineServer({ extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(/dynamic import.*protected universal state/)
  })

  it('fails CommonJS require() of protected universal state', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-require-mutator-'))
    await writeShell()
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(
      join(root, 'mutator.cjs'),
      `const { extensions } = require('./universal')\nextensions.push({ name: 'SERVER_ONLY_REQUIRE_MUTATION' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
import './mutator.cjs'
export default defineServer({ extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(/require\(\).*protected universal state/)
  })

  it.each(['module.require', "module['require']"])(
    'fails %s acquisition of protected state before evaluating the mutator',
    async (requireExpression) => {
      root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-module-require-'))
      await writeShell()
      await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
      await writeFile(
        join(root, 'mutator.cjs'),
        `(globalThis).__VUE_SSR_LITE_MUTATOR_EVALUATED__ = true\nconst { extensions } = ${requireExpression}('./universal')\nextensions.push({ name: 'SERVER_ONLY_MODULE_REQUIRE' })\n`
      )
      await writeFile(
        join(root, 'server.ts'),
        `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
import './mutator.cjs'
export default defineServer({ extensions })
`
      )
      await expect(loadSsrConfigFile(root)).rejects.toThrow(
        /module\.require\(\).*protected universal state/
      )
      expect((globalThis as Record<string, unknown>).__VUE_SSR_LITE_MUTATOR_EVALUATED__).toBeUndefined()
    }
  )

  it('fails module.require() acquisition through a relative barrel', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-module-require-barrel-'))
    await writeShell()
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(join(root, 'barrel.ts'), `export { extensions } from './universal'\n`)
    await writeFile(
      join(root, 'mutator.cjs'),
      `const { extensions } = module.require('./barrel')\nextensions.push({ name: 'SERVER_ONLY_BARREL_REQUIRE' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
import './mutator.cjs'
export default defineServer({ extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /module\.require\(\).*protected universal state/
    )
  })

  it('keeps literal module.require() of unrelated CommonJS state supported', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-safe-module-require-'))
    await writeShell()
    await writeFile(join(root, 'unrelated.cjs'), `module.exports = { value: 'SAFE_CJS' }\n`)
    await writeFile(
      join(root, 'consumer.cjs'),
      `const { value } = module.require('./unrelated.cjs')\nif (value !== 'SAFE_CJS') throw new Error('unexpected CommonJS value')\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineConfigPath)}\nimport './consumer.cjs'\nexport default defineServer({ extensions: [{ name: 'browser' }] })\n`
    )
    const loaded = await loadSsrConfigFile(root)
    expect(loaded.extensions).toEqual([{ name: 'browser' }])
  })

  it('uses the esbuild identity for a tsconfig path alias and rejects reachable mutation', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-path-alias-mutation-'))
    await writeShell()
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@universal': ['./universal.ts'],
            '@mutation-target': ['./universal.ts'],
          },
        },
      })
    )
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(
      join(root, 'mutator.ts'),
      `import { extensions } from '@mutation-target'\nextensions.push({ name: 'SERVER_ONLY_ALIAS_MUTATION' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from '@universal'
import './mutator'
export default defineServer({ extensions })
`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('keeps a read-only tsconfig alias and its original browser specifier supported', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-path-alias-safe-'))
    await writeShell()
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@universal': ['./universal.ts'] } } })
    )
    await writeFile(
      join(root, 'universal.ts'),
      `export const extensions = [{ name: 'SAFE_ALIAS' }]\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from '@universal'
export default defineServer({ extensions })
`
    )
    const loaded = await loadSsrConfigFile(root)
    const client = generateSsrClientModule(root, extractSsrViteEntries(loaded, { root }).applications[0])
    expect(client).toMatch(/from ["']@universal["']/)
    expect(loaded.extensions).toEqual([{ name: 'SAFE_ALIAS' }])
  })

  it('resolves a projected tsconfig alias through a re-export barrel', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-path-alias-barrel-'))
    await writeShell()
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@barrel': ['./barrel.ts'] } } })
    )
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'SAFE_ALIAS_BARREL' }]\n`)
    await writeFile(join(root, 'barrel.ts'), `export { extensions } from './universal'\n`)
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from '@barrel'
export default defineServer({ extensions })
`
    )
    const loaded = await loadSsrConfigFile(root)
    expect(loaded.extensions).toEqual([{ name: 'SAFE_ALIAS_BARREL' }])
  })

  it('rejects alias mutation in a multi-application graph', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-path-alias-multi-'))
    await writeShell()
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@universal': ['./universal.ts'] } } })
    )
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(
      join(root, 'app.ts'),
      `import { defineApplication } from ${JSON.stringify(defineConfigPath)}\nimport { extensions } from '@universal'\nexport default defineApplication({ name: 'app', extensions })\n`
    )
    await writeFile(
      join(root, 'mutator.ts'),
      `import { extensions } from '@universal'\nextensions.push({ name: 'SERVER_ONLY_ALIAS_MULTI' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineConfigPath)}\nimport application from './app'\nimport './mutator'\nexport default defineServer({ applications: [application] })\n`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  const writeStatePackage = async (
    packageName: string,
    manifest: Record<string, unknown> = { type: 'module', exports: './index.js' }
  ) => {
    const packageRoot = join(root, 'node_modules', packageName)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: packageName, ...manifest })
    )
    await writeFile(join(packageRoot, 'index.js'), `export const extensions = [{ name: 'browser' }]\n`)
    return packageRoot
  }

  it('rejects server-only mutation of a projected bare-package export', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-package-mutation-'))
    await writeShell()
    await writeStatePackage('projected-state')
    await writeFile(
      join(root, 'mutator.ts'),
      `import { extensions } from 'projected-state'\nextensions.push({ name: 'SERVER_ONLY_PACKAGE' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineConfigPath)}\nimport { extensions } from 'projected-state'\nimport './mutator'\nexport default defineServer({ extensions })\n`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('keeps a read-only browser-safe bare package supported', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-package-safe-'))
    await writeShell()
    await writeStatePackage('safe-projected-state')
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineConfigPath)}\nimport { extensions } from 'safe-projected-state'\nexport default defineServer({ extensions })\n`
    )
    const loaded = await loadSsrConfigFile(root)
    expect(loaded.extensions).toEqual([{ name: 'browser' }])
  })

  it('tracks a package subpath as a protected external identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-package-subpath-'))
    await writeShell()
    const packageRoot = await writeStatePackage('projected-subpath', {
      type: 'module',
      exports: { './state': './index.js' },
    })
    await writeFile(join(packageRoot, 'index.js'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(
      join(root, 'mutator.ts'),
      `import { extensions } from 'projected-subpath/state'\nextensions.push({ name: 'SERVER_ONLY_SUBPATH' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineConfigPath)}\nimport { extensions } from 'projected-subpath/state'\nimport './mutator'\nexport default defineServer({ extensions })\n`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('canonicalizes different package subpaths that resolve to the same module state', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-package-subpath-alias-'))
    await writeShell()
    await writeStatePackage('projected-subpath-alias', {
      type: 'module',
      exports: { './projected': './index.js', './mutated': './index.js' },
    })
    await writeFile(
      join(root, 'mutator.ts'),
      `import { extensions } from 'projected-subpath-alias/mutated'\nextensions.push({ name: 'SERVER_ONLY_SUBPATH_ALIAS' })\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineConfigPath)}\nimport { extensions } from 'projected-subpath-alias/projected'\nimport './mutator'\nexport default defineServer({ extensions })\n`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(
      /mutable binding "extensions"|universal field "extensions"/
    )
  })

  it('fails closed for divergent Node/browser conditional package exports', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-package-conditional-'))
    await writeShell()
    const packageRoot = await writeStatePackage('conditional-projected-state', {
      type: 'module',
      exports: {
        '.': { browser: './browser.js', node: './node.js', default: './browser.js' },
      },
    })
    await writeFile(join(packageRoot, 'browser.js'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(join(packageRoot, 'node.js'), `export const extensions = [{ name: 'SERVER_ONLY_NODE' }]\n`)
    await writeFile(
      join(root, 'server.ts'),
      `import { defineServer } from ${JSON.stringify(defineConfigPath)}\nimport { extensions } from 'conditional-projected-state'\nexport default defineServer({ extensions })\n`
    )
    await expect(loadSsrConfigFile(root)).rejects.toThrow(/browser\/Node conditional resolution/)
  })

  it('fails non-literal dynamic acquisition in a protected config graph', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-nonliteral-dynamic-'))
    await writeShell()
    await writeFile(join(root, 'universal.ts'), `export const extensions = [{ name: 'browser' }]\n`)
    await writeFile(
      join(root, 'mutator.ts'),
      `const target = './universal'\nconst universal = await import(target)\nuniversal.extensions.push({ name: 'SERVER_ONLY_NONLITERAL_MUTATION' })\n`
    )
    const serverPath = join(root, 'server.ts')
    const serverSource = `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal'
import './mutator'
export default defineServer({ extensions })
`
    await writeFile(serverPath, serverSource)
    await expect(
      assertNoImportedUniversalConfigMutation(
        serverSource,
        serverPath,
        [],
        [join(root, 'universal.ts')],
        [join(root, 'mutator.ts')]
      )
    ).rejects.toThrow(/non-literal dynamic import/)
  })

  it('keeps literal dynamic imports with no protected state supported', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-safe-dynamic-import-'))
    await writeShell()
    await writeFile(join(root, 'unrelated.ts'), `export const value = 'SAFE_DYNAMIC_IMPORT'\n`)
    await writeFile(join(root, 'side-effect.ts'), `await import('./unrelated')\n`)
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import './side-effect'
export default defineServer({ extensions: [{ name: 'SAFE_DYNAMIC_IMPORT' }] })
`
    )
    const loaded = await loadSsrConfigFile(root)
    const client = generateSsrClientModule(root, extractSsrViteEntries(loaded, { root }).applications[0])
    expect(client).toContain('SAFE_DYNAMIC_IMPORT')
  })

  it('keeps read-only application and dependency re-export barrels supported', async () => {
    root = await mkdtemp(join(tmpdir(), 'vue-ssr-lite-projection-safe-barrels-'))
    await writeShell()
    await writeFile(
      join(root, 'universal.ts'),
      `export const extensions = [{ name: 'SAFE_READ_ONLY_BARREL' }]\n`
    )
    await writeFile(
      join(root, 'universal-barrel.ts'),
      `export { extensions } from './universal'\n`
    )
    await writeFile(
      join(root, 'app.ts'),
      `
import { defineApplication } from ${JSON.stringify(defineConfigPath)}
import { extensions } from './universal-barrel'
export default defineApplication({ name: 'app', extensions })
`
    )
    await writeFile(
      join(root, 'apps.ts'),
      `export { default as application } from './app'\n`
    )
    await writeFile(
      join(root, 'server.ts'),
      `
import { defineServer } from ${JSON.stringify(defineConfigPath)}
import { application } from './apps'
export default defineServer({ applications: [application] })
`
    )
    const loaded = await loadSsrConfigFile(root)
    const client = generateSsrClientModule(root, extractSsrViteEntries(loaded, { root }).applications[0])
    expect(client).toContain('universal-barrel')
    expect(client).not.toContain('server.ts')
  })
})
