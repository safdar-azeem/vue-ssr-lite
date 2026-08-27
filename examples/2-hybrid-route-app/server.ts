import { defineServer } from 'vue-ssr-lite'
import { siteSeo } from './src/seo/site'
import { sitemap } from './src/seo/sitemap'
import { robots } from './src/seo/robots'

export default defineServer({
	// Default for the whole single application.
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

	// Proposed behavior:
	// route.meta.render may override the default render mode.
	//
	// No applications array.
	// No subdomains required.
	//
	// /src/main.ts and /src/App.vue are used automatically.
})
