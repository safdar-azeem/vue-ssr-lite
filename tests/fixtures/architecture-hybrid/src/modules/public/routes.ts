import LandingPage from './pages/LandingPage.vue'
import AboutPage from './pages/AboutPage.vue'

export default [
  {
    path: '/',
    component: LandingPage,
    meta: { render: 'ssr', seo: { title: 'Home' } },
  },
  {
    path: '/about',
    alias: '/about-us',
    component: AboutPage,
    meta: { render: 'ssr', seo: { title: 'About' } },
  },
  {
    path: '/go-app',
    redirect: '/app/projects',
  },
]
