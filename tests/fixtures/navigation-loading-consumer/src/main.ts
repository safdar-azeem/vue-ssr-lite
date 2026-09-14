import type { AppContext } from 'vue-ssr-lite'
import { routes } from './routes'

export { routes }

export default ({ app, server }: AppContext) => {
  // RouterLink intentionally relies on app.use(router)'s normal global
  // registration. App.vue imports the enhanced route outlet explicitly.
  if (!server) {
    const mountedDocument = document as typeof document & {
      __VSSL_NAVIGATION_FIXTURE_APP__?: typeof app
    }
    mountedDocument.__VSSL_NAVIGATION_FIXTURE_APP__ = app
    app.onUnmount(() => {
      if (mountedDocument.__VSSL_NAVIGATION_FIXTURE_APP__ === app) {
        delete mountedDocument.__VSSL_NAVIGATION_FIXTURE_APP__
      }
    })
  }
}
