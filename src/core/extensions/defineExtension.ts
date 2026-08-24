import type { ExtensionDefinition } from './ExtensionDefinition'

/** Identity helper that preserves extension state inference. */
export const defineExtension = <TState>(
  definition: ExtensionDefinition<TState>
): ExtensionDefinition<TState> => {
  if (!definition?.name || typeof definition.name !== 'string') {
    throw new Error('[vue-ssr-lite] defineExtension() requires a non-empty name.')
  }
  return definition
}
