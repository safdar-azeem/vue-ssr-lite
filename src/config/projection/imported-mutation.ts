/** Cross-module configuration provenance and mutation validation. */
import type { EstreeNode, ConfigHelpers, Binding, Scope, ScopeBinding, SsrUniversalModuleResolver } from './types'
import { resolveScopeName, walkChildNodes, collectConfigHelpers, importedExportName } from './scopes'
import {
  asNode,
  asNodeList,
  asNodes,
  loadParseAst,
  loaderForFile,
  projectionBoundaryError,
  collectModuleBindings,
  addPatternNames,
  findDefaultExport,
  unwrapConfigObject,
  recordDeclarationBindings,
  findObjectLiteralValue,
  isConfigHelperCall,
} from './syntax'
import { resolve, extname } from 'node:path'
import { PROJECTED_SCRIPT_EXTENSIONS, resolveProjectedModule } from './imports'
import { readFile } from 'node:fs/promises'
import { transformSync } from 'esbuild'
import { assertStaticUniversalGraph } from './validation'

const APPLICATION_PROVENANCE = 1
const DEPENDENCY_PROVENANCE = 2

type CrossModuleAudit = {
  filePath: string
  program: EstreeNode
  helpers: ConfigHelpers
  bindings: Map<string, Binding>
  resolvedSources: WeakMap<EstreeNode, string>
  dynamicAcquisitions: CrossModuleDynamicAcquisition[]
}

type CrossModuleDynamicAcquisition = {
  node: EstreeNode
  kind: 'dynamic import' | 'require()' | 'module.require()'
  specifier?: string
  resolvedSource?: string
}

const exportName = (node: EstreeNode | undefined): string | undefined =>
  node?.type === 'Identifier'
    ? (node.name as string)
    : node?.type === 'Literal' && typeof node.value === 'string'
      ? node.value
      : undefined

const mergeProvenance = <T>(map: Map<T, number>, key: T, provenance: number): boolean => {
  if (!provenance) return false
  const previous = map.get(key) ?? 0
  const next = previous | provenance
  if (next === previous) return false
  map.set(key, next)
  return true
}

const expressionProvenance = (
  node: EstreeNode | undefined,
  scope: Scope,
  origins: Map<ScopeBinding, number>
): number => {
  if (!node) return 0
  if (node.type === 'Identifier') {
    const binding = resolveScopeName(scope, node.name as string)
    return binding ? (origins.get(binding) ?? 0) : 0
  }
  if (
    node.type === 'ChainExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  ) {
    return expressionProvenance(asNode(node.expression), scope, origins)
  }
  if (node.type === 'MemberExpression') {
    return expressionProvenance(asNode(node.object), scope, origins)
  }
  if (node.type === 'SpreadElement') {
    return expressionProvenance(asNode(node.argument), scope, origins)
  }
  if (node.type === 'ArrayExpression') {
    return asNodeList(node.elements).reduce(
      (found, item) => found | expressionProvenance(item, scope, origins),
      0
    )
  }
  if (node.type === 'ObjectExpression') {
    let found = 0
    for (const property of asNodes(node.properties)) {
      found |= expressionProvenance(
        property.type === 'SpreadElement' ? asNode(property.argument) : asNode(property.value),
        scope,
        origins
      )
    }
    return found
  }
  if (node.type === 'ConditionalExpression') {
    return (
      expressionProvenance(asNode(node.consequent), scope, origins) |
      expressionProvenance(asNode(node.alternate), scope, origins)
    )
  }
  if (node.type === 'LogicalExpression') {
    return (
      expressionProvenance(asNode(node.left), scope, origins) |
      expressionProvenance(asNode(node.right), scope, origins)
    )
  }
  if (node.type === 'SequenceExpression') {
    const expressions = asNodes(node.expressions)
    return expressionProvenance(expressions.at(-1), scope, origins)
  }
  if (node.type === 'AssignmentExpression') {
    return expressionProvenance(asNode(node.right), scope, origins)
  }
  return 0
}

const collectCrossModuleDynamicAcquisitions = (program: EstreeNode): CrossModuleDynamicAcquisition[] => {
  const found: CrossModuleDynamicAcquisition[] = []
  const inspect = (node: EstreeNode | undefined) => {
    if (!node) return
    if (node.type === 'ImportExpression') {
      const source = asNode(node.source)
      found.push({
        node,
        kind: 'dynamic import',
        specifier: typeof source?.value === 'string' ? source.value : undefined,
      })
    } else if (node.type === 'CallExpression') {
      const callee = asNode(node.callee)
      const argument = asNodes(node.arguments)[0]
      if (callee?.type === 'Identifier' && callee.name === 'require') {
        found.push({
          node,
          kind: 'require()',
          specifier: typeof argument?.value === 'string' ? argument.value : undefined,
        })
      } else if (callee?.type === 'MemberExpression') {
        const object = asNode(callee.object)
        const property = asNode(callee.property)
        const memberName = callee.computed
          ? typeof property?.value === 'string'
            ? property.value
            : undefined
          : property?.type === 'Identifier'
            ? (property.name as string)
            : undefined
        if (object?.type === 'Identifier' && object.name === 'module' && memberName === 'require') {
          found.push({
            node,
            kind: 'module.require()',
            specifier: typeof argument?.value === 'string' ? argument.value : undefined,
          })
        }
      }
    }
    walkChildNodes(node, { names: new Map(), kind: 'module' }, (child) => inspect(child))
  }
  inspect(program)
  return found
}

/**
 * Audit every reachable server-config module, propagating protected binding
 * provenance through imports, const aliases, containers, and re-export barrels.
 * This closes the gap between per-file projection and later config evaluation:
 * any intermediary module that can observe protected application/universal state
 * is checked by the same mutation/escape analysis before the bundle is executed.
 */
export const assertNoImportedUniversalConfigMutation = async (
  source: string,
  filePath: string,
  applicationFiles: Iterable<string>,
  protectedDependencyFiles: Iterable<string> = [],
  reachableModuleFiles: Iterable<string> = [],
  moduleResolver?: SsrUniversalModuleResolver,
  protectedDependencyIdentities: Iterable<string> = []
): Promise<void> => {
  const normalizeFile = (item: string) => resolve(item).replaceAll('\\', '/')
  const normalizedEntry = normalizeFile(filePath)
  const applicationTargets = new Set(
    [...applicationFiles].map(normalizeFile)
  )
  const dependencyTargets = new Set([
    ...[...protectedDependencyFiles].map(normalizeFile),
    ...protectedDependencyIdentities,
  ])
  const targets = new Set([...applicationTargets, ...dependencyTargets])
  if (!targets.size) return
  const parseAst = await loadParseAst()
  const candidates = new Set([
    normalizedEntry,
    ...targets,
    ...[...reachableModuleFiles].map(normalizeFile),
  ])
  const audits = new Map<string, CrossModuleAudit>()
  for (const candidate of candidates) {
    if (!PROJECTED_SCRIPT_EXTENSIONS.has(extname(candidate).toLowerCase())) continue
    let moduleSource: string
    try {
      moduleSource = candidate === normalizedEntry ? source : await readFile(candidate, 'utf8')
    } catch {
      continue
    }
    const transformed = transformSync(moduleSource, {
      loader: loaderForFile(candidate),
      format: 'esm',
      target: 'esnext',
      sourcemap: false,
      legalComments: 'none',
    }).code
    const program = parseAst(transformed) as EstreeNode
    const resolvedSources = new WeakMap<EstreeNode, string>()
    const dynamicAcquisitions = collectCrossModuleDynamicAcquisitions(program)
    const nonLiteralAcquisition = dynamicAcquisitions.find((acquisition) => !acquisition.specifier)
    if (nonLiteralAcquisition) {
      throw projectionBoundaryError(
        candidate,
        `A reachable server-config module uses a non-literal ${nonLiteralAcquisition.kind}; ` +
          'Core cannot prove that it does not acquire protected universal state.'
      )
    }
    for (const statement of asNodes(program.body)) {
      if (
        statement.type !== 'ImportDeclaration' &&
        statement.type !== 'ExportNamedDeclaration' &&
        statement.type !== 'ExportAllDeclaration'
      ) {
        continue
      }
      const sourceNode = asNode(statement.source)
      if (typeof sourceNode?.value !== 'string') continue
      const resolution = await resolveProjectedModule(candidate, sourceNode.value, moduleResolver)
      if (resolution) {
        resolvedSources.set(statement, resolution.identity)
        if (
          resolution.path &&
          PROJECTED_SCRIPT_EXTENSIONS.has(extname(resolution.path).toLowerCase())
        ) {
          candidates.add(normalizeFile(resolution.path))
        }
      }
    }
    for (const acquisition of dynamicAcquisitions) {
      if (!acquisition.specifier) continue
      const resolution = await resolveProjectedModule(
        candidate,
        acquisition.specifier,
        moduleResolver
      )
      if (!resolution) continue
      acquisition.resolvedSource = resolution.identity
      if (
        resolution.path &&
        PROJECTED_SCRIPT_EXTENSIONS.has(extname(resolution.path).toLowerCase())
      ) {
        candidates.add(normalizeFile(resolution.path))
      }
    }
    audits.set(candidate, {
      filePath: candidate,
      program,
      helpers: collectConfigHelpers(program, candidate, moduleResolver),
      bindings: collectModuleBindings(program),
      resolvedSources,
      dynamicAcquisitions,
    })
  }
  const exportedOrigins = new Map<string, Map<string, number>>()
  const exportsFor = (modulePath: string): Map<string, number> => {
    let found = exportedOrigins.get(modulePath)
    if (!found) {
      found = new Map()
      exportedOrigins.set(modulePath, found)
    }
    return found
  }
  for (const application of applicationTargets) {
    mergeProvenance(exportsFor(application), 'default', APPLICATION_PROVENANCE)
  }
  for (const dependency of dependencyTargets) {
    mergeProvenance(exportsFor(dependency), '*', DEPENDENCY_PROVENANCE)
  }
  const exportedProvenance = (modulePath: string, name: string): number => {
    const origins = exportedOrigins.get(modulePath)
    return (origins?.get(name) ?? 0) | (origins?.get('*') ?? 0)
  }
  const anyExportedProvenance = (modulePath: string): number => {
    let found = 0
    for (const provenance of exportedOrigins.get(modulePath)?.values() ?? []) found |= provenance
    return found
  }

  const applicationImports = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const audit of audits.values()) {
      const trackedDeclarators = new Set<EstreeNode>()
      const trackedNames = new Set<string>()
      const bindingOrigins = new Map<ScopeBinding, number>()
      for (const statement of asNodes(audit.program.body)) {
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
        const importedModule = audit.resolvedSources.get(statement)
        if (!importedModule) continue
        for (const item of asNodes(statement.specifiers)) {
          if (item.importKind === 'type') continue
          const local = asNode(item.local)
          if (local?.type !== 'Identifier') continue
          const importedName =
            item.type === 'ImportDefaultSpecifier'
              ? 'default'
              : item.type === 'ImportNamespaceSpecifier'
                ? '*'
                : importedExportName(item) ?? (local.name as string)
          const provenance =
            importedName === '*'
              ? anyExportedProvenance(importedModule)
              : exportedProvenance(importedModule, importedName)
          if (!provenance) continue
          const binding = audit.helpers.scopes.moduleScope.names.get(local.name as string)
          if (binding) mergeProvenance(bindingOrigins, binding, provenance)
          trackedDeclarators.add(statement)
          trackedNames.add(local.name as string)
          if (audit.filePath === normalizedEntry && provenance & APPLICATION_PROVENANCE) {
            applicationImports.add(local.name as string)
          }
        }
      }

      let aliasesChanged = true
      while (aliasesChanged) {
        aliasesChanged = false
        for (const { node, scope, kind } of audit.helpers.scopes.variableDeclarators) {
          if (kind !== 'const') continue
          const provenance = expressionProvenance(asNode(node.init), scope, bindingOrigins)
          if (!provenance) continue
          for (const binding of audit.helpers.scopes.declaratorBindings.get(node) ?? []) {
            aliasesChanged = mergeProvenance(bindingOrigins, binding, provenance) || aliasesChanged
          }
        }
      }

      if (
        trackedNames.size &&
        !targets.has(audit.filePath) &&
        (audit.filePath !== normalizedEntry || applicationTargets.size)
      ) {
        assertStaticUniversalGraph(
          audit.program,
          audit.helpers,
          trackedDeclarators,
          new Set(),
          audit.filePath,
          trackedNames,
          new Set(),
          new Set(),
          true
        )
      }

      const moduleExports = exportsFor(audit.filePath)
      for (const statement of asNodes(audit.program.body)) {
        if (statement.type === 'ExportDefaultDeclaration') {
          const provenance = expressionProvenance(
            asNode(statement.declaration),
            audit.helpers.scopes.moduleScope,
            bindingOrigins
          )
          changed = mergeProvenance(moduleExports, 'default', provenance) || changed
          continue
        }
        if (statement.type === 'ExportAllDeclaration') {
          const exportedModule = audit.resolvedSources.get(statement)
          if (!exportedModule) continue
          const namespace = exportName(asNode(statement.exported))
          if (namespace) {
            changed =
              mergeProvenance(
                moduleExports,
                namespace,
                anyExportedProvenance(exportedModule)
              ) || changed
            continue
          }
          for (const [name, provenance] of exportedOrigins.get(exportedModule) ?? []) {
            if (name === 'default') continue
            changed = mergeProvenance(moduleExports, name, provenance) || changed
          }
          continue
        }
        if (statement.type !== 'ExportNamedDeclaration') continue
        const exportedModule = audit.resolvedSources.get(statement)
        if (exportedModule) {
          for (const item of asNodes(statement.specifiers)) {
            const exported = exportName(asNode(item.exported))
            const imported = exportName(asNode(item.local))
            if (!exported || !imported) continue
            changed =
              mergeProvenance(
                moduleExports,
                exported,
                exportedProvenance(exportedModule, imported)
              ) || changed
          }
          continue
        }
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
          for (const name of names) {
            const binding = audit.helpers.scopes.moduleScope.names.get(name)
            changed =
              mergeProvenance(moduleExports, name, binding ? (bindingOrigins.get(binding) ?? 0) : 0) ||
              changed
          }
        }
        for (const item of asNodes(statement.specifiers)) {
          const exported = exportName(asNode(item.exported))
          const local = exportName(asNode(item.local))
          if (!exported || !local) continue
          const binding = audit.helpers.scopes.moduleScope.names.get(local)
          changed =
            mergeProvenance(moduleExports, exported, binding ? (bindingOrigins.get(binding) ?? 0) : 0) ||
            changed
        }
      }

      for (const acquisition of audit.dynamicAcquisitions) {
        if (
          acquisition.resolvedSource &&
          anyExportedProvenance(acquisition.resolvedSource)
        ) {
          throw projectionBoundaryError(
            audit.filePath,
            `A reachable server-config module uses ${acquisition.kind} to acquire protected universal state through ${JSON.stringify(acquisition.specifier)}. ` +
              'Dynamic cross-module access cannot prove the approved browser projection remains unchanged.'
          )
        }
      }
    }
  }

  if (!applicationTargets.size) return
  const entryAudit = audits.get(normalizedEntry)
  if (!entryAudit) return
  const defaultExport = findDefaultExport(entryAudit.program)
  const unwrapped = unwrapConfigObject(defaultExport, entryAudit.bindings, entryAudit.helpers)
  if (!unwrapped) {
    throw projectionBoundaryError(
      filePath,
      'The multi-application server export cannot be statically inspected for imported application identity.'
    )
  }
  const bindings = new Map(entryAudit.bindings)
  for (const statement of unwrapped.extra) recordDeclarationBindings(statement, bindings)
  const applications = findObjectLiteralValue(unwrapped.object, 'applications')
  if (!applications) {
    throw projectionBoundaryError(
      filePath,
      'Imported defineApplication() modules were discovered, but defineServer({ applications }) is not a direct static property.'
    )
  }
  const unwrapTransparent = (node: EstreeNode | undefined): EstreeNode | undefined => {
    while (
      node &&
      [
        'ChainExpression',
        'ParenthesizedExpression',
        'TSAsExpression',
        'TSSatisfiesExpression',
        'TSNonNullExpression',
      ].includes(node.type)
    ) {
      node = asNode(node.expression)
    }
    return node
  }
  const assertApplicationEntry = (input: EstreeNode | undefined, seenNames: Set<string>) => {
    const node = unwrapTransparent(input)
    if (!node) {
      throw projectionBoundaryError(filePath, 'The applications array contains an empty entry.')
    }
    if (node.type === 'CallExpression' && isConfigHelperCall(node, entryAudit.helpers)) return
    if (node.type !== 'Identifier') {
      throw projectionBoundaryError(
        filePath,
        'Each discovered application must enter defineServer({ applications }) as a direct imported defineApplication() binding or immutable const alias. Clones, spreads, computed entries, and wrappers are not projection-safe.'
      )
    }
    const name = node.name as string
    if (applicationImports.has(name)) return
    if (seenNames.has(name)) {
      throw projectionBoundaryError(filePath, `Application alias ${JSON.stringify(name)} is cyclic.`)
    }
    const binding = bindings.get(name)
    if (
      binding?.kind !== 'declaration' ||
      binding.node.type !== 'VariableDeclarator' ||
      binding.declarationKind !== 'const'
    ) {
      throw projectionBoundaryError(
        filePath,
        `Application entry ${JSON.stringify(name)} is not a direct import or immutable const alias.`
      )
    }
    const next = new Set(seenNames)
    next.add(name)
    assertApplicationEntry(asNode(binding.node.init), next)
  }
  const assertApplicationsList = (input: EstreeNode | undefined, seenNames: Set<string>) => {
    const node = unwrapTransparent(input)
    if (!node) {
      throw projectionBoundaryError(filePath, 'The applications list is missing a static value.')
    }
    if (node.type === 'Identifier') {
      const name = node.name as string
      if (seenNames.has(name)) {
        throw projectionBoundaryError(filePath, `Applications-list alias ${JSON.stringify(name)} is cyclic.`)
      }
      const binding = bindings.get(name)
      if (
        binding?.kind !== 'declaration' ||
        binding.node.type !== 'VariableDeclarator' ||
        binding.declarationKind !== 'const'
      ) {
        throw projectionBoundaryError(
          filePath,
          'The applications list must be an inline array or a dedicated immutable const array.'
        )
      }
      const next = new Set(seenNames)
      next.add(name)
      assertApplicationsList(asNode(binding.node.init), next)
      return
    }
    if (node.type !== 'ArrayExpression') {
      throw projectionBoundaryError(
        filePath,
        'The applications list must be a static array; dynamic factories, spreads, and mutable containers are not supported.'
      )
    }
    for (const element of asNodeList(node.elements)) {
      if (element?.type === 'SpreadElement') {
        throw projectionBoundaryError(
          filePath,
          'The applications array cannot use spread because imported application identity would no longer be statically provable.'
        )
      }
      assertApplicationEntry(element, new Set())
    }
  }
  assertApplicationsList(applications, new Set())
}
