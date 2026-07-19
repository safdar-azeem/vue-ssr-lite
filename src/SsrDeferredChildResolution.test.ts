import { describe, expect, it } from 'vitest'
import {
  defineComponent,
  h,
  onServerPrefetch,
  reactive,
  computed,
} from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { defineSsrApplication } from './index'
import { useSsrRequestContext } from './SsrRequestContext'
import { useSsrResolution } from './SsrRequestResolution'
import { renderSsrApplication } from './SsrRenderRuntime'

/**
 * The generic "parent query → parent result determines children → children
 * create their own async work, consumed indirectly through a shared store read
 * by a sibling" pattern. A single render pass cannot capture it — Vue does not
 * block a sibling's render on an earlier sibling's `onServerPrefetch`. This
 * exercises the render loop's bounded multi-pass: children ask for another pass
 * when they hydrate asynchronously, and on the next pass their data is carried
 * forward and hydrates synchronously so the sibling sees it.
 */

interface ChildRecord {
  id: string
  name: string
}
interface AppState {
  ids: string[]
  store: Map<string, ChildRecord>
}

/** A request-scoped async source that records every id it fetched. */
const createSource = (options: { failFor?: string } = {}) => {
  const fetched: string[] = []
  return {
    fetched,
    fetchRoot: async (): Promise<string[]> => ['a', 'b', 'c'],
    fetchChild: async (id: string): Promise<ChildRecord> => {
      fetched.push(id)
      await new Promise((resolve) => setTimeout(resolve, 3))
      if (options.failFor === id) throw new Error(`child ${id} failed`)
      return { id, name: `Child-${id}` }
    },
  }
}

const Child = defineComponent({
  props: { id: { type: String, required: true } },
  setup(props) {
    const context = useSsrRequestContext<AppState>()
    const resolution = useSsrResolution()
    const source = (context.extension as any).source as ReturnType<typeof createSource>
    let synchronousPhase = true

    // A previous pass already resolved this child: hydrate the shared store
    // synchronously so the sibling renderer sees it this pass.
    const carried = context.hydration.read<ChildRecord>(`child:${props.id}`)
    if (carried) context.state.store.set(props.id, carried)
    else {
      onServerPrefetch(async () => {
        try {
          const record = await source.fetchChild(props.id)
          context.state.store.set(props.id, record)
          // Hydrated asynchronously, after the sibling already rendered — ask
          // for one more pass. Isolated: one child's failure never rejects the
          // shared prefetch or removes a sibling's data.
          if (resolution?.server && !synchronousPhase) {
            resolution.requestAdditionalPass()
          }
        } catch {
          /* section-level failure is swallowed; siblings are unaffected */
        }
      })
    }
    // Carry this child's resolved record to the next pass.
    context.hydration.contribute(
      `child:${props.id}`,
      () => context.state.store.get(props.id)
    )
    synchronousPhase = false
    return () => h('span', { class: 'child-loader', 'data-id': props.id })
  },
})

const RouteView = defineComponent({
  setup() {
    const context = useSsrRequestContext<AppState>()
    return () =>
      h(
        'ul',
        context.state.ids.map((id) =>
          h('li', { key: id }, context.state.store.get(id)?.name ?? `MISSING-${id}`)
        )
      )
  },
})

const Page = defineComponent({
  setup() {
    const context = useSsrRequestContext<AppState>()
    // Controllers first (they own the child queries), route view as a later
    // sibling that reads the store.
    return () =>
      h('main', [
        ...context.state.ids.map((id) => h(Child, { id, key: id })),
        h(RouteView),
      ])
  },
})

const Shell = defineComponent({
  setup() {
    const context = useSsrRequestContext<AppState>()
    const source = (context.extension as any).source as ReturnType<typeof createSource>
    const ready = computed(() => context.state.ids.length > 0)
    // The parent (root) query gates the child tree behind its loading state.
    onServerPrefetch(async () => {
      context.state.ids = await source.fetchRoot()
    })
    return () => (ready.value ? h(RouterView) : h('div', 'LOADING SHELL'))
  },
})

const routes: RouteRecordRaw[] = [{ path: '/:x(.*)*', component: Page }]

const buildApplication = (source: ReturnType<typeof createSource>) =>
  defineSsrApplication<AppState, unknown, { source: typeof source }>({
    id: 'parent-child',
    rootComponent: Shell,
    routes,
    createInitialState: () => ({ ids: [], store: reactive(new Map()) }),
    createExtension: () => ({ source }),
  })

const request = (host: string) => ({
  requestId: host,
  url: `https://${host}/`,
  host,
  protocol: 'https' as const,
  method: 'GET',
  headers: {},
  publicConfig: {},
  signal: new AbortController().signal,
})

describe('deferred parent → child SSR resolution', () => {
  it('discovers and resolves child queries after the parent, in a bounded second pass', async () => {
    const source = createSource()
    const rendered = await renderSsrApplication(
      buildApplication(source),
      request('parent-child.test'),
      { resolutionDeadlineMs: 1_000, diagnostics: false }
    )

    // Every child ran on the server, exactly once — no duplicate across passes.
    expect(source.fetched.sort()).toEqual(['a', 'b', 'c'])
    // The final HTML contains the child content read through the sibling store.
    expect(rendered.html).toContain('Child-a')
    expect(rendered.html).toContain('Child-b')
    expect(rendered.html).toContain('Child-c')
    expect(rendered.html).not.toContain('MISSING-')
    expect(rendered.html).not.toContain('LOADING SHELL')
    // It took a second pass to reflect the store into the sibling — not one.
    expect(rendered.metrics.renderPasses).toBe(2)
    // The resolved child state is serialized for hydration.
    expect(JSON.stringify(rendered.hydrationState.plugins)).toContain('Child-a')
  })

  it('isolates a failed child without removing successful siblings', async () => {
    const source = createSource({ failFor: 'b' })
    const rendered = await renderSsrApplication(
      buildApplication(source),
      request('partial-failure.test'),
      { resolutionDeadlineMs: 1_000, diagnostics: false }
    )

    expect(rendered.html).toContain('Child-a')
    expect(rendered.html).toContain('Child-c')
    expect(rendered.html).toContain('MISSING-b') // the failed one, not the others
    expect(rendered.html).not.toContain('LOADING SHELL')
  })

  it('does not leak child state across concurrent requests', async () => {
    const left = createSource()
    const right = createSource()
    const [leftResult, rightResult] = await Promise.all([
      renderSsrApplication(buildApplication(left), request('left.test'), {
        resolutionDeadlineMs: 1_000,
        diagnostics: false,
      }),
      renderSsrApplication(buildApplication(right), request('right.test'), {
        resolutionDeadlineMs: 1_000,
        diagnostics: false,
      }),
    ])

    expect(leftResult.html).toContain('Child-a')
    expect(rightResult.html).toContain('Child-a')
    expect(left.fetched.sort()).toEqual(['a', 'b', 'c'])
    expect(right.fetched.sort()).toEqual(['a', 'b', 'c'])
    // Each request has its own serialized state document.
    expect(leftResult.hydrationState).not.toBe(rightResult.hydrationState)
  })

  it('completes a page with no deferred children in a single pass', async () => {
    const application = defineSsrApplication<AppState, unknown, { source: any }>({
      id: 'no-children',
      rootComponent: defineComponent({
        setup: () => () => h('main', 'static content'),
      }),
      createInitialState: () => ({ ids: [], store: reactive(new Map()) }),
      createExtension: () => ({ source: createSource() }),
    })
    const rendered = await renderSsrApplication(application, request('static.test'), {
      diagnostics: false,
    })
    expect(rendered.metrics.renderPasses).toBe(1)
    expect(rendered.html).toContain('static content')
  })
})
