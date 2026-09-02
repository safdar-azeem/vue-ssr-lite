import HomePage from './pages/HomePage.vue'
import AboutPage from './pages/AboutPage.vue'
import PostPage from './pages/PostPage.vue'
import ProductsPage from './pages/ProductsPage.vue'

export default [
  {
    path: '/',
    component: HomePage,
    meta: {
      seo: {
        title: 'Home',
        description: 'Home route SEO.',
      },
    },
  },
  {
    path: '/about',
    component: AboutPage,
    meta: {
      seo: {
        title: 'About',
        description: 'About route SEO.',
      },
    },
  },
  {
    path: '/posts/:slug',
    component: PostPage,
    meta: {
      seo: {
        title: 'Post',
      },
    },
  },
  {
    path: '/products',
    component: ProductsPage,
    meta: {
      seo: {
        title: 'Products',
        description: 'Products fetched from a public API during SSR.',
      },
    },
  },
]
