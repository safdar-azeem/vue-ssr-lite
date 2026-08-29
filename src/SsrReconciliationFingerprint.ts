import { toRaw } from 'vue'

const normalizeReconciliationCheckpoint = (
  value: unknown,
  graph: { seen: WeakMap<object, number>; nextId: number },
  unwrap: (value: unknown) => unknown
): unknown => {
  if (value === null) return ['null']
  if (value === undefined) return ['undefined']
  if (typeof value === 'string') return ['string', value]
  if (typeof value === 'boolean') return ['boolean', value]
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return ['number', 'NaN']
    if (value === Infinity) return ['number', 'Infinity']
    if (value === -Infinity) return ['number', '-Infinity']
    if (Object.is(value, -0)) return ['number', '-0']
    return ['number', value]
  }
  if (typeof value === 'bigint') return ['bigint', String(value)]
  if (typeof value === 'symbol') return ['symbol', String(value)]
  if (typeof value === 'function') return ['function', String(value)]

  const raw = toRaw(unwrap(value) as object)
  const existingId = graph.seen.get(raw)
  if (existingId !== undefined) return ['reference', existingId]
  const id = graph.nextId
  graph.nextId += 1
  graph.seen.set(raw, id)
  if (raw instanceof Date) return ['date', id, raw.toISOString()]
  if (raw instanceof RegExp) return ['regexp', id, raw.source, raw.flags]
  if (raw instanceof Map) {
    return [
      'map',
      id,
      [...raw].map(([key, entry]) => [
        normalizeReconciliationCheckpoint(key, graph, unwrap),
        normalizeReconciliationCheckpoint(entry, graph, unwrap),
      ]),
    ]
  }
  if (raw instanceof Set) {
    return [
      'set',
      id,
      [...raw].map((entry) =>
        normalizeReconciliationCheckpoint(entry, graph, unwrap)
      ),
    ]
  }
  if (Array.isArray(raw)) {
    return [
      'array',
      id,
      Array.from({ length: raw.length }, (_, index) =>
        Object.hasOwn(raw, index)
          ? normalizeReconciliationCheckpoint(raw[index], graph, unwrap)
          : ['hole']
      ),
    ]
  }
  return [
    'object',
    id,
    Object.keys(raw).map((key) => [
      key,
      normalizeReconciliationCheckpoint(
        (raw as Record<string, unknown>)[key],
        graph,
        unwrap
      ),
    ]),
  ]
}

/**
 * Semantic graph identity for reconciliation consequences and observed values.
 * Deterministic IDs preserve alias/cycle topology; Map/Set traversal order is
 * retained because it can affect emitted HTML.
 */
export const fingerprintSsrReconciliationState = (
  value: unknown,
  unwrap: (value: unknown) => unknown = (entry) => entry
): string =>
  JSON.stringify(
    normalizeReconciliationCheckpoint(
      value,
      { seen: new WeakMap(), nextId: 0 },
      unwrap
    )
  )
