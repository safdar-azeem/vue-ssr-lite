import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'

const root = defineComponent({
  setup() {
    return () => h('main', 'Capability core')
  },
})

export const definition = {
  id: 'capability-minimal',
  root,
  seo: { enabled: false },
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
