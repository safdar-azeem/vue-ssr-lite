import { describe, expect, it } from 'vitest'
import {
  defineComponent,
  h,
  onServerPrefetch,
  reactive,
  computed,
  ref,
} from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { defineSsrApplication } from './index'
import { useSsrRequestContext } from './SsrRequestContext'
import { ssrWatch } from './SsrReactivityRuntime'
import { renderSsrApplication } from './SsrRenderRuntime'
import { createTestRenderRequest } from './SsrTestFixtures'

/**
 * The generic "parent query → parent result determines children → children
 * create their own async work, consumed INDIRECTLY through a shared store read
 * by a sibling" pattern. A single render pass cannot capture it — Vue does not
 * block a sibling's render on an earlier sibling's `onServerPrefetch`.
 *
 * The application writes NO SSR orchestration: children resolve data (an
 * `onServerPrefetch` here; a generated query composable in a real app) and
 * reconcile it into the store with `ssrWatch`. `ssrWatch` itself asks the
 * renderer for one more pass when it fires asynchronously, and the resumed pass
 * reads the data synchronously (warm request cache — here the generic hydration
 * carry) so the sibling sees it. Bounded, with each source resolved once.
 */

interface ChildRecord {
  id: string
  name: string
}
interface AppState {
  ids: string[]
  store: Map<string, ChildRecord>
}

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
    const source = (context.extension as any).source as ReturnType<typeof createSource>

    // A previous pass's resolved value is carried forward and read synchronously
    // here (stands in for an API client's warm request cache).
    const carried = context.hydration.read<ChildRecord>(`child:${props.id}`)
    const record = ref<ChildRecord | undefined>(carried)
    if (record.value === undefined) {
      onServerPrefetch(async () => {
        try {
          record.value = await source.fetchChild(props.id)
        } catch {
          /* one child failing must not remove its siblings */
        }
      })
    }
    // Reconcile into the shared store. No explicit pass request: ssrWatch drives
    // the extra pass automatically when this fires from the awaited prefetch.
    ssrWatch(() => record.value, (value) => {
      if (value) context.state.store.set(props.id, value)
    }, { immediate: true })
    context.hydration.contribute(`child:${props.id}`, () => record.value)
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

const request = (host: string) => createTestRenderRequest(host)

describe('deferred parent → child SSR resolution (no application orchestration)', () => {
  it('discovers and resolves child data after the parent, in a bounded second pass', async () => {
    const source = createSource()
    const rendered = await renderSsrApplication(
      buildApplication(source),
      request('parent-child.test'),
      { resolutionDeadlineMs: 1_000, diagnostics: false }
    )

    expect(source.fetched.sort()).toEqual(['a', 'b', 'c']) // each once, no duplicate
    expect(rendered.html).toContain('Child-a')
    expect(rendered.html).toContain('Child-b')
    expect(rendered.html).toContain('Child-c')
    expect(rendered.html).not.toContain('MISSING-')
    expect(rendered.html).not.toContain('LOADING SHELL')
    expect(rendered.metrics.renderPasses).toBe(2)
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
    expect(rendered.html).toContain('MISSING-b')
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
