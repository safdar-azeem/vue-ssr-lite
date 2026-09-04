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
  /**
   * Router accepted the destination. Return true when native page Suspense
   * must resolve before the navigation can finish.
   */
  accept(transaction: SsrNavigationTransaction): boolean
  /**
   * End a rejected router phase. Return true only when the already-current
   * page is still pending and this loading clock must follow that page.
   */
  abort(transactionId: number): boolean
}

/** @internal Browser navigation loading lifecycle owned by one Vue application. */
export interface SsrNavigationRuntime {
  subscribe(subscriber: SsrNavigationSubscriber): () => void
  registerBoundary(subscriber: SsrNavigationBoundarySubscriber): () => void
  /** Mark one selected outlet's current page generation as resolved. */
  pageReady(
    transactionId: number,
    boundary: SsrNavigationBoundarySubscriber
  ): void
  /** Positive rendered-page readiness, independent of any loading attempt. */
  pageRendered(
    route: RouteLocationNormalizedLoaded,
    boundary: SsrNavigationBoundarySubscriber
  ): void
  /** Initial root mount checkpoint for applications without an enhanced outlet. */
  appMounted(): void
  /** Wait for the exact accepted route generation's selected page boundary. */
  whenPageReady(route: RouteLocationNormalizedLoaded): Promise<boolean>
  /** Whether this exact accepted route generation still owns presentation. */
  isPageCurrent(route: RouteLocationNormalizedLoaded): boolean
  dispose(): void
}
