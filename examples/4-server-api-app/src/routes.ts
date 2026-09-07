import type { RouteRecordRaw } from 'vue-router'
import HomePage from './pages/HomePage.vue'
import OrganizationPage from './pages/OrganizationPage.vue'
import ProductPage from './pages/ProductPage.vue'
import ProductsPage from './pages/ProductsPage.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: HomePage,
    meta: {
      seo: {
        title: 'Server API Example',
        description: 'First-party server routes and middleware with vue-ssr-lite.',
      },
    },
  },
  {
    path: '/products',
    component: ProductsPage,
    meta: {
      seo: {
        title: 'Products',
        description: 'SSR-aware product data loaded through useFetch.',
      },
    },
  },
  {
    path: '/products/:id',
    component: ProductPage,
    meta: {
      seo: {
        title: 'Product',
      },
    },
  },
  {
    path: '/organizations/:organizationId',
    component: OrganizationPage,
    meta: {
      seo: {
        title: 'Organization',
      },
    },
  },
]

export default routes
