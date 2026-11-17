import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('./pages/HomePage.vue'),
    meta: { seo: { title: 'Home', description: 'Vue SSR on Cloudflare Workers.' } },
  },
  {
    path: '/posts/:slug',
    component: () => import('./pages/PostPage.vue'),
    meta: { seo: { title: 'Post' } },
  },
  {
    path: '/isolation',
    component: () => import('./pages/IsolationPage.vue'),
    meta: { seo: { title: 'Isolation probe', index: false } },
  },
  {
    // Client-only subtree: direct requests receive the SPA shell.
    path: '/dashboard',
    component: () => import('./pages/DashboardLayout.vue'),
    meta: { render: 'spa', seo: { title: 'Dashboard', index: false, follow: false } },
    children: [
      { path: '', component: () => import('./pages/DashboardHome.vue') },
      { path: 'settings', component: () => import('./pages/DashboardSettings.vue') },
    ],
  },
]

export default routes
