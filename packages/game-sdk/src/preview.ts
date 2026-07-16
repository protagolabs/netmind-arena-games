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
  /** Seat identity posted once via `onPlayers`. */
  players?: PlayerInfo[]
  ended?: boolean
  frameMs?: number
}

/**
 * T2: drive an author `view.ts` iframe exactly as the platform does — wait for
 * its `ready`, post `players` once, then post each `frame`. `iframe` MUST be a
 * sandboxed iframe whose srcdoc is the bundled view HTML. Returns a cleanup fn.
 */
export function hostSandboxedView(iframe: HTMLIFrameElement, opts: HostViewOptions): () => void {
  let stopReplay = () => {}
  const onMsg = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow) return
    const d = e.data as { __arenaView?: boolean; type?: string } | null
    if (d && d.__arenaView === true && d.type === 'ready') {
      const win = iframe.contentWindow
      if (opts.players?.length) win?.postMessage({ __arenaView: true, type: 'players', players: opts.players }, '*')
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
    window.removeEventListener('message', onMsg)
    stopReplay()
  }
}
