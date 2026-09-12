import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { ssrWatch, ssrWatchEffect } from 'vue-ssr-lite/client'

const root = defineComponent({
  setup() {
    const value = ref(0)
    ssrWatch(value, () => {})
    ssrWatchEffect(() => { void value.value })
    return () => h('main', { onClick: () => value.value++ }, `${value.value}`)
  },
})

export const definition = {
  id: 'capability-reactivity',
  root,
  seo: { enabled: false },
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
