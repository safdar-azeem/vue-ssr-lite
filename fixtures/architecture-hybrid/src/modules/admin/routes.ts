import AdminLayout from './AdminLayout.vue'
import UsersPage from './pages/UsersPage.vue'

export default [
  {
    path: '/admin',
    component: AdminLayout,
    meta: { render: 'spa', seo: { title: 'Admin', index: false } },
    children: [{ path: 'users', component: UsersPage }],
  },
]
