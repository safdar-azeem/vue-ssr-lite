import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { RouterView } from 'vue-router'
import { defineMiddleware } from 'vue-ssr-lite'

const root = defineComponent({
  setup() {
    return () => h(RouterView)
  },
})

export const definition = {
  id: 'capability-middleware',
  root,
  seo: { enabled: false },
  routes: [
    { path: '/', component: () => import('./Home'), meta: { middleware: [defineMiddleware(() => ({ props: { message: 'route props' } }))] } },
    { path: '/later', component: () => import('./Later') },
  ],
  middleware: [defineMiddleware(({ signal }) => !signal.aborted)],
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
