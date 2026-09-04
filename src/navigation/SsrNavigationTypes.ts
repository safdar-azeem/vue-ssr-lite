import type {
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
} from 'vue-router'

/** @internal One browser navigation observed by the loading UI runtime. */
export interface SsrNavigationTransaction {
  readonly id: number
  readonly from: RouteLocationNormalizedLoaded
  /** Latest target in this logical navigation, including redirects. */
  to: RouteLocationNormalized
  /** Latest route depth affected by this logical navigation. */
  changedDepth: number
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
  retarget?(transaction: SsrNavigationTransaction): void
}

/** @internal Browser navigation loading lifecycle owned by one Vue application. */
export interface SsrNavigationRuntime {
  subscribe(subscriber: SsrNavigationSubscriber): () => void
  registerBoundary(subscriber: SsrNavigationBoundarySubscriber): () => void
  dispose(): void
}
