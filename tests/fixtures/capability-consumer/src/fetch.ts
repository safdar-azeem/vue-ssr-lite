import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { RouterView } from 'vue-router'
import { setContext } from 'vue-ssr-lite'

const root = defineComponent({
  setup() {
    return () => h(RouterView)
  },
})

export const definition = {
  id: 'capability-fetch',
  root,
  seo: { enabled: false },
  routes: [
    { path: '/', component: () => import('./FetchPage'), meta: {  } },
    { path: '/later', component: () => import('./Later') },
  ],
  install() { setContext({ headers: { 'x-capability': 'fetch' } }) },
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
