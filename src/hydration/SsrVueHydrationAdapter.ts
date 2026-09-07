import { isVNode, type App, type VNode } from 'vue'

/**
 * VERSION-SENSITIVE: Vue 3.5.x renderer compatibility boundary.
 *
 * Owner: Core's browser hydration lifecycle. Before extending the supported
 * Vue minor, update this adapter and run its compatibility suite manually against
 * both supported range endpoints. No fetch logic belongs
 * here. Unknown structure must fail closed, never imply completed hydration.
 */
export const createSsrVueHydrationAdapter = (app: App): (() => readonly Promise<unknown>[]) => {
  const incompatible = (field: string): never => {
    throw new Error(
      `vue-ssr-lite cannot establish hydration completion with Vue ${app.version}: ${field}. ` +
      'The hydration adapter supports Vue 3.5.x; use a compatible Vue release or update the adapter. ' +
      'Initial hydration has been stopped instead of discarding continuation state as successfully hydrated.'
    )
  }
  if (!/^3\.5\.\d+$/.test(app.version)) incompatible('unsupported Vue version')
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) incompatible(field)
    return value as Record<string, unknown>
  }
  const field = (value: Record<string, unknown>, name: string): unknown => {
    if (!(name in value)) incompatible(`missing ${name}`)
    return value[name]
  }
  // Normalizing once also supports cross-realm promises without changing their
  // observed identity on each traversal. These maps belong to this transaction.
  const promises = new WeakMap<object, Promise<unknown>>()
  const settled = new WeakSet<Promise<unknown>>()
  const loaders = new WeakMap<object, Promise<unknown>>()
  const promise = (value: unknown, name: string): Promise<unknown> => {
    const source = object(value, name)
    if (typeof source.then !== 'function') incompatible(name)
    let normalized = promises.get(source)
    if (!normalized) {
      normalized = Promise.resolve(value as PromiseLike<unknown>)
      promises.set(source, normalized)
      const work = normalized
      void work.then(() => settled.add(work), () => settled.add(work))
    }
    return normalized
  }

  return () => {
    // Unlike app._instance, the renderer's root VNode exists in production and
    // for functional roots. Absence must never look like an empty, finished tree.
    const container = object(app._container, 'missing mounted renderer container')
    const root = field(container, '_vnode')
    if (!isVNode(root)) incompatible('missing mounted root VNode')
    const queue: unknown[] = [root]
    const visited = new Set<VNode>()
    const pending = new Set<Promise<unknown>>()
    while (queue.length) {
      const next = queue.pop()
      if (Array.isArray(next)) {
        for (const child of next) queue.push(child)
        continue
      }
      if (!isVNode(next)) incompatible('invalid mounted VNode')
      const node = next as VNode
      if (visited.has(node)) continue
      visited.add(node)
      const shape = object(node, 'VNode')
      if (typeof field(shape, 'shapeFlag') !== 'number') incompatible('VNode shapeFlag')
      const component = field(shape, 'component')
      const suspense = field(shape, 'suspense')
      // Vue 3.5 ShapeFlags: FUNCTIONAL_COMPONENT | STATEFUL_COMPONENT, SUSPENSE.
      if ((node.shapeFlag & 6) && !component) incompatible('missing mounted component')
      if ((node.shapeFlag & 128) && !suspense) incompatible('missing mounted Suspense boundary')
      if (component) {
        const instance = object(component, 'component instance')
        const asyncDep = field(instance, 'asyncDep')
        const setupWork = asyncDep === null ? undefined : promise(asyncDep, 'component asyncDep')
        if (setupWork) pending.add(setupWork)
        const type = object(field(instance, 'type'), 'component type')
        let loading = false
        if ('__asyncLoader' in type) {
          if (typeof type.__asyncLoader !== 'function') incompatible('async component loader')
          if (!field(type, '__asyncResolved')) {
            loading = true
            let work = loaders.get(type)
            if (!work) {
              // Vue already started this mounted wrapper's cached loader. Read
              // it only once; traversing again must not restart a failed loader.
              work = promise((type.__asyncLoader as () => unknown)(), 'async component loader promise')
              loaders.set(type, work)
            }
            pending.add(work)
          }
        }
        const subTree = field(instance, 'subTree')
        if (subTree !== null) queue.push(subTree)
        else if ((!setupWork || settled.has(setupWork)) && !loading) {
          incompatible('missing mounted component subtree')
        }
      }
      if (suspense) {
        const boundary = object(suspense, 'Suspense boundary')
        for (const name of ['activeBranch', 'pendingBranch']) {
          const branch = field(boundary, name)
          if (branch !== null) queue.push(branch)
        }
      }
      // Component children are raw slot input and need not have been mounted.
      // Their rendered instances are reached through subTree instead.
      if (!component && !suspense && Array.isArray(node.children)) {
        for (const child of node.children) {
          if (child && typeof child === 'object') queue.push(child)
        }
      }
    }
    return [...pending]
  }
}
