/** Application detection and route/middleware import analysis for config discovery. */
import type {
  SsrUniversalModuleResolver,
  EstreeNode,
  Binding,
  SsrApplicationRoutesImportBinding,
  ConfigHelpers,
  UnwrapResult,
} from './types'
import { transformSync } from 'esbuild'
import {
  loaderForFile,
  loadParseAst,
  collectModuleBindings,
  asNodes,
  asNode,
  propertyName,
  findDefaultExport,
  unwrapConfigObject,
  walkFreeIdentifiers,
  findObjectLiteralValue,
} from './syntax'
import { isLibraryConfigSpecifier, importedExportName, collectConfigHelpers } from './scopes'
import { importBindingTarget } from './imports'

/**
 * Distinguish an actual defineApplication() module from an ordinary module
 * whose default export merely happens to have projectable universal fields.
 * This intentionally follows only transparent export/const/function-return
 * aliases; ambiguous factories are not promoted to application provenance.
 */
export const isDefineApplicationModuleSource = async (
  source: string,
  filePath: string,
  moduleResolver?: SsrUniversalModuleResolver
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
      !isLibraryConfigSpecifier(sourceNode.value, filePath, moduleResolver)
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

const unwrapExpression = (input: EstreeNode | undefined): EstreeNode | undefined => {
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

const memberPropertyName = (node: EstreeNode | undefined): string | undefined => {
  if (!node || node.computed) return undefined
  const property = asNode(node.property)
  return property?.type === 'Identifier' ? (property.name as string) : undefined
}

const resolveIdentifierToImportBinding = (
  name: string,
  bindings: Map<string, Binding>,
  seen: Set<string>
): SsrApplicationRoutesImportBinding | undefined => {
  if (seen.has(name)) return undefined
  seen.add(name)
  const binding = bindings.get(name)
  if (!binding) return undefined
  if (binding.kind === 'import') return importBindingTarget(binding)
  if (
    binding.node.type !== 'VariableDeclarator' ||
    binding.declarationKind !== 'const'
  ) {
    return undefined
  }
  const init = unwrapExpression(asNode(binding.node.init))
  if (init?.type === 'Identifier') {
    return resolveIdentifierToImportBinding(init.name as string, bindings, seen)
  }
  if (init?.type === 'MemberExpression') {
    const object = unwrapExpression(asNode(init.object))
    const imported = memberPropertyName(init)
    if (object?.type === 'Identifier' && imported) {
      const namespace = resolveIdentifierToImportBinding(object.name as string, bindings, seen)
      if (namespace?.imported === '*') {
        return { specifier: namespace.specifier, imported }
      }
    }
  }
  return undefined
}

const bindingFromRoutesValue = (
  value: EstreeNode | undefined,
  bindings: Map<string, Binding>
): SsrApplicationRoutesImportBinding | undefined => {
  const node = unwrapExpression(value)
  if (!node) return undefined
  if (
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    asNodes(node.params).length === 0
  ) {
    const body = unwrapExpression(asNode(node.body))
    if (body?.type !== 'BlockStatement') {
      return bindingFromRoutesValue(body, bindings)
    }
    const statements = asNodes(body.body)
    if (statements.length === 1 && statements[0].type === 'ReturnStatement') {
      return bindingFromRoutesValue(asNode(statements[0].argument), bindings)
    }
    return undefined
  }
  if (node.type === 'Identifier') {
    return resolveIdentifierToImportBinding(node.name as string, bindings, new Set())
  }
  if (node.type === 'MemberExpression') {
    const object = unwrapExpression(asNode(node.object))
    const imported = memberPropertyName(node)
    if (object?.type === 'Identifier' && imported) {
      const namespace = resolveIdentifierToImportBinding(object.name as string, bindings, new Set())
      if (!namespace) return undefined
      if (namespace.imported === '*') {
        return { specifier: namespace.specifier, imported }
      }
    }
  }
  return undefined
}

/**
 * Route isolation also supports a statically transparent application factory:
 * `export default createApplication({ routes })`. The factory itself remains
 * outside projection's trusted helper set; only its literal argument is
 * inspected so the route import can be removed from Node evaluation.
 */
const unwrapApplicationRoutesObject = (
  input: EstreeNode | undefined,
  bindings: Map<string, Binding>,
  helpers: ConfigHelpers,
  seen: Set<string> = new Set()
): UnwrapResult | undefined => {
  const known = unwrapConfigObject(input, bindings, helpers)
  if (known) return known
  const node = unwrapExpression(input)
  if (!node) return undefined
  if (node.type === 'Identifier') {
    const name = node.name as string
    if (seen.has(name)) return undefined
    const binding = bindings.get(name)
    // esbuild lowers an expression default export to a generated `*_default`
    // var before Rollup parses it. That binding is immutable source identity,
    // while a consumer-authored let/var alias must remain unsupported.
    const transformedDefault =
      binding?.declarationKind === 'var' && /_default(?:_\d+)?$/.test(name)
    if (
      binding?.kind !== 'declaration' ||
      binding.node.type !== 'VariableDeclarator' ||
      (binding.declarationKind !== 'const' && !transformedDefault)
    ) {
      return undefined
    }
    const next = new Set(seen)
    next.add(name)
    return unwrapApplicationRoutesObject(asNode(binding.node.init), bindings, helpers, next)
  }
  if (node.type !== 'CallExpression') return undefined
  const args = asNodes(node.arguments)
  if (args.length !== 1) return undefined
  return unwrapConfigObject(args[0], bindings, helpers)
}

/**
 * Import specifiers that feed `defineApplication({ routes })` (or an equivalent
 * application-factory object). The config compiler stubs these modules so Node
 * never evaluates the Vite-owned route/Vue/CSS graph.
 */
export const resolveApplicationRoutesImportBindings = async (
  source: string,
  filePath: string
): Promise<SsrApplicationRoutesImportBinding[]> => {
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
  const application = unwrapApplicationRoutesObject(
    findDefaultExport(program),
    bindings,
    helpers
  )
  if (!application) return []
  const values = asNodes(application.object.properties)
    .filter((property) => property.type === 'Property' && propertyName(property) === 'routes')
    .map((property) => asNode(property.value))
    .filter((value): value is EstreeNode => Boolean(value))
  const found: SsrApplicationRoutesImportBinding[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const binding = bindingFromRoutesValue(value, bindings)
    if (!binding) continue
    const key = `${binding.specifier}\0${binding.imported}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push(binding)
  }
  return found
}

export const resolveApplicationRoutesImportSpecifiers = async (
  source: string,
  filePath: string
): Promise<string[]> => [
  ...new Set(
    (await resolveApplicationRoutesImportBindings(source, filePath)).map(
      (binding) => binding.specifier
    )
  ),
]

/**
 * Import specifiers that feed `defineApplication({ middleware })` (or an
 * equivalent application-factory object). The Node config evaluator can
 * replace these modules with inert placeholders when the application is a
 * statically declared SPA; the generated browser client still imports the
 * original module through normal Vite resolution.
 */
export const resolveApplicationMiddlewareImportBindings = async (
  source: string,
  filePath: string
): Promise<SsrApplicationRoutesImportBinding[]> => {
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
  const application = unwrapApplicationRoutesObject(
    findDefaultExport(program),
    bindings,
    helpers
  )
  if (!application) return []
  const values = asNodes(application.object.properties)
    .filter((property) => property.type === 'Property' && propertyName(property) === 'middleware')
    .map((property) => asNode(property.value))
    .filter((value): value is EstreeNode => Boolean(value))
  const found: SsrApplicationRoutesImportBinding[] = []
  const seenBindings = new Set<string>()
  const seenNodes = new Set<string>()
  const visit = (value: EstreeNode | undefined) => {
    const node = unwrapExpression(value)
    if (!node) return
    const nodeKey = `${node.type}:${node.start}`
    if (seenNodes.has(nodeKey)) return
    seenNodes.add(nodeKey)
    if (node.type === 'ArrayExpression') {
      for (const element of asNodes(node.elements)) visit(element)
      return
    }
    if (node.type === 'SpreadElement') {
      visit(asNode(node.argument))
      return
    }
    if (node.type === 'Identifier') {
      const declared = bindings.get(node.name as string)
      if (
        declared?.kind === 'declaration' &&
        declared.node.type === 'VariableDeclarator'
      ) {
        visit(asNode(declared.node.init))
        return
      }
    }
    const binding = bindingFromRoutesValue(node, bindings)
    if (binding) {
      const key = `${binding.specifier}\0${binding.imported}`
      if (!seenBindings.has(key)) {
        seenBindings.add(key)
        found.push(binding)
      }
      return
    }
    // Middleware is often wrapped in a local function/const before being
    // placed in the array. Follow only its free module bindings so a browser
    // dependency is still stubbed without evaluating that module in Node.
    const free = new Set<string>()
    walkFreeIdentifiers(node, new Set(), free)
    for (const name of free) {
      const declared = bindings.get(name)
      if (!declared) continue
      if (declared.kind === 'import') {
        const target = importBindingTarget(declared)
        if (!target) continue
        const key = `${target.specifier}\0${target.imported}`
        if (seenBindings.has(key)) continue
        seenBindings.add(key)
        found.push(target)
      } else if (
        declared.node.type === 'VariableDeclarator'
      ) {
        visit(asNode(declared.node.init))
      } else if (declared.node.type === 'FunctionDeclaration') {
        visit(declared.node)
      }
    }
  }
  for (const value of values) visit(value)
  return found
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

/**
 * Prove from source that this config describes a default-SPA application.
 * Core separately rejects SPA route branches that attempt to opt back into
 * SSR, so middleware in this application can never run on the server.
 */
export const sourceDeclaresSpaOnlyApplication = async (
  source: string,
  filePath: string,
  moduleResolver?: SsrUniversalModuleResolver
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
  const helpers = collectConfigHelpers(program, filePath, moduleResolver)
  const defaultExport = findDefaultExport(program)
  if (!defaultExport) return false
  const unwrapped = unwrapConfigObject(defaultExport, bindings, helpers)
  if (!unwrapped) return false
  const render = unwrapExpression(
    findObjectLiteralValue(unwrapped.object, 'render')
  )
  return render?.type === 'Literal' && render.value === 'spa'
}
