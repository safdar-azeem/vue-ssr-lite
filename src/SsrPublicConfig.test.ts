import { describe, expect, expectTypeOf, it } from 'vitest'
import { createTestDomain } from './SsrTestFixtures'
import type { SsrPublicConfigRequest } from './SsrRuntimeTypes'
import {
  assertPublicConfigSerializable,
  resolvePublicConfigValue,
} from './SsrPublicConfig'

const request = (): SsrPublicConfigRequest =>
  Object.freeze({
    requestId: 'public-config-request',
    url: 'https://tenant.test/checkout?preview=1',
    host: 'tenant.test',
    protocol: 'https',
    method: 'GET',
    headers: Object.freeze({ 'accept-language': 'en' }),
    cookie: 'locale=en',
    signal: new AbortController().signal,
    domain: Object.freeze(createTestDomain('tenant.test')),
    pathname: '/checkout',
    search: '?preview=1',
    entryId: 'storefront',
  })

describe('publicConfig serialization', () => {
  it('publishes deeply readonly header arrays and domain parameters', () => {
    expectTypeOf<SsrPublicConfigRequest['headers']>().toEqualTypeOf<
      Readonly<Record<string, string | readonly string[] | undefined>>
    >()
    expectTypeOf<SsrPublicConfigRequest['domain']['params']>().toEqualTypeOf<
      Readonly<Record<string, string>>
    >()
  })

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

  it('passes the complete request descriptor to a factory exactly once', async () => {
    const input = request()
    let received: SsrPublicConfigRequest | undefined
    let invocations = 0
    const resolved = await resolvePublicConfigValue((current) => {
      invocations += 1
      received = current
      return {
        requestId: current.requestId,
        host: current.host,
        pathname: current.pathname,
        locale: current.headers['accept-language'],
        tenant: current.domain.hostname,
      }
    }, input)

    expect(invocations).toBe(1)
    expect(received).toBe(input)
    expect(resolved).toEqual({
      requestId: 'public-config-request',
      host: 'tenant.test',
      pathname: '/checkout',
      locale: 'en',
      tenant: 'tenant.test',
    })
  })

  it('preserves zero-argument factories and static configuration', async () => {
    const legacy = await resolvePublicConfigValue(() => ({ version: 'old-style' }), request())
    const staticSource = { api: { url: 'https://api.test' } }
    const staticValue = await resolvePublicConfigValue(staticSource, request())

    expect(legacy).toEqual({ version: 'old-style' })
    expect(staticValue).toEqual(staticSource)
  })

  it('creates a deep request-owned frozen snapshot for objects and arrays', async () => {
    const source = {
      nested: { enabled: true },
      values: [{ id: 1 }, { id: 2 }],
    }
    const first = await resolvePublicConfigValue(source, request())
    const second = await resolvePublicConfigValue(source, request())

    expect(first).not.toBe(source)
    expect(first).not.toBe(second)
    expect(first.nested).not.toBe(source.nested)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.nested)).toBe(true)
    expect(Object.isFrozen(first.values)).toBe(true)
    expect(Object.isFrozen((first.values as Array<unknown>)[0])).toBe(true)
    expect(() => {
      ;(first.nested as { enabled: boolean }).enabled = false
    }).toThrow(TypeError)

    source.nested.enabled = false
    source.values[0].id = 99
    expect(first).toEqual({
      nested: { enabled: true },
      values: [{ id: 1 }, { id: 2 }],
    })
    expect(second).toEqual(first)
  })

  it('freezes a factory snapshot and retains script-hostile JSON values as data', async () => {
    const hostile = await resolvePublicConfigValue(
      () => ({
        payload: '</script><script>alert(1)</script>\u2028\u2029',
        nested: { enabled: true },
        list: [{ label: 'safe' }],
      }),
      request()
    )
    expect(Object.isFrozen(hostile)).toBe(true)
    expect(Object.isFrozen(hostile.nested)).toBe(true)
    expect(Object.isFrozen(hostile.list)).toBe(true)
    expect(Object.isFrozen((hostile.list as Array<unknown>)[0])).toBe(true)
    expect(hostile.payload).toContain('</script>')
  })

  it.each([
    [{ value: () => 1 }, 'function'],
    [{ value: Symbol('x') }, 'symbol'],
    [{ value: 1n }, 'bigint'],
    [{ value: new Date() }, 'non-serializable'],
  ])('keeps rejecting invalid request-aware output %s', async (value, message) => {
    await expect(
      resolvePublicConfigValue(() => value as Record<string, unknown>, request())
    ).rejects.toThrow(message)
  })

  it('rejects circular request-aware factory output', async () => {
    const value: Record<string, unknown> = {}
    value.self = value
    await expect(resolvePublicConfigValue(() => value, request())).rejects.toThrow('circular')
  })

  it.each([
    [{ nested: { value: undefined } }, 'undefined'],
    [{ values: [undefined] }, 'undefined'],
    [{ value: Number.NaN }, 'non-finite number'],
    [{ value: Number.POSITIVE_INFINITY }, 'non-finite number'],
    [{ value: Number.NEGATIVE_INFINITY }, 'non-finite number'],
  ])('rejects lossy JSON value %#', async (value, message) => {
    await expect(
      resolvePublicConfigValue(() => value, request())
    ).rejects.toThrow(message)
  })

  it('rejects sparse arrays', async () => {
    const values = new Array(2)
    values[1] = 'present'
    await expect(
      resolvePublicConfigValue(() => ({ values }), request())
    ).rejects.toThrow('sparse array slot at index 0')
  })

  it.each([undefined, null, [], 'public'])('rejects non-object factory output %#', async (value) => {
    await expect(
      resolvePublicConfigValue(() => value as never, request())
    ).rejects.toThrow(/undefined|plain object/)
  })

  it('normalizes negative zero before SSR and serialization', async () => {
    const resolved = await resolvePublicConfigValue(
      () => ({ value: -0, values: [-0] }),
      request()
    )

    expect(resolved).toEqual({ value: 0, values: [0] })
    expect(Object.is(resolved.value, -0)).toBe(false)
    expect(Object.is((resolved.values as number[])[0], -0)).toBe(false)
  })
})
