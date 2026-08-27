import AdminHome from './AdminHome.vue'

export default [
  { path: '/', component: AdminHome },
  { path: '/lazy', component: () => import('./AdminLazy.vue') },
]
