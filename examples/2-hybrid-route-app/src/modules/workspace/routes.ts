import WorkspaceLayout from './WorkspaceLayout.vue'
import WorkspaceHomePage from './pages/WorkspaceHomePage.vue'
import ProjectsPage from './pages/ProjectsPage.vue'
import ProjectPage from './pages/ProjectPage.vue'
import SettingsPage from './pages/SettingsPage.vue'

export default [
  {
    path: '/app',
    component: WorkspaceLayout,

    meta: {
      render: 'spa',
      seo: {
        title: 'Workspace',
        index: false,
        follow: false,
      },
    },

    children: [
      {
        path: '',
        component: WorkspaceHomePage,
        meta: {
          seo: {
            title: 'Workspace Home',
          },
        },
      },
      {
        path: 'projects',
        component: ProjectsPage,
        meta: {
          seo: {
            title: 'Projects',
          },
        },
      },
      {
        path: 'projects/:id',
        component: ProjectPage,
        meta: {
          seo: {
            title: 'Project',
          },
        },
      },
      {
        path: 'settings',
        component: SettingsPage,
        meta: {
          seo: {
            title: 'Settings',
          },
        },
      },
    ],
  },
]
