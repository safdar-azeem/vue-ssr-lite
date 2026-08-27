import publicRoutes from './modules/public/routes'
import workspaceRoutes from './modules/workspace/routes'
import adminRoutes from './modules/admin/routes'

export default [
  ...publicRoutes,
  ...workspaceRoutes,
  ...adminRoutes,
]
