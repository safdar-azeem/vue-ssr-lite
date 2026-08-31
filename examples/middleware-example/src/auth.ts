const SESSION_COOKIE = 'single_session'

const readCookie = (name: string): string | undefined => {
  if (typeof document === 'undefined') return undefined

  const prefix = `${encodeURIComponent(name)}=`
  const item = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))

  return item ? decodeURIComponent(item.slice(prefix.length)) : undefined
}

export const isLoggedIn = (): boolean => readCookie(SESSION_COOKIE) === 'yes'

export const login = (): void => {
  if (typeof document === 'undefined') return
  document.cookie = `${SESSION_COOKIE}=yes; Path=/; SameSite=Lax`
}

export const logout = (): void => {
  if (typeof document === 'undefined') return
  document.cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}
