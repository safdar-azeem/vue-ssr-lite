/** Configuration source discovery, graph evaluation, and Vite entry resolution. */
import { defineServer } from '../SsrConfigRuntime'
import {
  bundleSsrConfigModule,
  type SsrConfigModuleGraph,
  collectApplicationDeclarationFiles,
  resolveSsrConfigGraphModule,
  collectSkippedApplicationRoutesFiles,
  bundleSsrConfigModules,
  isEvaluatedApplicationConfig,
  resolveApplicationRoutesModule,
} from './SsrConfigCompileBoundary'
import {
  DEFINE_SERVER_ROUTES_ERROR,
  SSR_DEFAULT_APPLICATION_ID,
  SSR_DEFAULT_MAIN,
  SSR_DEFAULT_ROOT,
  SSR_DEFAULT_TEMPLATE,
  SSR_RENDERER_VIRTUAL_ID,
  resolveSsrDevelopmentControlPlane,
  normalizeSsrConfig,
  resolveApplicationSeoConfig,
  type NormalizeSsrConfigOptions,
  type SsrNormalizedConfig,
  type SsrResolvedServerOptions,
  type SsrViteApplicationEntry,
  type SsrViteEntries,
  toProjectRelative,
  attachClientGraph,
} from './SsrRuntimeConfigCompile'
import { access, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import {
  type SsrUniversalRuntimeProjection,
  isDefineApplicationModuleSource,
  resolveApplicationRoutesImportBindings,
  sourceDeclaresSpaOnlyApplication,
  projectUniversalRuntimeSource,
  assertUniversalProjectionCoverage,
  sourceDeclaresServerConfigRoutes,
  assertNoImportedUniversalConfigMutation,
} from '../projection/index'
import { resolve, relative, isAbsolute } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { SsrConfig, SsrConfigExport } from '../SsrConfigTypes'
import { prepareSsrHtmlTemplate, SSR_HTML_TEMPLATE } from '../../rendering/SsrHtmlRuntime'
import type { SsrBrowserBootstrapCapability } from '../../browser/SsrBrowserBootstrap'
import { isSeoEnabled } from '../../extensions/seo/types'

export { defineServer }
export { bundleSsrConfigModule } from './SsrConfigCompileBoundary'

export {
  DEFINE_SERVER_ROUTES_ERROR,
  SSR_CLIENT_VIRTUAL_PREFIX,
  SSR_DEFAULT_APPLICATION_ENTRY,
  SSR_DEFAULT_APPLICATION_ID,
  SSR_DEFAULT_MAIN,
  SSR_DEFAULT_MOUNT,
  SSR_DEFAULT_ROOT,
  SSR_DEFAULT_TEMPLATE,
  SSR_HTML_VIRTUAL_PREFIX,
  SSR_RENDERER_VIRTUAL_ID,
  SSR_RUNTIME_VIRTUAL_ID,
  compileSsrConfig,
  resolveSsrDevelopmentControlPlane,
  isStaticSiteSeo,
  normalizeRobotsConfig,
  normalizeSiteSeoConfig,
  normalizeSsrConfig,
  resolveApplicationSeoConfig,
  resolveProjectPath,
  siteSeoToApplicationConfig,
} from './SsrRuntimeConfigCompile'
export type {
  CompileSsrConfigOptions,
  NormalizeSsrConfigOptions,
  SsrCompiledApplication,
  SsrCompiledConfig,
  SsrNormalizedApplicationConfig,
  SsrNormalizedConfig,
  SsrResolvedServerOptions,
  SsrViteApplicationEntry,
  SsrViteEntries,
} from './SsrRuntimeConfigCompile'

const CONFIG_CANDIDATES = ['server.ts'] as const

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export interface SsrDiscoveredApplicationSources {
  files: Map<string, string>
  routesModules: Map<string, string>
  routesExports: Map<string, string>
  projections: Map<string, SsrUniversalRuntimeProjection>
  truncated: boolean
}

interface SsrConfigSourceAnalysis {
  source: string
  applicationModule: boolean
  browserOnlyMiddleware: boolean
  projection?: SsrUniversalRuntimeProjection
}

const evaluateBundledConfigModule = async (
  root: string,
  code: string
): Promise<Record<string, unknown>> => {
  const cacheDirectory = resolve(root, 'node_modules', '.cache', 'vue-ssr-lite')
  await mkdir(cacheDirectory, { recursive: true })
  const outfile = resolve(cacheDirectory, `server.${randomBytes(6).toString('hex')}.mjs`)
  try {
    await writeFile(outfile, code, 'utf8')
    return (await import(pathToFileURL(outfile).href)) as Record<string, unknown>
  } finally {
    await rm(outfile, { force: true })
  }
}

export const discoverApplicationSourceFiles = async (
  root: string,
  configPath: string,
  authoritativeGraph?: SsrConfigModuleGraph,
  sourceAnalyses: ReadonlyMap<string, SsrConfigSourceAnalysis> = new Map()
): Promise<SsrDiscoveredApplicationSources> => {
  const walked = await collectApplicationDeclarationFiles(configPath, 0, new Set(), root)
  const moduleResolver = authoritativeGraph
    ? (importer: string, specifier: string) =>
        resolveSsrConfigGraphModule(authoritativeGraph, importer, specifier)
    : undefined
  const isProjectFile = (file: string) => {
    const relativePath = relative(root, file)
    return !relativePath.startsWith('..') && !isAbsolute(relativePath)
  }
  const authoritativeFiles = authoritativeGraph
    ? [
        ...authoritativeGraph.imports.keys(),
        ...[...authoritativeGraph.imports.values()].flat(),
      ].filter((file) => file !== configPath && isProjectFile(file))
    : []
  const authoritativeApplicationFiles: string[] = []
  for (const file of [...new Set(authoritativeFiles)]) {
    try {
      const cached = sourceAnalyses.get(file)
      if (
        cached?.applicationModule ??
        (await isDefineApplicationModuleSource(
          await readFile(file, 'utf8'), file, moduleResolver
        ))
      ) {
        authoritativeApplicationFiles.push(file)
      }
    } catch {
      // Non-script and unavailable graph nodes cannot be declaration modules.
    }
  }
  const candidateFiles = [
    ...new Set([...walked.files, ...authoritativeApplicationFiles]),
  ]
  const skippedRoutesFiles = new Set([
    ...(await collectSkippedApplicationRoutesFiles(candidateFiles)),
    ...[...(authoritativeGraph?.applicationRoutesModules ?? [])].map((file) =>
      file.replaceAll('\\', '/')
    ),
  ])
  const files = new Map<string, string>()
  const routesModules = new Map<string, string>()
  const routesExports = new Map<string, string>()
  const projections = new Map<string, SsrUniversalRuntimeProjection>()
  const applicationCandidates = candidateFiles.filter(
    (file) =>
      !skippedRoutesFiles.has(
        file.replaceAll('\\', '/').replace(/^\/private(?=\/(?:var|tmp)\/)/, '')
      )
  )
  const bundledApplications = await bundleSsrConfigModules(
    root,
    applicationCandidates
  )
  for (const file of applicationCandidates) {
    const code = bundledApplications.codes.get(file)
    if (!code) throw new Error(`Failed to discover application config: ${file}`)
    const graph = bundledApplications.graph
    const namespace = await evaluateBundledConfigModule(root, code)
    if (!isEvaluatedApplicationConfig(namespace.default)) continue
    const application = namespace.default
    const existing = files.get(application.name)
    if (existing && existing !== file) {
      throw new Error(
        `Application "${application.name}" is default-exported from both ${existing} and ${file}. Import each defineApplication() module once.`
      )
    }
    files.set(application.name, file)
    const analysis = sourceAnalyses.get(file)
    const source = analysis?.source ?? (await readFile(file, 'utf8'))
    const routesAbsolute = resolveApplicationRoutesModule(file, graph, application.name)
    if (routesAbsolute) {
      routesModules.set(application.name, toProjectRelative(root, routesAbsolute))
      const [routesBinding] = await resolveApplicationRoutesImportBindings(source, file)
      if (routesBinding) routesExports.set(application.name, routesBinding.imported)
    } else if (application.routes) {
      throw new Error(
        `Application "${application.name}" must import a dedicated routes module so the client graph does not import ${file}.`
      )
    }
    const browserOnlyMiddleware = application.render === 'spa' &&
      (analysis?.browserOnlyMiddleware ??
        (await sourceDeclaresSpaOnlyApplication(source, file, moduleResolver)))
    const projection = analysis?.projection ??
      (await projectUniversalRuntimeSource(source, file, moduleResolver, {
        browserOnlyMiddleware,
      }))
    assertUniversalProjectionCoverage(application, projection, file)
    if (projection) projections.set(application.name, projection)
  }
  return { files, routesModules, routesExports, projections, truncated: walked.truncated }
}

export const resolveSsrConfigPath = async (
  root: string,
  explicit?: string
): Promise<string | undefined> => {
  if (explicit) {
    const fullPath = resolve(root, explicit)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      throw new Error(`vue-ssr-lite could not find the configured server file: ${fullPath}`)
    }
  }
  for (const candidate of CONFIG_CANDIDATES) {
    const fullPath = resolve(root, candidate)
    try {
      await access(fullPath)
      return fullPath
    } catch {
      // Configuration is optional; convention files still apply.
    }
  }
  return undefined
}

export interface SsrSelectedConfigIdentities {
  /** Explicit `vue-ssr-lite --config` path. */
  cli?: string
  /** Explicit `vueSsrLite({ config })` path. */
  plugin?: string
}

export const SSR_CONFLICTING_CONFIG_IDENTITY =
  'vue-ssr-lite received conflicting server configs'

const isSameSsrConfigIdentity = async (left: string, right: string) => {
  if (left === right) return true
  try {
    return (await realpath(left)) === (await realpath(right))
  } catch {
    return false
  }
}

/**
 * One authoritative server-config path for the Vite runtime graph and the
 * failed-startup control plane. Explicit CLI and plugin paths must agree;
 * otherwise convention discovery applies.
 */
export const resolveSsrSelectedConfigPath = async (
  root: string,
  identities: SsrSelectedConfigIdentities = {}
): Promise<string | undefined> => {
  const cli = identities.cli
    ? await resolveSsrConfigPath(root, identities.cli)
    : undefined
  const plugin = identities.plugin
    ? await resolveSsrConfigPath(root, identities.plugin)
    : undefined
  if (cli && plugin && !(await isSameSsrConfigIdentity(cli, plugin))) {
    throw new Error(
      [
        `${SSR_CONFLICTING_CONFIG_IDENTITY}.`,
        `  --config: ${cli}`,
        `  vueSsrLite({ config }): ${plugin}`,
        'Use one explicit server config, or make both paths refer to the same file.',
      ].join('\n')
    )
  }
  return resolveSsrConfigPath(root, cli ?? plugin)
}

const assertConventionFiles = async (
  root: string,
  config: SsrConfig,
  applicationFiles?: ReadonlyMap<string, string>
) => {
  const normalized = normalizeSsrConfig(config, { root, applicationFiles })
  for (const application of Object.values(normalized.applications)) {
    const mainPath = resolve(root, application.shell.main)
    const rootPath = resolve(root, application.shell.root)
    if (!(await exists(mainPath))) {
      throw new Error(
        `Application "${application.id}" main was not found at ${mainPath}. Create ${SSR_DEFAULT_MAIN}, or set app.main.`
      )
    }
    if (!(await exists(rootPath))) {
      throw new Error(
        `Application "${application.id}" root component was not found at ${rootPath}. Create ${SSR_DEFAULT_ROOT}, or set app.root.`
      )
    }
    const templatePath = resolve(root, application.template)
    if (await exists(templatePath)) {
      const source = await readFile(templatePath, 'utf8')
      try {
        prepareSsrHtmlTemplate(source, application.mountSelector)
      } catch (error) {
        throw new Error(
          `Application "${application.id}" template ${templatePath} is invalid: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } else if (application.template !== SSR_DEFAULT_TEMPLATE) {
      throw new Error(
        `Application "${application.id}" HTML template was not found at ${templatePath}.`
      )
    } else {
      try {
        prepareSsrHtmlTemplate(SSR_HTML_TEMPLATE, application.mountSelector)
      } catch (error) {
        throw new Error(
          `Application "${application.id}" default HTML template is invalid: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
  }
}

/** Load optional overrides; absence means the standard Vue conventions. */
export const loadSsrConfigFile = async (root: string, configPath?: string): Promise<SsrConfig> => {
  const absoluteConfig = await resolveSsrConfigPath(root, configPath)
  if (!absoluteConfig) {
    const config: SsrConfig = {}
    await assertConventionFiles(root, config)
    return config
  }
  const configSource = await readFile(absoluteConfig, 'utf8')
  if (await sourceDeclaresServerConfigRoutes(configSource, absoluteConfig)) {
    throw new Error(DEFINE_SERVER_ROUTES_ERROR)
  }
  const { code, graph } = await bundleSsrConfigModule(root, absoluteConfig)
  const moduleResolver = (importer: string, specifier: string) =>
    resolveSsrConfigGraphModule(graph, importer, specifier)
  const isProjectFile = (file: string) => {
    const relativePath = relative(root, file)
    return !relativePath.startsWith('..') && !isAbsolute(relativePath)
  }
  const browserMiddlewareModules = new Set(
    [...(graph.browserMiddlewareModules ?? [])].map((file) =>
      file.replaceAll('\\', '/').replace(/^\/private(?=\/(?:var|tmp)\/)/, '')
    )
  )
  const serverConfigModules = new Set(
    [...(graph.serverConfigModules ?? [])].map((file) =>
      file.replaceAll('\\', '/').replace(/^\/private(?=\/(?:var|tmp)\/)/, '')
    )
  )
  const reachableConfigModules = [
    ...new Set([
      ...graph.imports.keys(),
      ...[...graph.imports.values()].flat(),
    ]),
  ].filter(isProjectFile).filter((file) => {
    const normalized = file.replaceAll('\\', '/').replace(/^\/private(?=\/(?:var|tmp)\/)/, '')
    return !browserMiddlewareModules.has(normalized) || serverConfigModules.has(normalized)
  })
  const preEvaluationProjections = new Map<string, SsrUniversalRuntimeProjection>()
  const preEvaluationApplicationFiles = new Set<string>()
  const sourceAnalyses = new Map<string, SsrConfigSourceAnalysis>()
  const analyzedSources = await Promise.all(
    [absoluteConfig, ...reachableConfigModules].map(async (file) => {
      const source =
        file === absoluteConfig ? configSource : await readFile(file, 'utf8')
      const applicationModule =
        file !== absoluteConfig &&
        (await isDefineApplicationModuleSource(source, file, moduleResolver))
      const browserOnlyMiddleware =
        (file === absoluteConfig || applicationModule) &&
        (await sourceDeclaresSpaOnlyApplication(source, file, moduleResolver))
      const projection = await projectUniversalRuntimeSource(
        source,
        file,
        moduleResolver,
        { browserOnlyMiddleware }
      )
      return {
        file,
        analysis: {
          source,
          applicationModule,
          browserOnlyMiddleware,
          projection,
        } satisfies SsrConfigSourceAnalysis,
      }
    })
  )
  for (const { file, analysis } of analyzedSources) {
    const { applicationModule, projection } = analysis
    if (applicationModule) preEvaluationApplicationFiles.add(file)
    if (projection) {
      preEvaluationProjections.set(file, projection)
    }
    sourceAnalyses.set(file, analysis)
  }
  const protectedUniversalDependencies = [
    ...new Set(
      [...preEvaluationProjections.values()]
        .flatMap((projection) => projection.dependencyFiles ?? [])
    ),
  ]
  const protectedUniversalIdentities = [
    ...new Set(
      [...preEvaluationProjections.values()].flatMap(
        (projection) => projection.dependencyIdentities ?? []
      )
    ),
  ]
  await assertNoImportedUniversalConfigMutation(
    configSource,
    absoluteConfig,
    preEvaluationApplicationFiles,
    protectedUniversalDependencies,
    reachableConfigModules,
    moduleResolver,
    protectedUniversalIdentities
  )
  const discovered = await discoverApplicationSourceFiles(
    root,
    absoluteConfig,
    graph,
    sourceAnalyses
  )
  let singleApplicationProjection = discovered.files.size
    ? undefined
    : preEvaluationProjections.get(absoluteConfig)
  const loaded = (await evaluateBundledConfigModule(root, code)) as {
    default?: SsrConfigExport
  }
  const exported = loaded.default ?? (loaded as unknown as SsrConfigExport)
  const config = typeof exported === 'function' ? await exported() : exported
  if (!config || typeof config !== 'object') {
    throw new Error('The server.ts module must export an object.')
  }
  if (Array.isArray(config.applications)) {
    for (const application of config.applications) {
      if (!isEvaluatedApplicationConfig(application)) {
        throw new Error(
          'defineServer({ applications }) must contain defineApplication() results.'
        )
      }
        if (application.routes && !discovered.routesModules.has(application.name)) {
          throw new Error(
            `Application "${application.name}" must import a dedicated routes module from its own defineApplication() file` +
              (discovered.truncated
                ? ' (application discovery stopped at import depth 4)'
                : '') +
              '. Inline defineApplication({ routes }) and deep barrels are not supported.'
          )
        }
        const applicationFile = discovered.files.get(application.name) ?? absoluteConfig
        assertUniversalProjectionCoverage(
          application,
          discovered.projections.get(application.name),
          applicationFile
        )
    }
  } else {
    if (
      config.render !== 'spa' &&
      (await sourceDeclaresSpaOnlyApplication(configSource, absoluteConfig, moduleResolver))
    ) {
      singleApplicationProjection = await projectUniversalRuntimeSource(
        configSource,
        absoluteConfig,
        moduleResolver
      )
    }
    assertUniversalProjectionCoverage(
      config,
      singleApplicationProjection,
      absoluteConfig
    )
    if (singleApplicationProjection) {
      discovered.projections.set(
        SSR_DEFAULT_APPLICATION_ID,
        singleApplicationProjection
      )
    }
  }
  await assertConventionFiles(root, config, discovered.files)
  const normalized = normalizeSsrConfig(config, {
    root,
    applicationFiles: discovered.files,
    routesModules: discovered.routesModules,
    routesExports: discovered.routesExports,
  })
  attachClientGraph(
    normalized.applications,
    discovered.routesModules,
    discovered.routesExports
  )
  Object.defineProperty(config, '__vueSsrLiteApplicationFiles', {
    value: discovered.files,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteRoutesModules', {
    value: discovered.routesModules,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteRoutesExports', {
    value: discovered.routesExports,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteUniversalProjections', {
    value: discovered.projections,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteNormalized', {
    value: normalized,
    enumerable: false,
  })
  Object.defineProperty(config, '__vueSsrLiteConfigDependencies', {
    value: [...new Set([absoluteConfig, ...reachableConfigModules, ...discovered.files.values()])],
    enumerable: false,
  })
  return config
}

/**
 * Development listen options from the specialized config compiler.
 * Vue, routes, and other application modules are stubbed; only server.ts and
 * config-evaluated defineApplication modules run. Missing server.ts uses
 * convention defaults. A present but invalid server config remains fatal.
 */
export const resolveSsrDevelopmentControlPlaneFromRoot = async (
  root: string,
  configPath?: string
): Promise<SsrResolvedServerOptions> => {
  const absoluteConfig = await resolveSsrConfigPath(root, configPath)
  if (!absoluteConfig) {
    return resolveSsrDevelopmentControlPlane({ default: () => ({}) }, { root })
  }
  const config = await loadSsrConfigFile(root, absoluteConfig)
  return resolveSsrDevelopmentControlPlane({ default: () => config }, { root })
}

export const extractSsrViteEntries = (
  config: SsrConfig,
  options: NormalizeSsrConfigOptions = {}
): SsrViteEntries => {
  const attached = (config as { __vueSsrLiteNormalized?: SsrNormalizedConfig }).__vueSsrLiteNormalized
  const projections = (
    config as { __vueSsrLiteUniversalProjections?: Map<string, SsrUniversalRuntimeProjection> }
  ).__vueSsrLiteUniversalProjections
  const normalized = attached ?? normalizeSsrConfig(config, options)
  if (!attached) {
    attachClientGraph(normalized.applications, options.routesModules, options.routesExports)
  }
  return {
    applications: Object.values(normalized.applications).map((app) => ({
      id: app.id,
      kind: app.render,
      main: app.shell.main,
      root: app.shell.root,
      routesModule: app.shell.routesModule,
      routesExport: app.shell.routesExport,
      routesFromMain: !app.shell.applicationDir,
      template: app.template,
      mountSelector: app.mountSelector,
      applicationFile: app.shell.applicationFile,
      universalProjection: projections?.get(app.id),
      clientSeo: resolveApplicationSeoConfig(app.seo),
      initialBootstrap: (() => {
        const initial: SsrBrowserBootstrapCapability[] = []
        const navigation = Boolean(app.routes || app.router || app.shell.routesModule)
        if (navigation) initial.push('navigation')
        if (navigation && app.middleware?.length) initial.push('middleware')
        const seo = isSeoEnabled(resolveApplicationSeoConfig(app.seo))
        if (seo) initial.push('seo')
        if (seo || app.extensions?.length) initial.push('extensions')
        return initial
      })(),
    })),
  }
}

export const resolveSsrViteEntries = async (
  root: string,
  configPath?: string
): Promise<SsrViteEntries> =>
  extractSsrViteEntries(await loadSsrConfigFile(root, configPath), { root })

export { generateSsrRuntimeModule, generateSsrClientModule } from '../modules/SsrRuntimeModules'
