/** Import rewriting, module resolution, and browser-safe dependency validation. */
import { builtinModules } from 'node:module'
import { resolve, dirname, extname } from 'node:path'
import type { EstreeNode, Binding, SsrUniversalModuleResolver, SsrUniversalResolvedModule } from './types'
import {
  asNode,
  projectionBoundaryError,
  asNodes,
  walkFreeIdentifiers,
  tryResolve,
  loaderForFile,
  loadParseAst,
  collectModuleBindings,
  addPatternNames,
  collectNeededBindings,
  isTriviallyPure,
} from './syntax'
import { importedExportName, walkChildNodes } from './scopes'
import { stat, readFile } from 'node:fs/promises'
import { transformSync } from 'esbuild'

const NODE_BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => `node:${specifier}`),
])

const SERVER_RUNTIME_GLOBALS = new Set([
  'Bun',
  'Deno',
  'Buffer',
  'Function',
  '__dirname',
  '__filename',
  'eval',
  'global',
  'globalThis',
  'module',
  'process',
  'require',
])

const PROJECTED_MODULE_EXTENSIONS = [
  '',
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.tsx',
  '.jsx',
] as const
export const PROJECTED_SCRIPT_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.tsx',
  '.jsx',
])

const isNodeBuiltinSpecifier = (specifier: string): boolean => {
  const clean = specifier.split(/[?#]/, 1)[0]
  return NODE_BUILTIN_SPECIFIERS.has(clean) || clean.startsWith('node:')
}

const isKnownServerOnlySpecifier = (specifier: string, importer: string): boolean => {
  const clean = specifier.split(/[?#]/, 1)[0]
  if (
    clean === 'vue-ssr-lite/server' ||
    clean.startsWith('vue-ssr-lite/server/') ||
    clean === 'vue-ssr-lite/vite' ||
    clean.startsWith('vue-ssr-lite/vite/')
  ) {
    return true
  }
  if (!(clean.startsWith('.') || clean.startsWith('/'))) return false
  const resolved = (clean.startsWith('/') ? clean : resolve(dirname(importer), clean)).replaceAll(
    '\\',
    '/'
  )
  // Keep HTTP execution separate from the public identity helpers in server/routes.
  // Former server/ implementations retain their boundary after domain moves.
  return /\/vue-ssr-lite\/src\/(?:server(?:\.[cm]?[jt]s|\/runtime\/)|vite(?:\.[cm]?[jt]s|\/)|config\/(?:compile\/|projection\/|modules\/|SsrRuntimeConfigRuntime)|rendering\/(?:SsrHtmlRuntime|SsrProductionTemplateRuntime)|diagnostics\/SsrErrorDocument|extensions\/seo\/SsrSitemapConfig)/.test(
    resolved
  )
}

const rewriteSpecifier = (importer: string, specifier: string): string => {
  if (!(specifier.startsWith('.') || specifier.startsWith('/'))) return specifier
  return resolve(dirname(importer), specifier).replaceAll('\\', '/')
}

export const rewriteImport = (
  node: EstreeNode,
  filePath: string,
  locals: Set<string>
): string => {
  const source = asNode(node.source)
  const raw = typeof source?.value === 'string' ? source.value : undefined
  if (!raw) return ''
  if (isNodeBuiltinSpecifier(raw)) {
    throw projectionBoundaryError(
      filePath,
      `Universal runtime dependency ${JSON.stringify(raw)} is a Node built-in and cannot enter the browser graph.`
    )
  }
  if (isKnownServerOnlySpecifier(raw, filePath)) {
    throw projectionBoundaryError(
      filePath,
      `Universal runtime dependency ${JSON.stringify(raw)} is a server/build-only vue-ssr-lite module and cannot enter the browser graph.`
    )
  }
  const rewritten = JSON.stringify(rewriteSpecifier(filePath, raw))
  const used = asNodes(node.specifiers).filter((item) => {
    const local = asNode(item.local)
    return local?.type === 'Identifier' && locals.has(local.name as string)
  })
  if (!used.length) return `import ${rewritten}`
  let defaultLocal: string | undefined
  let namespaceLocal: string | undefined
  const named: string[] = []
  for (const item of used) {
    const local = asNode(item.local)
    if (local?.type !== 'Identifier') continue
    const localName = local.name as string
    if (item.type === 'ImportDefaultSpecifier') defaultLocal = localName
    else if (item.type === 'ImportNamespaceSpecifier') namespaceLocal = `* as ${localName}`
    else {
      const exported = importedExportName(item) ?? localName
      named.push(exported === localName ? exported : `${exported} as ${localName}`)
    }
  }
  const clauses: string[] = []
  if (defaultLocal) clauses.push(defaultLocal)
  if (namespaceLocal) clauses.push(namespaceLocal)
  if (named.length) clauses.push(`{ ${named.join(', ')} }`)
  return `import ${clauses.join(', ')} from ${rewritten}`
}

export const assertNoServerRuntimeGlobals = (
  fieldNodes: EstreeNode[],
  needed: Binding[],
  filePath: string
) => {
  const declared = new Set(needed.map((binding) => binding.name))
  const inspect = (node: EstreeNode) => {
    const free = new Set<string>()
    walkFreeIdentifiers(node, new Set(), free)
    for (const name of free) {
      if (!SERVER_RUNTIME_GLOBALS.has(name) || declared.has(name)) continue
      throw projectionBoundaryError(
        filePath,
        `Universal runtime dependency references server-only global ${JSON.stringify(name)}. ` +
          'Move Node/server environment access outside extensions, middleware, router, scrollBehavior, createInitialState, and cleanup.'
      )
    }
  }
  for (const node of fieldNodes) inspect(node)
  for (const binding of needed) {
    if (binding.kind !== 'import') inspect(binding.node)
  }
}

export const assertNoNodeBuiltinDynamicImports = (nodes: EstreeNode[], filePath: string) => {
  const inspect = (node: EstreeNode | undefined) => {
    if (!node) return
    if (node.type === 'ImportExpression') {
      const source = asNode(node.source)
      const specifier = typeof source?.value === 'string' ? source.value : undefined
      if (!specifier) {
        throw projectionBoundaryError(
          filePath,
          'A universal runtime dependency uses a non-literal dynamic import that Core cannot resolve and prove browser-safe.'
        )
      }
      if (specifier && isNodeBuiltinSpecifier(specifier)) {
        throw projectionBoundaryError(
          filePath,
          `Universal runtime dependency dynamically imports Node built-in ${JSON.stringify(specifier)}, which cannot enter the browser graph.`
        )
      }
    }
    walkChildNodes(node, { names: new Map(), kind: 'module' }, (child) => inspect(child))
  }
  for (const node of nodes) inspect(node)
}

const collectLiteralDynamicImports = (nodes: EstreeNode[]): string[] => {
  const found = new Set<string>()
  const inspect = (node: EstreeNode | undefined) => {
    if (!node) return
    if (node.type === 'ImportExpression') {
      const source = asNode(node.source)
      if (typeof source?.value === 'string') found.add(source.value)
    }
    walkChildNodes(node, { names: new Map(), kind: 'module' }, (child) => inspect(child))
  }
  for (const node of nodes) inspect(node)
  return [...found]
}

export const resolveProjectedModule = async (
  importer: string,
  specifier: string,
  moduleResolver?: SsrUniversalModuleResolver
): Promise<SsrUniversalResolvedModule | undefined> => {
  if (moduleResolver) return moduleResolver(importer, specifier)
  if (!(specifier.startsWith('.') || specifier.startsWith('/'))) {
    return { identity: `external:${specifier}`, external: true }
  }
  const base = specifier.startsWith('/') ? specifier : resolve(dirname(importer), specifier)
  for (const extension of PROJECTED_MODULE_EXTENSIONS) {
    const candidate = `${base}${extension}`
    try {
      if ((await stat(candidate)).isFile()) {
        const path = candidate.replaceAll('\\', '/')
        return { identity: path, path, external: false }
      }
    } catch {
      // Try the next supported module extension.
    }
  }
  for (const extension of PROJECTED_MODULE_EXTENSIONS) {
    const candidate = resolve(base, `index${extension}`)
    try {
      if ((await stat(candidate)).isFile()) {
        const path = candidate.replaceAll('\\', '/')
        return { identity: path, path, external: false }
      }
    } catch {
      // Try the next supported index module extension.
    }
  }
  return undefined
}

export const importBindingTarget = (
  binding: Binding
): { specifier: string; imported: string } | undefined => {
  if (binding.kind !== 'import' || binding.node.type !== 'ImportDeclaration') return undefined
  const source = asNode(binding.node.source)
  if (typeof source?.value !== 'string') return undefined
  for (const item of asNodes(binding.node.specifiers)) {
    const local = asNode(item.local)
    if (local?.type !== 'Identifier' || local.name !== binding.name) continue
    if (item.type === 'ImportDefaultSpecifier') return { specifier: source.value, imported: 'default' }
    if (item.type === 'ImportNamespaceSpecifier') return { specifier: source.value, imported: '*' }
    return { specifier: source.value, imported: importedExportName(item) ?? binding.name }
  }
  return undefined
}

const packageNameFromSpecifier = (specifier: string): string | undefined => {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return undefined
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const hasDivergentBrowserCondition = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasDivergentBrowserCondition)
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const conditionalKeys = ['browser', 'node'].filter((key) => key in record)
  if (conditionalKeys.length) {
    const branches = [record.browser, record.node, record.import, record.default]
      .filter((branch) => branch !== undefined)
      .map((branch) => JSON.stringify(branch))
    if (new Set(branches).size > 1) return true
  }
  return Object.values(record).some(hasDivergentBrowserCondition)
}

const assertExternalPackageHasStableBrowserIdentity = async (
  importer: string,
  specifier: string
): Promise<void> => {
  const packageName = packageNameFromSpecifier(specifier)
  if (!packageName) return
  let entry = tryResolve(importer, specifier)
  if (!entry) return
  let directory = dirname(entry)
  while (true) {
    const packagePath = resolve(directory, 'package.json')
    try {
      const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
        name?: string
        browser?: unknown
        exports?: unknown
      }
      if (manifest.name === packageName) {
        if (manifest.browser || hasDivergentBrowserCondition(manifest.exports)) {
          throw projectionBoundaryError(
            importer,
            `Universal runtime package ${JSON.stringify(specifier)} has browser/Node conditional resolution. Core cannot prove that the server package export is equivalent to the browser export.`
          )
        }
        return
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot project universal runtime')) {
        throw error
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return
    directory = parent
  }
}

const validateProjectedImportTarget = async (
  importer: string,
  specifier: string,
  imported: string,
  seen: Set<string>,
  moduleResolver?: SsrUniversalModuleResolver
): Promise<void> => {
  if (isNodeBuiltinSpecifier(specifier)) {
    throw projectionBoundaryError(
      importer,
      `Universal runtime dependency ${JSON.stringify(specifier)} is a Node built-in and cannot enter the browser graph.`
    )
  }
  if (isKnownServerOnlySpecifier(specifier, importer)) {
    throw projectionBoundaryError(
      importer,
      `Universal runtime dependency ${JSON.stringify(specifier)} is a server/build-only vue-ssr-lite module and cannot enter the browser graph.`
    )
  }
  const resolution = await resolveProjectedModule(importer, specifier, moduleResolver)
  if (!resolution) {
    if (!moduleResolver) return
    throw projectionBoundaryError(
      importer,
      `Universal runtime dependency ${JSON.stringify(specifier)} was not resolved by the authoritative server compiler graph.`
    )
  }
  const identity = `${resolution.identity}\0${imported}`
  if (seen.has(identity)) return
  seen.add(identity)
  if (resolution.external) {
    await assertExternalPackageHasStableBrowserIdentity(importer, specifier)
  }
  if (!resolution.path || !PROJECTED_SCRIPT_EXTENSIONS.has(extname(resolution.path).toLowerCase())) return
  const resolved = resolution.path

  const source = await readFile(resolved, 'utf8')
  const transformed = transformSync(source, {
    loader: loaderForFile(resolved),
    format: 'esm',
    target: 'esnext',
    sourcemap: false,
    legalComments: 'none',
  }).code
  const parseAst = await loadParseAst()
  const program = parseAst(transformed) as EstreeNode
  assertNoNodeBuiltinDynamicImports([program], resolved)
  const bindings = collectModuleBindings(program)
  const roots: EstreeNode[] = []
  const reexports: Array<{ specifier: string; imported: string }> = []
  const exportAll: string[] = []

  for (const statement of asNodes(program.body)) {
    if (
      statement.type === 'ImportDeclaration' ||
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportAllDeclaration'
    ) {
      const sourceNode = asNode(statement.source)
      if (typeof sourceNode?.value === 'string' && isNodeBuiltinSpecifier(sourceNode.value)) {
        throw projectionBoundaryError(
          resolved,
          `Browser-projected module references Node built-in ${JSON.stringify(sourceNode.value)}, even though that dependency may appear unrelated to the selected export.`
        )
      }
    }
    if (imported === 'default' && statement.type === 'ExportDefaultDeclaration') {
      const declaration = asNode(statement.declaration)
      if (declaration) roots.push(declaration)
      continue
    }
    if (statement.type === 'ExportAllDeclaration') {
      const sourceNode = asNode(statement.source)
      if (typeof sourceNode?.value === 'string') exportAll.push(sourceNode.value)
      continue
    }
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = asNode(statement.declaration)
    if (declaration) {
      const names = new Set<string>()
      if (declaration.type === 'VariableDeclaration') {
        for (const declarator of asNodes(declaration.declarations)) {
          addPatternNames(asNode(declarator.id), names)
        }
      } else {
        addPatternNames(asNode(declaration.id), names)
      }
      if (imported === '*' || names.has(imported)) roots.push(declaration)
    }
    for (const item of asNodes(statement.specifiers)) {
      const exported = asNode(item.exported)
      const exportedName =
        exported?.type === 'Identifier'
          ? (exported.name as string)
          : typeof exported?.value === 'string'
            ? exported.value
            : undefined
      if (imported !== '*' && exportedName !== imported) continue
      const local = asNode(item.local)
      const localName =
        local?.type === 'Identifier'
          ? (local.name as string)
          : typeof local?.value === 'string'
            ? local.value
            : undefined
      const sourceNode = asNode(statement.source)
      if (typeof sourceNode?.value === 'string' && localName) {
        reexports.push({ specifier: sourceNode.value, imported: localName })
      } else if (local) {
        roots.push(local)
      }
    }
  }

  if (!roots.length && !reexports.length && exportAll.length) {
    if (exportAll.length !== 1) {
      throw projectionBoundaryError(
        resolved,
        `Universal runtime import ${JSON.stringify(imported)} is resolved through multiple export-star barrels; Core cannot prove which browser dependency supplies it.`
      )
    }
    reexports.push({ specifier: exportAll[0], imported })
  }
  if (imported === '*') {
    for (const target of exportAll) reexports.push({ specifier: target, imported: '*' })
  }
  if (!roots.length && !reexports.length && imported !== '*') {
    throw projectionBoundaryError(
      resolved,
      `Universal runtime import ${JSON.stringify(imported)} could not be resolved to a static export.`
    )
  }

  const needed = roots.length ? collectNeededBindings(roots, [], bindings, resolved) : []
  const dependencyNodes = [
    ...roots,
    ...needed.filter((binding) => binding.kind !== 'import').map((binding) => binding.node),
  ]
  assertNoServerRuntimeGlobals(roots, needed, resolved)
  assertNoNodeBuiltinDynamicImports(dependencyNodes, resolved)

  const selectedDeclarations = new Set(
    needed.filter((binding) => binding.kind !== 'import').map((binding) => binding.node)
  )
  for (const root of roots) {
    if (root.type === 'VariableDeclaration') {
      for (const declarator of asNodes(root.declarations)) selectedDeclarations.add(declarator)
    } else if (root.type !== 'Identifier') {
      selectedDeclarations.add(root)
    }
  }
  for (const statement of asNodes(program.body)) {
    if (statement.type === 'ImportDeclaration' && !asNodes(statement.specifiers).length) {
      const sourceNode = asNode(statement.source)
      if (typeof sourceNode?.value === 'string') {
        await validateProjectedImportTarget(resolved, sourceNode.value, '*', seen, moduleResolver)
      }
      continue
    }
    const topLevel =
      statement.type === 'ExportNamedDeclaration' && statement.declaration
        ? asNode(statement.declaration)!
        : statement
    if (topLevel.type === 'ExpressionStatement' && asNode(topLevel.expression)?.type !== 'Literal') {
      throw projectionBoundaryError(
        resolved,
        'A browser-projected dependency contains a top-level side effect that Core cannot prove excludes server-only state.'
      )
    }
    if (topLevel.type === 'VariableDeclaration') {
      for (const declarator of asNodes(topLevel.declarations)) {
        if (selectedDeclarations.has(declarator) || isTriviallyPure(asNode(declarator.init))) continue
        throw projectionBoundaryError(
          resolved,
          'A browser-projected dependency contains an unrelated effectful top-level initializer that cannot be safely tree-shaken.'
        )
      }
    }
    if (
      ![
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportDefaultDeclaration',
        'ExportAllDeclaration',
        'VariableDeclaration',
        'FunctionDeclaration',
        'ClassDeclaration',
        'ExpressionStatement',
        'EmptyStatement',
      ].includes(topLevel.type)
    ) {
      throw projectionBoundaryError(
        resolved,
        `A browser-projected dependency contains unsupported top-level ${topLevel.type} syntax whose side effects cannot be proven safe.`
      )
    }
  }

  for (const binding of needed) {
    const target = importBindingTarget(binding)
    if (target) {
      await validateProjectedImportTarget(
        resolved,
        target.specifier,
        target.imported,
        seen,
        moduleResolver
      )
    }
  }
  for (const dynamicImport of collectLiteralDynamicImports(dependencyNodes)) {
    await validateProjectedImportTarget(resolved, dynamicImport, '*', seen, moduleResolver)
  }
  for (const target of reexports) {
    await validateProjectedImportTarget(
      resolved,
      target.specifier,
      target.imported,
      seen,
      moduleResolver
    )
  }
}

export const assertBrowserSafeImportedDependencies = async (
  fieldNodes: EstreeNode[],
  needed: Binding[],
  filePath: string,
  moduleResolver?: SsrUniversalModuleResolver
): Promise<{ files: string[]; identities: string[] }> => {
  const seen = new Set<string>()
  for (const binding of needed) {
    const target = importBindingTarget(binding)
    if (target) {
      await validateProjectedImportTarget(
        filePath,
        target.specifier,
        target.imported,
        seen,
        moduleResolver
      )
    }
  }
  const dependencyNodes = [
    ...fieldNodes,
    ...needed.filter((binding) => binding.kind !== 'import').map((binding) => binding.node),
  ]
  for (const dynamicImport of collectLiteralDynamicImports(dependencyNodes)) {
    await validateProjectedImportTarget(filePath, dynamicImport, '*', seen, moduleResolver)
  }
  const identities = [...new Set([...seen].map((identity) => identity.split('\0', 1)[0]))]
  return {
    files: identities.filter((identity) => !identity.startsWith('external:')),
    identities,
  }
}
