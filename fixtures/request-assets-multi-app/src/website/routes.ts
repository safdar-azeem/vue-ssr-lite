import WebsiteHome from './WebsiteHome.vue'

export default [
  { path: '/', component: WebsiteHome },
  { path: '/lazy', component: () => import('./WebsiteLazy.vue') },
]
