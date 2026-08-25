import './style.css'

import { defineApplication } from '../../../src/index'
import App from './App.vue'
import HomePage from './HomePage.vue'

export default defineApplication({
  root: App,
  routes: [
    { path: '/', component: HomePage },
    { path: '/lazy', component: () => import('./LazyPage.vue') },
  ],
})
