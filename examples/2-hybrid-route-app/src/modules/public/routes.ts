import LandingPage from './pages/LandingPage.vue'
import AboutPage from './pages/AboutPage.vue'
import PricingPage from './pages/PricingPage.vue'

export default [
  {
    path: '/',
    component: LandingPage,

    meta: {
      render: 'ssr',
      seo: {
        title: 'Home',
        description: 'Server-rendered landing page.',
      },
    },
  },
  {
    path: '/about',
    component: AboutPage,

    meta: {
      render: 'ssr',
      seo: {
        title: 'About',
        description: 'Server-rendered about page.',
      },
    },
  },
  {
    path: '/pricing',
    component: PricingPage,

    meta: {
      render: 'ssr',
      seo: {
        title: 'Pricing',
        description: 'Server-rendered pricing page.',
      },
    },
  },
]
