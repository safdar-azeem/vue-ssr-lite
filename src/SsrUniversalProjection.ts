import { dirname, extname, resolve } from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFile, stat } from 'node:fs/promises'
import { transformSync } from 'esbuild'

export const SSR_UNIVERSAL_RUNTIME_FIELDS = [
  'extensions',
  'router',
  'scrollBehavior',
  'createInitialState',
  'cleanup',
] as const

export type SsrUniversalRuntimeField = (typeof SSR_UNIVERSAL_RUNTIME_FIELDS)[number]

export interface SsrUniversalRuntimeProjection {
  imports: string[]
  statements?: string[]
  /** Absolute local modules proven as part of the emitted dependency closure. */
  dependencyFiles?: string[]
  /** Authoritative local or external identities selected by the server compiler. */
  dependencyIdentities?: string[]
  fields: Partial<Record<SsrUniversalRuntimeField, string>>
}

export interface SsrUniversalResolvedModule {
  identity: string
  path?: string
  external: boolean
}

export type SsrUniversalModuleResolver = (
  importer: string,
  specifier: string
) => SsrUniversalResolvedModule | undefined

type EstreeNode = {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

type Binding = {
  kind: 'import' | 'declaration'
  name: string
  node: EstreeNode
  declarationKind?: 'const' | 'let' | 'var'
}

type UnwrapResult = {
  object: EstreeNode
  extra: EstreeNode[]
  configNames: Set<string>
  configDeclarators: Set<EstreeNode>
  allowedReturns: Set<EstreeNode>
}

const OBJECT_MUTATORS = new Set(['assign', 'defineProperty', 'defineProperties'])

const CONFIG_HELPER_EXPORTS = new Set(['defineServer', 'defineApplication'])

const isLibraryConfigSpecifier = (specifier: string, importer: string): boolean => {
  if (specifier === 'vue-ssr-lite' || specifier.startsWith('vue-ssr-lite/')) return true
  const resolved = (
    specifier.startsWith('.') || specifier.startsWith('/')
      ? resolve(dirname(importer), specifier)
      : specifier
  ).replaceAll('\\', '/')
  return /\/vue-ssr-lite\/src\/(?:index|SsrConfigRuntime)(?:\.(?:ts|js|mts|mjs))?$/.test(
    resolved
  )
}

type ConfigHelpers = {
  calls: WeakSet<EstreeNode>
  scopes: LexicalScopes
}

const importedExportName = (specifier: EstreeNode): string | undefined => {
  const imported = asNode(specifier.imported) ?? asNode(specifier.exported)
  if (imported?.type === 'Identifier') return imported.name as string
  if (imported?.type === 'Literal' && typeof imported.value === 'string') return imported.value
  return undefined
}

const isConfigHelperCall = (node: EstreeNode, helpers: ConfigHelpers): boolean =>
  helpers.calls.has(node)

const UNIVERSAL_FIELD_SET = new Set<string>(SSR_UNIVERSAL_RUNTIME_FIELDS)
const CONFIG_REFERENCE = '$config'

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
const PROJECTED_SCRIPT_EXTENSIONS = new Set([
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
  return /\/vue-ssr-lite\/src\/(?:server(?:\.[cm]?[jt]s|\/)|vite(?:\.[cm]?[jt]s|\/)|SsrConfigCompile|SsrUniversalProjection)/.test(
    resolved
  )
}

const isUniversalField = (name: string): name is SsrUniversalRuntimeField =>
  UNIVERSAL_FIELD_SET.has(name)

const tryResolve = (from: string, id: string): string | undefined => {
  try {
    return createRequire(from).resolve(id)
  } catch {
    return undefined
  }
}

const resolveParseAstHref = (): string => {
  const fromHere = import.meta.url
  const direct = tryResolve(fromHere, 'rollup/parseAst')
  if (direct) return pathToFileURL(direct).href
  const vite = tryResolve(fromHere, 'vite')
  const nested = vite ? tryResolve(vite, 'rollup/parseAst') : undefined
  if (nested) return pathToFileURL(nested).href
  throw new Error(
    'Cannot resolve rollup/parseAst to project universal runtime fields. Install the vite peer dependency so vue-ssr-lite can parse server configuration.'
  )
}

let parseAstPromise: Promise<(code: string) => EstreeNode> | undefined

const loadParseAst = async (): Promise<(code: string) => EstreeNode> => {
  parseAstPromise ??= (async () => {
    const href = resolveParseAstHref()
    let parsed: { parseAst?: unknown }
    try {
      parsed = (await import(href)) as { parseAst?: unknown }
    } catch (error) {
      throw new Error(
        `Cannot load rollup/parseAst to project universal runtime fields. ` +
          `The Vite/Rollup parser dependency is unavailable or incompatible: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (typeof parsed.parseAst !== 'function') {
      throw new Error(
        'Cannot use rollup/parseAst to project universal runtime fields. ' +
          'The resolved Vite/Rollup version does not expose a compatible parseAst() function.'
      )
    }
    const parseAst = parsed.parseAst as (code: string) => EstreeNode
    let probe: EstreeNode
    try {
      probe = parseAst('import value from "probe"; export default helper({ value });')
    } catch (error) {
      throw new Error(
        `Cannot use rollup/parseAst to project universal runtime fields. ` +
          `The resolved parser failed its compatibility check: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const body = asNodes(probe.body)
    if (
      probe.type !== 'Program' ||
      !body.some((node) => node.type === 'ImportDeclaration') ||
      !body.some((node) => node.type === 'ExportDefaultDeclaration') ||
      typeof probe.start !== 'number' ||
      typeof probe.end !== 'number'
    ) {
      throw new Error(
        'Cannot use rollup/parseAst to project universal runtime fields. ' +
          'The resolved parser returned an incompatible AST shape.'
      )
    }
    return parseAst
  })()
  return parseAstPromise
}

const loaderForFile = (filePath: string): 'ts' | 'tsx' | 'js' | 'jsx' => {
  switch (extname(filePath).toLowerCase()) {
    case '.tsx':
      return 'tsx'
    case '.jsx':
      return 'jsx'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js'
    default:
      return 'ts'
  }
}

const slice = (code: string, node: EstreeNode): string => code.slice(node.start, node.end)

const asNode = (value: unknown): EstreeNode | undefined =>
  value && typeof value === 'object' && typeof (value as EstreeNode).type === 'string'
    ? (value as EstreeNode)
    : undefined

const asNodes = (value: unknown): EstreeNode[] =>
  Array.isArray(value) ? value.map(asNode).filter((node): node is EstreeNode => Boolean(node)) : []

const asNodeList = (value: unknown): (EstreeNode | undefined)[] =>
  Array.isArray(value) ? value.map((item) => asNode(item)) : []

const addPatternNames = (node: EstreeNode | undefined, names: Set<string>) => {
  if (!node) return
  if (node.type === 'Identifier') {
    names.add(node.name as string)
    return
  }
  if (node.type === 'ObjectPattern') {
    for (const property of asNodes(node.properties)) {
      if (property.type === 'RestElement') addPatternNames(asNode(property.argument), names)
      else addPatternNames(asNode(property.value) ?? asNode(property.argument), names)
    }
    return
  }
  if (node.type === 'ArrayPattern') {
    for (const element of asNodes(node.elements)) addPatternNames(element, names)
    return
  }
  if (node.type === 'RestElement' || node.type === 'AssignmentPattern') {
    addPatternNames(asNode(node.argument) ?? asNode(node.left), names)
  }
}

const patternContainsName = (node: EstreeNode | undefined, name: string): boolean => {
  const names = new Set<string>()
  addPatternNames(node, names)
  return names.has(name)
}

const projectionBoundaryError = (filePath: string, detail: string): Error =>
  new Error(
    `Cannot project universal runtime fields from ${filePath} into the browser application. ${detail}`
  )

const recordDeclarationBindings = (node: EstreeNode, bindings: Map<string, Binding>) => {
  if (node.type === 'VariableDeclaration') {
    const declarationKind = node.kind as 'const' | 'let' | 'var'
    for (const declarator of asNodes(node.declarations)) {
      const names = new Set<string>()
      addPatternNames(asNode(declarator.id), names)
      for (const name of names) {
        bindings.set(name, {
          kind: 'declaration',
          name,
          node: declarator,
          declarationKind,
        })
      }
    }
    return
  }
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
    const id = asNode(node.id)
    if (id?.type === 'Identifier') {
      bindings.set(id.name as string, { kind: 'declaration', name: id.name as string, node })
    }
  }
}

const recordImportBindings = (node: EstreeNode, bindings: Map<string, Binding>) => {
  if (node.type !== 'ImportDeclaration' || node.importKind === 'type') return
  for (const specifier of asNodes(node.specifiers)) {
    if (specifier.importKind === 'type') continue
    const local = asNode(specifier.local)
    if (local?.type === 'Identifier') {
      bindings.set(local.name as string, {
        kind: 'import',
        name: local.name as string,
        node,
      })
    }
  }
}

const collectModuleBindings = (program: EstreeNode): Map<string, Binding> => {
  const bindings = new Map<string, Binding>()
  for (const statement of asNodes(program.body)) {
    if (statement.type === 'ImportDeclaration') recordImportBindings(statement, bindings)
    else if (
      statement.type === 'VariableDeclaration' ||
      statement.type === 'FunctionDeclaration' ||
      statement.type === 'ClassDeclaration'
    ) {
      recordDeclarationBindings(statement, bindings)
    } else if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      recordDeclarationBindings(asNode(statement.declaration)!, bindings)
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = asNode(statement.declaration)
      if (
        declaration &&
        (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration')
      ) {
        recordDeclarationBindings(declaration, bindings)
      }
    }
  }
  return bindings
}

const walkFreeIdentifiers = (
  node: EstreeNode | undefined,
  bound: Set<string>,
  free: Set<string>
) => {
  if (!node) return
  switch (node.type) {
    case 'Identifier': {
      const name = node.name as string
      if (!bound.has(name)) free.add(name)
      return
    }
    case 'MemberExpression':
      walkFreeIdentifiers(asNode(node.object), bound, free)
      if (node.computed) walkFreeIdentifiers(asNode(node.property), bound, free)
      return
    case 'Property':
    case 'PropertyDefinition':
      if (node.computed) walkFreeIdentifiers(asNode(node.key), bound, free)
      walkFreeIdentifiers(asNode(node.value), bound, free)
      return
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const inner = new Set(bound)
      const id = asNode(node.id)
      if (id?.type === 'Identifier') inner.add(id.name as string)
      for (const param of asNodes(node.params)) addPatternNames(param, inner)
      walkFreeIdentifiers(asNode(node.body), inner, free)
      return
    }
    case 'BlockStatement': {
      const inner = new Set(bound)
      for (const statement of asNodes(node.body)) {
        if (statement.type === 'VariableDeclaration') {
          for (const declarator of asNodes(statement.declarations)) {
            addPatternNames(asNode(declarator.id), inner)
          }
        } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
          const id = asNode(statement.id)
          if (id?.type === 'Identifier') inner.add(id.name as string)
        }
      }
      for (const statement of asNodes(node.body)) walkFreeIdentifiers(statement, inner, free)
      return
    }
    case 'VariableDeclarator':
      walkFreeIdentifiers(asNode(node.init), bound, free)
      return
    case 'CatchClause': {
      const inner = new Set(bound)
      addPatternNames(asNode(node.param), inner)
      walkFreeIdentifiers(asNode(node.body), inner, free)
      return
    }
    case 'MetaProperty':
    case 'ThisExpression':
    case 'Super':
    case 'Literal':
    case 'PrivateIdentifier':
      return
    default: {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
          continue
        }
        if (Array.isArray(value)) {
          for (const item of value) walkFreeIdentifiers(asNode(item), bound, free)
        } else {
          walkFreeIdentifiers(asNode(value), bound, free)
        }
      }
    }
  }
}

const findReturnArguments = (node: EstreeNode | undefined, found: EstreeNode[]) => {
  if (!node) return
  if (node.type === 'ReturnStatement' && node.argument) {
    found.push(asNode(node.argument)!)
    return
  }
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    return
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) findReturnArguments(asNode(item), found)
    } else {
      findReturnArguments(asNode(value), found)
    }
  }
}

const unwrapConfigObject = (
  node: EstreeNode | undefined,
  bindings: Map<string, Binding>,
  helpers: ConfigHelpers
): UnwrapResult | undefined => {
  if (!node) return undefined
  if (node.type === 'ObjectExpression') {
    return {
      object: node,
      extra: [],
      configNames: new Set(),
      configDeclarators: new Set(),
      allowedReturns: new Set(),
    }
  }
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') {
    return unwrapConfigObject(asNode(node.expression), bindings, helpers)
  }
  if (node.type === 'ChainExpression') {
    return unwrapConfigObject(asNode(node.expression), bindings, helpers)
  }
  if (node.type === 'ParenthesizedExpression') {
    return unwrapConfigObject(asNode(node.expression), bindings, helpers)
  }
  if (node.type === 'AwaitExpression') {
    return unwrapConfigObject(asNode(node.argument), bindings, helpers)
  }
  if (node.type === 'CallExpression') {
    if (!isConfigHelperCall(node, helpers)) return undefined
    const args = asNodes(node.arguments)
    if (args.length !== 1) return undefined
    return unwrapConfigObject(args[0], bindings, helpers)
  }
  if (node.type === 'Identifier') {
    const name = node.name as string
    const binding = bindings.get(name)
    if (binding?.kind !== 'declaration') return undefined
    if (binding.node.type === 'VariableDeclarator') {
      const unwrapped = unwrapConfigObject(asNode(binding.node.init), bindings, helpers)
      if (!unwrapped) return undefined
      unwrapped.configNames.add(name)
      unwrapped.configDeclarators ??= new Set()
      unwrapped.configDeclarators.add(binding.node)
      return unwrapped
    }
    if (binding.node.type === 'FunctionDeclaration') {
      return unwrapFunctionConfig(binding.node, bindings, helpers)
    }
    return undefined
  }
  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  ) {
    return unwrapFunctionConfig(node, bindings, helpers)
  }
  return undefined
}

const unwrapFunctionConfig = (
  fn: EstreeNode,
  bindings: Map<string, Binding>,
  helpers: ConfigHelpers
): UnwrapResult | undefined => {
  const body = asNode(fn.body)
  if (!body) return undefined
  const extra: EstreeNode[] = []
  const inner = new Map(bindings)
  if (body.type !== 'BlockStatement') {
    const unwrapped = unwrapConfigObject(body, inner, helpers)
    return unwrapped
      ? {
          object: unwrapped.object,
          extra: [...extra, ...unwrapped.extra],
          configNames: unwrapped.configNames,
          configDeclarators: unwrapped.configDeclarators,
          allowedReturns: new Set([...unwrapped.allowedReturns, body]),
        }
      : undefined
  }
  for (const statement of asNodes(body.body)) {
    if (
      statement.type === 'VariableDeclaration' ||
      statement.type === 'FunctionDeclaration' ||
      statement.type === 'ClassDeclaration'
    ) {
      extra.push(statement)
      recordDeclarationBindings(statement, inner)
    }
  }
  const returns: EstreeNode[] = []
  findReturnArguments(body, returns)
  if (returns.length !== 1) return undefined
  const unwrapped = unwrapConfigObject(returns[0], inner, helpers)
  return unwrapped
    ? {
        object: unwrapped.object,
        extra: [...extra, ...unwrapped.extra],
        configNames: unwrapped.configNames,
        configDeclarators: unwrapped.configDeclarators,
        allowedReturns: new Set([...unwrapped.allowedReturns, returns[0]]),
      }
    : undefined
}

const findDefaultExport = (program: EstreeNode): EstreeNode | undefined => {
  for (const statement of asNodes(program.body)) {
    if (statement.type === 'ExportDefaultDeclaration') {
      return asNode(statement.declaration)
    }
    if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of asNodes(statement.specifiers)) {
        const exported = asNode(specifier.exported)
        const local = asNode(specifier.local)
        if (exported?.type === 'Identifier' && exported.name === 'default' && local) {
          return local
        }
      }
    }
  }
  return undefined
}

const propertyName = (property: EstreeNode): string | undefined => {
  if (property.computed) return undefined
  const key = asNode(property.key)
  if (key?.type === 'Identifier') return key.name as string
  if (key?.type === 'Literal' && typeof key.value === 'string') return key.value
  return undefined
}

const findObjectLiteralValue = (object: EstreeNode, key: string): EstreeNode | undefined => {
  let found: EstreeNode | undefined
  for (const property of asNodes(object.properties)) {
    if (property.type === 'SpreadElement') return undefined
    if (property.type !== 'Property') continue
    if (propertyName(property) === key) found = asNode(property.value)
  }
  return found
}

const assertStaticConfigObjectShape = (object: EstreeNode, filePath: string) => {
  for (const property of asNodes(object.properties)) {
    if (property.type === 'SpreadElement') {
      throw projectionBoundaryError(
        filePath,
        'The defineServer() / defineApplication() object contains a spread. ' +
          'A spread can add or override a universal field after static extraction, so declare configuration properties directly.'
      )
    }
    if (property.type === 'Property' && property.computed) {
      throw projectionBoundaryError(
        filePath,
        'The defineServer() / defineApplication() object contains a computed property. ' +
          'A computed key can override a universal field after static extraction, so use direct static property names.'
      )
    }
  }
}

const isPrimitiveLiteral = (node: EstreeNode | undefined): boolean => {
  if (!node || node.type !== 'Literal') return false
  const value = node.value
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

const isTriviallyPure = (node: EstreeNode | undefined): boolean => {
  if (!node) return true
  switch (node.type) {
    case 'Literal':
      return isPrimitiveLiteral(node) || Boolean(node.regex)
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return true
    case 'TemplateElement':
      return true
    case 'TemplateLiteral':
      return asNodes(node.expressions).every(isPrimitivePure)
    case 'UnaryExpression': {
      const argument = asNode(node.argument)
      if (node.operator === '!' || node.operator === 'void' || node.operator === 'typeof') {
        return isTriviallyPure(argument)
      }
      if (node.operator === '+' || node.operator === '-' || node.operator === '~') {
        return isPrimitiveLiteral(argument) || isPrimitivePure(argument)
      }
      return false
    }
    case 'BinaryExpression':
    case 'LogicalExpression':
      return isPrimitivePure(asNode(node.left)) && isPrimitivePure(asNode(node.right))
    case 'ConditionalExpression':
      return (
        isTriviallyPure(asNode(node.test)) &&
        isTriviallyPure(asNode(node.consequent)) &&
        isTriviallyPure(asNode(node.alternate))
      )
    case 'ArrayExpression':
      return asNodeList(node.elements).every(
        (element) => !element || (element.type !== 'SpreadElement' && isTriviallyPure(element))
      )
    case 'ObjectExpression':
      return asNodes(node.properties).every((property) => {
        if (property.type !== 'Property' || property.kind !== 'init' || property.method) return false
        if (property.computed && !isPrimitivePure(asNode(property.key))) return false
        return isTriviallyPure(asNode(property.value))
      })
    case 'ParenthesizedExpression':
      return isTriviallyPure(asNode(node.expression))
    default:
      return false
  }
}

const isPrimitivePure = (node: EstreeNode | undefined): boolean => {
  if (!node) return true
  if (isPrimitiveLiteral(node)) return true
  if (node.type === 'UnaryExpression') {
    if (node.operator === '!' || node.operator === 'void' || node.operator === 'typeof') {
      return isPrimitivePure(asNode(node.argument))
    }
    if (node.operator === '+' || node.operator === '-' || node.operator === '~') {
      return isPrimitivePure(asNode(node.argument))
    }
    return false
  }
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    return isPrimitivePure(asNode(node.left)) && isPrimitivePure(asNode(node.right))
  }
  if (node.type === 'ConditionalExpression') {
    return (
      isPrimitivePure(asNode(node.test)) &&
      isPrimitivePure(asNode(node.consequent)) &&
      isPrimitivePure(asNode(node.alternate))
    )
  }
  if (node.type === 'TemplateLiteral') return asNodes(node.expressions).every(isPrimitivePure)
  if (node.type === 'ParenthesizedExpression') return isPrimitivePure(asNode(node.expression))
  return false
}

const collectOmittedInits = (
  pattern: EstreeNode | undefined,
  init: EstreeNode | undefined,
  name: string,
  omitted: EstreeNode[]
) => {
  if (!init) return
  if (!pattern) {
    omitted.push(init)
    return
  }
  if (pattern.type === 'Identifier') {
    if (pattern.name !== name) omitted.push(init)
    return
  }
  if (pattern.type === 'AssignmentPattern' || pattern.type === 'RestElement') {
    omitted.push(init)
    return
  }
  if (pattern.type === 'ArrayPattern') {
    if (init.type !== 'ArrayExpression') {
      omitted.push(init)
      return
    }
    const patternElements = asNodeList(pattern.elements)
    const initElements = asNodeList(init.elements)
    for (let index = 0; index < initElements.length; index += 1) {
      const elementInit = initElements[index]
      if (!elementInit) continue
      const element = patternElements[index]
      if (!element) {
        omitted.push(elementInit)
        continue
      }
      if (element.type === 'RestElement') {
        if (!patternContainsName(element, name)) {
          for (let rest = index; rest < initElements.length; rest += 1) {
            if (initElements[rest]) omitted.push(initElements[rest]!)
          }
        }
        return
      }
      collectOmittedInits(element, elementInit, name, omitted)
    }
    return
  }
  if (pattern.type === 'ObjectPattern') {
    if (init.type !== 'ObjectExpression') {
      omitted.push(init)
      return
    }
    for (const property of asNodes(init.properties)) {
      if (property.type === 'SpreadElement') {
        omitted.push(property)
        continue
      }
      if (property.type !== 'Property') continue
      const key = propertyName(property)
      const value = asNode(property.value)
      if (!value) continue
      if (!key) {
        omitted.push(value)
        continue
      }
      const matched = asNodes(pattern.properties).find((item) => {
        if (item.type === 'RestElement') return false
        return item.type === 'Property' && propertyName(item) === key
      })
      if (!matched || matched.type !== 'Property') {
        omitted.push(value)
        continue
      }
      const valuePattern = asNode(matched.value)
      if (!valuePattern || !patternContainsName(valuePattern, name)) omitted.push(value)
      else collectOmittedInits(valuePattern, value, name, omitted)
    }
  }
}

const matchPatternInit = (
  pattern: EstreeNode | undefined,
  init: EstreeNode | undefined,
  name: string
): EstreeNode | undefined => {
  if (!pattern || !init) return undefined
  if (pattern.type === 'Identifier') return pattern.name === name ? init : undefined
  if (pattern.type === 'AssignmentPattern' || pattern.type === 'RestElement') return undefined
  if (pattern.type === 'ArrayPattern') {
    if (init.type !== 'ArrayExpression') return undefined
    const initElements = asNodeList(init.elements)
    if (initElements.some((element) => element?.type === 'SpreadElement')) return undefined
    const patternElements = asNodeList(pattern.elements)
    for (let index = 0; index < patternElements.length; index += 1) {
      const element = patternElements[index]
      if (!element) continue
      if (element.type === 'RestElement') {
        if (patternContainsName(element, name)) return undefined
        continue
      }
      if (!patternContainsName(element, name)) continue
      return matchPatternInit(element, initElements[index], name)
    }
    return undefined
  }
  if (pattern.type === 'ObjectPattern') {
    if (init.type !== 'ObjectExpression') return undefined
    if (asNodes(init.properties).some((property) => property.type === 'SpreadElement')) return undefined
    for (const property of asNodes(pattern.properties)) {
      if (property.type === 'RestElement') {
        if (patternContainsName(asNode(property.argument), name)) return undefined
        continue
      }
      if (property.type !== 'Property' || property.computed) {
        if (patternContainsName(property, name)) return undefined
        continue
      }
      const valuePattern = asNode(property.value)
      if (!valuePattern || !patternContainsName(valuePattern, name)) continue
      const key = propertyName(property)
      if (!key) return undefined
      return matchPatternInit(valuePattern, findObjectLiteralValue(init, key), name)
    }
    return undefined
  }
  return undefined
}

const isolateDeclaratorInit = (declarator: EstreeNode, name: string, filePath: string): EstreeNode => {
  const id = asNode(declarator.id)
  const init = asNode(declarator.init)
  if (id?.type === 'Identifier' && id.name === name && init) return init
  const isolated = matchPatternInit(id, init, name)
  const omitted: EstreeNode[] = []
  if (isolated) collectOmittedInits(id, init, name, omitted)
  if (isolated && omitted.every(isTriviallyPure)) return isolated
  throw projectionBoundaryError(
    filePath,
    `Binding "${name}" comes from a destructuring pattern that Core cannot prove is browser-safe. ` +
      `Use a dedicated \`const ${name} = ...\` so unused sibling values cannot change evaluation semantics or enter the client bundle.`
  )
}

type ScopeBinding = {
  name: string
  tracked?: string
  configHelper?: 'helper' | 'namespace'
}

type ScopeKind = 'module' | 'function' | 'block'

type Scope = {
  parent?: Scope
  names: Map<string, ScopeBinding>
  kind: ScopeKind
}

type LexicalScopes = {
  moduleScope: Scope
  lexicalScope: WeakMap<EstreeNode, Scope>
  nodeScope: WeakMap<EstreeNode, Scope>
  declaratorBindings: Map<EstreeNode, ScopeBinding[]>
  variableDeclarators: Array<{
    node: EstreeNode
    scope: Scope
    kind: 'const' | 'let' | 'var'
  }>
}

const resolveScopeName = (scope: Scope | undefined, name: string): ScopeBinding | undefined => {
  while (scope) {
    const found = scope.names.get(name)
    if (found) return found
    scope = scope.parent
  }
  return undefined
}

const memberFieldName = (node: EstreeNode): string | undefined => {
  const property = asNode(node.property)
  if (!node.computed && property?.type === 'Identifier') return property.name as string
  if (property?.type === 'Literal' && typeof property.value === 'string') return property.value
  return undefined
}

/**
 * Resolve expressions whose resulting value is, or contains, a tracked reference.
 *
 * This is deliberately an allowlist. It models only transparent reference aliases
 * and containers that retain a reference. Calls and coercive expressions are not
 * aliases: their safety is validated separately and unknown ones fail closed.
 */
const trackedRefFromExpression = (node: EstreeNode | undefined, scope: Scope): string | undefined => {
  if (!node) return undefined
  if (node.type === 'Identifier') return resolveScopeName(scope, node.name as string)?.tracked
  if (
    node.type === 'ChainExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  ) {
    return trackedRefFromExpression(asNode(node.expression), scope)
  }
  if (node.type === 'MemberExpression') {
    const objectTracked = trackedRefFromExpression(asNode(node.object), scope)
    if (!objectTracked) return undefined
    const field = memberFieldName(node)
    if (field && isUniversalField(field)) return field
    return objectTracked
  }
  if (node.type === 'SpreadElement') {
    return trackedRefFromExpression(asNode(node.argument), scope)
  }
  if (node.type === 'ArrayExpression') {
    for (const element of asNodeList(node.elements)) {
      const tracked = trackedRefFromExpression(element, scope)
      if (tracked) return tracked
    }
    return undefined
  }
  if (node.type === 'ObjectExpression') {
    for (const property of asNodes(node.properties)) {
      if (property.type === 'SpreadElement') {
        const tracked = trackedRefFromExpression(asNode(property.argument), scope)
        if (tracked) return tracked
        continue
      }
      if (property.type !== 'Property' || property.kind !== 'init' || property.method) continue
      const tracked = trackedRefFromExpression(asNode(property.value), scope)
      if (tracked) return tracked
    }
    return undefined
  }
  if (node.type === 'ConditionalExpression') {
    return (
      trackedRefFromExpression(asNode(node.consequent), scope) ??
      trackedRefFromExpression(asNode(node.alternate), scope)
    )
  }
  if (node.type === 'LogicalExpression') {
    return (
      trackedRefFromExpression(asNode(node.left), scope) ??
      trackedRefFromExpression(asNode(node.right), scope)
    )
  }
  if (node.type === 'SequenceExpression') {
    const expressions = asNodes(node.expressions)
    return trackedRefFromExpression(expressions.at(-1), scope)
  }
  if (node.type === 'AssignmentExpression') {
    return trackedRefFromExpression(asNode(node.right), scope)
  }
  return undefined
}

const mutationFieldLabel = (field: string): string =>
  field === '*' || field === CONFIG_REFERENCE || !isUniversalField(field)
    ? 'the configuration object'
    : `universal field "${field}"`

const mutableBindingError = (filePath: string, field: string, binding?: string): Error =>
  projectionBoundaryError(
    filePath,
    binding && isUniversalField(field)
      ? `Universal field "${field}" depends on mutable binding "${binding}"; use a static immutable value so the server and browser definitions cannot diverge.`
      : `Configuration is mutated after defineServer() / defineApplication() (${mutationFieldLabel(field)}). ` +
        'Universal fields must remain static so the server and browser definitions cannot diverge.'
  )

const unsupportedReferenceEscapeError = (
  filePath: string,
  field: string,
  context: string
): Error =>
  projectionBoundaryError(
    filePath,
    `${mutationFieldLabel(field)} escapes through ${context}; Core cannot prove that the server-only use preserves the browser value. ` +
      'Keep the value in a dedicated static const or define it directly on defineServer() / defineApplication().'
  )

const isObjectMutator = (callee: EstreeNode | undefined): boolean => {
  if (callee?.type !== 'MemberExpression') return false
  const object = asNode(callee.object)
  const field = memberFieldName(callee)
  return object?.type === 'Identifier' && object.name === 'Object' && !!field && OBJECT_MUTATORS.has(field)
}

const markTracked = (binding: ScopeBinding | undefined, tracked: string | undefined) => {
  if (!binding || !tracked || binding.tracked) return false
  binding.tracked = tracked
  return true
}

const bindAssignmentPattern = (
  pattern: EstreeNode | undefined,
  tracked: string,
  scope: Scope
): boolean => {
  if (!pattern) return false
  if (pattern.type === 'Identifier') {
    return markTracked(
      resolveScopeName(scope, pattern.name as string),
      isUniversalField(pattern.name as string) ? (pattern.name as string) : tracked
    )
  }
  if (pattern.type === 'ObjectPattern') {
    let changed = false
    for (const property of asNodes(pattern.properties)) {
      if (property.type === 'RestElement') {
        changed = bindAssignmentPattern(asNode(property.argument), tracked, scope) || changed
        continue
      }
      if (property.type !== 'Property') continue
      if (property.computed) {
        changed = bindAssignmentPattern(asNode(property.value), tracked, scope) || changed
        continue
      }
      const key = propertyName(property)
      const field = key && isUniversalField(key) ? key : tracked
      changed = bindAssignmentPattern(asNode(property.value), field, scope) || changed
    }
    return changed
  }
  if (pattern.type === 'ArrayPattern') {
    let changed = false
    for (const element of asNodeList(pattern.elements)) {
      if (!element) continue
      if (element.type === 'RestElement') {
        changed = bindAssignmentPattern(asNode(element.argument), tracked, scope) || changed
        continue
      }
      changed = bindAssignmentPattern(element, tracked, scope) || changed
    }
    return changed
  }
  if (pattern.type === 'AssignmentPattern') {
    return bindAssignmentPattern(asNode(pattern.left), tracked, scope)
  }
  return true
}

const isIterationStatement = (node: EstreeNode): boolean =>
  node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement'

const walkChildNodes = (
  node: EstreeNode,
  scope: Scope,
  visit: (child: EstreeNode | undefined, scope: Scope) => void
) => {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
    if (Array.isArray(value)) {
      for (const item of value) visit(asNode(item), scope)
    } else {
      visit(asNode(value), scope)
    }
  }
}

const collectLexicalScopes = (program: EstreeNode): LexicalScopes => {
  const declaratorBindings = new Map<EstreeNode, ScopeBinding[]>()
  const lexicalScope = new WeakMap<EstreeNode, Scope>()
  const nodeScope = new WeakMap<EstreeNode, Scope>()
  const variableDeclarators: LexicalScopes['variableDeclarators'] = []
  const createScope = (kind: ScopeKind, parent?: Scope): Scope => ({ parent, names: new Map(), kind })
  const recordBinding = (scope: Scope, name: string, declarator?: EstreeNode): ScopeBinding => {
    const existing = scope.names.get(name)
    if (existing) {
      if (declarator) {
        const list = declaratorBindings.get(declarator) ?? []
        if (!list.includes(existing)) {
          list.push(existing)
          declaratorBindings.set(declarator, list)
        }
      }
      return existing
    }
    const binding: ScopeBinding = { name }
    scope.names.set(name, binding)
    if (declarator) {
      const list = declaratorBindings.get(declarator) ?? []
      list.push(binding)
      declaratorBindings.set(declarator, list)
    }
    return binding
  }
  const recordPattern = (scope: Scope, pattern: EstreeNode | undefined, declarator?: EstreeNode) => {
    const names = new Set<string>()
    addPatternNames(pattern, names)
    for (const name of names) recordBinding(scope, name, declarator)
  }
  const functionOrModuleScope = (scope: Scope): Scope => {
    let current: Scope | undefined = scope
    while (current) {
      if (current.kind === 'function' || current.kind === 'module') return current
      current = current.parent
    }
    return scope
  }
  const variableScope = (declaration: EstreeNode, scope: Scope): Scope =>
    declaration.kind === 'var' ? functionOrModuleScope(scope) : scope
  const bindVariableDeclaration = (declaration: EstreeNode, scope: Scope) => {
    const target = variableScope(declaration, scope)
    for (const declarator of asNodes(declaration.declarations)) {
      recordPattern(target, asNode(declarator.id), declarator)
    }
  }
  const bindBlockDeclarations = (statements: EstreeNode[], scope: Scope) => {
    for (const statement of statements) {
      if (statement.type === 'ImportDeclaration') {
        for (const specifier of asNodes(statement.specifiers)) {
          const local = asNode(specifier.local)
          if (local?.type === 'Identifier') recordBinding(scope, local.name as string, statement)
        }
      } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
        const id = asNode(statement.id)
        if (id?.type === 'Identifier') recordBinding(scope, id.name as string, statement)
      } else if (statement.type === 'VariableDeclaration') {
        bindVariableDeclaration(statement, scope)
      } else if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
        bindBlockDeclarations([asNode(statement.declaration)!], scope)
      } else if (statement.type === 'ExportDefaultDeclaration') {
        const declaration = asNode(statement.declaration)
        if (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') {
          bindBlockDeclarations([declaration], scope)
        }
      }
    }
  }
  const collectScopes = (node: EstreeNode | undefined, scope: Scope) => {
    if (!node) return
    nodeScope.set(node, scope)
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (node.type === 'FunctionDeclaration') {
        const id = asNode(node.id)
        if (id?.type === 'Identifier') recordBinding(scope, id.name as string, node)
      }
      const inner = createScope('function', scope)
      if (node.type !== 'FunctionDeclaration') {
        const id = asNode(node.id)
        if (id?.type === 'Identifier') recordBinding(inner, id.name as string, node)
      }
      for (const param of asNodes(node.params)) recordPattern(inner, param)
      lexicalScope.set(node, inner)
      for (const param of asNodes(node.params)) collectScopes(param, inner)
      const body = asNode(node.body)
      if (body?.type === 'BlockStatement') {
        bindBlockDeclarations(asNodes(body.body), inner)
        lexicalScope.set(body, inner)
        nodeScope.set(body, inner)
        for (const statement of asNodes(body.body)) collectScopes(statement, inner)
      } else {
        collectScopes(body, inner)
      }
      return
    }
    if (node.type === 'BlockStatement' || node.type === 'Program') {
      const inner = node.type === 'Program' ? scope : createScope('block', scope)
      lexicalScope.set(node, inner)
      nodeScope.set(node, inner)
      if (node.type === 'BlockStatement') bindBlockDeclarations(asNodes(node.body), inner)
      for (const statement of asNodes(node.body)) collectScopes(statement, inner)
      return
    }
    if (node.type === 'CatchClause') {
      const inner = createScope('block', scope)
      lexicalScope.set(node, inner)
      nodeScope.set(node, inner)
      recordPattern(inner, asNode(node.param))
      collectScopes(asNode(node.param), inner)
      collectScopes(asNode(node.body), inner)
      return
    }
    if (isIterationStatement(node)) {
      const inner = createScope('block', scope)
      lexicalScope.set(node, inner)
      nodeScope.set(node, inner)
      const declaration = node.type === 'ForStatement' ? asNode(node.init) : asNode(node.left)
      if (declaration?.type === 'VariableDeclaration') bindVariableDeclaration(declaration, inner)
      walkChildNodes(node, inner, collectScopes)
      return
    }
    if (node.type === 'VariableDeclaration') {
      bindVariableDeclaration(node, scope)
      const target = variableScope(node, scope)
      for (const declarator of asNodes(node.declarations)) {
        nodeScope.set(declarator, target)
        variableDeclarators.push({
          node: declarator,
          scope: target,
          kind: node.kind as 'const' | 'let' | 'var',
        })
        collectScopes(asNode(declarator.id), target)
        collectScopes(asNode(declarator.init), scope)
      }
      return
    }
    walkChildNodes(node, scope, collectScopes)
  }
  const moduleScope = createScope('module')
  bindBlockDeclarations(asNodes(program.body), moduleScope)
  collectScopes(program, moduleScope)
  return { moduleScope, lexicalScope, nodeScope, declaratorBindings, variableDeclarators }
}

const configHelperFromExpression = (
  node: EstreeNode | undefined,
  scope: Scope
): ScopeBinding['configHelper'] => {
  if (!node) return undefined
  if (node.type === 'Identifier') {
    return resolveScopeName(scope, node.name as string)?.configHelper
  }
  if (
    node.type === 'ChainExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  ) {
    return configHelperFromExpression(asNode(node.expression), scope)
  }
  if (node.type !== 'MemberExpression' || node.computed) return undefined
  const object = asNode(node.object)
  const property = asNode(node.property)
  return configHelperFromExpression(object, scope) === 'namespace' &&
    property?.type === 'Identifier' &&
    CONFIG_HELPER_EXPORTS.has(property.name as string)
    ? 'helper'
    : undefined
}

const collectConfigHelpers = (program: EstreeNode, filePath: string): ConfigHelpers => {
  const scopes = collectLexicalScopes(program)
  for (const statement of asNodes(program.body)) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
    const source = asNode(statement.source)
    const specifier = typeof source?.value === 'string' ? source.value : ''
    if (!isLibraryConfigSpecifier(specifier, filePath)) continue
    for (const item of asNodes(statement.specifiers)) {
      const local = asNode(item.local)
      if (local?.type !== 'Identifier') continue
      const binding = scopes.moduleScope.names.get(local.name as string)
      if (!binding) continue
      if (item.type === 'ImportNamespaceSpecifier') {
        binding.configHelper = 'namespace'
        continue
      }
      const exported = importedExportName(item)
      if (exported && CONFIG_HELPER_EXPORTS.has(exported)) binding.configHelper = 'helper'
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const { node, scope, kind } of scopes.variableDeclarators) {
      if (kind !== 'const') continue
      const id = asNode(node.id)
      if (id?.type !== 'Identifier') continue
      const binding = scope.names.get(id.name as string)
      if (!binding || binding.configHelper) continue
      const helper = configHelperFromExpression(asNode(node.init), scope)
      if (!helper) continue
      binding.configHelper = helper
      changed = true
    }
  }
  const calls = new WeakSet<EstreeNode>()
  const collectCalls = (node: EstreeNode | undefined) => {
    if (!node) return
    if (node.type === 'CallExpression') {
      const scope = scopes.nodeScope.get(node) ?? scopes.moduleScope
      if (configHelperFromExpression(asNode(node.callee), scope) === 'helper') calls.add(node)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) collectCalls(asNode(item))
      } else {
        collectCalls(asNode(value))
      }
    }
  }
  collectCalls(program)
  return { calls, scopes }
}

/**
 * Safety invariant: after projection, no server-only statement may retain, mutate,
 * invoke, coerce, or otherwise expose the configuration object or any universal
 * dependency in a way that the emitted browser graph does not reproduce. Syntax
 * outside the small alias/container allowlist fails closed instead of attempting
 * whole-program JavaScript interpretation.
 */
const assertStaticUniversalGraph = (
  program: EstreeNode,
  helpers: ConfigHelpers,
  trackedDeclarators: Set<EstreeNode>,
  configDeclarators: Set<EstreeNode>,
  filePath: string,
  trackedNames: Set<string>,
  projectedRoots: Set<EstreeNode>,
  allowedReturns: Set<EstreeNode>,
  allowTrackedExports = false
) => {
  if (!trackedDeclarators.size && !trackedNames.size) return
  const { declaratorBindings, lexicalScope, moduleScope } = helpers.scopes
  const seedTrackedBinding = (binding: ScopeBinding) => {
    if (!binding.tracked) {
      binding.tracked = isUniversalField(binding.name) ? binding.name : '*'
    }
  }
  for (const [declarator, bindings] of declaratorBindings) {
    if (!trackedDeclarators.has(declarator)) continue
    for (const binding of bindings) {
      if (declarator.type === 'ImportDeclaration' && !trackedNames.has(binding.name)) continue
      if (configDeclarators.has(declarator)) binding.tracked = CONFIG_REFERENCE
      else seedTrackedBinding(binding)
    }
  }
  for (const name of trackedNames) {
    const binding = moduleScope.names.get(name)
    if (binding) seedTrackedBinding(binding)
  }
  const seedDeclaratorAliases = (declarator: EstreeNode, scope: Scope): boolean => {
    const aliased = trackedRefFromExpression(asNode(declarator.init), scope)
    if (!aliased) return false
    const id = asNode(declarator.id)
    if (id?.type === 'Identifier') {
      return markTracked(
        resolveScopeName(scope, id.name as string),
        isUniversalField(id.name as string) ? (id.name as string) : aliased
      )
    }
    if (
      id?.type === 'ObjectPattern' &&
      asNodes(id.properties).some((item) => item.type === 'Property' && Boolean(item.computed))
    ) {
      throw projectionBoundaryError(
        filePath,
        `${mutationFieldLabel(aliased)} is destructured through a computed property; Core cannot prove which tracked reference is retained.`
      )
    }
    return bindAssignmentPattern(id, aliased, scope)
  }
  const propagateAliases = (node: EstreeNode | undefined, scope: Scope): boolean => {
    if (!node) return false
    let changed = false
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const inner = lexicalScope.get(node) ?? scope
      const body = asNode(node.body)
      if (body?.type === 'BlockStatement') {
        let changedBody = false
        for (const statement of asNodes(body.body)) {
          changedBody = propagateAliases(statement, inner) || changedBody
        }
        return changedBody
      }
      return propagateAliases(body, inner)
    }
    if (node.type === 'BlockStatement' || node.type === 'Program') {
      const inner = lexicalScope.get(node) ?? scope
      for (const statement of asNodes(node.body)) changed = propagateAliases(statement, inner) || changed
      return changed
    }
    if (node.type === 'CatchClause') {
      return propagateAliases(asNode(node.body), lexicalScope.get(node) ?? scope)
    }
    if (isIterationStatement(node)) {
      const inner = lexicalScope.get(node) ?? scope
      walkChildNodes(node, inner, (child, childScope) => {
        changed = propagateAliases(child, childScope) || changed
      })
      return changed
    }
    if (node.type === 'VariableDeclaration') {
      for (const declarator of asNodes(node.declarations)) {
        changed = seedDeclaratorAliases(declarator, scope) || changed
      }
      return changed
    }
    if (node.type === 'AssignmentExpression') {
      const rightTracked = trackedRefFromExpression(asNode(node.right), scope)
      const left = asNode(node.left)
      if (left?.type === 'Identifier' && rightTracked) {
        changed = markTracked(resolveScopeName(scope, left.name as string), rightTracked) || changed
      } else if (left?.type === 'ObjectPattern' && rightTracked) {
        if (asNodes(left.properties).some((item) => item.type === 'Property' && Boolean(item.computed))) {
          throw mutableBindingError(filePath, rightTracked)
        }
        changed = bindAssignmentPattern(left, rightTracked, scope) || changed
      } else if (left?.type === 'ArrayPattern') {
        const right = asNode(node.right)
        if (right?.type === 'ArrayExpression') {
          const leftElements = asNodeList(left.elements)
          const rightElements = asNodeList(right.elements)
          for (let index = 0; index < leftElements.length; index += 1) {
            const elementTracked = trackedRefFromExpression(rightElements[index], scope)
            if (elementTracked && leftElements[index]) {
              changed = bindAssignmentPattern(leftElements[index], elementTracked, scope) || changed
            }
          }
        } else if (rightTracked) {
          changed = bindAssignmentPattern(left, rightTracked, scope) || changed
        }
      } else if (left && rightTracked && left.type !== 'Identifier') {
        const field = trackedRefFromExpression(left, scope)
        if (field) throw mutableBindingError(filePath, field)
      }
      return propagateAliases(asNode(node.right), scope) || changed
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      if (Array.isArray(value)) {
        for (const item of value) changed = propagateAliases(asNode(item), scope) || changed
      } else {
        changed = propagateAliases(asNode(value), scope) || changed
      }
    }
    return changed
  }
  let aliasChanged = true
  while (aliasChanged) aliasChanged = propagateAliases(program, moduleScope)

  const throwMutated = (field: string, binding?: string): never => {
    throw mutableBindingError(filePath, field, binding)
  }
  const trackedArgument = (argument: EstreeNode, scope: Scope): string | undefined =>
    trackedRefFromExpression(
      argument.type === 'SpreadElement' ? asNode(argument.argument) : argument,
      scope
    )
  const assertNoTrackedArguments = (
    args: EstreeNode[],
    scope: Scope,
    context: string
  ) => {
    for (const argument of args) {
      const field = trackedArgument(argument, scope)
      if (field) throw unsupportedReferenceEscapeError(filePath, field, context)
    }
  }
  const walkMutations = (
    node: EstreeNode | undefined,
    scope: Scope,
    insideProjectedGraph = false
  ) => {
    if (!node) return
    const projected = insideProjectedGraph || projectedRoots.has(node)
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const inner = lexicalScope.get(node) ?? scope
      for (const param of asNodes(node.params)) walkMutations(param, inner, projected)
      const body = asNode(node.body)
      if (body?.type === 'BlockStatement') {
        for (const statement of asNodes(body.body)) walkMutations(statement, inner, projected)
      } else {
        const returned = trackedRefFromExpression(body, inner)
        if (
          returned &&
          !allowedReturns.has(body!) &&
          (!projected || returned === CONFIG_REFERENCE || isUniversalField(returned))
        ) {
          throw unsupportedReferenceEscapeError(
            filePath,
            returned,
            'a value returned from an unsupported function'
          )
        }
        walkMutations(body, inner, projected)
      }
      return
    }
    if (node.type === 'BlockStatement' || node.type === 'Program') {
      const inner = lexicalScope.get(node) ?? scope
      for (const statement of asNodes(node.body)) walkMutations(statement, inner, projected)
      return
    }
    if (node.type === 'CatchClause') {
      walkMutations(asNode(node.body), lexicalScope.get(node) ?? scope, projected)
      return
    }
    if (isIterationStatement(node)) {
      if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
        const field = trackedRefFromExpression(asNode(node.right), scope)
        if (field) {
          throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported iteration')
        }
      }
      walkChildNodes(node, lexicalScope.get(node) ?? scope, (child, childScope) =>
        walkMutations(child, childScope, projected)
      )
      return
    }
    if (node.type === 'AssignmentExpression') {
      const left = asNode(node.left)
      const rightTracked = trackedRefFromExpression(asNode(node.right), scope)
      if (left?.type === 'Identifier') {
        const binding = resolveScopeName(scope, left.name as string)
        if (binding?.tracked && !rightTracked) throwMutated(binding.tracked, left.name as string)
        else if (binding?.tracked && rightTracked && binding.tracked !== rightTracked) {
          throwMutated(binding.tracked, left.name as string)
        }
      } else if (left && left.type !== 'ObjectPattern' && left.type !== 'ArrayPattern') {
        const field = trackedRefFromExpression(left, scope)
        if (field) throwMutated(field)
        if (rightTracked) {
          throw unsupportedReferenceEscapeError(
            filePath,
            rightTracked,
            'an unsupported member assignment'
          )
        }
      }
      walkMutations(asNode(node.right), scope, projected)
      return
    }
    if (node.type === 'UpdateExpression') {
      const field = trackedRefFromExpression(asNode(node.argument), scope)
      if (field) throwMutated(field)
      return
    }
    if (node.type === 'UnaryExpression' && node.operator === 'delete') {
      const field = trackedRefFromExpression(asNode(node.argument), scope)
      if (field) throwMutated(field)
      walkMutations(asNode(node.argument), scope, projected)
      return
    }
    if (node.type === 'ReturnStatement') {
      const argument = asNode(node.argument)
      const field = trackedRefFromExpression(argument, scope)
      if (
        field &&
        argument &&
        !allowedReturns.has(argument) &&
        (!projected || field === CONFIG_REFERENCE || isUniversalField(field))
      ) {
        throw unsupportedReferenceEscapeError(
          filePath,
          field,
          'a value returned from an unsupported function'
        )
      }
      walkMutations(argument, scope, projected)
      return
    }
    if (node.type === 'YieldExpression') {
      const argument = asNode(node.argument)
      const field = trackedRefFromExpression(argument, scope)
      if (field) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported yield')
      }
      walkMutations(argument, scope, projected)
      return
    }
    if (node.type === 'ThrowStatement') {
      const argument = asNode(node.argument)
      const field = trackedRefFromExpression(argument, scope)
      if (field) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported throw')
      }
      walkMutations(argument, scope, projected)
      return
    }
    if (node.type === 'AwaitExpression') {
      const argument = asNode(node.argument)
      const field = trackedRefFromExpression(argument, scope)
      if (field) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported await')
      }
      walkMutations(argument, scope, projected)
      return
    }
    if (node.type === 'UnaryExpression') {
      const argument = asNode(node.argument)
      const field = trackedRefFromExpression(argument, scope)
      if (field && node.operator !== '!' && node.operator !== 'typeof' && node.operator !== 'void') {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported coercion')
      }
    }
    if (node.type === 'BinaryExpression') {
      const left = trackedRefFromExpression(asNode(node.left), scope)
      const right = trackedRefFromExpression(asNode(node.right), scope)
      const field = left ?? right
      if (field && node.operator !== '===' && node.operator !== '!==') {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported coercion')
      }
    }
    if (node.type === 'TemplateLiteral') {
      for (const expression of asNodes(node.expressions)) {
        const field = trackedRefFromExpression(expression, scope)
        if (field) {
          throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported string coercion')
        }
      }
    }
    if (node.type === 'ImportExpression') {
      const field = trackedRefFromExpression(asNode(node.source), scope)
      if (field) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported dynamic import')
      }
    }
    if (node.type === 'AssignmentPattern') {
      const field = trackedRefFromExpression(asNode(node.right), scope)
      if (field && (!projected || field === CONFIG_REFERENCE || isUniversalField(field))) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported default value')
      }
    }
    if (node.type === 'MemberExpression' && node.computed) {
      const field = trackedRefFromExpression(asNode(node.property), scope)
      if (field) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported computed property key')
      }
    }
    if (node.type === 'Property' && node.computed) {
      const field = trackedRefFromExpression(asNode(node.key), scope)
      if (field) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported computed property key')
      }
    }
    if (node.type === 'CallExpression') {
      const callee = asNode(node.callee)
      const args = asNodes(node.arguments)
      const configHelper = isConfigHelperCall(node, helpers)
      if (isObjectMutator(callee)) {
        const field = trackedRefFromExpression(args[0], scope)
        if (field) throwMutated(field)
      } else if (callee?.type === 'MemberExpression') {
        const object = asNode(callee.object)
        const field = trackedRefFromExpression(object, scope)
        if (field && !isConfigHelperCall(node, helpers)) {
          const binding = object?.type === 'Identifier' ? (object.name as string) : undefined
          throwMutated(field, binding)
        }
      } else if (!configHelper) {
        const calleeField = trackedRefFromExpression(callee, scope)
        if (calleeField && !projected) {
          throw unsupportedReferenceEscapeError(
            filePath,
            calleeField,
            'an unsupported call outside the projected universal graph'
          )
        }
      }
      if (!configHelper) {
        assertNoTrackedArguments(args, scope, 'an unsupported call to an unknown function')
      }
    }
    if (node.type === 'NewExpression') {
      const args = asNodes(node.arguments)
      assertNoTrackedArguments(args, scope, 'an unsupported constructor call')
      const calleeField = trackedRefFromExpression(asNode(node.callee), scope)
      if (calleeField && !projected) {
        throw unsupportedReferenceEscapeError(
          filePath,
          calleeField,
          'an unsupported constructor call outside the projected universal graph'
        )
      }
    }
    if (node.type === 'TaggedTemplateExpression') {
      const tagField = trackedRefFromExpression(asNode(node.tag), scope)
      if (tagField) {
        throw unsupportedReferenceEscapeError(filePath, tagField, 'an unsupported tagged template')
      }
      const quasi = asNode(node.quasi)
      for (const expression of asNodes(quasi?.expressions)) {
        const field = trackedRefFromExpression(expression, scope)
        if (field) {
          throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported tagged template')
        }
      }
    }
    if (node.type === 'PropertyDefinition') {
      const field = trackedRefFromExpression(asNode(node.value), scope)
      if (field) {
        throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported class field')
      }
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (allowTrackedExports) {
        const declaration = asNode(node.declaration)
        if (declaration) walkMutations(declaration, scope, projected)
        return
      }
      for (const specifier of asNodes(node.specifiers)) {
        const exported = asNode(specifier.exported)
        const exportedName =
          exported?.type === 'Identifier'
            ? (exported.name as string)
            : exported?.type === 'Literal' && typeof exported.value === 'string'
              ? exported.value
              : undefined
        if (exportedName === 'default') continue
        const field = trackedRefFromExpression(asNode(specifier.local), scope)
        if (field) {
          throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported named export')
        }
      }
      const declaration = asNode(node.declaration)
      if (declaration?.type === 'VariableDeclaration') {
        for (const declarator of asNodes(declaration.declarations)) {
          const field = trackedRefFromExpression(asNode(declarator.init), scope)
          if (field) {
            throw unsupportedReferenceEscapeError(filePath, field, 'an unsupported named export')
          }
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue
      if (Array.isArray(value)) {
        for (const item of value) walkMutations(asNode(item), scope, projected)
      } else {
        walkMutations(asNode(value), scope, projected)
      }
    }
  }
  walkMutations(program, moduleScope)
}

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

const rewriteSpecifier = (importer: string, specifier: string): string => {
  if (!(specifier.startsWith('.') || specifier.startsWith('/'))) return specifier
  return resolve(dirname(importer), specifier).replaceAll('\\', '/')
}

const rewriteImport = (
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

const emitDeclaration = (code: string, binding: Binding, filePath: string): string => {
  if (binding.node.type === 'VariableDeclarator') {
    const id = asNode(binding.node.id)
    if (id?.type === 'Identifier') {
      return `${binding.declarationKind ?? 'const'} ${slice(code, binding.node)}`.replace(/;?\s*$/, '')
    }
    const isolated = isolateDeclaratorInit(binding.node, binding.name, filePath)
    return `${binding.declarationKind ?? 'const'} ${binding.name} = ${slice(code, isolated)}`.replace(
      /;?\s*$/,
      ''
    )
  }
  return slice(code, binding.node).trim().replace(/;?\s*$/, '')
}

const collectNeededBindings = (
  fieldNodes: EstreeNode[],
  extraDeclarations: EstreeNode[],
  moduleBindings: Map<string, Binding>,
  filePath: string
): Binding[] => {
  const extraBindings = new Map(moduleBindings)
  for (const statement of extraDeclarations) recordDeclarationBindings(statement, extraBindings)
  const needed = new Map<string, Binding>()
  const visiting = new Set<string>()
  const visit = (node: EstreeNode) => {
    const free = new Set<string>()
    walkFreeIdentifiers(node, new Set(), free)
    for (const name of free) {
      if (needed.has(name) || visiting.has(name)) continue
      const binding = extraBindings.get(name)
      if (!binding) continue
      visiting.add(name)
      if (binding.kind !== 'import') {
        if (binding.node.type === 'VariableDeclarator') {
          visit(isolateDeclaratorInit(binding.node, binding.name, filePath))
        } else {
          visit(binding.node)
        }
      }
      needed.set(name, binding)
    }
  }
  for (const node of fieldNodes) visit(node)
  return [...needed.values()]
}

const assertNoServerRuntimeGlobals = (
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
          'Move Node/server environment access outside extensions, router, scrollBehavior, createInitialState, and cleanup.'
      )
    }
  }
  for (const node of fieldNodes) inspect(node)
  for (const binding of needed) {
    if (binding.kind !== 'import') inspect(binding.node)
  }
}

const assertNoNodeBuiltinDynamicImports = (nodes: EstreeNode[], filePath: string) => {
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

const resolveProjectedModule = async (
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

const importBindingTarget = (
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

const assertBrowserSafeImportedDependencies = async (
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

const fieldValueNodes = (
  object: EstreeNode
): EstreeNode[] => {
  const nodes: EstreeNode[] = []
  for (const property of asNodes(object.properties)) {
    if (property.type !== 'Property') continue
    const name = propertyName(property)
    if (!name || !isUniversalField(name)) continue
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
  if (field === 'extensions' && Array.isArray(value) && value.length === 0) return false
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

/**
 * Distinguish an actual defineApplication() module from an ordinary module
 * whose default export merely happens to have projectable universal fields.
 * This intentionally follows only transparent export/const/function-return
 * aliases; ambiguous factories are not promoted to application provenance.
 */
export const isDefineApplicationModuleSource = async (
  source: string,
  filePath: string
): Promise<boolean> => {
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
  const directHelpers = new Set<string>()
  const helperNamespaces = new Set<string>()

  for (const statement of asNodes(program.body)) {
    if (statement.type !== 'ImportDeclaration') continue
    const sourceNode = asNode(statement.source)
    if (
      typeof sourceNode?.value !== 'string' ||
      !isLibraryConfigSpecifier(sourceNode.value, filePath)
    ) {
      continue
    }
    for (const item of asNodes(statement.specifiers)) {
      const local = asNode(item.local)
      if (local?.type !== 'Identifier') continue
      if (item.type === 'ImportNamespaceSpecifier') {
        helperNamespaces.add(local.name as string)
      } else if (
        item.type === 'ImportSpecifier' &&
        importedExportName(item) === 'defineApplication'
      ) {
        directHelpers.add(local.name as string)
      }
    }
  }

  const unwrap = (input: EstreeNode | undefined): EstreeNode | undefined => {
    let node = input
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

  const isHelperCallee = (input: EstreeNode | undefined, seen: Set<string>): boolean => {
    const node = unwrap(input)
    if (!node) return false
    if (node.type === 'Identifier') {
      const name = node.name as string
      if (directHelpers.has(name)) return true
      if (seen.has(name)) return false
      const binding = bindings.get(name)
      if (
        binding?.kind !== 'declaration' ||
        binding.node.type !== 'VariableDeclarator' ||
        binding.declarationKind !== 'const'
      ) {
        return false
      }
      const next = new Set(seen)
      next.add(name)
      return isHelperCallee(asNode(binding.node.init), next)
    }
    if (node.type !== 'MemberExpression') return false
    const object = unwrap(asNode(node.object))
    const property = asNode(node.property)
    const propertyName = node.computed
      ? typeof property?.value === 'string'
        ? property.value
        : undefined
      : property?.type === 'Identifier'
        ? (property.name as string)
        : undefined
    return (
      object?.type === 'Identifier' &&
      helperNamespaces.has(object.name as string) &&
      propertyName === 'defineApplication'
    )
  }

  const isApplicationExport = (input: EstreeNode | undefined, seen: Set<string>): boolean => {
    const node = unwrap(input)
    if (!node) return false
    if (node.type === 'CallExpression') return isHelperCallee(asNode(node.callee), new Set())
    if (node.type === 'Identifier') {
      const name = node.name as string
      if (seen.has(name)) return false
      const binding = bindings.get(name)
      if (binding?.kind !== 'declaration') return false
      const next = new Set(seen)
      next.add(name)
      if (binding.node.type === 'VariableDeclarator') {
        return isApplicationExport(asNode(binding.node.init), next)
      }
      if (
        binding.node.type === 'FunctionDeclaration' ||
        binding.node.type === 'FunctionExpression' ||
        binding.node.type === 'ArrowFunctionExpression'
      ) {
        return isApplicationExport(binding.node, next)
      }
      return false
    }
    if (node.type === 'ArrowFunctionExpression' && asNode(node.body)?.type !== 'BlockStatement') {
      return isApplicationExport(asNode(node.body), seen)
    }
    if (
      node.type === 'ArrowFunctionExpression' ||
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration'
    ) {
      const body = asNode(node.body)
      if (body?.type !== 'BlockStatement') return false
      const returns = asNodes(body.body).filter((statement) => statement.type === 'ReturnStatement')
      return returns.length === 1 && isApplicationExport(asNode(returns[0].argument), seen)
    }
    return false
  }

  return isApplicationExport(findDefaultExport(program), new Set())
}

const objectDeclaresRoutes = (object: EstreeNode): boolean => {
  for (const property of asNodes(object.properties)) {
    if (property.type !== 'Property') continue
    if (propertyName(property) === 'routes') return true
  }
  return false
}

/**
 * True when `server.ts` statically declares `routes` on the exported
 * `defineServer()` / config object. Used to reject the removed single-app API
 * before the config bundler follows route-graph imports.
 */
export const sourceDeclaresServerConfigRoutes = async (
  source: string,
  filePath: string
): Promise<boolean> => {
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
  const helpers = collectConfigHelpers(program, filePath)
  const defaultExport = findDefaultExport(program)
  if (!defaultExport) return false
  const unwrapped = unwrapConfigObject(defaultExport, bindings, helpers)
  return Boolean(unwrapped && objectDeclaresRoutes(unwrapped.object))
}

export const projectUniversalRuntimeSource = async (
  source: string,
  filePath: string,
  moduleResolver?: SsrUniversalModuleResolver
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
  const helpers = collectConfigHelpers(program, filePath)
  const defaultExport = findDefaultExport(program)
  if (!defaultExport) return undefined
  const unwrapped = unwrapConfigObject(defaultExport, bindings, helpers)
  if (!unwrapped) return undefined
  const fields = extractUniversalFields(unwrapped.object, transformed)
  if (!Object.keys(fields).length) return undefined
  assertStaticConfigObjectShape(unwrapped.object, filePath)
  const needed = collectNeededBindings(
    fieldValueNodes(unwrapped.object),
    unwrapped.extra,
    bindings,
    filePath
  )
  assertNoServerRuntimeGlobals(fieldValueNodes(unwrapped.object), needed, filePath)
  assertNoNodeBuiltinDynamicImports(
    [
      ...fieldValueNodes(unwrapped.object),
      ...needed.filter((binding) => binding.kind !== 'import').map((binding) => binding.node),
    ],
    filePath
  )
  const dependencies = await assertBrowserSafeImportedDependencies(
    fieldValueNodes(unwrapped.object),
    needed,
    filePath,
    moduleResolver
  )
  const trackedDeclarators = new Set(unwrapped.configDeclarators)
  const trackedNames = new Set<string>()
  for (const binding of needed) {
    trackedDeclarators.add(binding.node)
    trackedNames.add(binding.name)
  }
  const projectedRoots = new Set<EstreeNode>(fieldValueNodes(unwrapped.object))
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
      helpers: collectConfigHelpers(program, candidate),
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
    if (key === 'extensions' && fields.extensions) {
      fields.extensions = `[...(${fields.extensions}), ...(${extraValue})]`
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
