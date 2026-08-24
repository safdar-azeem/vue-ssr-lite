import { describe, expect, it } from 'vitest'
import { assertPublicConfigSerializable } from './SsrPublicConfig'

describe('publicConfig serialization', () => {
  it('accepts plain JSON values', () => {
    expect(
      assertPublicConfigSerializable({
        apiUrl: 'https://api.example.com',
        flags: { dark: true },
      })
    ).toEqual({
      apiUrl: 'https://api.example.com',
      flags: { dark: true },
    })
  })

  it.each([
    [{ fn: () => 1 }, 'function'],
    [{ mark: Symbol('x') }, 'symbol'],
  ])('rejects %s', (value, kind) => {
    expect(() => assertPublicConfigSerializable(value)).toThrow(kind)
  })

  it('rejects circular references', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => assertPublicConfigSerializable(value)).toThrow('circular')
  })

  it('accepts the same object referenced from multiple branches', () => {
    const shared = { enabled: true }
    expect(
      assertPublicConfigSerializable({
        a: shared,
        b: shared,
      })
    ).toEqual({
      a: { enabled: true },
      b: { enabled: true },
    })
  })

  it('still rejects a genuine recursive cycle after shared references', () => {
    const shared = { enabled: true }
    const cycle: Record<string, unknown> = { shared }
    cycle.self = cycle
    expect(() => assertPublicConfigSerializable(cycle)).toThrow('circular')
  })
})
