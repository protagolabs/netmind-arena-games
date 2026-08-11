/**
 * DOM overlay: HUD, building tray, draft modal, settle panel, score popups.
 * Everything is textContent — never innerHTML with any dynamic string.
 */
import type { BType, GameState, Round } from './sim.js'
import { ROUNDS } from './sim.js'
import type { Dict } from './i18n.js'

export interface Ui {
  root: HTMLElement
  setDict(d: Dict): void
  setDay(day: string): void
  setScore(n: number): void
  setRound(r: number): void
  setTray(tray: BType[], selected: BType | null): void
  hint(msg: string): void
  popup(xFrac: number, yFrac: number, text: string, good: boolean): void
  showDraft(round: Round, onPick: (which: 'a' | 'b') => void): void
  hideDraft(): void
  showSettle(score: number, stuck: boolean, onAgain: () => void): void
  hideSettle(): void
  onSelect: (t: BType) => void
  onMute: (muted: boolean) => void
  dispose(): void
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, parent?: HTMLElement): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.style.cssText = css
  if (parent) parent.appendChild(e)
  return e
}

const PANEL = 'background:rgba(10,14,26,0.55);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.14);border-radius:12px;color:#f2f5fa'
const BTN = 'cursor:pointer;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.22);border-radius:9px;color:#f2f5fa;font:inherit;padding:7px 14px'

export function makeUi(host: HTMLElement, dict0: Dict): Ui {
  let dict = dict0
  const root = el('div', 'position:absolute;inset:0;pointer-events:none;font:14px/1.5 system-ui,sans-serif;user-select:none;-webkit-user-select:none')
  host.appendChild(root)

  const top = el('div', `position:absolute;top:12px;left:12px;padding:8px 14px;${PANEL};pointer-events:none`, root)
  const dayEl = el('div', 'font-size:12px;opacity:0.75', top)
  const scoreEl = el('div', 'font-size:22px;font-weight:600;letter-spacing:0.5px', top)
  const roundEl = el('div', 'font-size:12px;opacity:0.75', top)

  const muteBtn = el('button', `position:absolute;top:12px;right:12px;${BTN};pointer-events:auto;font-size:12px`, root)
  let muted = false

  const hintEl = el('div', `position:absolute;top:12px;left:50%;transform:translateX(-50%);padding:6px 14px;${PANEL};font-size:12px;opacity:0;transition:opacity 0.4s;max-width:70%;text-align:center`, root)
  let hintTimer = 0

  const tray = el('div', 'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:8px;pointer-events:auto', root)

  const draftWrap = el('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,9,18,0.45);pointer-events:auto', root)
  const draftBox = el('div', `padding:20px 22px;${PANEL};max-width:560px;width:86%`, draftWrap)
  const draftTitle = el('div', 'font-size:17px;font-weight:600;margin-bottom:4px', draftBox)
  const draftSub = el('div', 'font-size:12px;opacity:0.75;margin-bottom:14px', draftBox)
  const draftCards = el('div', 'display:flex;gap:12px', draftBox)

  const settleWrap = el('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:auto', root)
  const settleBox = el('div', `padding:24px 28px;${PANEL};text-align:center`, settleWrap)
  const settleTitle = el('div', 'font-size:20px;font-weight:600', settleBox)
  const settleSub = el('div', 'font-size:13px;opacity:0.8;margin:8px 0 16px', settleBox)
  const settleBtn = el('button', BTN, settleBox)

  const popupLayer = el('div', 'position:absolute;inset:0;overflow:hidden;pointer-events:none', root)

  const styleTag = document.createElement('style')
  styleTag.textContent = '@keyframes mipop{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-36px)}}'
  root.appendChild(styleTag)

  const api: Ui = {
    root,
    onSelect: () => undefined,
    onMute: () => undefined,
    setDict(d) {
      dict = d
      muteBtn.textContent = muted ? dict.unmute : dict.mute
    },
    setDay(day) {
      dayEl.textContent = dict.day(day)
    },
    setScore(n) {
      scoreEl.textContent = `${dict.score} ${n}`
    },
    setRound(r) {
      roundEl.textContent = dict.round(r + 1, ROUNDS.length)
    },
    setTray(items, selected) {
      tray.textContent = ''
      const counts = new Map<BType, number>()
      for (const t of items) counts.set(t, (counts.get(t) ?? 0) + 1)
      for (const [t, n] of counts) {
        const chip = el('button', `${BTN};display:flex;flex-direction:column;align-items:center;min-width:74px;padding:8px 10px;${t === selected ? 'border-color:#ffd27a;background:rgba(255,210,122,0.18)' : ''}`, tray)
        const name = el('div', 'font-size:13px;font-weight:600', chip)
        name.textContent = dict.b[t] ?? t
        const cnt = el('div', 'font-size:11px;opacity:0.75', chip)
        cnt.textContent = `×${n}`
        chip.onclick = () => api.onSelect(t)
        chip.title = dict.bHint[t] ?? ''
      }
    },
    hint(msg) {
      hintEl.textContent = msg
      hintEl.style.opacity = '1'
      window.clearTimeout(hintTimer)
      hintTimer = window.setTimeout(() => {
        hintEl.style.opacity = '0'
      }, 2600)
    },
    popup(xf, yf, text, good) {
      const d = el('div', `position:absolute;font-size:13px;font-weight:600;pointer-events:none;animation:mipop 1.15s ease-out forwards;color:${good ? '#c8f0a8' : '#ffab98'}`, popupLayer)
      d.textContent = text
      d.style.left = `${Math.round(xf * 100)}%`
      d.style.top = `${Math.round(yf * 100)}%`
      window.setTimeout(() => d.remove(), 1250)
    },
    showDraft(round, onPick) {
      draftTitle.textContent = dict.draftTitle
      const nextIdx = ROUNDS.indexOf(round) + 1
      draftSub.textContent = nextIdx < ROUNDS.length ? dict.draftUnlockAt(ROUNDS[nextIdx]!.unlock) : ''
      draftCards.textContent = ''
      for (const which of ['a', 'b'] as const) {
        const pack = round[which]
        const card = el('div', 'flex:1;border:1px solid rgba(255,255,255,0.2);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:6px;background:rgba(255,255,255,0.05)', draftCards)
        const name = el('div', 'font-size:15px;font-weight:600', card)
        name.textContent = dict.pack[pack.id] ?? pack.id
        const list = el('div', 'font-size:12.5px;opacity:0.85;flex:1', card)
        const counts = new Map<BType, number>()
        for (const t of pack.items) counts.set(t, (counts.get(t) ?? 0) + 1)
        list.textContent = [...counts].map(([t, n]) => `${dict.b[t] ?? t} ×${n}`).join(' · ')
        const hintLine = el('div', 'font-size:11.5px;opacity:0.6', card)
        hintLine.textContent = [...counts.keys()].map((t) => dict.bHint[t] ?? '').join('；')
        const btn = el('button', BTN + ';margin-top:6px', card)
        btn.textContent = dict.pick
        btn.onclick = () => onPick(which)
      }
      draftWrap.style.display = 'flex'
    },
    hideDraft() {
      draftWrap.style.display = 'none'
    },
    showSettle(score, stuck, onAgain) {
      settleTitle.textContent = dict.settledTitle
      settleSub.textContent = (stuck ? `${dict.settledStuck} · ` : '') + dict.settledScore(score)
      settleBtn.textContent = dict.again
      settleBtn.onclick = onAgain
      settleWrap.style.display = 'flex'
    },
    hideSettle() {
      settleWrap.style.display = 'none'
    },
    dispose() {
      window.clearTimeout(hintTimer)
      root.remove()
    },
  }
  muteBtn.textContent = dict.mute
  muteBtn.onclick = () => {
    muted = !muted
    muteBtn.textContent = muted ? dict.unmute : dict.mute
    api.onMute(muted)
  }
  return api
}

export function applyStateToUi(ui: Ui, state: GameState, selected: BType | null): void {
  ui.setScore(state.score)
  ui.setRound(state.round)
  ui.setTray(state.tray, selected)
}
