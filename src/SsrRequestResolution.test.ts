import { describe, expect, it } from 'vitest'
import {
  createSsrResolutionController,
  fingerprintSsrReactivityValues,
} from './SsrRequestResolution'
import { fingerprintSsrReconciliationState } from './SsrReconciliationFingerprint'

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('SsrResolutionController', () => {
  it('fingerprints equivalent circular request graphs with stable back-references', () => {
    type CircularState = { phase: string; self?: CircularState }
    const first: CircularState = { phase: 'ready' }
    first.self = first
    const second: CircularState = { phase: 'ready' }
    second.self = second

    expect(fingerprintSsrReconciliationState(first)).toBe(
      fingerprintSsrReconciliationState(second)
    )
    second.phase = 'changed'
    expect(fingerprintSsrReconciliationState(first)).not.toBe(
      fingerprintSsrReconciliationState(second)
    )
  })

  it('tracks unsettled work and clears it once settled', async () => {
    const controller = createSsrResolutionController(true)
    let resolve!: () => void
    const work = new Promise<void>((r) => {
      resolve = r
    })
    controller.track(work)
    expect(controller.pendingWork()).toHaveLength(1)

    resolve()
    await work
    await flushMicrotasks()
    expect(controller.pendingWork()).toHaveLength(0)
  })

  it('is inert in the browser', () => {
    const controller = createSsrResolutionController(false)
    controller.track(Promise.resolve('ignored'))
    controller.requestAdditionalPass()
    expect(controller.pendingWork()).toHaveLength(0)
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('drains a waterfall: work registered while awaiting is included', async () => {
    const controller = createSsrResolutionController(true)
    const first = new Promise<void>((r) => setTimeout(r, 5))
    controller.track(first)
    void first.then(() => controller.track(new Promise<void>((r) => setTimeout(r, 5))))

    const settled = await controller.drain(1_000)
    expect(settled).toBe(true)
    expect(controller.pendingWork()).toHaveLength(0)
  })

  it('honours the deadline when work never settles', async () => {
    const controller = createSsrResolutionController(true)
    controller.track(new Promise<void>(() => {}))
    const settled = await controller.drain(20)
    expect(settled).toBe(false)
  })

  it('stops an unbounded drain when the request is aborted', async () => {
    const controller = createSsrResolutionController(true)
    controller.track(new Promise<void>(() => {}))
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 10)
    const settled = await controller.drain(0, abort.signal)
    expect(settled).toBe(false)
  })

  it('beginPass advances the pass index and clears the pass request', () => {
    const controller = createSsrResolutionController(true)
    controller.requestAdditionalPass()
    expect(controller.additionalPassRequested()).toBe(true)

    controller.beginPass(1)
    expect(controller.pass).toBe(1)
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('coalesces repeated watcher transitions without suppressing a distinct source', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'state-a'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/component', true)
    controller.requestReactivityPass(first, '[42,0]')
    expect(controller.additionalPassRequested()).toBe(true)
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/component', true)
    controller.requestReactivityPass(repeated, '[42,0]')
    expect(controller.additionalPassRequested()).toBe(false)

    const distinct = controller.registerReactivitySource('root/component', true)
    checkpoint = 'state-b'
    controller.requestReactivityPass(distinct, '["ready","loading"]')
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('does not let an exact repeated transition hide a new checkpoint', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'first-ready'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/component', true)
    controller.requestReactivityPass(first, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/component', true)
    checkpoint = 'second-ready'
    controller.requestReactivityPass(repeated, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('coalesces an exact no-op watcher across an unrelated warmer baseline', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'first-ready/second-loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/first', true)
    controller.requestReactivityPass(
      first,
      '["first-ready","first-loading"]',
      checkpoint
    )

    const second = controller.registerReactivitySource('root/second', true)
    const beforeSecond = checkpoint
    checkpoint = 'first-ready/second-ready'
    controller.requestReactivityPass(
      second,
      '["second-ready","second-loading"]',
      beforeSecond
    )
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedFirst = controller.registerReactivitySource(
      'root/first',
      true
    )
    controller.requestReactivityPass(
      repeatedFirst,
      '["first-ready","first-loading"]',
      checkpoint
    )
    controller.completeReactivityPass()

    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('converges when a real watcher consequence becomes a no-op', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/producer', true)
    const beforeFirstCallback = checkpoint
    checkpoint = 'ready'
    controller.requestReactivityPass(
      first,
      '["ready","loading"]',
      beforeFirstCallback
    )
    expect(controller.additionalPassRequested()).toBe(true)
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/producer', true)
    controller.requestReactivityPass(repeated, '["ready","loading"]', checkpoint)
    expect(controller.additionalPassRequested()).toBe(false)

    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('keeps a newly discovered no-op watcher eligible for reconciliation', () => {
    const controller = createSsrResolutionController(true)
    const checkpoint = 'ready'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/local', true)
    controller.requestReactivityPass(first, '["ready","loading"]', checkpoint)

    expect(controller.additionalPassRequested()).toBe(true)
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/local', true)
    controller.requestReactivityPass(repeated, '["ready","loading"]', checkpoint)

    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('keeps a genuine exact watcher consequence eligible after a no-op replay', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'first-ready/second-loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/first', true)
    controller.requestReactivityPass(first, '["ready","loading"]', checkpoint)
    controller.completeReactivityPass()

    controller.beginPass(1)
    const beforeCallback = 'first-ready/second-ready'
    checkpoint = beforeCallback
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/first', true)
    checkpoint = 'first-changed/second-ready'
    controller.requestReactivityPass(
      repeated,
      '["ready","loading"]',
      beforeCallback
    )

    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('matches watcher checkpoints only against the preceding generation', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'state-a'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/component', true)
    controller.requestReactivityPass(first, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    checkpoint = 'state-b'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const second = controller.registerReactivitySource('root/component', true)
    controller.requestReactivityPass(second, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(2)
    checkpoint = 'state-a'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const third = controller.registerReactivitySource('root/component', true)
    controller.requestReactivityPass(third, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('does not deduplicate values that cannot be represented exactly', () => {
    expect(
      fingerprintSsrReactivityValues([new Map([['phase', 1]])])
    ).toBeNull()
    expect(
      fingerprintSsrReactivityValues([new Map([['phase', 2]])])
    ).toBeNull()

    const symbolValue = { phase: 1, [Symbol('phase')]: 2 }
    expect(fingerprintSsrReactivityValues([symbolValue])).toBeNull()

    const accessor = Object.defineProperty({}, 'phase', {
      enumerable: true,
      get: () => {
        throw new Error('must not be invoked')
      },
    })
    expect(fingerprintSsrReactivityValues([accessor])).toBeNull()
  })

  it('absorbs an effect replay in its reconciliation generation', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'ready'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/effect', true)
    controller.requestReactivityEffectPass(first)
    expect(controller.additionalPassRequested()).toBe(true)
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/effect', true)
    controller.requestReactivityEffectPass(repeated)
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('opens another effect generation for a same-count render-state mutation', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'first-ready'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/effect', true)
    controller.requestReactivityEffectPass(first)
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const changed = controller.registerReactivitySource('root/effect', true)
    checkpoint = 'second-ready'
    controller.requestReactivityEffectPass(changed)
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('opens another effect generation for an extra pass-local invalidation', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'ready'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/effect', true)
    controller.requestReactivityEffectPass(first)
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/effect', true)
    controller.requestReactivityEffectPass(repeated)
    expect(controller.additionalPassRequested()).toBe(false)
    checkpoint = 'second-ready'
    controller.requestReactivityEffectPass(repeated)
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('converges ambiguous watcher invalidations on a stable completed pass', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'ready'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/child', false)
    controller.requestReactivityPass(first, '[1,0]')
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/child', false)
    controller.requestReactivityPass(repeated, '[1,0]')
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('compares ambiguous watcher checkpoints as an ordered stream', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'state-a'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/items', false)
    controller.requestReactivityPass(first, '[1,0]')
    checkpoint = 'state-b'
    const second = controller.registerReactivitySource('root/items', false)
    controller.requestReactivityPass(second, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    checkpoint = 'state-b'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const reordered = controller.registerReactivitySource('root/items', false)
    controller.requestReactivityPass(reordered, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('applies ambiguous registration changes to effects', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'state-a'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/items', false)
    controller.requestReactivityEffectPass(first)
    checkpoint = 'state-b'
    const second = controller.registerReactivitySource('root/items', false)
    controller.requestReactivityEffectPass(second)
    controller.completeReactivityPass()

    controller.beginPass(1)
    checkpoint = 'state-a'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const surviving = controller.registerReactivitySource('root/items', false)
    controller.requestReactivityEffectPass(surviving)
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('does not discard an unmatched exact watcher obligation after state changes', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/producer', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(first, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityPass(first, '[2,1]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    checkpoint = 'state-b'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/producer', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeated, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('reconciles reordered exact callbacks when terminal state changes', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstA = controller.registerReactivitySource('root/a', true)
    const firstB = controller.registerReactivitySource('root/b', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(firstA, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityPass(firstB, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    checkpoint = 'state-b'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedA = controller.registerReactivitySource('root/a', true)
    const repeatedB = controller.registerReactivitySource('root/b', true)
    controller.requestReactivityPass(repeatedB, '[1,0]')
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeatedA, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('allows reordered exact callbacks when terminal state is unchanged', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'ready'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstA = controller.registerReactivitySource('root/a', true)
    const firstB = controller.registerReactivitySource('root/b', true)
    controller.requestReactivityPass(firstA, '[1,0]')
    controller.requestReactivityPass(firstB, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedA = controller.registerReactivitySource('root/a', true)
    const repeatedB = controller.registerReactivitySource('root/b', true)
    controller.requestReactivityPass(repeatedB, '[1,0]')
    controller.requestReactivityPass(repeatedA, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('rejects terminal-equal exact reordering with intermediate checkpoints', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstA = controller.registerReactivitySource('root/a', true)
    const firstB = controller.registerReactivitySource('root/b', true)
    const firstFinal = controller.registerReactivitySource('root/final', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(firstA, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityPass(firstB, '[1,0]')
    checkpoint = 'final'
    controller.requestReactivityPass(firstFinal, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedA = controller.registerReactivitySource('root/a', true)
    const repeatedB = controller.registerReactivitySource('root/b', true)
    const repeatedFinal = controller.registerReactivitySource(
      'root/final',
      true
    )
    checkpoint = 'state-b'
    controller.requestReactivityPass(repeatedB, '[1,0]')
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeatedA, '[1,0]')
    checkpoint = 'final'
    controller.requestReactivityPass(repeatedFinal, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('detects changed render visibility around an identical callback timeline', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstA = controller.registerReactivitySource('root/a', true)
    const firstB = controller.registerReactivitySource('root/b', true)
    controller.registerReactivityObservation()
    checkpoint = 'state-a'
    controller.requestReactivityPass(firstA, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityPass(firstB, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedA = controller.registerReactivitySource('root/a', true)
    const repeatedB = controller.registerReactivitySource('root/b', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeatedA, '[1,0]')
    controller.registerReactivityObservation()
    checkpoint = 'state-b'
    controller.requestReactivityPass(repeatedB, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('rejects an identical visibility timeline that renders intermediate state', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstA = controller.registerReactivitySource('root/a', true)
    const firstB = controller.registerReactivitySource('root/b', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(firstA, '[1,0]')
    controller.registerReactivityObservation()
    checkpoint = 'state-b'
    controller.requestReactivityPass(firstB, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedA = controller.registerReactivitySource('root/a', true)
    const repeatedB = controller.registerReactivitySource('root/b', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeatedA, '[1,0]')
    controller.registerReactivityObservation()
    checkpoint = 'state-b'
    controller.requestReactivityPass(repeatedB, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('detects an ordinary mutation before a replay observation', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/producer', true)
    controller.registerReactivityObservation()
    checkpoint = 'state-b'
    controller.requestReactivityPass(first, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource(
      'root/producer',
      true
    )
    checkpoint = 'state-a'
    controller.registerReactivityObservation()
    checkpoint = 'state-b'
    controller.requestReactivityPass(repeated, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('accepts replay mutations restored before the request state is observed', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'state-b'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstA = controller.registerReactivitySource('root/a', true)
    const firstB = controller.registerReactivitySource('root/b', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(firstA, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityPass(firstB, '[1,0]')
    controller.registerReactivityObservation()
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedA = controller.registerReactivitySource('root/a', true)
    const repeatedB = controller.registerReactivitySource('root/b', true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeatedA, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityPass(repeatedB, '[1,0]')
    controller.registerReactivityObservation()
    controller.completeReactivityPass()

    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('preserves ordering across exact and ambiguous callback domains', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstExact = controller.registerReactivitySource('root/exact', true)
    const firstAmbiguous = controller.registerReactivitySource(
      'root/ambiguous',
      false
    )
    checkpoint = 'state-a'
    controller.requestReactivityEffectPass(firstExact)
    checkpoint = 'state-b'
    controller.requestReactivityPass(firstAmbiguous, '[1,0]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedExact = controller.registerReactivitySource(
      'root/exact',
      true
    )
    const repeatedAmbiguous = controller.registerReactivitySource(
      'root/ambiguous',
      false
    )
    controller.requestReactivityPass(repeatedAmbiguous, '[1,0]')
    checkpoint = 'state-a'
    controller.requestReactivityEffectPass(repeatedExact)
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('allows duplicate effect obligations to collapse when terminal state is unchanged', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'state-a'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/effect', true)
    controller.requestReactivityEffectPass(first)
    controller.requestReactivityEffectPass(first)
    controller.completeReactivityPass()

    controller.beginPass(1)
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/effect', true)
    controller.requestReactivityEffectPass(repeated)
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(false)
  })

  it('does not discard an unmatched ambiguous obligation after state changes', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const first = controller.registerReactivitySource('root/producer', false)
    checkpoint = 'state-a'
    controller.requestReactivityPass(first, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityPass(first, '[2,1]')
    controller.completeReactivityPass()

    controller.beginPass(1)
    checkpoint = 'state-b'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeated = controller.registerReactivitySource('root/producer', false)
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeated, '[1,0]')
    expect(controller.additionalPassRequested()).toBe(false)
    controller.completeReactivityPass()
    expect(controller.additionalPassRequested()).toBe(true)
  })

  it('preserves mixed watcher and effect ordering for ambiguous sources', () => {
    const controller = createSsrResolutionController(true)
    let checkpoint = 'loading'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const firstWatch = controller.registerReactivitySource(
      'root/producer',
      false
    )
    const firstEffect = controller.registerReactivitySource(
      'root/producer',
      false
    )
    checkpoint = 'state-a'
    controller.requestReactivityPass(firstWatch, '[1,0]')
    checkpoint = 'state-b'
    controller.requestReactivityEffectPass(firstEffect)
    controller.completeReactivityPass()

    controller.beginPass(1)
    checkpoint = 'state-b'
    controller.setReactivityCheckpointReader(() => checkpoint)
    const repeatedWatch = controller.registerReactivitySource(
      'root/producer',
      false
    )
    const repeatedEffect = controller.registerReactivitySource(
      'root/producer',
      false
    )
    controller.requestReactivityEffectPass(repeatedEffect)
    expect(controller.additionalPassRequested()).toBe(true)
    checkpoint = 'state-a'
    controller.requestReactivityPass(repeatedWatch, '[1,0]')
  })

  it('does not swallow the original rejection of tracked work', async () => {
    const controller = createSsrResolutionController(true)
    const failure = new Error('boom')
    const work = controller.track(Promise.reject(failure))
    await expect(work).rejects.toBe(failure)
    await flushMicrotasks()
    expect(controller.pendingWork()).toHaveLength(0)
  })
})
