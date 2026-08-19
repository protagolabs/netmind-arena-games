/**
 * @arena/game-sdk/preview — the platform's renderer, framework-agnostic.
 *
 * This is the SINGLE SOURCE OF TRUTH for how Arena draws a game locally and on
 * the platform. It mirrors the two live viewers:
 *   - `drawRenderSpec`   ↔ the platform's T1 board/panel renderer (CustomGameBoard)
 *   - `hostSandboxedView`↔ the platform's T2 iframe driver (SandboxedGameViewer)
 * so the arena-games local preview shows EXACTLY what the platform will render.
 * (The React app wraps these same behaviours; keeping the contract here avoids
 * drift between the preview harness and production.)
 */
import type { RenderSpec, PlayerInfo } from './types.js'
import { ARENA_THEME } from './theme.js'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css?: string): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag)
  if (css) n.style.cssText = css
  return n
}

/**
 * T1: draw a declarative RenderSpec (board grid + panels) into `root`. Pure/
 * presentational — no author JS runs. Colours default to ARENA_THEME.
 */
export function drawRenderSpec(root: HTMLElement, spec: RenderSpec): void {
  root.innerHTML = ''
  const wrap = el('div', `display:flex;flex-direction:column;gap:16px;align-items:center;font:14px ${ARENA_THEME.font};color:${ARENA_THEME.fg}`)

  const b = spec.board
  if (b) {
    const board = el('div', `width:100%;max-width:480px;background:${ARENA_THEME.board.wood};border-radius:8px;padding:8px;box-sizing:border-box`)
    const grid = el('div', `display:grid;gap:1px;grid-template-columns:repeat(${b.cols},minmax(0,1fr))`)
    for (let y = 0; y < b.rows; y++) {
      for (let x = 0; x < b.cols; x++) {
        const code = b.cells[y]?.[x] ?? 0
        const isLast = b.lastMove?.x === x && b.lastMove?.y === y
        const cell = el('div', `position:relative;aspect-ratio:1;background:rgba(40,25,10,0.12)${isLast ? `;outline:1px solid ${ARENA_THEME.accent}` : ''}`)
        if (code !== 0) {
          const color = b.palette?.[code] ?? ARENA_THEME.stones[code - 1] ?? '#888'
          cell.appendChild(el('div', `position:absolute;inset:12%;border-radius:50%;background:${color};box-shadow:0 1px 2px rgba(0,0,0,0.4)`))
        }
        grid.appendChild(cell)
      }
    }
    board.appendChild(grid)
    wrap.appendChild(board)
  }

  for (const panel of spec.panels ?? []) {
    if (panel.type === 'status') {
      wrap.appendChild(el('div', `color:${ARENA_THEME.fgSubtle};text-align:center`)).textContent = panel.text
    } else if (panel.type === 'scoreboard') {
      const row = el('div', 'display:flex;gap:24px')
      for (const r of panel.rows) {
        const col = el('div', 'display:flex;flex-direction:column;align-items:center')
        col.appendChild(el('span', `color:${ARENA_THEME.fgSubtle};font-size:12px`)).textContent = r.label
        col.appendChild(el('span', 'font-weight:600')).textContent = String(r.value)
        row.appendChild(col)
      }
      wrap.appendChild(row)
    } else if (panel.type === 'timeline') {
      const ul = el('ul', `color:${ARENA_THEME.fgSubtle};font-size:12px;max-width:28rem;list-style:none;padding:0;margin:0`)
      for (const it of panel.items) {
        ul.appendChild(el('li')).textContent = it.detail ? `${it.label} · ${it.detail}` : it.label
      }
      wrap.appendChild(ul)
    }
  }
  root.appendChild(wrap)
}

export interface ReplayOptions {
  frames: unknown[]
  /** true = replay from the first frame; false = jump to the latest (live). Default true. */
  ended?: boolean
  /** ms per frame during replay. Default 1500 (matches the platform). */
  frameMs?: number
  onFrame: (frame: unknown, index: number) => void
}

/**
 * Drive a frame log the way the platform does: ENDED → animate from frame 0;
 * LIVE → show only the latest frame. Returns a stop() to cancel the timer.
 */
export function replayFrames(opts: ReplayOptions): () => void {
  const { frames, ended = true, frameMs = 1500, onFrame } = opts
  if (frames.length === 0) return () => {}
  if (!ended) {
    onFrame(frames[frames.length - 1], frames.length - 1)
    return () => {}
  }
  let i = 0
  onFrame(frames[0], 0)
  const timer = setInterval(() => {
    i = i + 1 < frames.length ? i + 1 : i
    onFrame(frames[i], i)
  }, frameMs)
  return () => clearInterval(timer)
}

export interface HostViewOptions {
  frames: unknown[]
  /** Seat identity posted via `onPlayers` (avatars inlined first — see `inlineAvatars`). */
  players?: PlayerInfo[]
  ended?: boolean
  frameMs?: number
}

/**
 * Fetch a remote image URL and return it as a `data:` URI, or null on any failure.
 *
 * The sandboxed view's CSP caps `img-src` to `data:` (no `https:`) — an `<img>`
 * beacon is an outbound channel out of the browser even with `connect-src 'none'`,
 * so author view code must not be able to load a remote URL (#2031). That means a
 * remote `https://` avatar posted into the sandbox is blocked by the browser. This
 * runs in the PARENT frame (normal network, no CSP), inlining the bytes so the
 * sandboxed `<img src="data:…">` is allowed.
 */
export async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * Return a copy of `players` with every remote avatar URL inlined as a `data:` URI,
 * so avatars survive the sandbox's `img-src data:` CSP. Already-inlined (`data:`)
 * avatars pass through untouched; a fetch failure drops that avatar to `null` (author
 * views guard on a missing avatar and fall back to a generated monogram), never
 * blocking the others.
 *
 * This is part of the HOST's contract with a view, not an optimisation: a view that
 * renders `info.avatar` directly is correct, because the host guarantees whatever it
 * posts is already CSP-safe. Mirrors the platform's `inlineAvatars`.
 */
export async function inlineAvatars(players: PlayerInfo[]): Promise<PlayerInfo[]> {
  return Promise.all(
    players.map(async (p) => {
      if (!p.avatar || p.avatar.startsWith('data:')) return p
      const dataUri = await fetchAsDataUri(p.avatar)
      return { ...p, avatar: dataUri ?? undefined }
    }),
  )
}

/**
 * T2: drive an author `view.ts` iframe exactly as the platform does — wait for
 * its `ready`, post `players`, then post each `frame`. `iframe` MUST be a
 * sandboxed iframe whose srcdoc is the bundled view HTML. Returns a cleanup fn.
 *
 * Players are posted twice, as the platform does: once immediately so identity is
 * available from the first frame, then again once remote avatars have been inlined
 * as `data:` URIs (the sandbox CSP blocks `https:` images — see `inlineAvatars`).
 * Views already re-render on every `onPlayers`, so the second post just fills in
 * the avatars.
 */
export function hostSandboxedView(iframe: HTMLIFrameElement, opts: HostViewOptions): () => void {
  let stopReplay = () => {}
  let stopped = false
  const onMsg = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return
    const d = e.data as { __arenaView?: boolean; type?: string } | null
    if (d && d.__arenaView === true && d.type === 'ready') {
      const win = iframe.contentWindow
      if (opts.players?.length) {
        const players = opts.players
        win?.postMessage({ __arenaView: true, type: 'players', players }, '*')
        void inlineAvatars(players).then((inlined) => {
          // The view may have been torn down while we were fetching.
          if (!stopped) win?.postMessage({ __arenaView: true, type: 'players', players: inlined }, '*')
        })
      }
      stopReplay = replayFrames({
        frames: opts.frames,
        ended: opts.ended,
        frameMs: opts.frameMs,
        onFrame: (frame) => win?.postMessage({ __arenaView: true, type: 'frame', frame }, '*'),
      })
    }
  }
  window.addEventListener('message', onMsg)
  return () => {
    stopped = true
    window.removeEventListener('message', onMsg)
    stopReplay()
  }
}
