import AboutPage from './AboutPage.vue'
import CancelledPage from './CancelledPage.vue'
import DashboardPage from './DashboardPage.vue'
import DashboardNestedPage from './DashboardNestedPage.vue'
import HomePage from './HomePage.vue'
import LoginPage from './LoginPage.vue'
import ProductsPage from './ProductsPage.vue'
import SettingsPage from './SettingsPage.vue'
import { authMiddleware } from './middleware/authMiddleware'
import { cancellationMiddleware } from './middleware/cancellationMiddleware'

export const routes = [
  { path: '/', component: HomePage },
  { path: '/about', component: AboutPage },
  { path: '/products', component: ProductsPage },
  { path: '/settings', component: SettingsPage },
  {
    path: '/cancelled',
    component: CancelledPage,
    meta: { middleware: [cancellationMiddleware] },
  },
  {
    path: '/dashboard',
    component: DashboardPage,
    meta: { middleware: [authMiddleware] },
    children: [
      {
        path: 'nested',
        component: DashboardNestedPage,
      },
    ],
  },
  { path: '/login', component: LoginPage },
]
