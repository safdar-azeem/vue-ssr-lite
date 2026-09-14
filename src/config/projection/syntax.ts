/** Parser loading, AST bindings, static object unwrapping, and declaration purity. */
import type { EstreeNode, ConfigHelpers, Binding, UnwrapResult } from './types'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { extname } from 'node:path'

export const isConfigHelperCall = (node: EstreeNode, helpers: ConfigHelpers): boolean =>
  helpers.calls.has(node)

export const tryResolve = (from: string, id: string): string | undefined => {
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

export const loadParseAst = async (): Promise<(code: string) => EstreeNode> => {
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

export const loaderForFile = (filePath: string): 'ts' | 'tsx' | 'js' | 'jsx' => {
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

export const slice = (code: string, node: EstreeNode): string => code.slice(node.start, node.end)

export const asNode = (value: unknown): EstreeNode | undefined =>
  value && typeof value === 'object' && typeof (value as EstreeNode).type === 'string'
    ? (value as EstreeNode)
    : undefined

export const asNodes = (value: unknown): EstreeNode[] =>
  Array.isArray(value) ? value.map(asNode).filter((node): node is EstreeNode => Boolean(node)) : []

export const asNodeList = (value: unknown): (EstreeNode | undefined)[] =>
  Array.isArray(value) ? value.map((item) => asNode(item)) : []

export const addPatternNames = (node: EstreeNode | undefined, names: Set<string>) => {
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

export const projectionBoundaryError = (filePath: string, detail: string): Error =>
  new Error(
    `Cannot project universal runtime fields from ${filePath} into the browser application. ${detail}`
  )

export const recordDeclarationBindings = (node: EstreeNode, bindings: Map<string, Binding>) => {
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

export const collectModuleBindings = (program: EstreeNode): Map<string, Binding> => {
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

export const walkFreeIdentifiers = (
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

export const unwrapConfigObject = (
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

export const findDefaultExport = (program: EstreeNode): EstreeNode | undefined => {
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

export const propertyName = (property: EstreeNode): string | undefined => {
  if (property.computed) return undefined
  const key = asNode(property.key)
  if (key?.type === 'Identifier') return key.name as string
  if (key?.type === 'Literal' && typeof key.value === 'string') return key.value
  return undefined
}

export const findObjectLiteralValue = (object: EstreeNode, key: string): EstreeNode | undefined => {
  let found: EstreeNode | undefined
  for (const property of asNodes(object.properties)) {
    if (property.type === 'SpreadElement') return undefined
    if (property.type !== 'Property') continue
    if (propertyName(property) === key) found = asNode(property.value)
  }
  return found
}

export const assertStaticConfigObjectShape = (object: EstreeNode, filePath: string) => {
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

export const isTriviallyPure = (node: EstreeNode | undefined): boolean => {
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

export const isolateDeclaratorInit = (declarator: EstreeNode, name: string, filePath: string): EstreeNode => {
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

export const emitDeclaration = (code: string, binding: Binding, filePath: string): string => {
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

export const collectNeededBindings = (
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
