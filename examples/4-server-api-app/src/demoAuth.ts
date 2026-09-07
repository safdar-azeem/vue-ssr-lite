// Public fixture tokens used only by this example.
// Real applications should use their normal cookie/session/token architecture.
export const memberHeaders = {
  authorization: 'Bearer member-token',
} as const

export const adminHeaders = {
  authorization: 'Bearer admin-token',
} as const
