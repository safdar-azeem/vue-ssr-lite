/** Lexical scopes and authoritative configuration-helper identity. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  SsrUniversalModuleResolver,
  EstreeNode,
  Scope,
  ScopeBinding,
  LexicalScopes,
  ScopeKind,
  ConfigHelpers,
} from './types'
import { asNode, addPatternNames, asNodes } from './syntax'

const CONFIG_HELPER_EXPORTS = new Set(['defineServer', 'defineApplication'])
const SERVER_IDENTITY_HELPER_EXPORTS = new Set(['defineServerRoutes', 'defineServerMiddleware'])

// Both source and preserveModules output keep projection two levels below src/dist.
const LIBRARY_CONFIG_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../..').replaceAll('\\', '/')

const isLibraryConfigPath = (filePath: string): boolean => {
  const normalized = filePath
    .replaceAll('\\', '/')
    .replace(/^external-file:/, '')
    .replace(/\.(?:ts|js|mts|mjs)$/, '')
  return (
    normalized === `${LIBRARY_CONFIG_DIRECTORY}/index` ||
    normalized === `${LIBRARY_CONFIG_DIRECTORY}/config/SsrConfigRuntime` ||
    normalized === `${LIBRARY_CONFIG_DIRECTORY}/config/SsrPublicConfigHelpers` ||
    /\/vue-ssr-lite\/src\/(?:index|config\/(?:SsrConfigRuntime|SsrPublicConfigHelpers))$/.test(normalized)
  )
}

export const isLibraryConfigSpecifier = (
  specifier: string,
  importer: string,
  moduleResolver?: SsrUniversalModuleResolver
): boolean => {
  if (specifier === 'vue-ssr-lite' || specifier.startsWith('vue-ssr-lite/')) return true
  const resolved = (
    specifier.startsWith('.') || specifier.startsWith('/')
      ? resolve(dirname(importer), specifier)
      : specifier
  ).replaceAll('\\', '/')
  if (isLibraryConfigPath(resolved)) return true
  const authoritative = moduleResolver?.(importer, specifier)
  const identity = authoritative?.path ?? authoritative?.identity
  return Boolean(identity && isLibraryConfigPath(identity))
}

export const importedExportName = (specifier: EstreeNode): string | undefined => {
  const imported = asNode(specifier.imported) ?? asNode(specifier.exported)
  if (imported?.type === 'Identifier') return imported.name as string
  if (imported?.type === 'Literal' && typeof imported.value === 'string') return imported.value
  return undefined
}

export const resolveScopeName = (scope: Scope | undefined, name: string): ScopeBinding | undefined => {
  while (scope) {
    const found = scope.names.get(name)
    if (found) return found
    scope = scope.parent
  }
  return undefined
}

export const memberFieldName = (node: EstreeNode): string | undefined => {
  const property = asNode(node.property)
  if (!node.computed && property?.type === 'Identifier') return property.name as string
  if (property?.type === 'Literal' && typeof property.value === 'string') return property.value
  return undefined
}

export const isIterationStatement = (node: EstreeNode): boolean =>
  node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement'

export const walkChildNodes = (
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
  if (configHelperFromExpression(object, scope) !== 'namespace' || property?.type !== 'Identifier') {
    return undefined
  }
  const name = property.name as string
  if (CONFIG_HELPER_EXPORTS.has(name)) return 'helper'
  if (SERVER_IDENTITY_HELPER_EXPORTS.has(name)) return 'server-identity'
  return undefined
}

export const collectConfigHelpers = (
  program: EstreeNode,
  filePath: string,
  moduleResolver?: SsrUniversalModuleResolver
): ConfigHelpers => {
  const scopes = collectLexicalScopes(program)
  for (const statement of asNodes(program.body)) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
    const source = asNode(statement.source)
    const specifier = typeof source?.value === 'string' ? source.value : ''
    if (!isLibraryConfigSpecifier(specifier, filePath, moduleResolver)) continue
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
      else if (exported && SERVER_IDENTITY_HELPER_EXPORTS.has(exported)) {
        binding.configHelper = 'server-identity'
      }
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
  const serverIdentityCalls = new WeakSet<EstreeNode>()
  const collectCalls = (node: EstreeNode | undefined) => {
    if (!node) return
    if (node.type === 'CallExpression') {
      const scope = scopes.nodeScope.get(node) ?? scopes.moduleScope
      const helper = configHelperFromExpression(asNode(node.callee), scope)
      if (helper === 'helper') calls.add(node)
      else if (helper === 'server-identity') serverIdentityCalls.add(node)
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
  return { calls, serverIdentityCalls, scopes }
}
