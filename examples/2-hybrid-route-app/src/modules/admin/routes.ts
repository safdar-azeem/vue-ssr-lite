import AdminLayout from './AdminLayout.vue'
import DashboardPage from './pages/DashboardPage.vue'
import UsersPage from './pages/UsersPage.vue'
import SettingsPage from './pages/SettingsPage.vue'

export default [
  {
    path: '/admin',
    component: AdminLayout,

    meta: {
      render: 'spa',
      seo: {
        title: 'Admin',
        index: false,
        follow: false,
      },
    },

    children: [
      {
        path: '',
        component: DashboardPage,
        meta: {
          seo: {
            title: 'Admin Dashboard',
          },
        },
      },
      {
        path: 'users',
        component: UsersPage,
        meta: {
          seo: {
            title: 'Users',
          },
        },
      },
      {
        path: 'settings',
        component: SettingsPage,
        meta: {
          seo: {
            title: 'Admin Settings',
          },
        },
      },
    ],
  },
]
