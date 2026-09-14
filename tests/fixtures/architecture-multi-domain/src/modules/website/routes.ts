import HomePage from './pages/HomePage.vue'
import ProjectsPage from './pages/ProjectsPage.vue'

export default [
  { path: '/', component: HomePage, meta: { seo: { title: 'Home' } } },
  { path: '/projects', component: ProjectsPage, meta: { seo: { title: 'Projects' } } },
]
