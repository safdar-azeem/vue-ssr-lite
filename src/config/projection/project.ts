/** Projection emission, evaluated-field coverage, and projection merging. */
import {
  type EstreeNode,
  type SsrUniversalRuntimeField,
  isUniversalField,
  type SsrUniversalRuntimeProjection,
  SSR_UNIVERSAL_RUNTIME_FIELDS,
  type SsrUniversalModuleResolver,
  type SsrUniversalProjectionOptions,
} from './types'
import {
  asNodes,
  propertyName,
  asNode,
  slice,
  loaderForFile,
  loadParseAst,
  collectModuleBindings,
  findDefaultExport,
  unwrapConfigObject,
  assertStaticConfigObjectShape,
  collectNeededBindings,
  isolateDeclaratorInit,
  emitDeclaration,
} from './syntax'
import { transformSync } from 'esbuild'
import { collectConfigHelpers } from './scopes'
import {
  assertNoServerRuntimeGlobals,
  assertNoNodeBuiltinDynamicImports,
  assertBrowserSafeImportedDependencies,
  rewriteImport,
} from './imports'
import { assertStaticUniversalGraph } from './validation'

const extractUniversalFields = (
  object: EstreeNode,
  code: string
): Partial<Record<SsrUniversalRuntimeField, string>> => {
  const fields: Partial<Record<SsrUniversalRuntimeField, string>> = {}
  for (const property of asNodes(object.properties)) {
    if (property.type === 'SpreadElement') continue
    if (property.type !== 'Property') continue
    if (property.kind === 'get' || property.kind === 'set') {
      const name = propertyName(property)
      if (name && isUniversalField(name)) {
        throw new Error(
          `Universal field "${name}" cannot use a getter or setter. Use a static object property.`
        )
      }
      continue
    }
    const name = propertyName(property)
    if (!name || !isUniversalField(name)) continue
    const value = asNode(property.value)
    if (!value) continue
    if (property.method) {
      fields[name] = `function ${slice(code, value)}`
    } else {
      fields[name] = slice(code, value).trim()
    }
  }
  return fields
}

const fieldValueNodes = (
  object: EstreeNode,
  excludedFields: ReadonlySet<SsrUniversalRuntimeField> = new Set()
): EstreeNode[] => {
  const nodes: EstreeNode[] = []
  for (const property of asNodes(object.properties)) {
    if (property.type !== 'Property') continue
    const name = propertyName(property)
    if (!name || !isUniversalField(name)) continue
    if (excludedFields.has(name)) continue
    const value = asNode(property.value)
    if (value) nodes.push(value)
  }
  return nodes
}

export const hasUniversalRuntimeValue = (
  evaluated: object | undefined,
  field: SsrUniversalRuntimeField
): boolean => {
  if (!evaluated) return false
  const value = (evaluated as Record<string, unknown>)[field]
  if (value == null) return false
  if (
    (field === 'extensions' || field === 'middleware') &&
    Array.isArray(value) &&
    value.length === 0
  ) return false
  return true
}

export const assertUniversalProjectionCoverage = (
  evaluated: object | undefined,
  projection: SsrUniversalRuntimeProjection | undefined,
  filePath: string
): void => {
  if (!evaluated) return
  for (const field of SSR_UNIVERSAL_RUNTIME_FIELDS) {
    if (!hasUniversalRuntimeValue(evaluated, field)) continue
    if (projection?.fields[field]) continue
    throw new Error(
      `Cannot project universal field "${field}" from ${filePath} into the browser application. ` +
        'Declare it as a static object property on defineServer() / defineApplication() ' +
        '(inline value, shorthand, local const, config variable, or a function/async export that returns that object). ' +
        'Dynamic construction such as defineServer(factory()) is not supported because it would silently diverge after hydration.'
    )
  }
}

export const projectUniversalRuntimeSource = async (
  source: string,
  filePath: string,
  moduleResolver?: SsrUniversalModuleResolver,
  options: SsrUniversalProjectionOptions = {}
): Promise<SsrUniversalRuntimeProjection | undefined> => {
  const transformed = transformSync(source, {
    loader: loaderForFile(filePath),
    format: 'esm',
    target: 'esnext',
    sourcemap: false,
    legalComments: 'none',
  }).code
  const parseAst = await loadParseAst()
  const program = parseAst(transformed) as EstreeNode
  const bindings = collectModuleBindings(program)
  const helpers = collectConfigHelpers(program, filePath, moduleResolver)
  const defaultExport = findDefaultExport(program)
  if (!defaultExport) return undefined
  const unwrapped = unwrapConfigObject(defaultExport, bindings, helpers)
  if (!unwrapped) return undefined
  const fields = extractUniversalFields(unwrapped.object, transformed)
  if (!Object.keys(fields).length) return undefined
  assertStaticConfigObjectShape(unwrapped.object, filePath)
  const allFieldNodes = fieldValueNodes(unwrapped.object)
  const needed = collectNeededBindings(
    allFieldNodes,
    unwrapped.extra,
    bindings,
    filePath
  )
  const browserOnlyFields = new Set<SsrUniversalRuntimeField>()
  if (options.browserOnlyMiddleware) browserOnlyFields.add('middleware')
  const serverExecutableFieldNodes = fieldValueNodes(
    unwrapped.object,
    browserOnlyFields
  )
  const serverExecutableBindings = collectNeededBindings(
    serverExecutableFieldNodes,
    unwrapped.extra,
    bindings,
    filePath
  )
  assertNoServerRuntimeGlobals(
    serverExecutableFieldNodes,
    serverExecutableBindings,
    filePath
  )
  assertNoNodeBuiltinDynamicImports(
    [
      ...serverExecutableFieldNodes,
      ...serverExecutableBindings
        .filter((binding) => binding.kind !== 'import')
        .map((binding) => binding.node),
    ],
    filePath
  )
  const dependencies = await assertBrowserSafeImportedDependencies(
    serverExecutableFieldNodes,
    serverExecutableBindings,
    filePath,
    moduleResolver
  )
  const trackedDeclarators = new Set(unwrapped.configDeclarators)
  const trackedNames = new Set<string>()
  for (const binding of needed) {
    trackedDeclarators.add(binding.node)
    trackedNames.add(binding.name)
  }
  const projectedRoots = new Set<EstreeNode>(allFieldNodes)
  for (const binding of needed) {
    if (binding.kind === 'import') continue
    if (binding.node.type === 'VariableDeclarator') {
      projectedRoots.add(isolateDeclaratorInit(binding.node, binding.name, filePath))
    } else {
      projectedRoots.add(binding.node)
    }
  }
  assertStaticUniversalGraph(
    program,
    helpers,
    trackedDeclarators,
    unwrapped.configDeclarators,
    filePath,
    trackedNames,
    projectedRoots,
    unwrapped.allowedReturns
  )
  const statements: string[] = []
  const importLocals = new Map<EstreeNode, Set<string>>()
  const importOrder: EstreeNode[] = []
  const seenDeclarations = new Set<string>()
  for (const binding of needed) {
    if (binding.kind === 'import') {
      let locals = importLocals.get(binding.node)
      if (!locals) {
        locals = new Set<string>()
        importLocals.set(binding.node, locals)
        importOrder.push(binding.node)
      }
      locals.add(binding.name)
      continue
    }
    const declarationKey =
      binding.node.type === 'VariableDeclarator' && asNode(binding.node.id)?.type !== 'Identifier'
        ? `${binding.name}@${binding.node.start}`
        : String(binding.node.start)
    if (seenDeclarations.has(declarationKey)) continue
    seenDeclarations.add(declarationKey)
    statements.push(emitDeclaration(transformed, binding, filePath))
  }
  return {
    imports: importOrder.map((node) => rewriteImport(node, filePath, importLocals.get(node)!)),
    statements,
    dependencyFiles: dependencies.files.length ? dependencies.files : undefined,
    dependencyIdentities: dependencies.identities.length ? dependencies.identities : undefined,
    fields,
  }
}

export const mergeUniversalRuntimeProjections = (
  base: SsrUniversalRuntimeProjection | undefined,
  extra: SsrUniversalRuntimeProjection | undefined
): SsrUniversalRuntimeProjection | undefined => {
  if (!base) return extra
  if (!extra) return base
  const imports = [...base.imports]
  for (const line of extra.imports) {
    if (!imports.includes(line)) imports.push(line)
  }
  const statements = [...(base.statements ?? [])]
  for (const line of extra.statements ?? []) {
    if (!statements.includes(line)) statements.push(line)
  }
  const dependencyFiles = [...(base.dependencyFiles ?? [])]
  for (const file of extra.dependencyFiles ?? []) {
    if (!dependencyFiles.includes(file)) dependencyFiles.push(file)
  }
  const dependencyIdentities = [...(base.dependencyIdentities ?? [])]
  for (const identity of extra.dependencyIdentities ?? []) {
    if (!dependencyIdentities.includes(identity)) dependencyIdentities.push(identity)
  }
  const fields: SsrUniversalRuntimeProjection['fields'] = { ...base.fields }
  for (const key of SSR_UNIVERSAL_RUNTIME_FIELDS) {
    const extraValue = extra.fields[key]
    if (!extraValue) continue
    if ((key === 'extensions' || key === 'middleware') && fields[key]) {
      fields[key] = `[...(${fields[key]}), ...(${extraValue})]`
      continue
    }
    fields[key] = extraValue
  }
  return {
    imports,
    statements,
    dependencyFiles: dependencyFiles.length ? dependencyFiles : undefined,
    dependencyIdentities: dependencyIdentities.length ? dependencyIdentities : undefined,
    fields,
  }
}
