/**
 * @arena/game-sdk view helpers — the AUTHOR's frontend renderer (T2).
 *
 * A game's optional `view.ts` runs inside an Arena **sandbox iframe** (opaque
 * origin, no cookies, no network). It receives one frame at a time from the
 * platform and draws it however it likes — the platform never runs this code on
 * its own origin, so it can't touch a visitor's session.
 *
 * A "frame" is whatever the game's `render(state)` returned (author-shaped JSON).
 */

interface ViewMessage {
  __arenaView?: boolean
  type?: string
  frame?: unknown
}

/**
 * Register a draw callback. Called once per frame the platform posts in; also
 * signals readiness to the parent so it starts sending frames.
 *
 * ```ts
 * import { onFrame } from '@arena/game-sdk/view'
 * onFrame((frame, root) => { root.innerHTML = ... })
 * ```
 */
export function onFrame(draw: (frame: unknown, root: HTMLElement) => void): void {
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as ViewMessage | null
    if (d && d.__arenaView === true && d.type === 'frame') {
      try {
        draw(d.frame, document.body)
      } catch {
        /* a draw error must never break the host */
      }
    }
  })
  // Only the parent talks to us; announce readiness.
  window.parent.postMessage({ __arenaView: true, type: 'ready' }, '*')
}
