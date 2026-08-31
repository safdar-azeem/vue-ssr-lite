import {
  Fragment,
  defineComponent,
  h,
  inject,
  onBeforeUnmount,
  ref,
  type PropType,
} from 'vue'
import { SSR_NAVIGATION_RUNTIME } from './SsrNavigationRuntime'
import type { SsrNavigationTransaction } from './SsrNavigationTypes'

const ROOT_STYLE = {
  position: 'fixed',
  top: '0',
  right: '0',
  left: '0',
  zIndex: '2147483647',
  height: '3px',
  overflow: 'hidden',
  pointerEvents: 'none',
}

const BAR_STYLE = {
  width: '40%',
  height: '100%',
  background: 'var(--vssl-loading-indicator-color, #42b883)',
  transform: 'translate3d(-110%, 0, 0)',
  animation: 'vssl-loading-indicator 1s ease-in-out infinite',
  willChange: 'transform',
}

const KEYFRAMES =
  '@keyframes vssl-loading-indicator{' +
  '0%{transform:translate3d(-110%,0,0)}' +
  '55%{transform:translate3d(90%,0,0)}' +
  '100%{transform:translate3d(260%,0,0)}}' +
  '@media (prefers-reduced-motion:reduce){' +
  '.vssl-loading-indicator__bar{' +
  'width:100%;transform:none;animation:none}}'

export const LoadingIndicator = defineComponent({
  name: 'LoadingIndicator',
  inheritAttrs: false,
  props: {
    delay: {
      type: Number as PropType<number>,
      default: 120,
      validator: (value: number) => Number.isFinite(value) && value >= 0,
    },
  },
  setup(props, { attrs }) {
    const runtime = inject(SSR_NAVIGATION_RUNTIME, null)
    const activeId = ref<number | null>(null)
    const visible = ref(false)
    let timer: ReturnType<typeof setTimeout> | undefined

    const clearTimer = () => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
    }

    const unsubscribe =
      runtime?.subscribe({
        start(transaction: SsrNavigationTransaction) {
          activeId.value = transaction.id
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
      }) ?? (() => undefined)

    onBeforeUnmount(() => {
      unsubscribe()
      clearTimer()
    })

    return () => {
      if (!visible.value) return null
      return h(Fragment, null, [
        h(
          'div',
          {
            ...attrs,
            class: ['vssl-loading-indicator', attrs.class],
            style: [ROOT_STYLE, attrs.style],
            role: attrs.role ?? 'progressbar',
            'aria-label': attrs['aria-label'] ?? 'Loading page',
            'aria-live': attrs['aria-live'] ?? 'off',
          },
          [
            h('div', {
              class: 'vssl-loading-indicator__bar',
              style: BAR_STYLE,
            }),
          ]
        ),
        h('style', { type: 'text/css' }, KEYFRAMES),
      ])
    }
  },
})
