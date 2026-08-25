import { describe, expect, it, vi } from 'vitest'
import { createSsrProductionTemplateStore } from './SsrProductionTemplateRuntime'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('production template store', () => {
  it('coalesces concurrent source loading and structural preparation', async () => {
    const loading = deferred<string>()
    const load = vi.fn(() => loading.promise)
    const prepare = vi.fn((source: string, mountSelector: string) => `${source}:${mountSelector}`)
    const store = createSsrProductionTemplateStore({ load, prepare })

    const requests = Array.from({ length: 20 }, () => store.prepare('/client/index.html', '#app'))
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    expect(prepare).not.toHaveBeenCalled()

    loading.resolve('template')
    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 20 }, () => 'template:#app')
    )
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('shares one source while isolating structural mount options', async () => {
    const load = vi.fn(async () => 'template')
    const prepare = vi.fn((source: string, mountSelector: string) => `${source}:${mountSelector}`)
    const store = createSsrProductionTemplateStore({ load, prepare })

    await expect(
      Promise.all([
        store.prepare('/client/index.html', '#app'),
        store.prepare('/client/index.html', '#admin'),
      ])
    ).resolves.toEqual(['template:#app', 'template:#admin'])
    expect(load).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('loads different template identities independently', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const load = vi.fn((templatePath: string) =>
      templatePath.endsWith('site.html') ? first.promise : second.promise
    )
    const store = createSsrProductionTemplateStore({
      load,
      prepare: (source, mountSelector) => `${source}:${mountSelector}`,
    })

    const site = store.prepare('/client/site.html', '#app')
    const admin = store.prepare('/client/admin.html', '#admin')
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)

    second.resolve('admin')
    await expect(admin).resolves.toBe('admin:#admin')
    first.resolve('site')
    await expect(site).resolves.toBe('site:#app')
  })

  it('evicts failed in-flight loads so later requests retry', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce('template')
    const store = createSsrProductionTemplateStore({
      load,
      prepare: (source, mountSelector) => `${source}:${mountSelector}`,
    })

    await expect(store.prepare('/client/index.html', '#app')).rejects.toThrow(
      'temporarily unavailable'
    )
    await expect(store.prepare('/client/index.html', '#app')).resolves.toBe('template:#app')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not share entries between managed-server store instances', async () => {
    const load = vi.fn(async () => 'template')
    const options = {
      load,
      prepare: (source: string, mountSelector: string) => `${source}:${mountSelector}`,
    }
    const serverA = createSsrProductionTemplateStore(options)
    const serverB = createSsrProductionTemplateStore(options)

    await serverA.prepare('/client/index.html', '#app')
    await serverB.prepare('/client/index.html', '#app')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
