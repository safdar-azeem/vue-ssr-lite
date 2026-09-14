/** Single-module mutation and reference-escape validation for projected fields. */
import { type EstreeNode, type Scope, isUniversalField, type ScopeBinding, type ConfigHelpers } from './types'
import { resolveScopeName, memberFieldName, isIterationStatement, walkChildNodes } from './scopes'
import { asNode, asNodeList, asNodes, projectionBoundaryError, propertyName, isConfigHelperCall } from './syntax'

const OBJECT_MUTATORS = new Set(['assign', 'defineProperty', 'defineProperties'])
const CONFIG_REFERENCE = '$config'

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

const sentenceFieldLabel = (field: string): string => {
  const label = mutationFieldLabel(field)
  return label[0].toUpperCase() + label.slice(1)
}

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
    `${sentenceFieldLabel(field)} escapes through ${context}; Core cannot prove that this ${mutationFieldLabel(field)} preserves the browser value. ` +
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

/**
 * Safety invariant: after projection, no server-only statement may retain, mutate,
 * invoke, coerce, or otherwise expose the configuration object or any universal
 * dependency in a way that the emitted browser graph does not reproduce. Syntax
 * outside the small alias/container allowlist fails closed instead of attempting
 * whole-program JavaScript interpretation.
 */
export const assertStaticUniversalGraph = (
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
      // A projected import can protect the entire package namespace. Calling a
      // Core HTTP identity helper does not mutate that namespace or make its
      // result universal. Only exempt the callee: arguments and callback bodies
      // still undergo the ordinary tracked-reference checks below.
      const identityHelper = helpers.serverIdentityCalls.has(node)
      if (isObjectMutator(callee)) {
        const field = trackedRefFromExpression(args[0], scope)
        if (field) throwMutated(field)
      } else if (callee?.type === 'MemberExpression') {
        const object = asNode(callee.object)
        const field = trackedRefFromExpression(object, scope)
        if (field && !configHelper && !identityHelper) {
          const binding = object?.type === 'Identifier' ? (object.name as string) : undefined
          throwMutated(field, binding)
        }
      } else if (!configHelper && !identityHelper) {
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
