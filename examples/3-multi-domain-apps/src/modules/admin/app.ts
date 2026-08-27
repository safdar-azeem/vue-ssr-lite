import { defineApplication } from 'vue-ssr-lite'
import routes from './routes'

export default defineApplication({
	name: 'admin',
	render: 'spa',

	domain: {
		development: 'admin.localhost',
		production: 'admin.example.com',
	},

	routes,

	seo: {
		site: {
			title: 'Admin',
			siteName: 'Admin',
			description: 'Private administration application.',
			index: false,
			follow: false,
		},
	},
})
