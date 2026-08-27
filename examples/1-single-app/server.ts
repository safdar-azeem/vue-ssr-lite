import { defineServer } from 'vue-ssr-lite'
import { siteSeo } from './src/seo/site'
import { sitemap } from './src/seo/sitemap'
import { robots } from './src/seo/robots'

export default defineServer({
	render: 'ssr',

	server: {
		port: 4211,
		trustProxy: true,
	},

	seo: {
		site: siteSeo,
		sitemap,
		robots,
	},

	// No `app` config required.
	// Defaults:
	//   main -> /src/main.ts
	//   root -> /src/App.vue
})
