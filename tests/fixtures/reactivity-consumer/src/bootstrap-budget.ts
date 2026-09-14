// Externalizing host-owned Vue peers in this inspection build makes the
// emitted files an exact framework-only contribution, with no apportioning
// of compressed bytes in a mixed application/Vue chunk.
export { hydrateSsrApplication, mountSpaApplication, ssrWatch, ssrWatchEffect } from 'vue-ssr-lite/client'
