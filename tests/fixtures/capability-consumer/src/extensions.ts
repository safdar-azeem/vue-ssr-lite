import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { defineExtension } from 'vue-ssr-lite'

const root = defineComponent({
  setup() {
    return () => h('main', 'Capability core')
  },
})

export const definition = {
  id: 'capability-extensions',
  root,
  seo: { enabled: false },
  extensions: [defineExtension({
    name: 'capability-extension',
    createState: () => ({ title: 'Extension' }),
    setup({ state, contributeHead }) { contributeHead(() => ({ title: state.title })) },
  })],
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
