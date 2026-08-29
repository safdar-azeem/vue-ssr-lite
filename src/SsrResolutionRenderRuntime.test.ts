import { describe, expect, it } from 'vitest'
import { defineComponent, h, inject, onServerPrefetch, ref, useSSRContext } from 'vue'
import { createTestApplication } from './SsrTestFixtures'
import { SSR_REQUEST_RESOLUTION } from './SsrRequestResolution'
import { ssrWatch, ssrWatchEffect } from './SsrReactivityRuntime'
import { useSsrRequestContext } from './SsrRequestContext'
import { renderSsrApplication } from './SsrRenderRuntime'
import { createTestRenderRequest } from './SsrTestFixtures'
import { useSeo } from './index'

const baseRequest = (host = 'app.test') => createTestRenderRequest(host)

/** A generic async store that resolves work OUTSIDE any component prefetch. */
const createDeferredStore = (loadDelayMs: number) => {
  const state = { loaded: false, value: 'DATA' }
  return {
    state,
    load: () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          state.loaded = true
          resolve()
        }, loadDelayMs)
      ),
  }
}

describe('renderSsrApplication resolution passes', () => {
  it('completes a fully resolvable page in a single pass', async () => {
    const application = createTestApplication({
      id: 'one-pass',
      root: defineComponent({
        setup: () => () => h('main', 'ready'),
      }),
    })
    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.metrics.renderPasses).toBe(1)
    expect(rendered.html).toContain('ready')
  })

  it('re-renders when a plugin resolves work after the first pass', async () => {
    const store = createDeferredStore(5)
    const application = createTestApplication({
      id: 'resolve-later',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (resolution.server && !store.state.loaded) {
            resolution.track(store.load())
            resolution.requestAdditionalPass()
          }
          return () => h('main', store.state.loaded ? store.state.value : 'LOADING')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(rendered.html).toContain('DATA')
    expect(rendered.html).not.toContain('LOADING')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('awaits non-render work on the last allowed pass without a false pass-limit diagnostic', async () => {
    let completed = false
    let renders = 0
    const warnings: string[] = []
    const application = createTestApplication({
      id: 'await-without-rerender',
      root: defineComponent({
        setup() {
          renders += 1
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (!completed) {
            resolution.track(
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  completed = true
                  resolve()
                }, 5)
              )
            )
          }
          return () => h('main', 'stable')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      maxResolutionPasses: 1,
      resolutionDeadlineMs: 1_000,
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(completed).toBe(true)
    expect(renders).toBe(1)
    expect(rendered.metrics.renderPasses).toBe(1)
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('reports track-only resolution that exceeds its deadline without rerendering', async () => {
    const warnings: string[] = []
    let renders = 0
    const application = createTestApplication({
      id: 'resolution-deadline',
      root: defineComponent({
        setup() {
          renders += 1
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          resolution.track(new Promise<void>(() => {}))
          return () => h('main', 'latest render')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 5,
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(rendered.html).toContain('latest render')
    expect(rendered.metrics.renderPasses).toBe(1)
    expect(renders).toBe(1)
    expect(warnings).toContain('ssr.diagnostic.resolution-deadline')
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('freezes the accepted response snapshot before timed-out work completes', async () => {
    type DeadlineState = { phase: string }
    let releaseLateWork: () => void = () => undefined
    let lateWorkCompleted = false
    const application = createTestApplication<DeadlineState>({
      id: 'resolution-deadline-snapshot',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const context = useSsrRequestContext<DeadlineState>()
          useSeo({ title: () => context.state.phase })
          return () => h('main', context.state.phase)
        },
      }),
      install({ context, hydration, resolution }) {
        hydration.contribute('late-state', () => context.state)
        resolution.track(
          new Promise<void>((resolve) => {
            releaseLateWork = () => {
              context.state.phase = 'late-ready'
              context.response.statusCode = 404
              lateWorkCompleted = true
              resolve()
            }
          })
        )
      },
      cleanup() {
        // The renderer has selected its deadline fallback before cleanup. This
        // resolves the timed-out work while the request is still unwinding.
        releaseLateWork()
      },
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1,
      logger: { warn: () => undefined },
    })
    expect(lateWorkCompleted).toBe(true)
    expect(rendered.html).toContain('loading')
    expect(rendered.hydrationState.application.phase).toBe('loading')
    expect(
      (rendered.hydrationState.plugins?.['late-state'] as DeadlineState).phase
    ).toBe('loading')
    expect(rendered.head.title).toBe('loading')
    expect(rendered.response.statusCode).toBe(200)
    expect(rendered.metrics.renderPasses).toBe(1)
  })

  it('honours invalidation requested asynchronously while draining', async () => {
    let loaded = false
    const application = createTestApplication({
      id: 'async-invalidation',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (!loaded) {
            resolution.track(
              new Promise<void>((resolve) => setTimeout(resolve, 5)).then(() => {
                loaded = true
                resolution.requestAdditionalPass()
              })
            )
          }
          return () => h('main', loaded ? 'resolved' : 'loading')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(rendered.html).toContain('resolved')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('coalesces multiple work items registered by one pass into one rerender', async () => {
    const completed = new Set<number>()
    const observedAtRender: number[] = []
    const application = createTestApplication({
      id: 'coalesced-resolution',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          observedAtRender.push(completed.size)
          if (completed.size === 0) {
            for (const [index, delay] of [8, 2, 5].entries()) {
              resolution.track(
                new Promise<void>((resolve) =>
                  setTimeout(() => {
                    completed.add(index)
                    resolve()
                  }, delay)
                )
              )
            }
            resolution.requestAdditionalPass()
          }
          return () => h('main', `resolved:${completed.size}`)
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(observedAtRender).toEqual([0, 3])
    expect(rendered.html).toContain('resolved:3')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('preserves chained resolution discovered by successive passes', async () => {
    let stage = 0
    const application = createTestApplication({
      id: 'chained-resolution',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (stage < 2) {
            const nextStage = stage + 1
            resolution.track(
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  stage = nextStage
                  resolve()
                }, 2)
              )
            )
            resolution.requestAdditionalPass()
          }
          return () => h('main', `stage:${stage}`)
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(rendered.html).toContain('stage:2')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('does not begin another render when cancellation interrupts resolution', async () => {
    let renders = 0
    const abort = new AbortController()
    const cancellation = new Error('request cancelled')
    const application = createTestApplication({
      id: 'cancel-resolution',
      root: defineComponent({
        setup() {
          renders += 1
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          resolution.track(new Promise<void>(() => {}))
          resolution.requestAdditionalPass()
          return () => h('main', 'waiting')
        },
      }),
    })
    const rendering = renderSsrApplication(
      application,
      createTestRenderRequest('cancel.test', { signal: abort.signal }),
      { resolutionDeadlineMs: 0 }
    )
    setTimeout(() => abort.abort(cancellation), 5)

    await expect(rendering).rejects.toBe(cancellation)
    expect(renders).toBe(1)
  })

  it('returns modules from only the final accepted render pass', async () => {
    const store = createDeferredStore(5)
    const application = createTestApplication({
      id: 'final-assets',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const ssrContext = useSSRContext<{ modules?: Set<string> }>()
          if (!store.state.loaded) {
            ssrContext.modules ??= new Set()
            ssrContext.modules.add('src/Discarded.vue')
            resolution.track(store.load())
            resolution.requestAdditionalPass()
          } else {
            ssrContext.modules ??= new Set()
            ssrContext.modules.add('src/Final.vue')
          }
          return () => h('main', store.state.loaded ? 'final' : 'discarded')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(rendered.renderedModules).toEqual(['src/Final.vue'])
  })

  it('is bounded: never exceeds maxResolutionPasses when work never settles', async () => {
    const application = createTestApplication({
      id: 'never-settles',
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          if (resolution.server) {
            resolution.track(new Promise<void>((r) => setTimeout(r, 1)))
            resolution.requestAdditionalPass()
          }
          return () => h('main', 'still-loading')
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      maxResolutionPasses: 2,
      resolutionDeadlineMs: 50,
    })
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(rendered.html).toContain('still-loading')
  })
})

describe('ssrWatch under server render', () => {
  it('is active during SSR: reacts to state settled in onServerPrefetch', async () => {
    const application = createTestApplication({
      id: 'ssr-watch',
      root: defineComponent({
        setup() {
          const source = ref(0)
          const captured = ref('initial')
          ssrWatch(source, (value) => {
            captured.value = `watched:${value}`
          })
          onServerPrefetch(async () => {
            source.value = 42
          })
          return () => h('main', captured.value)
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('watched:42')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('reconciles state consumed before an ordinary unkeyed watcher in two passes', async () => {
    type WatchState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<WatchState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Child = defineComponent({
      setup() {
        const context = useSsrRequestContext<WatchState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase = 'ready'
        })
        onServerPrefetch(async () => {
          source.value = 1
        })
        return () => h('span')
      },
    })
    const application = createTestApplication<WatchState>({
      id: 'stable-unkeyed-child-watch',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Child)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('ready')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('reconciles state before a keyed watcher with non-exact props in two passes', async () => {
    type WatchState = { phase: string }
    const callback = () => undefined
    const config = new Map([['mode', 'ready']])
    const Worker = defineComponent({
      props: {
        callback: { type: Function, required: true },
        config: { type: Map, required: true },
      },
      setup() {
        const context = useSsrRequestContext<WatchState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase = 'ready'
        })
        onServerPrefetch(async () => {
          source.value = 1
        })
        return () => h('span')
      },
    })
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<WatchState>()
        return () => h('strong', context.state.phase)
      },
    })
    const application = createTestApplication<WatchState>({
      id: 'stable-non-exact-props-watch',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [
            h(Consumer),
            h(Worker, { key: 'worker', callback, config }),
          ]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('ready')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('allows a distinct watcher discovered on pass two to request pass three', async () => {
    type WatchState = { first: string; second: string }

    const FirstWatcher = defineComponent({
      setup() {
        const context = useSsrRequestContext<WatchState>()
        const source = ref('first-loading')
        ssrWatch(source, (value) => {
          context.state.first = value
        })
        onServerPrefetch(async () => {
          source.value = 'first-ready'
        })
        return () => h('span', context.state.first)
      },
    })

    const SecondWatcher = defineComponent({
      setup() {
        const context = useSsrRequestContext<WatchState>()
        const carried = context.hydration.read<string>('second-watcher')
        const source = ref(carried ?? 'second-loading')
        ssrWatch(
          source,
          (value) => {
            context.state.second = value
          },
          { immediate: true }
        )
        if (!carried) {
          onServerPrefetch(async () => {
            source.value = 'second-ready'
          })
        }
        context.hydration.contribute('second-watcher', () => source.value)
        return () => h('span', { class: 'loader' })
      },
    })

    const SecondConsumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<WatchState>()
        return () => h('strong', `second:${context.state.second}`)
      },
    })

    const application = createTestApplication<WatchState>({
      id: 'chained-ssr-watch',
      createInitialState: () => ({
        first: 'first-loading',
        second: 'second-loading',
      }),
      install({ context, hydration }) {
        const second = hydration.read<string>('second-watcher')
        if (second) context.state.second = second
      },
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h('main', [
              h(FirstWatcher, { key: 'first' }),
              ...(resolution.pass > 0
                ? [
                    h(SecondConsumer, { key: 'consumer' }),
                    h(SecondWatcher, { key: 'second' }),
                  ]
                : []),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      resolutionDeadlineMs: 1_000,
    })
    expect(rendered.html).toContain('second:second-ready')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('does not let an unkeyed instance inherit a removed sibling transition', async () => {
    type MembershipState = { settled: string }
    const registrations = new Map<number, number>()

    const Item = defineComponent({
      setup() {
        const context = useSsrRequestContext<MembershipState>()
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const ordinal = registrations.get(resolution.pass) ?? 0
        registrations.set(resolution.pass, ordinal + 1)
        const source = ref(0)
        ssrWatch(source, () => {
          if (resolution.pass === 0 && ordinal === 0) {
            context.state.settled = 'item-a'
          }
          if (resolution.pass === 1 && ordinal === 0) {
            context.state.settled = 'item-b'
          }
        })
        if (resolution.pass < 2 && ordinal === 0) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })

    const application = createTestApplication<MembershipState>({
      id: 'unkeyed-watchers',
      createInitialState: () => ({ settled: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<MembershipState>()
          return () =>
            h('main', [
              h('strong', context.state.settled),
              ...Array.from(
                { length: resolution.pass === 0 ? 2 : 1 },
                () => h(Item)
              ),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('item-b')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('keeps collision-prone Map transitions eligible for reconciliation', async () => {
    type MapState = { settled: string }
    const application = createTestApplication<MapState>({
      id: 'map-watch-transition',
      createInitialState: () => ({ settled: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<MapState>()
          const source = ref(new Map([['phase', 0]]))
          ssrWatch(source, (value) => {
            context.state.settled = `phase:${value.get('phase')}`
          })
          if (resolution.pass < 2) {
            onServerPrefetch(async () => {
              source.value = new Map([['phase', resolution.pass + 1]])
            })
          }
          return () => h('main', context.state.settled)
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('phase:2')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('does not deduplicate a keyed watcher when its props are uncertain', async () => {
    type PropState = { settled: string }

    const Worker = defineComponent({
      props: {
        config: { type: Map, required: true },
      },
      setup(props) {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<PropState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.settled = String(props.config.get('mode'))
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })

    const application = createTestApplication<PropState>({
      id: 'uncertain-keyed-props',
      createInitialState: () => ({ settled: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<PropState>()
          return () =>
            h('main', [
              h('strong', context.state.settled),
              h(Worker, {
                key: 'worker',
                config: new Map([
                  ['mode', resolution.pass === 0 ? 'mode-a' : 'mode-b'],
                ]),
              }),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('mode-b')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('honours a new consequence from the same exact watcher transition', async () => {
    type ExactState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<ExactState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<ExactState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase =
            resolution.pass === 0 ? 'first-ready' : 'second-ready'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<ExactState>({
      id: 'exact-watch-new-consequence',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [h(Consumer), h(Producer, { key: 'producer' })]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('second-ready')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('does not suppress a cyclic exact watcher consequence from an older generation', async () => {
    type CyclicState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<CyclicState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<CyclicState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase =
            resolution.pass % 2 === 0 ? 'state-a' : 'state-b'
        })
        if (resolution.pass < 3) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<CyclicState>({
      id: 'cyclic-exact-watch-consequence',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [h(Consumer), h(Producer, { key: 'producer' })]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(4)
  })

  it('does not suppress a cyclic ambiguous watcher consequence', async () => {
    type CyclicState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<CyclicState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<CyclicState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase =
            resolution.pass % 2 === 0 ? 'state-a' : 'state-b'
        })
        if (resolution.pass < 3) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<CyclicState>({
      id: 'cyclic-ambiguous-watch-consequence',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Producer)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(4)
  })

  it('preserves ordered consequences for indistinguishable unkeyed watchers', async () => {
    type OrderedState = { phase: string }
    const registrations = new Map<number, number>()
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<OrderedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Item = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<OrderedState>()
        const ordinal = registrations.get(resolution.pass) ?? 0
        registrations.set(resolution.pass, ordinal + 1)
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase =
            resolution.pass === 0
              ? ordinal === 0
                ? 'state-a'
                : 'state-b'
              : ordinal === 0
                ? 'state-b'
                : 'state-a'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<OrderedState>({
      id: 'ordered-ambiguous-watch-consequences',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Item), h(Item)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('reconciles a shorter exact watcher generation that changes rendered state', async () => {
    type PrefixState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<PrefixState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<PrefixState>()
        const source = ref(0)
        ssrWatch(source, (value) => {
          context.state.phase = value === 1 ? 'state-a' : 'state-b'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
            if (resolution.pass === 0) source.value = 2
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<PrefixState>({
      id: 'shorter-exact-watch-generation',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [h(Consumer), h(Producer, { key: 'producer' })]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('reconciles reversed consequences from independently exact watchers', async () => {
    type OrderedState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<OrderedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<OrderedState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phase = phase
          })
          if (resolution.pass < 2) {
            onServerPrefetch(async () => {
              source.value = 1
            })
          }
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<OrderedState>({
      id: 'reordered-exact-watch-consequences',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h('main', [
              h(Consumer),
              ...(resolution.pass === 0
                ? [h(ProducerA, { key: 'a' }), h(ProducerB, { key: 'b' })]
                : [h(ProducerB, { key: 'b' }), h(ProducerA, { key: 'a' })]),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('allows reordered exact watcher consequences with unchanged terminal state', async () => {
    type OrderedState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<OrderedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<OrderedState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase = 'ready'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<OrderedState>({
      id: 'commuting-reordered-exact-watch-consequences',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h('main', [
              h(Consumer),
              ...(resolution.pass === 0
                ? [h(Producer, { key: 'a' }), h(Producer, { key: 'b' })]
                : [h(Producer, { key: 'b' }), h(Producer, { key: 'a' })]),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('ready')
    expect(rendered.hydrationState.application.phase).toBe('ready')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('converges a moved Consumer when accepted HTML observes settled state', async () => {
    type OrderedState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<OrderedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<OrderedState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phase = phase
          })
          if (resolution.pass < 2) {
            onServerPrefetch(async () => {
              source.value = 1
            })
          }
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<OrderedState>({
      id: 'moved-consumer-identical-callback-order',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h(
              'main',
              resolution.pass === 0
                ? [
                    h(Consumer),
                    h(ProducerA, { key: 'a' }),
                    h(ProducerB, { key: 'b' }),
                  ]
                : [
                    h(ProducerA, { key: 'a' }),
                    h(Consumer),
                    h(ProducerB, { key: 'b' }),
                  ]
            )
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-b')
    expect(rendered.html).not.toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-b')
    // Vue accepts terminal state-b on pass two; dependency comparison proves
    // that no intermediate state-a text reached this rendered HTML.
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('converges recurring transient callbacks when only the stable state is observed', async () => {
    type ReplayState = { phase: string }
    const warnings: string[] = []
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<ReplayState>()
        return () => h('strong', context.state.phase)
      },
    })
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const context = useSsrRequestContext<ReplayState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phase = phase
          })
          onServerPrefetch(async () => {
            source.value = 1
          })
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<ReplayState>({
      id: 'recurring-static-producer-replay',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [
            h(Consumer),
            h(ProducerA, { key: 'a' }),
            h(ProducerB, { key: 'b' }),
          ]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(rendered.html).toContain('state-b')
    expect(rendered.html).not.toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-b')
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('converges recurring producers before a consumer at semantic stable state', async () => {
    type ReplayState = { phase: string }
    const warnings: string[] = []
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<ReplayState>()
        return () => h('strong', context.state.phase)
      },
    })
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const context = useSsrRequestContext<ReplayState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phase = phase
          })
          onServerPrefetch(async () => {
            source.value = 1
          })
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<ReplayState>({
      id: 'recurring-producers-before-consumer',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [
            h(ProducerA, { key: 'a' }),
            h(ProducerB, { key: 'b' }),
            h(Consumer),
          ]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(rendered.html).toContain('state-b')
    expect(rendered.html).not.toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-b')
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('ignores unrelated stable reads between recurring transient callbacks', async () => {
    type DependencyState = { phase: string; title: string }
    const warnings: string[] = []
    const PhaseConsumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<DependencyState>()
        return () => h('strong', `phase:${context.state.phase}`)
      },
    })
    const TitleConsumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<DependencyState>()
        return () => h('em', `title:${context.state.title}`)
      },
    })
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const context = useSsrRequestContext<DependencyState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phase = phase
          })
          onServerPrefetch(async () => {
            source.value = 1
          })
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<DependencyState>({
      id: 'unrelated-read-during-recurring-replay',
      createInitialState: () => ({ phase: 'loading', title: 'constant' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [
            h(PhaseConsumer),
            h(ProducerA, { key: 'a' }),
            h(TitleConsumer),
            h(ProducerB, { key: 'b' }),
          ]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(rendered.html).toContain('phase:state-b')
    expect(rendered.html).toContain('title:constant')
    expect(rendered.html).not.toContain('phase:state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-b')
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('converges alias replay when accepted HTML observes the restored alias', async () => {
    type AliasValue = { label: string }
    type AliasState = {
      left: AliasValue
      right: AliasValue
      alternate: AliasValue
    }
    const warnings: string[] = []
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<AliasState>()
        return () =>
          h(
            'strong',
            context.state.left === context.state.right ? 'same' : 'different'
          )
      },
    })
    const createProducer = (mutate: (state: AliasState) => void) =>
      defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<AliasState>()
          const source = ref(0)
          ssrWatch(source, () => mutate(context.state))
          if (resolution.pass < 2) {
            onServerPrefetch(async () => {
              source.value = 1
            })
          }
          return () => h('i')
        },
      })
    const ProducerA = createProducer((state) => {
      state.left = state.alternate
    })
    const ProducerB = createProducer((state) => {
      state.left = state.right
    })
    const application = createTestApplication<AliasState>({
      id: 'transient-container-alias-topology',
      createInitialState: () => {
        const shared = { label: 'shared' }
        return {
          left: shared,
          right: shared,
          alternate: { label: 'alternate' },
        }
      },
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () => {
            const producerA = h(ProducerA, { key: 'a' })
            const producerB = h(ProducerB, { key: 'b' })
            return h(
              'main',
              resolution.pass === 1
                ? [producerA, h(Consumer), producerB]
                : [h(Consumer), producerA, producerB]
            )
          }
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(rendered.html).toContain('same')
    expect(rendered.html).not.toContain('different')
    expect(rendered.hydrationState.application.left).toBe(
      rendered.hydrationState.application.right
    )
    // The accepted HTML and hydration both observe the restored alias.
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('observes only entries yielded by a partial lazy Map iterator', async () => {
    type IteratorState = { items: Map<string, string> }
    const warnings: string[] = []
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<IteratorState>()
        return () =>
          h('strong', `first:${context.state.items.values().next().value}`)
      },
    })
    const createProducer = (value: string) =>
      defineComponent({
        setup() {
          const context = useSsrRequestContext<IteratorState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.items.set('second', value)
          })
          onServerPrefetch(async () => {
            source.value = 1
          })
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<IteratorState>({
      id: 'partial-map-iterator-observation',
      createInitialState: () => ({
        items: new Map([
          ['first', 'stable'],
          ['second', 'state-b'],
        ]),
      }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () => {
            const producerA = h(ProducerA, { key: 'a' })
            const producerB = h(ProducerB, { key: 'b' })
            return h(
              'main',
              resolution.pass === 0
                ? [h(Consumer), producerA, producerB]
                : [producerA, h(Consumer), producerB]
            )
          }
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(rendered.html).toContain('first:stable')
    expect(rendered.hydrationState.application.items.get('second')).toBe(
      'state-b'
    )
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('observes cached Map interiors across recurring replay callbacks', async () => {
    type MapReplayState = { phases: Map<string, string> }
    const warnings: string[] = []
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const context = useSsrRequestContext<MapReplayState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phases.set('current', phase)
          })
          onServerPrefetch(async () => {
            source.value = 1
          })
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<MapReplayState>({
      id: 'cached-map-interior-observation',
      createInitialState: () => ({
        phases: new Map([['current', 'state-b']]),
      }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<MapReplayState>()
          const phases = context.state.phases
          const Consumer = defineComponent({
            setup: () => () => h('strong', phases.get('current')),
          })
          return () => {
            const producers = [
              h(ProducerA, { key: 'a' }),
              h(ProducerB, { key: 'b' }),
            ]
            if (resolution.pass === 1) {
              return h('main', [producers[0], h(Consumer), producers[1]])
            }
            return h(
              'main',
              resolution.pass === 0
                ? [h(Consumer), ...producers]
                : [...producers, h(Consumer)]
            )
          }
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest(), {
      logger: { warn: (event) => warnings.push(event) },
    })
    expect(rendered.html).toContain('state-b')
    expect(rendered.html).not.toContain('state-a')
    expect(rendered.hydrationState.application.phases.get('current')).toBe(
      'state-b'
    )
    // The cached proxy reads terminal state-b in the accepted render.
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(warnings).not.toContain('ssr.diagnostic.resolution-pass-limit')
  })

  it('reconciles an ordinary mutation observed before a replay callback', async () => {
    type ReplayState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<ReplayState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const context = useSsrRequestContext<ReplayState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase = 'state-b'
        })
        onServerPrefetch(async () => {
          source.value = 1
        })
        return () => h('i')
      },
    })
    const application = createTestApplication<ReplayState>({
      id: 'ordinary-mutation-before-replay-observation',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<ReplayState>()
          if (resolution.pass === 1) context.state.phase = 'state-a'
          return () =>
            h('main', [h(Consumer), h(Producer, { key: 'producer' })])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-b')
    expect(rendered.html).not.toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-b')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('tracks Object.keys visibility between recurring callbacks', async () => {
    type StructuralState = { temporary?: boolean }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<StructuralState>()
        return () =>
          h(
            'strong',
            Object.keys(context.state).includes('temporary')
              ? 'temporary-present'
              : 'stable'
          )
      },
    })
    const createProducer = (mutate: (state: StructuralState) => void) =>
      defineComponent({
        setup() {
          const context = useSsrRequestContext<StructuralState>()
          const source = ref(0)
          ssrWatch(source, () => mutate(context.state))
          onServerPrefetch(async () => {
            source.value = 1
          })
          return () => h('i')
        },
      })
    const ProducerA = createProducer((state) => {
      state.temporary = true
    })
    const ProducerB = createProducer((state) => {
      delete state.temporary
    })
    const application = createTestApplication<StructuralState>({
      id: 'object-keys-between-recurring-callbacks',
      createInitialState: () => ({}),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h(
              'main',
              resolution.pass !== 1
                ? [
                    h(Consumer),
                    h(ProducerA, { key: 'a' }),
                    h(ProducerB, { key: 'b' }),
                  ]
                : [
                    h(ProducerA, { key: 'a' }),
                    h(Consumer),
                    h(ProducerB, { key: 'b' }),
                  ]
            )
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('stable')
    expect(rendered.html).not.toContain('temporary-present')
    expect(rendered.hydrationState.application).not.toHaveProperty('temporary')
    // The accepted render observes the terminal key set without `temporary`.
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('tracks request-state observation from a functional Consumer', async () => {
    type FunctionalState = { phase: string }
    const Consumer = () => {
      const context = useSsrRequestContext<FunctionalState>()
      return h('strong', context.state.phase)
    }
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<FunctionalState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phase = phase
          })
          if (resolution.pass < 2) {
            onServerPrefetch(async () => {
              source.value = 1
            })
          }
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<FunctionalState>({
      id: 'functional-consumer-observation',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h(
              'main',
              resolution.pass === 0
                ? [
                    h(Consumer),
                    h(ProducerA, { key: 'a' }),
                    h(ProducerB, { key: 'b' }),
                  ]
                : [
                    h(ProducerA, { key: 'a' }),
                    h(Consumer),
                    h(ProducerB, { key: 'b' }),
                  ]
            )
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-b')
    expect(rendered.hydrationState.application.phase).toBe('state-b')
    // Functional rendering already observes terminal state-b on pass two.
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('reconciles terminal-equal exact reordering observed between callbacks', async () => {
    type OrderedState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<OrderedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<OrderedState>()
          const source = ref(0)
          ssrWatch(source, () => {
            context.state.phase = phase
          })
          if (resolution.pass < 2) {
            onServerPrefetch(async () => {
              source.value = 1
            })
          }
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const ProducerFinal = createProducer('final')
    const application = createTestApplication<OrderedState>({
      id: 'terminal-equal-interleaved-exact-order',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h(
              'main',
              resolution.pass === 0
                ? [
                    h(Consumer),
                    h(ProducerA, { key: 'a' }),
                    h(ProducerB, { key: 'b' }),
                    h(ProducerFinal, { key: 'final' }),
                  ]
                : [
                    h(ProducerB, { key: 'b' }),
                    h(Consumer),
                    h(ProducerA, { key: 'a' }),
                    h(ProducerFinal, { key: 'final' }),
                  ]
            )
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('final')
    expect(rendered.html).not.toContain('state-b')
    expect(rendered.hydrationState.application.phase).toBe('final')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('reconciles ordering changes across exact and ambiguous callbacks', async () => {
    type OrderedState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<OrderedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const ExactProducer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<OrderedState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase = 'state-a'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const AmbiguousProducer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<OrderedState>()
        const source = ref(0)
        ssrWatch(source, () => {
          context.state.phase = 'state-b'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<OrderedState>({
      id: 'mixed-exact-ambiguous-order',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h('main', [
              h(Consumer),
              ...(resolution.pass === 0
                ? [
                    h(ExactProducer, { key: 'exact' }),
                    h(AmbiguousProducer),
                  ]
                : [
                    h(AmbiguousProducer),
                    h(ExactProducer, { key: 'exact' }),
                  ]),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('reconciles a shorter ambiguous watcher generation that changes rendered state', async () => {
    type PrefixState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<PrefixState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<PrefixState>()
        const source = ref(0)
        ssrWatch(source, (value) => {
          context.state.phase = value === 1 ? 'state-a' : 'state-b'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
            if (resolution.pass === 0) source.value = 2
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<PrefixState>({
      id: 'shorter-ambiguous-watch-generation',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Producer)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('tracks an ambiguous watcher consequence in request-local plugin state', async () => {
    const store = { phase: 'loading' }
    const Consumer = defineComponent({
      setup: () => () => h('strong', store.phase),
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const source = ref(0)
        ssrWatch(source, () => {
          store.phase =
            resolution.pass === 0 ? 'first-ready' : 'second-ready'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication({
      id: 'ambiguous-watch-plugin-state',
      install({ hydration }) {
        hydration.contribute('external-store', () => store)
      },
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Producer)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('second-ready')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('treats response changes as request-owned watcher consequences', async () => {
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext()
        const source = ref(0)
        ssrWatch(source, () => {
          context.response.statusCode = resolution.pass === 0 ? 201 : 202
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication({
      id: 'watch-response-consequence',
      root: defineComponent({
        setup: () => () => h('main', [h(Producer, { key: 'producer' })]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.response.statusCode).toBe(202)
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('snapshots reconciliation state before discarded-app cleanup', async () => {
    type LifecycleState = { phase: string }
    let initializations = 0
    const application = createTestApplication<LifecycleState>({
      id: 'reconciliation-state-ownership',
      createInitialState: () => {
        initializations += 1
        return { phase: 'loading' }
      },
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<LifecycleState>()
          if (resolution.pass === 0) {
            context.state.phase = 'render-ready'
            resolution.requestAdditionalPass()
          }
          return () => h('main', context.state.phase)
        },
      }),
      cleanup(context) {
        context.state.phase = 'cleanup-mutated'
      },
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('render-ready')
    expect(rendered.hydrationState.application.phase).toBe('render-ready')
    expect(rendered.metrics.renderPasses).toBe(2)
    expect(initializations).toBe(1)
  })
})

describe('ssrWatchEffect under server render', () => {
  it('coalesces an identical recreated trigger after one follow-up pass', async () => {
    const application = createTestApplication({
      id: 'ssr-watch-effect-stable',
      root: defineComponent({
        setup() {
          const source = ref(0)
          const captured = ref(0)
          ssrWatchEffect(() => {
            captured.value = source.value
          })
          onServerPrefetch(async () => {
            source.value = 1
          })
          return () => h('main', `effect:${captured.value}`)
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('effect:1')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('reconciles a consumer rendered before its producer in exactly two passes', async () => {
    type EffectState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<EffectState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const context = useSsrRequestContext<EffectState>()
        const source = ref(0)
        ssrWatchEffect(() => {
          if (source.value === 1) context.state.phase = 'ready'
        })
        onServerPrefetch(async () => {
          source.value = 1
        })
        return () => h('i')
      },
    })
    const application = createTestApplication<EffectState>({
      id: 'ssr-watch-effect-stale-sibling',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Producer)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('ready')
    expect(rendered.metrics.renderPasses).toBe(2)
  })

  it('allows the same effect source to reconcile a later distinct trigger', async () => {
    type EffectState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<EffectState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<EffectState>()
        const first = ref(0)
        const second = ref(10)
        ssrWatchEffect(() => {
          const value = resolution.pass === 0 ? first.value : second.value
          if (value === 1) context.state.phase = 'first-ready'
          if (value === 20) context.state.phase = 'second-ready'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            if (resolution.pass === 0) first.value = 1
            else second.value = 20
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<EffectState>({
      id: 'ssr-watch-effect-chained',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Producer)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('second-ready')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('reconciles a shorter exact effect generation that changes rendered state', async () => {
    type PrefixState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<PrefixState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<PrefixState>()
        const source = ref(0)
        ssrWatchEffect(() => {
          if (source.value === 1) context.state.phase = 'state-a'
          if (source.value === 2) context.state.phase = 'state-b'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
            if (resolution.pass === 0) source.value = 2
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<PrefixState>({
      id: 'shorter-exact-effect-generation',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [h(Consumer), h(Producer, { key: 'producer' })]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('reconciles reversed consequences from independently exact effects', async () => {
    type OrderedState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<OrderedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const createProducer = (phase: string) =>
      defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          const context = useSsrRequestContext<OrderedState>()
          const source = ref(0)
          ssrWatchEffect(() => {
            if (source.value === 1) context.state.phase = phase
          })
          if (resolution.pass < 2) {
            onServerPrefetch(async () => {
              source.value = 1
            })
          }
          return () => h('i')
        },
      })
    const ProducerA = createProducer('state-a')
    const ProducerB = createProducer('state-b')
    const application = createTestApplication<OrderedState>({
      id: 'reordered-exact-effect-consequences',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h('main', [
              h(Consumer),
              ...(resolution.pass === 0
                ? [h(ProducerA, { key: 'a' }), h(ProducerB, { key: 'b' })]
                : [h(ProducerB, { key: 'b' }), h(ProducerA, { key: 'a' })]),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('preserves mixed ambiguous watcher and effect consequence ordering', async () => {
    type MixedState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<MixedState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<MixedState>()
        const watchSource = ref(0)
        const effectSource = ref(0)
        ssrWatch(watchSource, () => {
          context.state.phase = 'state-a'
        })
        ssrWatchEffect(() => {
          if (effectSource.value === 1) context.state.phase = 'state-b'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            if (resolution.pass === 0) {
              watchSource.value = 1
              effectSource.value = 1
            } else {
              effectSource.value = 1
              watchSource.value = 1
            }
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<MixedState>({
      id: 'mixed-ambiguous-reactivity-order',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Producer)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('tracks same-count effect consequences in request-local plugin state', async () => {
    const store = { phase: 'loading' }
    const Consumer = defineComponent({
      setup: () => () => h('strong', store.phase),
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const first = ref(0)
        const second = ref(10)
        ssrWatchEffect(() => {
          const value = resolution.pass === 0 ? first.value : second.value
          if (value === 1) store.phase = 'first-ready'
          if (value === 20) store.phase = 'second-ready'
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            if (resolution.pass === 0) first.value = 1
            else second.value = 20
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication({
      id: 'effect-plugin-state-consequence',
      install({ hydration }) {
        hydration.contribute('external-store', () => store)
      },
      root: defineComponent({
        setup: () => () => h('main', [h(Consumer), h(Producer)]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('second-ready')
    expect(rendered.metrics.renderPasses).toBe(3)
  })

  it('does not suppress a cyclic effect consequence from an older generation', async () => {
    type CyclicState = { phase: string }
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<CyclicState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Producer = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<CyclicState>()
        const source = ref(0)
        ssrWatchEffect(() => {
          if (source.value === 1) {
            context.state.phase =
              resolution.pass % 2 === 0 ? 'state-a' : 'state-b'
          }
        })
        if (resolution.pass < 3) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<CyclicState>({
      id: 'cyclic-effect-consequence',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup: () => () =>
          h('main', [h(Consumer), h(Producer, { key: 'producer' })]),
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(4)
  })

  it('reconciles changed membership for indistinguishable unkeyed effects', async () => {
    type MembershipState = { phase: string }
    const registrations = new Map<number, number>()
    const Consumer = defineComponent({
      setup() {
        const context = useSsrRequestContext<MembershipState>()
        return () => h('strong', context.state.phase)
      },
    })
    const Item = defineComponent({
      setup() {
        const resolution = inject(SSR_REQUEST_RESOLUTION)!
        const context = useSsrRequestContext<MembershipState>()
        const ordinal = registrations.get(resolution.pass) ?? 0
        registrations.set(resolution.pass, ordinal + 1)
        const source = ref(0)
        ssrWatchEffect(() => {
          if (source.value === 1) {
            context.state.phase = ordinal === 0 ? 'state-a' : 'state-b'
          }
        })
        if (resolution.pass < 2) {
          onServerPrefetch(async () => {
            source.value = 1
          })
        }
        return () => h('i')
      },
    })
    const application = createTestApplication<MembershipState>({
      id: 'ambiguous-effect-membership',
      createInitialState: () => ({ phase: 'loading' }),
      root: defineComponent({
        setup() {
          const resolution = inject(SSR_REQUEST_RESOLUTION)!
          return () =>
            h('main', [
              h(Consumer),
              ...Array.from(
                { length: resolution.pass === 0 ? 2 : 1 },
                () => h(Item)
              ),
            ])
        },
      }),
    })

    const rendered = await renderSsrApplication(application, baseRequest())
    expect(rendered.html).toContain('state-a')
    expect(rendered.hydrationState.application.phase).toBe('state-a')
    expect(rendered.metrics.renderPasses).toBe(3)
  })
})
