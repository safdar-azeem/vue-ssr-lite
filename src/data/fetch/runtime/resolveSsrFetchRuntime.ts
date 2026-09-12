import { readSsrFetchBinding } from './SsrFetchRuntimeScope'
import { SsrFetchRuntime } from './SsrFetchRuntime'

/** The public consumer import carries execution; creation remains synchronous. */
export const resolveSsrFetchRuntime = (setupOnly = false): SsrFetchRuntime | null => {
  const binding = readSsrFetchBinding(setupOnly)
  if (!binding) return null
  // Existing server/advanced integrations still inject the concrete runtime.
  if ('createConsumer' in binding) return binding
  if (binding.disposed) return null
  return binding.runtime ??= new SsrFetchRuntime(
    binding.server, binding.context, binding.hydration, binding.hydrating
  )
}
