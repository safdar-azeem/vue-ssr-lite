import { defineComponent, h, ref } from 'vue'
import { hydrateSsrApplication, mountSpaApplication } from 'vue-ssr-lite/client'
import { RouterView } from 'vue-ssr-lite'
import { LoadingIndicator } from 'vue-ssr-lite'
import { setContext } from 'vue-ssr-lite'
import { defineMiddleware } from 'vue-ssr-lite'
import { defineExtension } from 'vue-ssr-lite'

const root = defineComponent({
  setup() {
    return () => [h(LoadingIndicator), h(RouterView)]
  },
})

export const definition = {
  id: 'capability-full',
  root,
  seo: { siteUrl: 'https://capability.test', titleTemplate: '%s | Capability' },
  routes: [
    { path: '/', component: () => import('./FullPage'), meta: { middleware: [defineMiddleware(() => ({ props: { message: 'route props' } }))] } },
    { path: '/later', component: () => import('./Later') },
  ],
  middleware: [defineMiddleware(({ signal }) => !signal.aborted)],
  extensions: [defineExtension({
    name: 'capability-extension',
    createState: () => ({ title: 'Extension' }),
    setup({ state, contributeHead }) { contributeHead(() => ({ title: state.title })) },
  })],
  install() { setContext({ headers: { 'x-capability': 'fetch' } }) },
}

export const start = (hydrate = false) => hydrate
  ? hydrateSsrApplication(definition)
  : mountSpaApplication(definition)
