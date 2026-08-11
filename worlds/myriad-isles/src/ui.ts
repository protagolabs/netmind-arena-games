/**
 * DOM overlay: HUD, building tray, draft modal, settle panel, score popups.
 * Everything is textContent — never innerHTML with any dynamic string.
 */
import type { BType, GameState, Round } from './sim.js'
import { ROUNDS, B_TYPES } from './sim.js'
import type { Dict } from './i18n.js'

export interface SeaRow {
  id: string
  name: string
  author: string
  score: number
  lamps: number
  mine: boolean
}

export interface SettleOpts {
  score: number
  stuck: boolean
  canSave: boolean
  signInHint: boolean
  onSave: (name: string) => void
  onAgain: () => void
}

export interface VisitInfo {
  label: string
  score: number
  lamps: number
  lamped: boolean
  canLamp: boolean
}

export interface Ui {
  root: HTMLElement
  setDict(d: Dict): void
  setDay(day: string): void
  setScore(n: number): void
  setRound(r: number, nextUnlock: number | null): void
  setTray(tray: BType[], selected: BType | null, canRedraft: boolean): void
  hint(msg: string): void
  popup(xFrac: number, yFrac: number, text: string, good: boolean): void
  showPreview(pt: { x: number; y: number } | null, text: string, good: boolean): void
  showNeighborTip(pt: { x: number; y: number } | null, text: string): void
  showDraft(round: Round, onPick: (which: 'a' | 'b') => void): void
  hideDraft(): void
  showSettle(opts: SettleOpts): void
  settleStatus(msg: string): void
  hideSettle(): void
  showSea(rows: SeaRow[], hasMore: boolean, onVisit: (row: SeaRow) => void, onMore: () => void): void
  hideSea(): void
  showVisit(info: VisitInfo, onLamp: () => void, onBack: () => void): void
  updateVisit(lamps: number, lamped: boolean): void
  hideVisit(): void
  onSelect: (t: BType) => void
  onMute: (muted: boolean) => void
  onRedraft: () => void
  onSeaOpen: () => void
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

  const muteBtn = el('button', `position:absolute;top:12px;right:12px;${BTN};pointer-events:auto;font-size:12px;z-index:5`, root)
  let muted = false
  const rulesBtn = el('button', `position:absolute;top:54px;right:12px;${BTN};pointer-events:auto;font-size:12px;z-index:5`, root)
  const rulesWrap = el('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,9,18,0.45);pointer-events:auto', root)
  const rulesBox = el('div', `padding:20px 22px;${PANEL};max-width:520px;width:86%;max-height:82%;overflow-y:auto`, rulesWrap)
  const rulesTitle = el('div', 'font-size:17px;font-weight:600;margin-bottom:10px', rulesBox)
  const rulesBody = el('div', 'font-size:13px;line-height:1.65;opacity:0.92', rulesBox)
  const rulesClose = el('button', BTN + ';margin-top:14px', rulesBox)
  let rulesOpen = false
  const renderRules = () => {
    rulesTitle.textContent = dict.rulesTitle
    rulesClose.textContent = dict.rulesClose
    rulesBody.textContent = ''
    for (const line of [dict.rulesFlow, dict.rulesPlace, dict.rulesGold, dict.rulesGhost, dict.rulesLadder(ROUNDS.slice(1).map((r) => r.unlock).join(' / '))]) {
      const p = el('p', 'margin:0 0 8px', rulesBody)
      p.textContent = line
    }
    const listTitle = el('div', 'font-weight:600;margin:10px 0 6px', rulesBody)
    listTitle.textContent = dict.tray
    for (const t of B_TYPES) {
      const row = el('div', 'margin:0 0 7px', rulesBody)
      const name = el('div', 'font-weight:600', row)
      name.textContent = dict.b[t] ?? t
      const desc = el('div', 'opacity:0.85;font-size:12.5px', row)
      desc.textContent = dict.bRule[t] ?? dict.bHint[t] ?? ''
    }
    rulesBody.appendChild(rulesClose)
  }
  rulesBtn.onclick = () => {
    rulesOpen = true
    renderRules()
    rulesWrap.style.display = 'flex'
  }
  rulesClose.onclick = () => {
    rulesOpen = false
    rulesWrap.style.display = 'none'
  }

  const hintEl = el('div', `position:absolute;top:12px;left:50%;transform:translateX(-50%);padding:6px 14px;${PANEL};font-size:12px;opacity:0;transition:opacity 0.4s;max-width:70%;text-align:center`, root)
  let hintTimer = 0

  const tray = el('div', 'position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:8px;pointer-events:auto', root)
  const selInfo = el('div', `position:absolute;bottom:82px;left:50%;transform:translateX(-50%);padding:5px 12px;${PANEL};font-size:12.5px;display:none;max-width:78%;text-align:center`, root)

  const draftWrap = el('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,9,18,0.45);pointer-events:auto', root)
  const draftBox = el('div', `padding:20px 22px;${PANEL};max-width:560px;width:86%`, draftWrap)
  const draftTitle = el('div', 'font-size:17px;font-weight:600;margin-bottom:4px', draftBox)
  const draftSub = el('div', 'font-size:12px;opacity:0.75;margin-bottom:14px', draftBox)
  const draftCards = el('div', 'display:flex;gap:12px', draftBox)

  const settleWrap = el('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;pointer-events:auto', root)
  const settleBox = el('div', `padding:24px 28px;${PANEL};text-align:center;max-width:400px;width:84%`, settleWrap)
  const settleTitle = el('div', 'font-size:20px;font-weight:600', settleBox)
  const settleSub = el('div', 'font-size:13px;opacity:0.8;margin:8px 0 14px', settleBox)
  const settleName = el('input', 'display:none;width:100%;box-sizing:border-box;margin:0 0 10px;padding:9px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.25);background:rgba(255,255,255,0.08);color:#f2f5fa;font:inherit;font-size:13px;text-align:center', settleBox)
  const settleSave = el('button', `${BTN};display:none;margin:0 6px 10px`, settleBox)
  const settleStatusEl = el('div', 'font-size:12px;opacity:0.75;min-height:16px;margin-bottom:10px', settleBox)
  const settleBtn = el('button', BTN, settleBox)

  const seaBtn = el('button', `position:absolute;top:96px;right:12px;${BTN};pointer-events:auto;font-size:12px;z-index:5`, root)
  const seaWrap = el('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(6,9,18,0.45);pointer-events:auto', root)
  const seaBox = el('div', `padding:20px 22px;${PANEL};max-width:460px;width:86%;max-height:78%;display:flex;flex-direction:column`, seaWrap)
  const seaTitleEl = el('div', 'font-size:17px;font-weight:600;margin-bottom:10px', seaBox)
  const seaList = el('div', 'overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:8px', seaBox)
  const seaFoot = el('div', 'display:flex;gap:10px;margin-top:12px', seaBox)
  const seaMore = el('button', BTN + ';font-size:12px', seaFoot)
  const seaClose = el('button', BTN + ';font-size:12px;margin-left:auto', seaFoot)
  seaClose.onclick = () => {
    seaWrap.style.display = 'none'
  }

  const visitBar = el('div', `position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:none;align-items:center;gap:12px;padding:9px 16px;${PANEL};pointer-events:auto`, root)
  const visitLabel = el('div', 'font-size:13px;font-weight:600;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', visitBar)
  const visitLamps = el('div', 'font-size:12.5px;opacity:0.85', visitBar)
  const visitLampBtn = el('button', BTN + ';font-size:12px', visitBar)
  const visitBackBtn = el('button', BTN + ';font-size:12px', visitBar)

  const popupLayer = el('div', 'position:absolute;inset:0;overflow:hidden;pointer-events:none', root)
  const previewChip = el('div', 'position:absolute;display:none;padding:2px 8px;border-radius:8px;background:rgba(10,14,26,0.72);font-size:13px;font-weight:600;pointer-events:none;transform:translate(-50%,-100%)', root)
  const nbTip = el('div', 'position:absolute;display:none;padding:3px 10px;border-radius:8px;background:rgba(10,14,26,0.72);font-size:12.5px;pointer-events:none;transform:translate(-50%,-100%);color:#dfe8f5;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', root)

  const styleTag = document.createElement('style')
  styleTag.textContent = '@keyframes mipop{from{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-36px)}}'
  root.appendChild(styleTag)

  const api: Ui = {
    root,
    onSelect: () => undefined,
    onMute: () => undefined,
    onRedraft: () => undefined,
    onSeaOpen: () => undefined,
    setDict(d) {
      dict = d
      muteBtn.textContent = muted ? dict.unmute : dict.mute
      rulesBtn.textContent = dict.rulesBtn
      seaBtn.textContent = dict.sea
      if (rulesOpen) renderRules()
    },
    setDay(day) {
      dayEl.textContent = dict.day(day)
    },
    setScore(n) {
      scoreEl.textContent = `${dict.score} ${n}`
    },
    setRound(r, nextUnlock) {
      const tail = nextUnlock === null ? dict.hudDone : dict.hudNext(nextUnlock)
      roundEl.textContent = `${dict.round(r + 1, ROUNDS.length)} · ${tail}`
    },
    setTray(items, selected, canRedraft) {
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
      if (canRedraft && items.length) {
        const back = el('button', `${BTN};font-size:12px;opacity:0.85;align-self:center`, tray)
        back.textContent = dict.redraft
        back.onclick = () => api.onRedraft()
      }
      if (selected && items.includes(selected)) {
        selInfo.textContent = `${dict.b[selected] ?? selected}：${dict.bHint[selected] ?? ''}`
        selInfo.style.display = 'block'
      } else {
        selInfo.style.display = 'none'
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
    showPreview(pt, text, good) {
      if (!pt) {
        previewChip.style.display = 'none'
        return
      }
      previewChip.style.display = 'block'
      previewChip.style.left = `${(pt.x * 100).toFixed(2)}%`
      previewChip.style.top = `${(pt.y * 100).toFixed(2)}%`
      previewChip.style.color = good ? '#c8f0a8' : '#ffab98'
      previewChip.textContent = text
    },
    showNeighborTip(pt, text) {
      if (!pt) {
        nbTip.style.display = 'none'
        return
      }
      nbTip.style.display = 'block'
      nbTip.style.left = `${(pt.x * 100).toFixed(2)}%`
      nbTip.style.top = `${(pt.y * 100).toFixed(2)}%`
      nbTip.textContent = text
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
    showSettle(opts) {
      settleTitle.textContent = dict.settledTitle
      settleSub.textContent = (opts.stuck ? `${dict.settledStuck} · ` : '') + dict.settledScore(opts.score)
      settleStatusEl.textContent = opts.signInHint ? dict.signInToSave : ''
      settleName.style.display = opts.canSave ? 'block' : 'none'
      settleSave.style.display = opts.canSave ? 'inline-block' : 'none'
      settleName.maxLength = 18
      settleName.placeholder = dict.namePlaceholder
      settleSave.textContent = dict.saveIsle
      settleSave.disabled = false
      settleSave.onclick = () => {
        settleSave.disabled = true
        opts.onSave(settleName.value.trim())
      }
      settleBtn.textContent = dict.again
      settleBtn.onclick = opts.onAgain
      settleWrap.style.display = 'flex'
    },
    settleStatus(msg) {
      settleStatusEl.textContent = msg
      settleSave.disabled = false
    },
    hideSettle() {
      settleWrap.style.display = 'none'
    },
    showSea(rows, hasMore, onVisit, onMore) {
      seaTitleEl.textContent = dict.seaTitle
      seaList.textContent = ''
      if (!rows.length) {
        const empty = el('div', 'font-size:13px;opacity:0.75;padding:14px 4px', seaList)
        empty.textContent = dict.seaEmpty
      }
      for (const row of rows) {
        const line = el('div', 'display:flex;align-items:center;gap:10px;border:1px solid rgba(255,255,255,0.14);border-radius:9px;padding:9px 12px', seaList)
        const info = el('div', 'flex:1;min-width:0', line)
        const nm = el('div', 'font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', info)
        nm.textContent = row.name + (row.mine ? ` · ${dict.seaMine}` : '')
        const by = el('div', 'font-size:11.5px;opacity:0.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', info)
        by.textContent = dict.seaBy(row.author)
        if (row.lamps > 0) {
          const lp = el('div', 'font-size:12px;opacity:0.8;flex-shrink:0;color:#ffd98a', line)
          lp.textContent = dict.lampCount(row.lamps)
        }
        const sc = el('div', 'font-size:13px;font-weight:600;flex-shrink:0', line)
        sc.textContent = dict.seaScore(row.score)
        const go = el('button', BTN + ';font-size:12px;flex-shrink:0', line)
        go.textContent = dict.seaVisit
        go.onclick = () => onVisit(row)
      }
      seaMore.textContent = dict.seaLoadMore
      seaMore.style.display = hasMore ? 'inline-block' : 'none'
      seaMore.onclick = onMore
      seaClose.textContent = dict.rulesClose
      seaWrap.style.display = 'flex'
    },
    hideSea() {
      seaWrap.style.display = 'none'
    },
    showVisit(info, onLamp, onBack) {
      visitLabel.textContent = dict.visiting(info.label)
      visitLamps.textContent = dict.lampCount(info.lamps)
      visitLampBtn.textContent = info.lamped ? dict.lamped : dict.lamp
      visitLampBtn.disabled = info.lamped || !info.canLamp
      visitLampBtn.style.display = info.canLamp || info.lamped ? 'inline-block' : 'none'
      visitLampBtn.onclick = onLamp
      visitBackBtn.textContent = dict.backHome
      visitBackBtn.onclick = onBack
      visitBar.style.display = 'flex'
    },
    updateVisit(lamps, lamped) {
      visitLamps.textContent = dict.lampCount(lamps)
      visitLampBtn.textContent = lamped ? dict.lamped : dict.lamp
      visitLampBtn.disabled = lamped
    },
    hideVisit() {
      visitBar.style.display = 'none'
    },
    dispose() {
      window.clearTimeout(hintTimer)
      root.remove()
    },
  }
  muteBtn.textContent = dict.mute
  rulesBtn.textContent = dict.rulesBtn
  seaBtn.textContent = dict.sea
  seaBtn.onclick = () => api.onSeaOpen()
  muteBtn.onclick = () => {
    muted = !muted
    muteBtn.textContent = muted ? dict.unmute : dict.mute
    api.onMute(muted)
  }
  return api
}

export function applyStateToUi(ui: Ui, state: GameState, selected: BType | null, canRedraft: boolean): void {
  ui.setScore(state.score)
  ui.setRound(state.round, state.round + 1 < ROUNDS.length ? ROUNDS[state.round + 1]!.unlock : null)
  ui.setTray(state.tray, selected, canRedraft)
}
