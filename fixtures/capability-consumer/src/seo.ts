import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { RouterView } from 'vue-router'

const root = defineComponent({
  setup() {
    return () => h(RouterView)
  },
})

export const definition = {
  id: 'capability-seo',
  root,
  seo: { siteUrl: 'https://capability.test', titleTemplate: '%s | Capability' },
  routes: [
    { path: '/', component: () => import('./SeoPage'), meta: { seo: { title: 'Route SEO' } } },
    { path: '/later', component: () => import('./Later') },
  ],
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
