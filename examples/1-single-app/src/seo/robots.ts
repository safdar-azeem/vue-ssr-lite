export const robots = {
  resolve: async (context: { siteOrigin: string }) => ({
    status: 'resolved' as const,
    config: {
      groups: [
        {
          userAgents: ['*'],
          allow: ['/'],
        },
      ],
      sitemaps: [`${context.siteOrigin}/sitemap.xml`],
    },
  }),
}
