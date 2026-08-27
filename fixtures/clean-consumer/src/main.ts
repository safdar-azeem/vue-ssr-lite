import './style.css'

import type { AppContext } from '../../../src/index'
import HomePage from './HomePage.vue'

const routes = [
  { path: '/', component: HomePage },
  { path: '/lazy', component: () => import('./LazyPage.vue') },
]

export { routes }

export default (_context: AppContext) => {
  // Plugins and providers belong here. Core owns createApp / mount.
}
