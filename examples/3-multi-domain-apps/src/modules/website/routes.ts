import HomePage from './pages/HomePage.vue'
import ProjectsPage from './pages/ProjectsPage.vue'
import ProjectPage from './pages/ProjectPage.vue'

export default [
  {
    path: '/',
    component: HomePage,
    meta: {
      seo: {
        title: 'Home',
        description: 'Public website home.',
      },
    },
  },
  {
    path: '/projects',
    component: ProjectsPage,
    meta: {
      seo: {
        title: 'Projects',
      },
    },
  },
  {
    path: '/projects/:slug',
    component: ProjectPage,
    meta: {
      seo: {
        title: 'Project',
      },
    },
  },
]
