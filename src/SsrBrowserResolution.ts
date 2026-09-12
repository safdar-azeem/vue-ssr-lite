import type { SsrResolutionController } from './SsrRequestResolution'

const noop = () => {}

/**
 * The browser implements the same injection contract without allocating SSR
 * obligation maps, promise drains or render-state checkpoint readers.
 */
export const createSsrBrowserResolution = (): SsrResolutionController => ({
  server: false,
  pass: 0,
  track: <T>(work: Promise<T>) => work,
  requestAdditionalPass: noop,
  beginPass: noop,
  registerReactivitySource: (identity = 'anonymous', deduplicable = false) => ({
    identity, slot: 0, deduplicable,
  }),
  requestReactivityPass: noop,
  reactivityCheckpoint: () => null,
  setReactivityCheckpointReader: noop,
  registerReactivityObservation: noop,
  completeReactivityObservation: noop,
  beginReactivityCallback: noop,
  endReactivityCallback: noop,
  requestReactivityEffectPass: noop,
  completeReactivityPass: noop,
  pendingWork: () => [],
  additionalPassRequested: () => false,
  drain: async () => true,
  dispose: noop,
})
