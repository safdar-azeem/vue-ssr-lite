import WorkspaceLayout from './WorkspaceLayout.vue'
import ProjectsPage from './pages/ProjectsPage.vue'
import SettingsPage from './pages/SettingsPage.vue'

export default [
  {
    path: '/app',
    component: WorkspaceLayout,
    meta: { render: 'spa', seo: { title: 'Workspace', index: false } },
    children: [
      { path: '', component: WorkspaceLayout },
      { path: 'projects', component: ProjectsPage },
      { path: 'go-public', redirect: '/about' },
      { path: 'settings', component: SettingsPage },
    ],
  },
]
