import { defineApplication } from 'vue-ssr-lite'
import routes from './routes'
import { siteSeo } from './seo/site'
import { sitemap } from './seo/sitemap'
import { robots } from './seo/robots'

export default defineApplication({
	name: 'website',
	render: 'ssr',

	domain: {
		development: '*.localhost',
		production: '*.example.com',
		customDomains: true,
	},

	routes,

	seo: {
		site: siteSeo,
		sitemap,
		robots,
	},
})
