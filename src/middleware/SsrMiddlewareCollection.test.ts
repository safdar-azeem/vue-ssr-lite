import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import {
  START_LOCATION,
  createMemoryHistory,
  createRouter,
  type RouteRecordRaw,
} from 'vue-router'
import { defineMiddleware } from './defineMiddleware'
import {
  collectMiddleware,
  resolveEnteredMatchedIndices,
} from './SsrMiddlewareCollection'

const Page = defineComponent({ setup: () => () => h('main') })

const createRoutes = (middleware: {
  parent: ReturnType<typeof defineMiddleware>
  firstChild: ReturnType<typeof defineMiddleware>
  secondChild: ReturnType<typeof defineMiddleware>
}): RouteRecordRaw[] => [
  { path: '/public', component: Page },
  {
    path: '/parent',
    component: Page,
    meta: { middleware: [middleware.parent] },
    children: [
      {
        path: 'first',
        component: Page,
        meta: { middleware: [middleware.firstChild] },
      },
      {
        path: 'second',
        component: Page,
        meta: { middleware: [middleware.secondChild] },
      },
    ],
  },
  {
    path: '/users/:id',
    alias: '/members/:id',
    component: Page,
    meta: { middleware: [middleware.parent] },
  },
]

const createFixture = () => {
  const parent = defineMiddleware(() => undefined)
  const firstChild = defineMiddleware(() => undefined)
  const secondChild = defineMiddleware(() => undefined)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: createRoutes({ parent, firstChild, secondChild }),
  })
  return { router, parent, firstChild, secondChild }
}

describe('route-entry middleware collection', () => {
  it('treats every matched record as entered on initial navigation', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        START_LOCATION,
        router.resolve('/parent/first')
      )
    ).toEqual([0, 1])
  })

  it('detects public-to-parent and parent-to-child entry scope', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/public'),
        router.resolve('/parent')
      )
    ).toEqual([0])
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/parent'),
        router.resolve('/parent/first')
      )
    ).toEqual([1])
  })

  it('enters only the new child during a child-to-child navigation', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/parent/first'),
        router.resolve('/parent/second')
      )
    ).toEqual([1])
  })

  it('enters parent and child again after leaving their branch', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/public'),
        router.resolve('/parent/first')
      )
    ).toEqual([0, 1])
  })

  it('does not re-enter a record for query-only changes', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/parent?tab=one'),
        router.resolve('/parent?tab=two')
      )
    ).toEqual([])
  })

  it('does not re-enter a record for hash-only changes', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/parent#overview'),
        router.resolve('/parent#activity')
      )
    ).toEqual([])
  })

  it('does not re-enter the same record when params change', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/users/1'),
        router.resolve('/users/2')
      )
    ).toEqual([])
  })

  it('uses canonical record identity across aliases', () => {
    const { router } = createFixture()
    expect(
      resolveEnteredMatchedIndices(
        router.resolve('/users/1'),
        router.resolve('/members/1')
      )
    ).toEqual([])
  })

  it('always includes globals before newly entered parent and child middleware', () => {
    const { router, parent, firstChild } = createFixture()
    const global = defineMiddleware(() => undefined)
    const collection = collectMiddleware(
      [global],
      router.resolve('/parent/first'),
      router.resolve('/public')
    )
    expect(collection.enteredMatchedIndices).toEqual([0, 1])
    expect(collection.entries.map((entry) => entry.middleware)).toEqual([
      global,
      parent,
      firstChild,
    ])
    expect(collection.entries.map((entry) => entry.matchedIndex)).toEqual([
      null,
      0,
      1,
    ])
  })

  it('keeps globals on parent-to-child navigation while skipping the parent', () => {
    const { router, firstChild } = createFixture()
    const global = defineMiddleware(() => undefined)
    const collection = collectMiddleware(
      [global],
      router.resolve('/parent/first'),
      router.resolve('/parent')
    )
    expect(collection.entries.map((entry) => entry.middleware)).toEqual([
      global,
      firstChild,
    ])
  })

  it('deduplicates entered route middleware by function identity', () => {
    const shared = defineMiddleware(() => undefined)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/public', component: Page },
        {
          path: '/parent',
          component: Page,
          meta: { middleware: [shared] },
          children: [
            {
              path: 'child',
              component: Page,
              meta: { middleware: [shared] },
            },
          ],
        },
      ],
    })
    const collection = collectMiddleware(
      [],
      router.resolve('/parent/child'),
      router.resolve('/public')
    )
    expect(collection.entries).toHaveLength(1)
    expect(collection.entries[0]).toMatchObject({
      middleware: shared,
      matchedIndex: 0,
    })
  })

  it('validates malformed middleware on an entered route', () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/public', component: Page },
        {
          path: '/invalid',
          component: Page,
          meta: { middleware: 'invalid' as never },
        },
        {
          path: '/invalid-entry',
          component: Page,
          meta: { middleware: [null as never] },
        },
      ],
    })
    expect(() =>
      collectMiddleware(
        [],
        router.resolve('/invalid'),
        router.resolve('/public')
      )
    ).toThrow(/meta\.middleware must be an array/)
    expect(() =>
      collectMiddleware(
        [],
        router.resolve('/invalid-entry'),
        router.resolve('/public')
      )
    ).toThrow(/must contain only middleware functions/)
  })
})
