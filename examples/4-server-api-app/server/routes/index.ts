import { healthRoutes } from './health'
import { organizationRoutes } from './organizations'
import { productsRoutes } from './products'

export const serverRoutes = [
  healthRoutes,
  productsRoutes,
  organizationRoutes,
]
