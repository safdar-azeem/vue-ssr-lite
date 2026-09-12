import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { RouterView } from 'vue-ssr-lite'
import { LoadingIndicator } from 'vue-ssr-lite'

const root = defineComponent({
  setup() {
    return () => [h(LoadingIndicator), h(RouterView)]
  },
})

export const definition = {
  id: 'capability-navigation',
  root,
  seo: { enabled: false },
  routes: [
    { path: '/', component: () => import('./Home'), meta: {  } },
    { path: '/later', component: () => import('./Later') },
  ],
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
