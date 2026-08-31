import type { RouteRecordRaw } from 'vue-router'
import { authMiddleware } from './middleware/authMiddleware'
import AboutPage from './pages/AboutPage.vue'
import DashboardNestedPage from './pages/DashboardNestedPage.vue'
import DashboardPage from './pages/DashboardPage.vue'
import HomePage from './pages/HomePage.vue'
import LoginPage from './pages/LoginPage.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: HomePage,
  },
  {
    path: '/about',
    component: AboutPage,
  },
  {
    path: '/dashboard',
    component: DashboardPage,
    meta: {
      middleware: [authMiddleware],
    },
    children: [
      {
        path: 'nested',
        component: DashboardNestedPage,
      },
    ],
  },
  {
    path: '/login',
    component: LoginPage,
  },
]

export default routes
