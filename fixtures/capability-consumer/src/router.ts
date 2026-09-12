import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { RouterView } from 'vue-router'

const root = defineComponent({
  setup() {
    return () => h(RouterView)
  },
})

export const definition = {
  id: 'capability-router',
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
