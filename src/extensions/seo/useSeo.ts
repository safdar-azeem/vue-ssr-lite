import { getCurrentInstance, onActivated, onDeactivated, onUnmounted, watch } from 'vue'
import { isSsrProduction } from '../../SsrCanonicalOrigin'
import {
  SSR_EXTENSION_RUNTIME,
  type ExtensionRuntime,
} from '../../core/extensions/ExtensionRuntime'
import { useSsrRequestContext } from '../../SsrRequestContext'
import {
  recomputeSeoResponseStatus,
  registerSeoLayer,
  removeSeoLayer,
  resolveUseSeoInput,
  type SeoState,
} from './state'
import type { UseSeoSource } from './types'

type RequestWithRuntime = {
  [SSR_EXTENSION_RUNTIME]?: ExtensionRuntime
  managedHead?: { invalidate(): void }
}

const SEO_DISABLED_WARNING =
  '[vue-ssr-lite] useSeo() was called, but the built-in SEO extension is disabled.'

const SETUP_WARNING =
  '[vue-ssr-lite] useSeo() must be called during component setup().'

const warn = (message: string) => {
  if (!isSsrProduction()) console.warn(message)
}

export const useSeo = (input: UseSeoSource): void => {
  const instance = getCurrentInstance()
  if (!instance || instance.isUnmounted) {
    warn(SETUP_WARNING)
    return
  }

  let context: RequestWithRuntime
  try {
    context = useSsrRequestContext() as RequestWithRuntime
  } catch {
    warn(SETUP_WARNING)
    return
  }

  const runtime = context[SSR_EXTENSION_RUNTIME]
  if (!runtime || runtime.disposed) {
    warn(SETUP_WARNING)
    return
  }
  const state = runtime.getState<SeoState>('seo')
  if (!state) {
    warn(SEO_DISABLED_WARNING)
    return
  }

  const layer = registerSeoLayer(state, input)
  const syncStatus = () => {
    const route = runtime.getRoute()
    recomputeSeoResponseStatus(
      state,
      (context as ReturnType<typeof useSsrRequestContext>).response,
      route
    )
  }
  const invalidate = () => {
    syncStatus()
    if (layer.active) context.managedHead?.invalidate()
  }
  invalidate()

  const stop = watch(
    () => resolveUseSeoInput(input),
    () => invalidate(),
    { flush: 'sync' }
  )

  onDeactivated(() => {
    layer.active = false
    syncStatus()
    context.managedHead?.invalidate()
  })
  onActivated(() => {
    layer.active = true
    invalidate()
  })
  onUnmounted(() => {
    stop()
    removeSeoLayer(state, layer)
    syncStatus()
    context.managedHead?.invalidate()
  })
}
