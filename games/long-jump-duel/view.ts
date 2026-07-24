/**
 * Long Jump Duel author view (T2) — runs in a sandboxed Arena iframe. Draws
 * two runway lanes (one per seat) with a sandpit ruler, and marks each
 * resolved attempt as a flag at its landing distance (red "FOUL" flag for a
 * fouled attempt, green flag otherwise; the seat's personal-best attempt gets
 * a gold star). Reads only the game's viewer-scoped `render(state, ctx)`
 * frame -- it never learns anything the frame doesn't already expose.
 *
 * Suspense contract (mirrors the game's hidden-info design): the CURRENT,
 * unresolved round never shows a distance or a mark for either seat -- only
 * `frame.history` (already-resolved rounds) ever produces a flag. While
 * waiting, a participant only ever sees a status line about THEIR OWN
 * submission (from `frame.myPending`); a spectator sees an aggregate
 * "who's submitted" readout (from `frame.submittedThisRound`) with no
 * values. Neither ever reveals the opponent's pending speed/angle, because
 * the frame itself never contains it.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'

interface Attempt {
  round: number
  seat: 0 | 1
  speed: number
  angle: number
  fouled: boolean
  distance: number
  windPct: number
}
interface Frame {
  phase?: 'playing' | 'done'
  viewerSeat?: number
  players?: [string, string]
  round?: number
  attempts?: number
  myPending?: { speed: number; angle: number } | null
  submittedThisRound?: [boolean, boolean] | null
  bestDistance?: [number, number]
  history?: Attempt[]
  winner?: string
  moves?: number
}

let host: HTMLElement | null = null
let root: HTMLElement | null = null
let players: PlayerInfo[] = []
let lastFrame: Frame | null = null

function monogramUri(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  const hue = h % 360
  const initials = (label.match(/[a-z0-9]/gi)?.slice(0, 2).join('') || '?').toUpperCase()
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36">` +
    `<rect width="36" height="36" rx="8" fill="hsl(${hue},55%,42%)"/>` +
    `<text x="18" y="24" font-family="system-ui,sans-serif" font-size="15" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text>` +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

const nameOf = (seat: number | undefined, fallback: string): string =>
  (seat !== undefined && players.find((p) => p.seat === seat)?.name) || fallback
const avatarOf = (seat: number | undefined, label: string): string => {
  const a = seat !== undefined ? players.find((p) => p.seat === seat)?.avatar : undefined
  return a && a.length > 0 ? a : monogramUri(label)
}

const TRACK_WIDTH = 420
const TRACK_HEIGHT = 64
// Comfortably above the formula's practical max (speed<=12, sin(2*angle)<=1,
// g=9.8, wind up to +8%): 12*12/9.8*1.08 ~= 15.9m.
const MAX_DISPLAY_DISTANCE = 18

function distanceToPx(d: number): number {
  return Math.max(0, Math.min(1, d / MAX_DISPLAY_DISTANCE)) * TRACK_WIDTH
}

function rulerEl(): HTMLDivElement {
  const ruler = document.createElement('div')
  ruler.style.cssText = `position:relative;width:${TRACK_WIDTH}px;height:14px;margin-left:2px`
  for (let m = 0; m <= MAX_DISPLAY_DISTANCE; m += 2) {
    const tick = document.createElement('div')
    const x = (m / MAX_DISPLAY_DISTANCE) * TRACK_WIDTH
    tick.style.cssText = `position:absolute;left:${x}px;top:0;font:9px system-ui;color:#64748b;transform:translateX(-50%)`
    tick.textContent = String(m)
    ruler.appendChild(tick)
  }
  return ruler
}

function flagEl(distance: number, fouled: boolean, isBest: boolean): HTMLDivElement {
  const flag = document.createElement('div')
  const x = fouled ? 8 : distanceToPx(distance) // a foul never travels -- pin it at the take-off line
  flag.style.cssText = `position:absolute;left:${x}px;bottom:0;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center`
  const pole = document.createElement('div')
  pole.style.cssText = `width:2px;height:26px;background:${fouled ? '#dc2626' : isBest ? '#facc15' : '#94a3b8'}`
  const cloth = document.createElement('div')
  cloth.textContent = fouled ? 'FOUL' : isBest ? '★' : ''
  cloth.style.cssText =
    `font:700 9px system-ui;color:${fouled ? '#dc2626' : '#facc15'};position:absolute;top:-2px;` +
    `left:2px;white-space:nowrap;background:rgba(15,23,42,.75);padding:0 3px;border-radius:3px`
  flag.appendChild(pole)
  if (fouled || isBest) flag.appendChild(cloth)
  return flag
}

function trackEl(seat: 0 | 1, attempts: Attempt[], best: number): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px'
  const track = document.createElement('div')
  track.style.cssText =
    `position:relative;width:${TRACK_WIDTH}px;height:${TRACK_HEIGHT}px;border-radius:8px;overflow:hidden;` +
    'background:linear-gradient(90deg,#3f2d1a 0%,#3f2d1a 8px,#c9a876 8px,#c9a876 100%)'
  // take-off line
  const line = document.createElement('div')
  line.style.cssText = 'position:absolute;left:8px;top:0;bottom:0;width:2px;background:#f8fafc'
  track.appendChild(line)
  const bestDistance = Math.max(0, ...attempts.filter((a) => !a.fouled).map((a) => a.distance))
  for (const a of attempts) {
    track.appendChild(flagEl(a.distance, a.fouled, !a.fouled && a.distance === bestDistance && bestDistance > 0))
  }
  wrap.appendChild(track)
  wrap.appendChild(rulerEl())
  return wrap
}

function laneEl(seat: 0 | 1, f: Frame): HTMLDivElement {
  const lane = document.createElement('div')
  lane.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px;background:#111827;border-radius:12px'

  const isViewer = f.viewerSeat === seat
  const label = isViewer ? 'You' : nameOf(seat, f.players?.[seat] ?? `Player ${seat + 1}`)

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;gap:8px'
  const img = document.createElement('img')
  img.src = avatarOf(seat, label)
  img.width = 26
  img.height = 26
  img.style.cssText = 'width:26px;height:26px;border-radius:50%;object-fit:cover;background:#0b0b0f'
  const nm = document.createElement('span')
  const best = f.bestDistance?.[seat] ?? 0
  nm.textContent = `${label} · best ${best.toFixed(2)}m`
  nm.style.cssText = 'font:700 13px system-ui;color:#e2e8f0'
  header.appendChild(img)
  header.appendChild(nm)
  lane.appendChild(header)

  const attempts = (f.history ?? []).filter((a) => a.seat === seat)
  lane.appendChild(trackEl(seat, attempts, best))

  // Suspense status for the CURRENT unresolved round -- never reveals the
  // other seat's submission, only what this viewer is entitled to know.
  const status = document.createElement('div')
  status.style.cssText = 'font:11px system-ui;color:#94a3b8'
  if (f.phase === 'done') {
    status.textContent = ''
  } else if (isViewer) {
    status.textContent = f.myPending
      ? `Submitted: speed ${f.myPending.speed.toFixed(1)}, angle ${f.myPending.angle.toFixed(0)}° — waiting for opponent…`
      : 'Awaiting your jump…'
  } else if (f.viewerSeat === undefined || f.viewerSeat < 0) {
    // spectator: aggregate submitted-status only, never values
    const submitted = f.submittedThisRound?.[seat]
    status.textContent = submitted === undefined ? '' : submitted ? 'Submitted — waiting on opponent' : 'Not yet submitted'
  } else {
    // the OTHER seat's view of THIS seat: nothing to show, by design.
    status.textContent = ''
  }
  lane.appendChild(status)

  const lastResolved = attempts[attempts.length - 1]
  if (lastResolved) {
    const wind = document.createElement('div')
    const sign = lastResolved.windPct >= 0 ? '+' : ''
    wind.textContent = lastResolved.fouled
      ? `Last attempt: FOUL (speed ${lastResolved.speed.toFixed(1)} was over the safe threshold)`
      : `Last attempt: ${lastResolved.distance.toFixed(2)}m · wind ${sign}${lastResolved.windPct.toFixed(1)}%`
    wind.style.cssText = 'font:11px system-ui;color:#cbd5e1'
    lane.appendChild(wind)
  }

  return lane
}

function ensureRoot(h: HTMLElement): HTMLElement {
  if (!root) {
    host = h
    host.innerHTML = ''
    root = document.createElement('div')
    root.style.cssText = 'padding:14px;max-width:520px;margin:0 auto;font-family:system-ui'
    host.appendChild(root)
  }
  return root
}

function draw(): void {
  if (!root || !lastFrame) return
  const f = lastFrame
  root.innerHTML = ''

  const title = document.createElement('div')
  title.textContent = 'Long Jump Duel'
  title.style.cssText = 'font:700 18px system-ui;color:#60a5fa;text-align:center;margin-bottom:4px'
  root.appendChild(title)

  const sub = document.createElement('div')
  sub.textContent = f.phase === 'done' ? 'Final results' : `Round ${Math.min((f.round ?? 0) + 1, f.attempts ?? 3)} / ${f.attempts ?? 3}`
  sub.style.cssText = 'font:12px system-ui;color:#94a3b8;text-align:center;margin-bottom:10px'
  root.appendChild(sub)

  const lanes = document.createElement('div')
  lanes.style.cssText = 'display:flex;flex-direction:column;gap:12px'
  lanes.appendChild(laneEl(0, f))
  lanes.appendChild(laneEl(1, f))
  root.appendChild(lanes)

  const legend = document.createElement('div')
  legend.style.cssText = 'display:flex;gap:14px;justify-content:center;margin-top:10px;font:11px system-ui;color:#94a3b8;flex-wrap:wrap'
  legend.innerHTML =
    '<span style="color:#facc15">★ personal best</span>' +
    '<span style="color:#dc2626">FOUL = 0m, pinned at the line</span>' +
    '<span>gray flag = a normal (non-best) attempt</span>'
  root.appendChild(legend)

  if (f.phase === 'done') {
    const banner = document.createElement('div')
    const a0 = f.bestDistance?.[0] ?? 0
    const a1 = f.bestDistance?.[1] ?? 0
    const winnerSeat = f.winner ? f.players?.indexOf(f.winner) : undefined
    const text =
      f.winner && winnerSeat !== undefined && winnerSeat >= 0
        ? `🏆 ${nameOf(winnerSeat, f.winner)} wins — ${a0.toFixed(2)}m vs ${a1.toFixed(2)}m`
        : `Draw — ${a0.toFixed(2)}m vs ${a1.toFixed(2)}m`
    banner.textContent = text
    banner.style.cssText =
      'margin-top:12px;padding:10px;border-radius:10px;background:#1e293b;color:#facc15;font:700 14px system-ui;text-align:center'
    root.appendChild(banner)
  }
}

// —— playback pacing (same convention as battleship/doudizhu's view) ——
const HOLD_MS = 1000
const frameQueue: Frame[] = []
let busy = false
function pump(): void {
  if (busy || frameQueue.length === 0) return
  lastFrame = frameQueue.shift()!
  draw()
  if (frameQueue.length > 0) {
    busy = true
    setTimeout(() => {
      busy = false
      pump()
    }, HOLD_MS)
  }
}

onFrame((frame, h) => {
  ensureRoot(h)
  frameQueue.push(frame as Frame)
  pump()
})
onPlayers((p) => {
  players = p
  draw()
})
