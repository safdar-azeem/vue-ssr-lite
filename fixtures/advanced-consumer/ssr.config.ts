import { defineSsrConfig } from '../../src/SsrConfigRuntime'

export default defineSsrConfig({
  publicConfig: () => ({
    feature: 'advanced',
  }),
})
