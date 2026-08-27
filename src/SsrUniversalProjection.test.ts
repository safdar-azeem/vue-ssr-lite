import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertUniversalProjectionCoverage,
  projectUniversalRuntimeSource,
  type SsrUniversalRuntimeProjection,
} from './SsrUniversalProjection'
import { loadSsrConfigFile, extractSsrViteEntries, generateSsrClientModule } from './SsrConfigCompileRuntime'

const libraryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const defineServerPath = join(libraryRoot, 'src/SsrConfigRuntime.ts')

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
})

describe('universal projection compile coverage', () => {
  let root = ''

  afterEach(async () => {
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
})
