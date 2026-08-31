import type {
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
} from 'vue-router'

/** @internal One browser navigation observed by the loading UI runtime. */
export interface SsrNavigationTransaction {
  readonly id: number
  readonly from: RouteLocationNormalizedLoaded
  readonly to: RouteLocationNormalized
  readonly changedDepth: number
  readonly startedAt: number
}

/** @internal Direct, application-local loading UI subscription. */
export interface SsrNavigationSubscriber {
  start(transaction: SsrNavigationTransaction): void
  settle(transactionId: number): void
}

/** @internal Route-outlet loading boundary subscription. */
export interface SsrNavigationBoundarySubscriber
  extends SsrNavigationSubscriber {
  readonly depth: number
}

/** @internal Browser navigation loading lifecycle owned by one Vue application. */
export interface SsrNavigationRuntime {
  subscribe(subscriber: SsrNavigationSubscriber): () => void
  registerBoundary(subscriber: SsrNavigationBoundarySubscriber): () => void
  dispose(): void
}
