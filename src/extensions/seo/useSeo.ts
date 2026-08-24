import { getCurrentInstance, onActivated, onDeactivated, onUnmounted, watch } from 'vue'
import { isSsrProduction } from '../../SsrCanonicalOrigin'
import {
  SSR_EXTENSION_RUNTIME,
  type ExtensionRuntime,
} from '../../core/extensions/ExtensionRuntime'
import { useSsrRequestContext } from '../../SsrRequestContext'
import { registerSeoLayer, removeSeoLayer, resolveUseSeoInput, type SeoState } from './state'
import type { UseSeoInput } from './types'

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

export const useSeo = (input: UseSeoInput): void => {
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
  const invalidate = () => {
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
    context.managedHead?.invalidate()
  })
  onActivated(() => {
    layer.active = true
    invalidate()
  })
  onUnmounted(() => {
    stop()
    removeSeoLayer(state, layer)
    context.managedHead?.invalidate()
  })
}
