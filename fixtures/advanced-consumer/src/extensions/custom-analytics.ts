import { defineExtension } from '../../../../src/index'

export interface AnalyticsOptions {
  propertyId: string
}

export interface AnalyticsState {
  trackId: string
}

export const analyticsExtension = (options: AnalyticsOptions) =>
  defineExtension({
    name: 'custom-analytics',
    createState(): AnalyticsState {
      return { trackId: options.propertyId }
    },
    setup(context) {
      context.contributeHead({
        meta: [
          {
            key: 'analytics-id',
            name: 'x-analytics-id',
            content: context.state.trackId,
          },
        ],
      })
      return () => undefined
    },
  })
