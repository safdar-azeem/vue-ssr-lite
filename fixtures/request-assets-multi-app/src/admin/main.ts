import { defineApplication } from '../../../../src/index'
import AdminShell from './AdminShell.vue'
import AdminHome from './AdminHome.vue'

export default defineApplication({
  root: AdminShell,
  routes: [
    { path: '/', component: AdminHome },
    { path: '/lazy', component: () => import('./AdminLazy.vue') },
  ],
})
