import { describe, expect, it } from 'vitest'
import { createManagedHeadController } from '../../SsrManagedHead'
import { defineExtension } from './defineExtension'
import {
  createExtensionRuntime,
  resolveExtensions,
} from './ExtensionRuntime'

const options = () => ({
  applicationId: 'app',
  server: true,
  production: false,
  getRoute: () => null,
  getSiteOrigin: () => 'https://ex.com',
  getResponseStatus: () => 200,
  managedHead: createManagedHeadController(true),
})

describe('extension runtime', () => {
  it('rejects duplicate names in every environment', () => {
    const extension = defineExtension({ name: 'dup' })
    expect(() => resolveExtensions([extension], [extension])).toThrow(
      /Duplicate extension "dup"/
    )
  })

  it('creates isolated state per runtime instance', () => {
    const definition = defineExtension({
      name: 'analytics',
      createState: () => ({ trackId: Math.random() }),
    })
    const left = createExtensionRuntime([definition], [], options())
    const right = createExtensionRuntime([definition], [], options())
    left.setup()
    right.setup()
    expect(left.getState('analytics')).not.toBe(right.getState('analytics'))
  })

  it('runs built-ins before custom extensions and wraps setup errors', () => {
    const order: string[] = []
    const builtIn = defineExtension({
      name: 'seo',
      setup() {
        order.push('seo')
      },
    })
    const custom = defineExtension({
      name: 'company',
      setup() {
        order.push('company')
        throw new Error('boom')
      },
    })
    const runtime = createExtensionRuntime([builtIn], [custom], options())
    expect(() => runtime.setup()).toThrow(
      /Extension "company" failed during setup/
    )
    expect(order).toEqual(['seo', 'company'])
  })

  it('runs cleanup on dispose', () => {
    let cleaned = 0
    const runtime = createExtensionRuntime(
      [
        defineExtension({
          name: 'temp',
          setup() {
            return () => {
              cleaned += 1
            }
          },
        }),
      ],
      [],
      options()
    )
    runtime.setup()
    runtime.dispose()
    expect(cleaned).toBe(1)
  })
})
