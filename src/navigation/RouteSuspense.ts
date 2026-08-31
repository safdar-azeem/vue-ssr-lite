import {
  defineComponent,
  h,
  inject,
  onBeforeUnmount,
  ref,
  unref,
  watch,
  type PropType,
} from 'vue'
import { viewDepthKey } from 'vue-router'
import { SSR_NAVIGATION_RUNTIME } from './SsrNavigationRuntime'
import type {
  SsrNavigationBoundarySubscriber,
  SsrNavigationTransaction,
} from './SsrNavigationTypes'

const FALLBACK_STYLE = {
  position: 'absolute',
  inset: '0',
  zIndex: '1',
}

export const RouteSuspense = defineComponent({
  name: 'RouteSuspense',
  inheritAttrs: false,
  props: {
    delay: {
      type: Number as PropType<number>,
      default: 120,
      validator: (value: number) => Number.isFinite(value) && value >= 0,
    },
  },
  setup(props, { attrs, slots }) {
    const runtime = inject(SSR_NAVIGATION_RUNTIME, null)
    const injectedDepth = inject(viewDepthKey, 0)
    const activeId = ref<number | null>(null)
    const visible = ref(false)
    let timer: ReturnType<typeof setTimeout> | undefined
    let unregister: () => void = () => undefined

    const clearTimer = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }

    const subscriberForDepth = (
      depth: number
    ): SsrNavigationBoundarySubscriber => ({
      depth,
      start(transaction: SsrNavigationTransaction) {
        activeId.value = transaction.id
        // A redirect or superseding navigation using the same boundary should
        // not reset an elapsed delay or hide an already-visible fallback.
        if (visible.value || timer !== undefined) return
        const remaining = Math.max(
          0,
          props.delay - (Date.now() - transaction.startedAt)
        )
        if (remaining === 0) {
          visible.value = true
          return
        }
        timer = setTimeout(() => {
          timer = undefined
          if (activeId.value !== null) visible.value = true
        }, remaining)
      },
      settle(transactionId: number) {
        if (activeId.value !== transactionId) return
        activeId.value = null
        clearTimer()
        visible.value = false
      },
    })

    if (runtime) {
      watch(
        () => unref(injectedDepth),
        (depth) => {
          unregister()
          unregister = runtime.registerBoundary(subscriberForDepth(depth))
        },
        { immediate: true }
      )
    }

    onBeforeUnmount(() => {
      unregister()
      clearTimer()
    })

    return () => {
      const covered = visible.value && Boolean(slots.fallback)
      const rootStyle = covered
        ? { display: 'block', position: 'relative' }
        : { display: 'contents' }
      const contentStyle = covered
        ? { display: 'block', pointerEvents: 'none' }
        : { display: 'contents' }
      return h(
        'div',
        {
          ...attrs,
          class: ['vssl-route-suspense', attrs.class],
          style: [rootStyle, attrs.style],
          'aria-busy': visible.value ? 'true' : undefined,
        },
        [
          h(
            'div',
            {
              class: 'vssl-route-suspense__content',
              inert: covered ? '' : undefined,
              'aria-hidden': covered ? 'true' : undefined,
              style: contentStyle,
            },
            slots.default?.()
          ),
          covered
            ? h(
                'div',
                {
                  class: 'vssl-route-suspense__fallback',
                  style: FALLBACK_STYLE,
                },
                slots.fallback?.()
              )
            : null,
        ]
      )
    }
  },
})
