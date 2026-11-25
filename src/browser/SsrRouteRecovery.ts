import { START_LOCATION, type Router } from 'vue-router'

// Render outside Vue's managed subtree so this also works with the native
// vue-router outlet and with custom root layouts. Remove on acceptance/disposal.
export function showRouteRecovery(router: Router, target: string, mount?: Element | null) {
  const panel = document.createElement('section')
  const message = document.createElement('p')
  const retry = document.createElement('button')
  message.setAttribute('role', 'status')
  message.textContent = 'This page could not be opened.'
  retry.type = 'button'
  retry.textContent = 'Try again'
  panel.append(message, retry)
  if (mount) mount.before(panel)
  else document.body.prepend(panel)
  const removeAfter = router.afterEach((_to, _from, failure) => {
    if (!failure && router.currentRoute.value !== START_LOCATION) cleanup()
  })
  function cleanup() {
    removeAfter()
    retry.onclick = null
    panel.remove()
  }
  retry.onclick = async () => {
    if (retry.disabled) return
    retry.disabled = true
    message.textContent = 'Opening page…'
    try { await router.replace(target) } catch { /* The user can retry again. */ }
    finally {
      if (panel.isConnected) {
        retry.disabled = false
        message.textContent = 'This page could not be opened.'
        retry.focus()
      }
    }
  }
  return cleanup
}

