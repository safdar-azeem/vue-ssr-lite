import { token } from 'style-package'
import AdminPage from './AdminPage.vue'
import Something from '@/components/Something.vue'

export const adminRoutes = [
  { path: '/', component: AdminPage, meta: { token } },
  { path: '/alias', component: Something },
]

export const routes = adminRoutes
export default adminRoutes
