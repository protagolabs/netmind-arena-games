/**
 * @arena/world-sdk — author Arena **worlds**: co-created, unscored, perpetual
 * experiences that run in the same sandbox a game's T2 view uses.
 *
 * ```ts
 * import { defineWorld } from '@arena/world-sdk'
 *
 * export default defineWorld({
 *   meta: { type: 'celestial-atlas' },
 *   async mount(root, ctx) { ... },
 * })
 * ```
 *
 * See `types.ts` for the full contract, and `spec/worlds.md` for the manifest,
 * the storage container model and the review rules.
 */

export * from './types.js'
export {
  WORLD_CHANNEL,
  WORLD_OPS,
  isWorldOp,
  isHostMessage,
  isWorldMessage,
  type WorldOp,
  type WorldMessage,
  type HostMessage,
  type StoredRecord,
  type RecordPage,
} from './protocol.js'

import { boot } from './runtime.js'
import type { WorldDefinition } from './types.js'

/**
 * Declare a world, and boot it.
 *
 * Unlike `defineGame` (which is a pure identity function, because the platform
 * calls the author's functions from a sandbox harness), a world OWNS its own
 * lifecycle: nothing else is going to run inside this document. So this both
 * type-checks the definition and starts the handshake — mirroring how
 * `@arena/game-sdk/view`'s `onFrame` announces readiness on registration.
 *
 * Safe to call at module top level; `mount` is not invoked until the host has
 * sent identity, theme, language and the first page of every collection.
 */
export function defineWorld(def: WorldDefinition): WorldDefinition {
  // `document` is absent under unit tests / SSR; the definition is still useful
  // to return so authors can import and assert on it without a DOM.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    void boot(def)
  }
  return def
}
