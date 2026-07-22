/**
 * Penalty Shootout author view (T2) — runs in a sandboxed Arena iframe. Pure
 * text/ASCII, drawn into a monospace <pre>, animated with a small local timer
 * loop (no images, no canvas) — a goal frame with 3 columns (L/M/R) x 2 rows
 * (U/D, cosmetic only), the ball, and the keeper.
 *
 * The box is drawn with plain ASCII (+ - |), not Unicode box-drawing glyphs
 * (┌─┬┐ etc). Unicode box-drawing characters are NOT guaranteed single-width
 * in every monospace font a browser falls back to, which visibly skewed the
 * grid; plain ASCII is single-width everywhere, no exceptions.
 *
 * Team color: seat 0 is always blue, seat 1 always orange, applied to that
 * seat's ball (whoever is kicking), keeper glyph (whoever is defending),
 * name, and nickname wherever they appear -- consistent throughout. This
 * means the `<pre>` is rendered as HTML (colored spans), not plain
 * textContent; every piece of dynamic text (names, nicknames) is HTML-escaped
 * before insertion since it ultimately comes from the platform, not this
 * file's own literals.
 *
 * The suspense is real, not staged: while a shot is `awaitingSave`, the
 * engine's own frame hides the target (`?` marks) from everyone except the
 * shooter — this view can only draw what render() actually reveals to this
 * viewer. Once a shot resolves, the NEXT engine frame carries the real
 * outcome in `history`; this view unpacks that single transition into a
 * short flipbook (windup already shown -> reveal -> banner) for drama,
 * ticking every ~450ms like a terminal spinner.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'

type Col = 'L' | 'M' | 'R'
type Row = 'U' | 'D'
type Outcome = 'goal' | 'saved' | 'wide'
type Seat = 0 | 1
interface ShotRecord {
  round: number
  shooterSeat: Seat
  power: number
  col: Col
  row: Row
  keeperCol: Col
  outcome: Outcome
}
interface PSFrame {
  phase?: 'setup' | 'shooting' | 'won'
  viewerSeat?: number
  players?: [string, string]
  orderSet?: [boolean, boolean]
  nicknames?: string[] // index i = power (i+1)'s nickname
  round?: number
  isSuddenDeath?: boolean
  shooterSeat?: Seat
  awaitingSave?: boolean
  myPendingTarget?: { col: Col; row: Row } | null
  score?: [number, number]
  history?: ShotRecord[]
  winner?: string
}

let host: HTMLElement | null = null
let pre: HTMLPreElement | null = null
let players: PlayerInfo[] = []

const nameOf = (seat: number | undefined, fallback: string): string =>
  (seat !== undefined && players.find((p) => p.seat === seat)?.name) || fallback

// The current shooter's power isn't known to this view until the shot
// resolves and lands in `history` (power is part of the hidden order before
// then) -- nickname lookups always go through the resolved record, never a
// guess at "whoever is about to kick".
const nicknameFor = (f: PSFrame, power: number): string => f.nicknames?.[power - 1] ?? `#${power}`

// Combined identity tag for whoever is CURRENTLY SHOOTING: the agent's real
// name plus their power nickname, e.g. "Napoleon_3lot" -- one colored unit,
// since the nickname alone doesn't say who's playing and the real name alone
// doesn't say which of their 6 shooters is up.
const combinedShooterTag = (seat: Seat, realName: string, nick: string): string => teamSpan(seat, `${realName}_${nick}`)

// ---- HTML + team color ------------------------------------------------------

// pre.innerHTML is used (not textContent) so team colors can be applied --
// escape any text that ultimately comes from the platform (player names).
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
const TEAM_COLOR: Record<Seat, string> = { 0: '#60a5fa', 1: '#fb923c' } // seat0 blue, seat1 orange
function teamSpan(seat: Seat, text: string): string {
  return `<span style="color:${TEAM_COLOR[seat]};font-weight:700">${esc(text)}</span>`
}

// ---- ASCII goal art (plain characters only -- see file header) ------------

const COLS: Col[] = ['L', 'M', 'R']
const COL_LABEL: Record<Col, string> = { L: 'left', M: 'mid', R: 'right' }
const BORDER = '+-----+-----+-----+'
const FRAME_COLOR = '#475569' // soft slate -- the goal box's own lines, distinct from any mark inside it
const fLine = (s: string): string => `<span style="color:${FRAME_COLOR}">${s}</span>`

// Renders the goal box (+ keeper/wide-marker line beneath it) at 2x size,
// while the surrounding scoreboard/status text stays normal -- a font-size
// scale on a wrapping span, not a change to the underlying character grid,
// so none of the column-alignment math above has to change at all.
function bigBlock(s: string): string {
  // 2em pushed total content past the sandboxed iframe's fixed 560px height
  // budget (platform-controlled, not something this view can resize),
  // causing both scrollbars -- 1.5em is still a clear enlargement but fits.
  return `<span style="font-size:1.5em;line-height:1.15">${s}</span>`
}

/** Center `s` in a fixed 5-char cell; optionally wrap it in a team color span. */
function cell(s: string, color?: string): string {
  const width = 5
  const pad = width - s.length
  const left = Math.floor(pad / 2)
  const right = pad - left
  const content = color ? `<span style="color:${color};font-weight:700">${s}</span>` : s
  return ' '.repeat(Math.max(left, 0)) + content + ' '.repeat(Math.max(right, 0))
}

interface Mark {
  glyph: string
  color?: string
}

/** Draw the 3x2 goal frame. `marks` gives the glyph (+ optional color) for each (col,row). */
function goalFrame(marks: Partial<Record<`${Col}${Row}`, Mark>>): string {
  const row = (r: Row) =>
    COLS.map((c) => {
      const m = marks[`${c}${r}`]
      return cell(m?.glyph ?? '', m?.color)
    }).join(fLine('|'))
  return [fLine(BORDER), `${fLine('|')}${row('U')}${fLine('|')}`, fLine(BORDER), `${fLine('|')}${row('D')}${fLine('|')}`, fLine(BORDER)].join(
    '\n',
  )
}

// Keeper glyph on its own line, aligned under the goal box's L/M/R column,
// colored for whichever seat is currently defending. Column content starts
// at char 1 (L), 7 (M), 13 (R) in each `|...|...|...|` row (border char +
// 5-wide cell, three times) -- computed, not guessed, so it can never drift
// out of sync with goalFrame()'s own column math.
function keeperLine(col: Col | null, keeperSeat: Seat): string {
  const idx = col === null ? 1 : COLS.indexOf(col) // default to center stance
  const leftPad = 1 + idx * 6
  return ' '.repeat(leftPad) + cell('[Y]', TEAM_COLOR[keeperSeat])
}

// A ball that sailed past the frame entirely (a wide shot) -- drawn just
// outside the box so it visually reads as "missed the goal", never inside a
// cell (which would misleadingly suggest it was on target). Colored for the
// shooting seat, matching the ball everywhere else.
function wideMarker(col: Col, shooterSeat: Seat): string {
  const idx = COLS.indexOf(col)
  const leftPad = 1 + idx * 6
  return ' '.repeat(leftPad) + cell('o ->', TEAM_COLOR[shooterSeat]) + '  (WIDE -- missed the goal)'
}

// ---- fixed-slot scoreboard --------------------------------------------------

// Drawn empty from the very first shooting-phase frame and filled in one
// cell at a time as shots resolve, so the whole match's progress and shape
// are visible at a glance the entire time, not just a "last shot" snapshot.
// Starts at REGULATION_COLS wide; only grows into sudden-death columns once
// a tie actually pushes the match past regulation. 'O' = goal, 'X' = saved,
// 'W' = wide (missed the goal outright), '.' = not taken yet. Row labels are
// fixed-width "P1"/"P2" (never a player's real name, so the table can never
// drift out of column alignment regardless of name length or script), tinted
// with that seat's team color for consistency with the rest of the view.
const REGULATION_COLS = 5

function scoreboard(history: ShotRecord[]): string {
  // Column count must come from shots that ACTUALLY happened, not the raw
  // round counter: the counter advances to 5 the instant round 5's second
  // shot resolves, even when that's also the moment the match ends outright
  // (e.g. 4:3 after exactly 5 rounds) -- using it directly showed a phantom
  // empty 6th column that could never be filled.
  const maxRoundSeen = history.reduce((m, h) => Math.max(m, h.round), -1)
  const totalCols = Math.max(REGULATION_COLS, maxRoundSeen + 1)
  const markFor = (seat: Seat, r: number): string => {
    const rec = history.find((h) => h.shooterSeat === seat && h.round === r)
    if (!rec) return '.'
    return rec.outcome === 'goal' ? 'O' : rec.outcome === 'saved' ? 'X' : 'W'
  }
  const num = (i: number) => String(i + 1).padStart(2)
  const header = '        ' + Array.from({ length: totalCols }, (_, i) => num(i)).join(' ')
  // "P1"/"P2" is 2 visible chars; pad with 6 spaces to match the header's
  // 8-char lead-in -- teamSpan() only adds invisible HTML around the text,
  // so the padding math must be based on the plain label, not the HTML.
  const rowLabel = (seat: Seat) => teamSpan(seat, seat === 0 ? 'P1' : 'P2') + '      '
  const rowP1 = rowLabel(0) + Array.from({ length: totalCols }, (_, i) => markFor(0, i).padStart(2)).join(' ')
  const rowP2 = rowLabel(1) + Array.from({ length: totalCols }, (_, i) => markFor(1, i).padStart(2)).join(' ')
  return [header, rowP1, rowP2, '', '  O=goal  X=saved  W=wide  .=not taken'].join('\n')
}

// ---- static (non-animated) scenes -----------------------------------------

function sceneSetup(f: PSFrame): string {
  const [a, b] = f.orderSet ?? [false, false]
  const aName = nameOf(0, f.players?.[0] ?? 'Player 1')
  const bName = nameOf(1, f.players?.[1] ?? 'Player 2')
  return [
    bigBlock(goalFrame({}) + '\n' + keeperLine(null, 1)),
    '',
    `  ${teamSpan(0, aName)} setting up lineup ${a ? '(done)' : '...'}`,
    `  ${teamSpan(1, bName)} setting up lineup ${b ? '(done)' : '...'}`,
    '',
    '  Scoreboard (not started yet)',
    scoreboard([]),
  ].join('\n')
}

function sceneIdle(f: PSFrame, shooterSeat: Seat, shooterName: string, keeperName: string): string {
  const keeperSeat: Seat = shooterSeat === 0 ? 1 : 0
  return [
    bigBlock(goalFrame({}) + '\n' + keeperLine(null, keeperSeat)),
    '',
    `  ${teamSpan(shooterSeat, shooterName)} running up...`,
    `  ${teamSpan(keeperSeat, keeperName)} standing ready`,
    '',
    scoreboard(f.history ?? []),
  ].join('\n')
}

function sceneAwaitingSave(f: PSFrame, shooterSeat: Seat, shooterName: string, keeperName: string): string {
  const keeperSeat: Seat = shooterSeat === 0 ? 1 : 0
  const mine = f.myPendingTarget
  const marks: Partial<Record<`${Col}${Row}`, Mark>> = mine
    ? { [`${mine.col}${mine.row}`]: { glyph: 'o', color: TEAM_COLOR[shooterSeat] } }
    : {}
  return [
    bigBlock(goalFrame(marks) + '\n' + keeperLine(null, keeperSeat)),
    '',
    `  ${teamSpan(shooterSeat, shooterName)} has struck the ball!`,
    `  ${teamSpan(keeperSeat, keeperName)} diving to save... (blind guess)`,
    '',
    scoreboard(f.history ?? []),
  ].join('\n')
}

const OUTCOME_COLOR: Record<Outcome, string> = { goal: '#4ade80', saved: '#fbbf24', wide: '#94a3b8' } // green / amber / slate
function outcomeSpan(o: Outcome): string {
  const label = o === 'goal' ? 'GOAL!!' : o === 'saved' ? 'SAVE!!' : 'WIDE!!'
  return `<span style="color:${OUTCOME_COLOR[o]};font-weight:700">${label}</span>`
}
function outcomeBanner(o: Outcome): string {
  const spaced = o === 'goal' ? 'G O A L ! !' : o === 'saved' ? 'S A V E ! !' : 'W I D E ! !'
  return `  <span style="color:${OUTCOME_COLOR[o]};font-weight:700">&gt;&gt;&gt;  ${spaced}  &lt;&lt;&lt;</span>`
}

function sceneSettled(f: PSFrame): string {
  const history = f.history ?? []
  const last = history[history.length - 1]
  const score = f.score ?? [0, 0]
  const aName = nameOf(0, f.players?.[0] ?? 'Player 1')
  const bName = nameOf(1, f.players?.[1] ?? 'Player 2')
  const lines: string[] = []
  if (last && last.outcome === 'wide') {
    lines.push(bigBlock(goalFrame({}) + '\n' + wideMarker(last.col, last.shooterSeat)))
  } else {
    // Ball glyph inside the box must stay single-width (no emoji) or it
    // drifts out of alignment with the border characters -- always 'o' for
    // where the ball actually landed, tinted for the shooting team; goal vs
    // save is conveyed by the keeper line and the status text below.
    const keeperSeat: Seat | undefined = last ? (last.shooterSeat === 0 ? 1 : 0) : undefined
    const box = goalFrame(last ? { [`${last.col}${last.row}`]: { glyph: 'o', color: TEAM_COLOR[last.shooterSeat] } } : {})
    lines.push(bigBlock(box + '\n' + keeperLine(last?.keeperCol ?? null, keeperSeat ?? 1)))
  }
  lines.push('')
  if (last) {
    const nick = nicknameFor(f, last.power)
    const shooterRealName = last.shooterSeat === 0 ? aName : bName
    const shooter = combinedShooterTag(last.shooterSeat, shooterRealName, nick) // e.g. "Napoleon_3lot"
    lines.push(`  Last shot: ${outcomeSpan(last.outcome)}  (${shooter}, ${COL_LABEL[last.col]})`)
  }
  lines.push('')
  lines.push(`  P1 = ${teamSpan(0, aName)}   P2 = ${teamSpan(1, bName)}`)
  lines.push(scoreboard(history))
  lines.push('')
  lines.push(
    `  Score  ${teamSpan(0, aName)} ${teamSpan(0, String(score[0]))} : ${teamSpan(1, String(score[1]))} ${teamSpan(1, bName)}${f.isSuddenDeath ? '  <span style="color:#f87171;font-weight:700">[SUDDEN DEATH]</span>' : ''}`,
  )
  return lines.join('\n')
}

function sceneWon(f: PSFrame): string {
  const score = f.score ?? [0, 0]
  const aName = nameOf(0, f.players?.[0] ?? 'Player 1')
  const bName = nameOf(1, f.players?.[1] ?? 'Player 2')
  const winnerSeat: Seat | null = f.winner ? ((f.players?.indexOf(f.winner) ?? -1) as Seat) : null
  const winnerName = f.winner ? nameOf(f.players?.indexOf(f.winner), f.winner) : null
  const lines = [bigBlock(goalFrame({}))]
  lines.push('')
  lines.push(`  P1 = ${teamSpan(0, aName)}   P2 = ${teamSpan(1, bName)}`)
  lines.push(scoreboard(f.history ?? []))
  lines.push('')
  lines.push(
    `  Final score  ${teamSpan(0, aName)} ${teamSpan(0, String(score[0]))} : ${teamSpan(1, String(score[1]))} ${teamSpan(1, bName)}`,
  )
  lines.push('')
  lines.push(
    winnerName && winnerSeat !== null
      ? `  <span style="color:#fcd34d">***</span>  ${teamSpan(winnerSeat, winnerName)}  <span style="color:#fcd34d;font-weight:700">WINS!!</span>  <span style="color:#fcd34d">***</span>`
      : '  <span style="color:#94a3b8">-- DRAW --</span>',
  )
  return lines.join('\n')
}

// ---- reveal flipbook (plays once per newly-resolved shot) -----------------

function revealTicks(f: PSFrame, shot: ShotRecord, shooterName: string, keeperName: string): string[] {
  const board = scoreboard(f.history ?? [])
  const nick = nicknameFor(f, shot.power)
  const keeperSeat: Seat = shot.shooterSeat === 0 ? 1 : 0
  const shooter = combinedShooterTag(shot.shooterSeat, shooterName, nick) // e.g. "Napoleon_3lot"
  const keeperTag = teamSpan(keeperSeat, keeperName)

  if (shot.outcome === 'wide') {
    const tick1 = [
      bigBlock(goalFrame({}) + '\n' + keeperLine(null, keeperSeat)),
      '',
      `  ${shooter} strikes it... flying toward the ${COL_LABEL[shot.col]}...`,
      '',
      board,
    ].join('\n')
    const banner = [
      bigBlock(goalFrame({}) + '\n' + wideMarker(shot.col, shot.shooterSeat)),
      '',
      outcomeBanner('wide'),
      `        ${shooter} shakes their head...`,
      '',
      board,
    ].join('\n')
    return [tick1, banner]
  }

  const ballAt: Partial<Record<`${Col}${Row}`, Mark>> = {
    [`${shot.col}${shot.row}`]: { glyph: 'o', color: TEAM_COLOR[shot.shooterSeat] },
  }
  const tick1 = [
    bigBlock(goalFrame(ballAt) + '\n' + keeperLine(null, keeperSeat)),
    '',
    `  ${shooter} strikes it... flying toward the ${COL_LABEL[shot.col]}...`,
    '',
    board,
  ].join('\n')
  const tick2 = [
    bigBlock(goalFrame(ballAt) + '\n' + keeperLine(shot.keeperCol, keeperSeat)),
    '',
    `  ${keeperTag} dives toward the ${COL_LABEL[shot.keeperCol]}!`,
    '',
    board,
  ].join('\n')
  const bigResolved = bigBlock(goalFrame(ballAt) + '\n' + keeperLine(shot.keeperCol, keeperSeat))
  const bannerLines =
    shot.outcome === 'goal'
      ? [
          bigResolved,
          '',
          outcomeBanner('goal'),
          `        ${shooter} pumps a fist in the air!`,
          '',
          board,
        ]
      : [
          bigResolved,
          '',
          outcomeBanner('saved'),
          `        ${keeperTag} roars!`,
          '',
          board,
        ]
  return [tick1, tick2, bannerLines.join('\n')]
}

// ---- draw / playback loop ---------------------------------------------------

function ensureRoot(h: HTMLElement): void {
  if (host) return
  host = h
  host.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'padding:10px;max-width:520px;margin:0 auto;font-family:system-ui'
  const title = document.createElement('div')
  title.textContent = '⚽ Penalty Shootout'
  title.style.cssText =
    'font:700 17px system-ui;color:#60a5fa;text-align:center;letter-spacing:.5px;' +
    'padding-bottom:6px;margin-bottom:8px;border-bottom:2px solid #334155'
  pre = document.createElement('pre')
  pre.style.cssText =
    'background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;border-radius:12px;padding:12px;' +
    'font:14px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre;overflow:auto;margin:0;' +
    'box-shadow:0 4px 18px rgba(0,0,0,.35)'
  const cap = document.createElement('div')
  cap.style.cssText = 'font:11px system-ui;color:#94a3b8;text-align:center;margin-top:8px'
  cap.textContent = 'L / M / R = left / mid / right (up/down is cosmetic only, never affects the result)'
  wrap.appendChild(title)
  wrap.appendChild(pre)
  wrap.appendChild(cap)
  host.appendChild(wrap)
}

// `s` is trusted HTML built entirely by this file's own template functions
// (teamSpan()/cell() already HTML-escape every piece of dynamic text they
// wrap), so innerHTML here is safe -- it's what lets team colors render.
function setText(s: string): void {
  if (pre) pre.innerHTML = s
}

const HOLD_MS = 1300 // was 800 -- overall pace slowed again per feedback
const RESULT_HOLD_MS = HOLD_MS + 3000 // linger longer on a shot's outcome specifically
const TICK_MS = 700 // was 450 -- still too fast to read each reveal step
const frameQueue: PSFrame[] = []
let busy = false
let lastFrame: PSFrame | null = null

function shooterKeeperNames(f: PSFrame): [string, string] {
  const shooterSeat = f.shooterSeat ?? 0
  const keeperSeat = shooterSeat === 0 ? 1 : 0
  return [
    nameOf(shooterSeat, f.players?.[shooterSeat] ?? `Player ${shooterSeat + 1}`),
    nameOf(keeperSeat, f.players?.[keeperSeat] ?? `Player ${keeperSeat + 1}`),
  ]
}

function playTicks(ticks: string[], onDone: () => void): void {
  let i = 0
  const step = () => {
    if (i >= ticks.length) {
      onDone()
      return
    }
    setText(ticks[i]!)
    i++
    setTimeout(step, TICK_MS)
  }
  step()
}

function settle(f: PSFrame, holdMs: number = HOLD_MS): void {
  lastFrame = f
  if (f.phase === 'setup') setText(sceneSetup(f))
  else if (f.phase === 'won') setText(sceneWon(f))
  else setText(sceneSettled(f))
  busy = true
  setTimeout(() => {
    busy = false
    pump()
  }, holdMs)
}

function pump(): void {
  if (busy || frameQueue.length === 0) return
  const next = frameQueue.shift()!
  const prevHistoryLen = lastFrame?.history?.length ?? 0
  const nextHistoryLen = next.history?.length ?? 0

  if (next.phase !== 'setup' && nextHistoryLen > prevHistoryLen) {
    // a shot just resolved -- play the reveal flipbook before settling
    const shot = next.history![nextHistoryLen - 1]!
    const shooterName = nameOf(shot.shooterSeat, next.players?.[shot.shooterSeat] ?? 'Shooter')
    const keeperSeat: Seat = shot.shooterSeat === 0 ? 1 : 0
    const keeperName = nameOf(keeperSeat, next.players?.[keeperSeat] ?? 'Keeper')
    busy = true
    // this settle() follows a just-revealed result -- linger on it longer
    // than the routine idle/awaiting-save holds (explicit ask: +2s per shot).
    playTicks(revealTicks(next, shot, shooterName, keeperName), () => settle(next, RESULT_HOLD_MS))
    return
  }

  if (next.phase === 'setup') {
    settle(next)
    return
  }
  if (next.awaitingSave) {
    const shooterSeat = next.shooterSeat ?? 0
    const [shooterName, keeperName] = shooterKeeperNames(next)
    lastFrame = next
    setText(sceneAwaitingSave(next, shooterSeat, shooterName, keeperName))
    busy = true
    setTimeout(() => {
      busy = false
      pump()
    }, HOLD_MS)
    return
  }
  // about to kick, nothing new resolved yet (e.g. very first frame)
  const shooterSeat = next.shooterSeat ?? 0
  const [shooterName, keeperName] = shooterKeeperNames(next)
  lastFrame = next
  setText(sceneIdle(next, shooterSeat, shooterName, keeperName))
  busy = true
  setTimeout(() => {
    busy = false
    pump()
  }, HOLD_MS)
}

onFrame((frame, h) => {
  ensureRoot(h)
  frameQueue.push(frame as PSFrame)
  pump()
})
onPlayers((p) => {
  players = p
})
