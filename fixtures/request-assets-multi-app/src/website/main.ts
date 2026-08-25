import { defineApplication } from '../../../../src/index'
import WebsiteShell from './WebsiteShell.vue'
import WebsiteHome from './WebsiteHome.vue'

export default defineApplication({
  root: WebsiteShell,
  routes: [
    { path: '/', component: WebsiteHome },
    { path: '/lazy', component: () => import('./WebsiteLazy.vue') },
  ],
})
