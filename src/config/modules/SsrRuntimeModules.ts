/** Generated server and browser module source from resolved configuration entries. */
import { resolve } from 'node:path'
import { type SsrViteApplicationEntry, SSR_RENDERER_VIRTUAL_ID, toProjectRelative } from '../compile/SsrRuntimeConfigCompile'
import { createHash } from 'node:crypto'
import { getSsrStateElementId } from '../../hydration/SsrSerialization'
import { generateSsrDevelopmentStylesheetHandoff, generateSsrDevelopmentRenderedStylesheetHandoff } from '../../assets/SsrApplicationAssetRuntime'

const absoluteImportPath = (root: string, filePath: string): string => {
  if (/^[@~#]/.test(filePath)) return filePath.replaceAll('\\', '/')
  return resolve(root, filePath).replaceAll('\\', '/')
}

const shellAlias = (kind: 'root' | 'main', id: string, index: number): string =>
  `__ssr${kind === 'root' ? 'Root' : 'Main'}${index}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`

export const generateSsrRuntimeModule = (
  root: string,
  configPath: string | undefined,
  entries: SsrViteApplicationEntry[],
  viteBase = '/'
): string => {
  const importLines: string[] = configPath
    ? [`import __ssrUserConfig from ${JSON.stringify(absoluteImportPath(root, configPath))}`]
    : []
  importLines.push(
    `import { renderSsrApplication as __vueSsrLiteRenderApplication } from ${JSON.stringify(SSR_RENDERER_VIRTUAL_ID)}`
  )
  const shellBindings: string[] = ['  const __vueSsrLiteShells = {']
  const imported = new Map<string, string>()
  entries
    .filter((entry) => entry.kind === 'ssr')
    .forEach((entry, index) => {
      const rootPath = absoluteImportPath(root, entry.root)
      const mainPath = absoluteImportPath(root, entry.main)
      const rootAlias =
        imported.get(`root:${rootPath}`) ?? shellAlias('root', entry.id, index)
      const mainAlias =
        imported.get(`main:${mainPath}`) ?? shellAlias('main', entry.id, index)
      if (!imported.has(`root:${rootPath}`)) {
        importLines.push(`import ${rootAlias} from ${JSON.stringify(rootPath)}`)
        imported.set(`root:${rootPath}`, rootAlias)
      }
      if (!imported.has(`main:${mainPath}`)) {
        importLines.push(`import * as ${mainAlias} from ${JSON.stringify(mainPath)}`)
        imported.set(`main:${mainPath}`, mainAlias)
      }
      shellBindings.push(
        `    ${JSON.stringify(entry.id)}: { root: ${imported.get(`root:${rootPath}`)}, main: ${imported.get(`main:${mainPath}`)} },`
      )
    })
  shellBindings.push('  }')
  const applicationFiles = entries
    .filter((entry) => entry.applicationFile)
    .map(
      (entry) =>
        `    [${JSON.stringify(entry.id)}, ${JSON.stringify(toProjectRelative(root, absoluteImportPath(root, entry.applicationFile!)))}],`
    )
  return [
    ...importLines,
    '',
    'const resolveConfig = async () => {',
    configPath
      ? '  const exported = __ssrUserConfig?.default ?? __ssrUserConfig\n  const config = typeof exported === "function" ? await exported() : exported'
      : '  const config = {}',
    `  const viteBase = ${JSON.stringify(viteBase)}`,
    `  const __vueSsrLiteModuleRoot = ${JSON.stringify(root.replaceAll('\\', '/'))}`,
    ...shellBindings,
    '  const __vueSsrLiteApplicationFiles = new Map([',
    ...applicationFiles,
    '  ])',
    '  return { ...config, __vueSsrLiteViteBase: viteBase, __vueSsrLiteModuleRoot, __vueSsrLiteRenderApplication, __vueSsrLiteShells, __vueSsrLiteApplicationFiles }',
    '}',
    '',
    'export default resolveConfig',
    '',
  ].join('\n')
}

const isIdentifierName = (value: string): boolean => /^[A-Za-z_$][\w$]*$/.test(value)

const applicationRoutesImportLine = (routesPath: string, exported?: string): string => {
  if (exported === 'default') {
    return `import applicationRoutes from ${JSON.stringify(routesPath)}`
  }
  if (exported && exported !== '*' && isIdentifierName(exported)) {
    return `import { ${exported} as applicationRoutes } from ${JSON.stringify(routesPath)}`
  }
  return `import * as applicationRoutes from ${JSON.stringify(routesPath)}`
}

const applicationRoutesBindingLine = (exported?: string): string => {
  if (exported === 'default' || (exported && exported !== '*' && isIdentifierName(exported))) {
    return 'const routes = applicationRoutes'
  }
  if (exported && exported !== '*') {
    return `const routes = applicationRoutes[${JSON.stringify(exported)}]`
  }
  return 'const routes = applicationRoutes.default ?? applicationRoutes.routes'
}

export const generateSsrClientModule = (
  root: string,
  entry: SsrViteApplicationEntry,
  environment: { development?: boolean } = {}
): string => {
  const rootPath = absoluteImportPath(root, entry.root)
  const mainPath = absoluteImportPath(root, entry.main)
  const routesPath = entry.routesModule
    ? absoluteImportPath(root, entry.routesModule)
    : undefined
  const hydrate = entry.kind !== 'spa'
  const mountSelector = JSON.stringify(entry.mountSelector)
  const projection = entry.universalProjection
  // A linked or duplicated module graph can evaluate the same generated entry
  // twice with different component and initializer object identities. Coordinate
  // that entry through its complete projected input identity. A different entry
  // that happens to use the same public id receives a different identity and
  // still reaches the browser document ownership guard.
  const readyIdentity = createHash('sha256')
    .update(JSON.stringify([
      entry.root,
      entry.main,
      entry.routesModule,
      entry.routesExport,
      entry.routesFromMain,
      entry.kind,
      entry.mountSelector,
      entry.clientSeo,
      projection,
      environment.development,
    ]))
    .digest('hex')
    .slice(0, 16)
  const lines = [
    `import App from ${JSON.stringify(rootPath)}`,
    `import * as __ssrMain from ${JSON.stringify(mainPath)}`,
  ]
  if (routesPath) {
    lines.push(applicationRoutesImportLine(routesPath, entry.routesExport))
  }
  if (projection?.imports.length) {
    lines.push(...projection.imports)
  }
  if (projection?.statements?.length) {
    lines.push(...projection.statements)
  }
  lines.push(
    `import { ${hydrate ? 'hydrateSsrApplication, mountSpaApplication' : 'mountSpaApplication'} } from 'vue-ssr-lite/client'`
  )
  lines.push(
    'try {',
    '  const observer = globalThis[Symbol.for("vue-ssr-lite:browser-timing")]',
    `  if (typeof observer === "function") observer({ applicationId: ${JSON.stringify(entry.id)}, phase: "client-entry-evaluated", time: performance.now() })`,
    '} catch {}',
  )
  const projectedFields = projection
    ? Object.entries(projection.fields).map(([key, value]) => `  ${key}: ${value},`)
    : []
  lines.push(
    'const initialize = __ssrMain.default',
    routesPath
      ? applicationRoutesBindingLine(entry.routesExport)
      : entry.routesFromMain === false
        ? 'const routes = undefined'
        : 'const routes = __ssrMain.routes',
    'if (typeof initialize !== "function") {',
    `  throw new Error(${JSON.stringify(`Application "${entry.id}" main module must default-export an initializer function.`)})`,
    '}',
    'if (!App) {',
    `  throw new Error(${JSON.stringify(`Application "${entry.id}" root component is missing.`)})`,
    '}',
    'export const definition = {',
    `  id: ${JSON.stringify(entry.id)},`,
    `  __vueSsrLiteDevelopment: ${environment.development ?? 'import.meta.env.DEV'},`,
    '  root: App,',
    `  seo: ${JSON.stringify(entry.clientSeo ?? {})},`,
    '  routes,',
    `  defaultRender: ${JSON.stringify(entry.kind)},`,
    '  install: initialize,',
    ...projectedFields,
    '}',
    `const __ssrReadyKey = Symbol.for(${JSON.stringify(`vue-ssr-lite:client-ready:${entry.id}`)})`,
    'const __ssrDocument = document',
    'const __ssrReadyRecord = __ssrDocument[__ssrReadyKey]',
    `const __ssrReadyIdentity = ${JSON.stringify(readyIdentity)}`,
    'const __ssrExistingReady = __ssrReadyRecord?.identity === __ssrReadyIdentity ? __ssrReadyRecord.ready : undefined',
    'let __ssrOwnReady',
    'let __ssrOwnReadyRecord',
  )
  if (hydrate) {
    lines.push(
      `const __ssrStateId = ${JSON.stringify(getSsrStateElementId(entry.id))}`,
      'export const ready = __ssrExistingReady ?? (__ssrOwnReady = (async () => {',
      '  const __ssrStateElement = document.getElementById(__ssrStateId)',
      '  if (__ssrStateElement?.textContent) {',
      ...(environment.development === false ? [] : [
        `    if (${environment.development ?? 'import.meta.env.DEV'}) {`,
        ...generateSsrDevelopmentStylesheetHandoff(entry.id).map((line) => `      ${line}`),
        ...generateSsrDevelopmentRenderedStylesheetHandoff(entry.id).map((line) => `      ${line}`),
        '    }',
      ]),
      `    await hydrateSsrApplication(definition, { mountSelector: ${mountSelector} })`,
      '    return',
      '  }',
      `  return mountSpaApplication(definition, { mountSelector: ${mountSelector} })`,
      '})())',
      'if (__ssrOwnReady) {',
      '  if (!__ssrReadyRecord) {',
      '    __ssrOwnReadyRecord = { identity: __ssrReadyIdentity, ready }',
      '    __ssrDocument[__ssrReadyKey] = __ssrOwnReadyRecord',
      '  }',
      '  void ready.catch((error) => {',
      '    if (__ssrDocument[__ssrReadyKey] === __ssrOwnReadyRecord) delete __ssrDocument[__ssrReadyKey]',
      "    console.error('[vue-ssr-lite] hydration failed', error)",
      '  })',
      '}',
      '',
    )
  } else {
    lines.push(
      `export const ready = __ssrExistingReady ?? (__ssrOwnReady = mountSpaApplication(definition, { mountSelector: ${mountSelector} }))`,
      'if (__ssrOwnReady) {',
      '  if (!__ssrReadyRecord) {',
      '    __ssrOwnReadyRecord = { identity: __ssrReadyIdentity, ready }',
      '    __ssrDocument[__ssrReadyKey] = __ssrOwnReadyRecord',
      '  }',
      '  void ready.catch((error) => {',
      '    if (__ssrDocument[__ssrReadyKey] === __ssrOwnReadyRecord) delete __ssrDocument[__ssrReadyKey]',
      "    console.error('[vue-ssr-lite] SPA mount failed', error)",
      '  })',
      '}',
      '',
    )
  }
  return lines.join('\n')
}
