import DashboardPage from './pages/DashboardPage.vue'
import UsersPage from './pages/UsersPage.vue'

export default [
  {
    path: '/',
    component: DashboardPage,
    meta: {
      seo: {
        title: 'Dashboard',
      },
    },
  },
  {
    path: '/users',
    component: UsersPage,
    meta: {
      seo: {
        title: 'Users',
      },
    },
  },
]
