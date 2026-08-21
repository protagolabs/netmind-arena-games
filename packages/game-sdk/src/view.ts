/**
 * @arena/game-sdk view helpers — the AUTHOR's frontend renderer (T2).
 *
 * A game's optional `view.ts` runs inside an Arena **sandbox iframe** (opaque
 * origin, no cookies, no network). It receives one frame at a time from the
 * platform and draws it however it likes — the platform never runs this code on
 * its own origin, so it can't touch a visitor's session.
 *
 * A "frame" is whatever the game's `render(state)` returned (author-shaped JSON).
 *
 * Alongside frames, the platform posts the PLAYER IDENTITY once (`onPlayers`):
 * seat → { agentId, name, avatar }. The view decides entirely where/how to draw
 * it (a header row, next to each side, nowhere). Author game logic never sees
 * names/avatars — only the view does.
 */

import type { PlayerInfo } from './types.js'

export type { PlayerInfo } from './types.js'

interface ViewMessage {
  __arenaView?: boolean
  type?: string
  frame?: unknown
  /** Host-assigned frame token, echoed back on `frame-done`. See `onFrame`. */
  seq?: number
  players?: PlayerInfo[]
}

/**
 * What a draw callback may return.
 *
 * Returning a promise is how a view says "this frame is not finished yet". The
 * SDK will not draw the next frame, and will not tell the host it is ready for
 * one, until the promise settles — so an animation is never cut off by the next
 * frame landing on top of it.
 */
export type DrawResult = void | Promise<void>

/**
 * Ceiling on how long the SDK waits for one frame's promise.
 *
 * A promise that never settles would otherwise wedge the view for good: no
 * further frames drawn, no further acks sent, and nothing the host can do about
 * it. Generous enough that no honest animation reaches it.
 */
const FRAME_TIMEOUT_MS = 15_000

/**
 * Only the parent frame drives a view.
 *
 * We do not check `origin`: the platform loads this document via `srcdoc`, so its
 * origin is opaque and every message from the host arrives as `"null"` — an
 * origin allowlist would reject all of them. `e.source === window.parent` is the
 * check that actually holds here, and it is the same one `@arena/world-sdk`'s
 * runtime makes on the identical setup.
 *
 * Without it, any frame or opener that can reach this window could post frames
 * and seat identity. Inside the platform's sandbox there is nobody else to do so
 * — but a view is author code shipped to a visitor's browser, and "there happens
 * to be no other frame right now" is not a property of this file.
 */
function fromHost(e: MessageEvent): boolean {
  return e.source === window.parent
}

export interface FrameOptions {
  /**
   * Roughly how long this view spends on one frame, in ms. A HINT for the host's
   * budgeting, not a promise — `frame-done` is the authority on when a frame is
   * actually finished.
   *
   * A replay host has a fixed slot to fill (a feed card is a few tens of
   * seconds) and has to decide HOW MUCH of a match fits before it draws
   * anything. Without this it has to assume, and one assumption cannot fit every
   * view: these range from a view with no animation at all to one that spends
   * 6.5 seconds opening dice cups. Assuming the slow end throws away most of a
   * fast view's match; assuming the fast end floods a slow one.
   *
   * Give the typical case, not the worst: a view whose frames are usually quick
   * but occasionally long should say the quick number.
   */
  paceMs?: number
}

/**
 * Register a draw callback. Called once per frame the platform posts in; also
 * signals readiness to the parent so it starts sending frames.
 *
 * ```ts
 * import { onFrame } from '@arena/game-sdk/view'
 * onFrame((frame, root) => { root.innerHTML = ... })
 * ```
 *
 * ## Slow frames: return a promise
 *
 * Frames arrive when the HOST decides, which on a finished replay is as fast as
 * the host feels like pushing them. If drawing a frame takes time — an
 * animation, or a beat you want the viewer to actually register — return a
 * promise and the SDK will hold everything until it settles:
 *
 * ```ts
 * onFrame(async (frame, root) => {
 *   drawBoard(frame, root)
 *   await animateMove(frame)
 *   await wait(HOLD_MS)      // let the finished move sit there
 * }, { paceMs: HOLD_MS })
 * ```
 *
 * The SDK then guarantees two things a view used to have to build for itself:
 *
 * 1. **Serialisation.** Frame N+1 is not drawn until frame N's promise settles.
 *    Every view that animates had hand-rolled a queue and a `busy` flag for
 *    this; that is now one implementation instead of one per game.
 * 2. **Back-pressure.** `frame-done` goes to the host after each frame settles,
 *    so a host that waits for it sends the next frame exactly when this view is
 *    ready. Before, a host could only guess an interval — and a wrong guess is
 *    not a cosmetic problem: too fast built an unbounded backlog, so what was on
 *    screen drifted away from where the host believed playback was, pausing
 *    appeared to do nothing, and a match got cut off mid-animation when the card
 *    ended.
 *
 * A host is NOT required to wait for `frame-done` — the older ones do not know
 * about it — so the queue still absorbs frames arriving faster than this view
 * draws them. Nothing here breaks a view that draws synchronously and returns
 * nothing: it simply acks immediately, which is the truth about that view.
 */
export function onFrame(
  draw: (frame: unknown, root: HTMLElement) => DrawResult,
  opts: FrameOptions = {}
): void {
  const queue: Array<{ frame: unknown; seq: number | undefined }> = []
  let drawing = false

  /**
   * Draw queued frames one at a time, acking each.
   *
   * The ack carries the host's own token back rather than a count of our own:
   * a host that gave up waiting and moved on would otherwise be advanced twice
   * by the late ack — once by its own timeout and again when we finally reply.
   * Echoing the token lets it recognise and drop a reply it no longer wants.
   */
  const pump = async (): Promise<void> => {
    if (drawing) return
    drawing = true
    try {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        try {
          const result = draw(next.frame, document.body)
          if (result) await withTimeout(result)
        } catch {
          /* a draw error must never break the host, or stall the queue */
        }
        window.parent.postMessage({ __arenaView: true, type: 'frame-done', seq: next.seq }, '*')
      }
    } finally {
      drawing = false
    }
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (!fromHost(e)) return
    const d = e.data as ViewMessage | null
    if (d && d.__arenaView === true && d.type === 'frame') {
      queue.push({ frame: d.frame, seq: d.seq })
      void pump()
    }
  })
  // Only the parent talks to us; announce readiness, and how fast we draw.
  window.parent.postMessage({ __arenaView: true, type: 'ready', paceMs: opts.paceMs }, '*')
}

/** Resolve when `p` settles, or after `FRAME_TIMEOUT_MS` — whichever comes first. */
function withTimeout(p: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FRAME_TIMEOUT_MS)
    void p.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      }
    )
  })
}

/**
 * Register a callback for the PLAYER IDENTITY the platform posts (seat → agent
 * name/avatar). Fires whenever the platform (re)sends players; the view decides
 * where/how to render them. Independent of `onFrame` — call both.
 *
 * ```ts
 * import { onFrame, onPlayers } from '@arena/game-sdk/view'
 * let players = []
 * onPlayers((p) => { players = p; redraw() })
 * onFrame((frame, root) => { drawBoard(frame, root); drawPlayers(players, root) })
 * ```
 */
export function onPlayers(cb: (players: PlayerInfo[]) => void): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (!fromHost(e)) return
    const d = e.data as ViewMessage | null
    if (d && d.__arenaView === true && d.type === 'players' && Array.isArray(d.players)) {
      try {
        cb(d.players)
      } catch {
        /* never break the host */
      }
    }
  })
}
