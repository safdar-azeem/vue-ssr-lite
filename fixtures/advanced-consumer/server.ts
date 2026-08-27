import { defineServer } from '../../src/index'
import { analyticsExtension } from './src/extensions/custom-analytics'

export default defineServer({
  publicConfig: () => ({
    feature: 'advanced',
  }),
  extensions: [analyticsExtension({ propertyId: 'UA-123456' })],
})
