/**
 * 万灯市 · Lantern Row — Arena's advertising bazaar, as a world.
 *
 * A night street where every stall is a home for a live world from this repo's
 * own registry: a procedural demo plays in each window, ambient passers-by
 * drift between stalls weighted by how many lamps visitors have lit, and the
 * empty plots are the product — a place a prospective partner can preview
 * their own booth (purely local, writes nothing) or hang an intent lantern
 * (a lead, stored).
 *
 * What is stored vs. baked in:
 *   stalls   — BAKED IN. A stall advertises another world, which is an
 *              editorial decision; it changes by PR through review.
 *   lamps    — append-only, one per (visitor, stall). Public appreciation;
 *              drives the crowd sim and the numbers partners see.
 *   intents  — one per (visitor, empty plot), author-editable. Leads.
 *
 * The sandbox cannot navigate anywhere, so no element here pretends to be a
 * link: game homes are shown as plain text paths, and the real links live in
 * about.md, which Arena renders in its own chrome.
 */
import { defineWorld, type Collection, type WorldCtx, type WorldError } from '@arena/world-sdk'
import { makePlots, PLOT_W, type Plot, type PreviewData } from './data.js'
import { strings, type Strings } from './i18n.js'
import { Scene } from './render.js'

interface Lamp { stall: string }
interface Intent { plot: string; name: string; note?: string }

const PREVIEW_KEY = 'preview:v1'
const SWATCHES = ['#e8655a', '#f0a03c', '#57d18e', '#5aa9ff', '#b98bff']

export default defineWorld({
  meta: { type: 'lantern-row' },

  async mount(root, ctx) {
    const market = new Market(root, ctx)
    await market.start()
  },
})

type SheetState =
  | { kind: 'closed' }
  | { kind: 'bulletin' }
  | { kind: 'stall'; id: string }
  | { kind: 'empty'; id: string }
  | { kind: 'wish'; id: string }
  | { kind: 'preview' }

class Market {
  private readonly lamps: Collection<Lamp>
  private readonly intents: Collection<Intent>
  private readonly plots: Plot[]
  private readonly scene: Scene
  private msg: Strings

  private readonly canvas: HTMLCanvasElement
  private readonly hudTitle: HTMLHeadingElement
  private readonly hudSub: HTMLSpanElement
  private readonly hudHint: HTMLParagraphElement
  private readonly bulletinBtn: HTMLButtonElement
  private readonly previewBtn: HTMLButtonElement
  private readonly sheet: HTMLDivElement
  private readonly sheetBody: HTMLDivElement
  private readonly toastEl: HTMLDivElement

  private sheetState: SheetState = { kind: 'closed' }
  private toastTimer: number | null = null
  private refreshTimer: number | null = null
  private ghostToastPending = false
  private lastW = 0
  private lastH = 0
  private lastT = 0

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: WorldCtx,
  ) {
    this.lamps = ctx.collection<Lamp>('lamps')
    this.intents = ctx.collection<Intent>('intents')
    this.plots = makePlots()
    this.msg = strings(ctx.lang)

    root.innerHTML = ''
    root.classList.add('lr')

    const style = document.createElement('style')
    style.textContent = SHEET_CSS
    root.appendChild(style)

    this.canvas = document.createElement('canvas')
    this.canvas.className = 'lr-stage'
    root.appendChild(this.canvas)

    const hud = el('header', 'lr-hud')
    this.hudTitle = document.createElement('h1')
    this.hudSub = el('span', 'lr-hud-en')
    this.hudTitle.appendChild(this.hudSub)
    this.hudHint = el('p', 'lr-hud-hint')
    hud.append(this.hudTitle, this.hudHint)
    root.appendChild(hud)

    const cta = el('div', 'lr-cta')
    this.bulletinBtn = btn('lr-btn lr-btn-amber')
    this.previewBtn = btn('lr-btn')
    cta.append(this.bulletinBtn, this.previewBtn)
    root.appendChild(cta)

    this.sheet = el('div', 'lr-sheet lr-hidden')
    const close = btn('lr-sheet-close')
    close.textContent = '×'
    close.setAttribute('aria-label', 'close')
    close.addEventListener('click', () => this.closeSheet())
    this.sheetBody = el('div', 'lr-sheet-body')
    this.sheet.append(close, this.sheetBody)
    root.appendChild(this.sheet)

    this.toastEl = el('div', 'lr-toast lr-hidden')
    root.appendChild(this.toastEl)

    this.scene = new Scene(this.canvas, this.plots, this.msg)
    this.scene.setStrings(this.msg, ctx.lang === 'zh')
    this.applyStaticText()

    this.bulletinBtn.addEventListener('click', () => this.openBulletin())
    this.previewBtn.addEventListener('click', () => this.openPreviewForm())
    this.wireInput()

    ctx.onLangChange((lang) => {
      this.msg = strings(lang)
      this.scene.setStrings(this.msg, lang === 'zh')
      this.applyStaticText()
      this.rerenderSheet()
    })
    ctx.onVisitor(() => {
      void this.refresh()
    })
    this.lamps.onChange(() => this.queueRefresh())
    this.intents.onChange(() => this.queueRefresh())
  }

  async start(): Promise<void> {
    await this.restorePreview()
    await this.refresh()
    this.loop(performance.now())
    this.openBulletin()
  }

  /* ────────────────────────── frame loop ────────────────────────── */

  private loop(now: number): void {
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    if ((w !== this.lastW || h !== this.lastH) && w > 0 && h > 0) {
      this.lastW = w
      this.lastH = h
      this.scene.resize(w, h, window.devicePixelRatio || 1)
    }
    const t = now / 1000
    const dt = Math.min(Math.max(t - (this.lastT || t), 0.001), 0.05)
    this.lastT = t
    if (w > 0 && h > 0) this.scene.frame(t, dt)

    const ghost = this.ghost()
    if (this.ghostToastPending && ghost.preview && ghost.buildT >= 1) {
      this.ghostToastPending = false
      this.toast(this.msg.openedToast)
      this.scene.burstAt(ghost.x + PLOT_W / 2, 430)
    }
    requestAnimationFrame((n) => this.loop(n))
  }

  /* ────────────────────────── input ────────────────────────── */

  private wireInput(): void {
    const cv = this.canvas
    let down = false
    let moved = 0
    let sx = 0
    let lastX = 0
    let lastMoveT = 0
    let vx = 0

    const press = (x: number): void => {
      down = true
      moved = 0
      sx = x
      lastX = x
      lastMoveT = performance.now()
      vx = 0
      this.scene.stopAuto()
    }
    const move = (x: number): void => {
      if (!down) return
      const dx = x - lastX
      moved = Math.max(moved, Math.abs(x - sx))
      this.scene.panBy(dx)
      const now = performance.now()
      const dts = (now - lastMoveT) / 1000
      if (dts > 0.001) vx = -dx / dts
      lastX = x
      lastMoveT = now
    }
    const release = (x: number, y: number): void => {
      if (!down) return
      down = false
      if (moved < 6) {
        const hit = this.scene.hit(this.scene.worldX(x), this.scene.worldY(y))
        if (!hit) { this.closeSheet(); return }
        if (hit.type === 'bulletin') { this.openBulletin(); return }
        this.openPlot(hit.plot)
      } else {
        this.scene.flingBy(vx)
      }
    }

    cv.addEventListener('mousedown', (e) => press(e.clientX))
    cv.addEventListener('mousemove', (e) => {
      if (down) { move(e.clientX); return }
      const hit = this.scene.hit(this.scene.worldX(e.clientX), this.scene.worldY(e.clientY))
      cv.style.cursor = hit ? 'pointer' : 'grab'
    })
    cv.addEventListener('mouseup', (e) => release(e.clientX, e.clientY))
    cv.addEventListener('mouseleave', () => { down = false })
    cv.addEventListener('touchstart', (e) => {
      const t0 = e.touches[0]
      if (t0) press(t0.clientX)
    }, { passive: true })
    cv.addEventListener('touchmove', (e) => {
      const t0 = e.touches[0]
      if (t0) move(t0.clientX)
    }, { passive: true })
    cv.addEventListener('touchend', (e) => {
      const t0 = e.changedTouches[0]
      if (t0) release(t0.clientX, t0.clientY)
    })
    cv.addEventListener('wheel', (e) => {
      this.scene.stopAuto()
      this.scene.panBy(-(e.deltaY + e.deltaX) * 0.9)
    }, { passive: true })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { this.scene.stopAuto(); this.scene.panBy(-90 * 1.15) }
      if (e.key === 'ArrowLeft') { this.scene.stopAuto(); this.scene.panBy(90 * 1.15) }
      if (e.key === 'Escape') this.closeSheet()
    })
  }

  /* ────────────────────────── storage sync ────────────────────────── */

  private queueRefresh(): void {
    if (this.refreshTimer !== null) return
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, 700)
  }

  private async refresh(): Promise<void> {
    const live = this.plots.filter((p) => p.kind === 'live' || p.kind === 'demo')
    const counts = await Promise.all(
      live.map((p) => this.lamps.count({ where: { 'payload.stall': { eq: p.id } } }).catch(() => p.lamps)),
    )
    live.forEach((p, i) => { p.lamps = counts[i] ?? p.lamps })

    const mine = new Set<string>()
    if (this.ctx.me) {
      const page = await this.lamps.list({ mine: true, limit: 50 }).catch(() => null)
      if (page) for (const r of page.items) mine.add(r.payload.stall)
    }
    for (const p of live) p.myLamp = mine.has(p.id)

    for (const p of this.plots) {
      if (p.kind !== 'empty') continue
      const page = await this.intents
        .list({ where: { 'payload.plot': { eq: p.id } }, limit: 50, sort: ['createdAt'] })
        .catch(() => null)
      if (!page) continue
      p.wishes = page.items.map((r) => ({
        id: r.id,
        name: r.payload.name,
        note: r.payload.note ?? '',
        mine: r.mine,
      }))
      const mineWish = page.items.find((r) => r.mine)
      p.myWishId = mineWish ? mineWish.id : null
    }
    this.rerenderSheet()
  }

  private async restorePreview(): Promise<void> {
    const saved = await this.ctx.local.get<PreviewData>(PREVIEW_KEY).catch(() => null)
    if (!saved || !saved.name) return
    const ghost = this.ghost()
    ghost.preview = { name: String(saved.name).slice(0, 12), tag: String(saved.tag ?? '').slice(0, 20), color: SWATCHES.includes(saved.color) ? saved.color : SWATCHES[1] ?? '#f0a03c' }
    ghost.buildT = 1
    ghost.heat = 40
    this.toast(this.msg.restoredToast)
  }

  private ghost(): Plot {
    const g = this.plots.find((p) => p.kind === 'ghost')
    if (!g) throw new Error('street lost its ghost plot')
    return g
  }

  private errToast(e: unknown, dupeMsg: string): void {
    const code = (e && typeof e === 'object' && 'code' in e) ? (e as WorldError).code : null
    if (code === 'unique') this.toast(dupeMsg)
    else if (code === 'unauthenticated') this.toast(this.msg.lampAnon)
    else if (code === 'quota') this.toast(this.msg.quotaErr)
    else if (code === 'rate-limited') this.toast(this.msg.rateErr)
    else this.toast(this.msg.unavailableErr)
  }

  /* ────────────────────────── static text ────────────────────────── */

  private applyStaticText(): void {
    const m = this.msg
    this.hudTitle.childNodes.forEach((n) => { if (n.nodeType === Node.TEXT_NODE) n.remove() })
    this.hudTitle.insertBefore(document.createTextNode(m.title + ' '), this.hudSub)
    this.hudSub.textContent = m.titleSub
    this.hudHint.textContent = m.hudHint
    this.bulletinBtn.textContent = m.bulletinBtn
    this.previewBtn.textContent = m.previewBtn
  }

  /* ────────────────────────── sheets ────────────────────────── */

  private openSheet(state: SheetState): void {
    this.sheetState = state
    this.sheet.classList.remove('lr-hidden')
    this.renderSheet()
  }

  private closeSheet(): void {
    this.sheetState = { kind: 'closed' }
    this.sheet.classList.add('lr-hidden')
  }

  private rerenderSheet(): void {
    if (this.sheetState.kind === 'closed') return
    this.renderSheet()
  }

  private openBulletin(): void { this.openSheet({ kind: 'bulletin' }) }

  private openPlot(p: Plot): void {
    if (p.kind === 'empty') { this.openSheet({ kind: 'empty', id: p.id }); return }
    if (p.kind === 'ghost' && !p.preview) { this.openPreviewForm(); return }
    this.openSheet({ kind: 'stall', id: p.id })
  }

  private openPreviewForm(): void { this.openSheet({ kind: 'preview' }) }

  private renderSheet(): void {
    const st = this.sheetState
    this.sheetBody.innerHTML = ''
    if (st.kind === 'bulletin') this.renderBulletin()
    else if (st.kind === 'stall') this.renderStall(st.id)
    else if (st.kind === 'empty') this.renderEmpty(st.id)
    else if (st.kind === 'wish') this.renderWishForm(st.id)
    else if (st.kind === 'preview') this.renderPreviewForm()
  }

  private renderBulletin(): void {
    const m = this.msg
    const b = this.sheetBody
    b.appendChild(head(m.welcomeTitle, 'HOW IT WORKS'))
    b.appendChild(el('p', 'lr-tag', m.welcomeTag))
    const ol = el('ol', 'lr-steps')
    const steps: Array<[string, string]> = [
      [m.step1Head, m.step1Rest],
      [m.step2Head, m.step2Rest],
      [m.step3Head, m.step3Rest],
    ]
    steps.forEach(([headTxt, rest], i) => {
      const li = el('li', '')
      const n = el('span', 'lr-step-n', String(i + 1))
      const bb = el('b', '', headTxt)
      li.append(n, bb, document.createTextNode(rest))
      ol.appendChild(li)
    })
    b.appendChild(ol)
    const note = el('p', 'lr-note')
    note.append(
      document.createTextNode(m.mutualLead),
      el('span', 'lr-warm', m.mutualChain),
      document.createTextNode(m.mutualTail),
    )
    b.appendChild(note)
    b.appendChild(el('p', 'lr-note', m.linksHint))
    const row = el('div', 'lr-row')
    const pv = btn('lr-btn lr-btn-amber')
    pv.textContent = m.previewBtn
    pv.addEventListener('click', () => this.openPreviewForm())
    row.appendChild(pv)
    b.appendChild(row)
  }

  private renderStall(id: string): void {
    const m = this.msg
    const p = this.plots.find((x) => x.id === id)
    if (!p) return
    const zh = this.ctx.lang === 'zh'
    const b = this.sheetBody
    const isGhost = p.kind === 'ghost'
    const name = isGhost && p.preview ? p.preview.name : (zh ? p.nameZh : p.nameEn)
    const tag = isGhost && p.preview ? (p.preview.tag || '—') : (zh ? p.tagZh : p.tagEn)
    b.appendChild(head(name, isGhost ? 'YOUR BOOTH' : p.caption))
    b.appendChild(el('p', 'lr-tag', tag))

    if (!isGhost) {
      const dots = el('div', 'lr-dots')
      const n = Math.min(p.lamps, 10)
      for (let i = 0; i < n; i++) dots.appendChild(el('i', ''))
      b.appendChild(dots)
      b.appendChild(el('p', 'lr-dim', m.popLabel(p.lamps)))
      if (p.kind === 'demo') b.appendChild(el('p', 'lr-note', m.demoChain))
      const pathLine = el('p', 'lr-note')
      pathLine.append(document.createTextNode(m.stallPathLead), el('span', 'lr-warm', p.path))
      b.appendChild(pathLine)
      b.appendChild(el('p', 'lr-note', m.linksHint))
    } else {
      b.appendChild(el('p', 'lr-note', m.ghostNote))
    }

    const row = el('div', 'lr-row')
    if (isGhost) {
      const pack = btn('lr-btn')
      pack.textContent = m.packBtn
      pack.addEventListener('click', () => {
        const g = this.ghost()
        g.preview = null
        g.buildT = 1
        g.heat = 6
        void this.ctx.local.del(PREVIEW_KEY).catch(() => undefined)
        this.closeSheet()
        this.toast(m.packedToast)
      })
      row.appendChild(pack)
    } else {
      const copy = btn('lr-btn lr-btn-amber')
      copy.textContent = m.copyBtn
      copy.addEventListener('click', () => { void this.copyPath(p) })
      row.appendChild(copy)
      const lamp = btn('lr-btn')
      lamp.textContent = p.myLamp ? m.lampLit : m.lampBtn
      lamp.disabled = p.myLamp
      lamp.addEventListener('click', () => { void this.lightLamp(p, lamp) })
      row.appendChild(lamp)
    }
    b.appendChild(row)
  }

  /**
   * The sandbox has no `allow-popups`, so nothing in here can OPEN the game's
   * page — the honest best is putting the URL on the clipboard. The clickable
   * links live in about.md, which Arena renders outside the sandbox.
   */
  private async copyPath(p: Plot): Promise<void> {
    const url = 'https://' + p.path
    let ok = false
    try {
      await navigator.clipboard.writeText(url)
      ok = true
    } catch {
      ok = legacyCopy(url)
    }
    this.toast(ok ? this.msg.copiedToast : this.msg.copyFail)
  }

  private async lightLamp(p: Plot, button: HTMLButtonElement): Promise<void> {
    const m = this.msg
    if (!this.ctx.me) { this.toast(m.lampAnon); return }
    button.disabled = true
    try {
      await this.lamps.add({ stall: p.id })
      p.lamps += 1
      p.myLamp = true
      p.flash = 1
      p.heat += 30
      this.scene.burstAt(p.x + PLOT_W / 2, 424)
      const zh = this.ctx.lang === 'zh'
      this.toast(m.lampDone(zh ? p.nameZh : p.nameEn, p.lamps))
      this.rerenderSheet()
    } catch (e) {
      button.disabled = false
      this.errToast(e, m.lampDupe)
    }
  }

  private renderEmpty(id: string): void {
    const m = this.msg
    const p = this.plots.find((x) => x.id === id)
    if (!p) return
    const b = this.sheetBody
    b.appendChild(head(m.emptyTitle, 'FOR RENT'))
    b.appendChild(el('p', 'lr-tag', m.emptyTag))
    b.appendChild(el('p', 'lr-note', m.emptySteps))
    if (p.wishes.length) {
      const line = el('p', 'lr-note')
      line.appendChild(document.createTextNode(m.intentLead(p.wishes.length)))
      const names = p.wishes.slice(0, 6).map((w) => w.name).join(' · ')
      const extra = p.wishes.length > 6 ? ' +' + (p.wishes.length - 6) : ''
      line.appendChild(el('span', 'lr-warm', names + extra))
      b.appendChild(line)
    }
    const row = el('div', 'lr-row')
    const pv = btn('lr-btn lr-btn-amber')
    pv.textContent = m.previewHereBtn
    pv.addEventListener('click', () => this.openPreviewForm())
    row.appendChild(pv)
    if (p.myWishId) {
      const take = btn('lr-btn')
      take.textContent = m.wishMineBtn
      take.addEventListener('click', () => { void this.removeWish(p) })
      row.appendChild(take)
    } else {
      const hang = btn('lr-btn')
      hang.textContent = m.wishBtn
      hang.addEventListener('click', () => {
        if (!this.ctx.me) { this.toast(m.wishAnon); return }
        this.openSheet({ kind: 'wish', id: p.id })
      })
      row.appendChild(hang)
    }
    b.appendChild(row)
  }

  private async removeWish(p: Plot): Promise<void> {
    if (!p.myWishId) return
    try {
      await this.intents.del(p.myWishId)
      p.myWishId = null
      p.wishes = p.wishes.filter((w) => !w.mine)
      this.toast(this.msg.wishRemoved)
      this.rerenderSheet()
    } catch (e) {
      this.errToast(e, this.msg.wishDupe)
    }
  }

  private renderWishForm(id: string): void {
    const m = this.msg
    const b = this.sheetBody
    b.appendChild(head(m.wishTitle, 'INTENT LANTERN'))
    b.appendChild(el('p', 'lr-tag', m.wishTag))
    const form = el('div', 'lr-form')
    const name = input(m.wishPlaceholder, 16)
    const note = input(m.wishNotePlaceholder, 40)
    const err = el('p', 'lr-err')
    err.style.display = 'none'
    const go = btn('lr-btn lr-btn-amber')
    go.textContent = m.wishSubmit
    go.addEventListener('click', () => { void submit() })
    name.addEventListener('input', () => { err.style.display = 'none' })
    form.append(name, note, err, go)
    b.appendChild(form)

    const submit = async (): Promise<void> => {
      const v = name.value.trim()
      if (!v) {
        err.textContent = m.wishErr
        err.style.display = 'block'
        name.focus()
        return
      }
      go.disabled = true
      try {
        const payload: Intent = { plot: id, name: v }
        const noteV = note.value.trim()
        if (noteV) payload.note = noteV
        await this.intents.add(payload)
        this.toast(m.wishDone(v))
        await this.refresh()
        this.openSheet({ kind: 'empty', id })
      } catch (e) {
        go.disabled = false
        this.errToast(e, m.wishDupe)
      }
    }
  }

  private renderPreviewForm(): void {
    const m = this.msg
    const b = this.sheetBody
    b.appendChild(head(m.previewTitle, 'TRY YOUR BOOTH'))
    b.appendChild(el('p', 'lr-tag', m.previewTag))
    const form = el('div', 'lr-form')
    const name = input(m.namePlaceholder, 12)
    const tag = input(m.tagPlaceholder, 20)
    const sw = el('div', 'lr-swatches')
    let chosen = SWATCHES[1] ?? '#f0a03c'
    SWATCHES.forEach((c, i) => {
      const s = btn('lr-swatch' + (i === 1 ? ' lr-active' : ''))
      s.style.background = c
      s.setAttribute('aria-label', c)
      s.addEventListener('click', () => {
        chosen = c
        sw.querySelectorAll('.lr-swatch').forEach((x) => x.classList.remove('lr-active'))
        s.classList.add('lr-active')
      })
      sw.appendChild(s)
    })
    const err = el('p', 'lr-err')
    err.style.display = 'none'
    const go = btn('lr-btn lr-btn-amber')
    go.textContent = m.openBtn
    go.addEventListener('click', () => {
      const v = name.value.trim()
      if (!v) {
        err.textContent = m.nameErr
        err.style.display = 'block'
        name.focus()
        return
      }
      const ghost = this.ghost()
      ghost.preview = { name: v, tag: tag.value.trim(), color: chosen }
      ghost.buildT = 0
      ghost.heat = 620
      this.ghostToastPending = true
      this.scene.flock(ghost, 7)
      this.scene.flyTo(ghost.x + PLOT_W / 2)
      void this.ctx.local.set(PREVIEW_KEY, ghost.preview).catch(() => undefined)
      this.closeSheet()
    })
    name.addEventListener('input', () => { err.style.display = 'none' })
    form.append(name, tag, sw, err, go)
    b.appendChild(form)
  }

  /* ────────────────────────── toast ────────────────────────── */

  private toast(text: string): void {
    this.toastEl.textContent = text
    this.toastEl.classList.remove('lr-hidden')
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('lr-hidden'), 2600)
  }
}

/* ────────────────────────── DOM helpers ────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

function btn(cls: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  return b
}

function input(placeholder: string, maxLen: number): HTMLInputElement {
  const i = document.createElement('input')
  i.className = 'lr-input'
  i.placeholder = placeholder
  i.maxLength = maxLen
  return i
}

function head(title: string, en: string): HTMLHeadingElement {
  const h = el('h2', 'lr-head', title + ' ')
  h.appendChild(el('span', 'lr-head-en', en))
  return h
}

/** `navigator.clipboard` is unavailable in an opaque-origin frame; this is the fallback. */
function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

/* ────────────────────────── stylesheet ────────────────────────── */

const SHEET_CSS = `
.lr { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0b0e1a; color: #ede6d8; font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif; }
.lr-stage { position: absolute; inset: 0; display: block; touch-action: pan-y; }
.lr-hud { position: absolute; top: 22px; left: 26px; pointer-events: none; text-shadow: 0 2px 12px rgba(0,0,0,0.8); }
.lr-hud h1 { font-size: 26px; font-weight: 600; margin: 0 0 4px; letter-spacing: 0.12em; color: #ffe9c4; }
.lr-hud-en { font-size: 13px; font-weight: 400; letter-spacing: 0.3em; color: #b8a888; margin-left: 6px; }
.lr-hud-hint { font-size: 13px; color: #a99a82; margin: 0; letter-spacing: 0.05em; }
.lr-cta { position: absolute; top: 24px; right: 26px; display: flex; gap: 10px; z-index: 5; }
.lr-btn { font-size: 14px; padding: 10px 18px; border-radius: 10px; border: 1px solid rgba(255,214,150,0.22); background: rgba(20,16,10,0.72); color: #cbbf9e; cursor: pointer; font-family: inherit; }
.lr-btn:hover { background: rgba(50,38,20,0.85); border-color: rgba(255,214,150,0.5); color: #ffe9c4; }
.lr-btn:disabled { opacity: 0.55; cursor: default; }
.lr-btn-amber { background: linear-gradient(180deg, #f5b350, #dd8f2e); border-color: #f5b350; color: #2a1a06; font-weight: 600; }
.lr-btn-amber:hover { background: linear-gradient(180deg, #ffc76a, #eea23d); color: #2a1a06; }
.lr-cta .lr-btn-amber { box-shadow: 0 4px 24px -6px rgba(245,179,80,0.55); }
.lr-sheet { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); width: min(560px, calc(100% - 32px)); background: rgba(16,13,20,0.92); border: 1px solid rgba(255,220,160,0.18); border-radius: 18px; padding: 22px 24px; backdrop-filter: blur(14px); box-shadow: 0 18px 60px -12px rgba(0,0,0,0.8); transition: transform .25s ease, opacity .25s ease; z-index: 10; }
.lr-sheet.lr-hidden { opacity: 0; transform: translateX(-50%) translateY(24px); pointer-events: none; }
.lr-sheet-close { position: absolute; top: 10px; right: 14px; background: none; border: none; color: #8a7d68; font-size: 22px; cursor: pointer; line-height: 1; padding: 4px; }
.lr-sheet-close:hover { color: #ffe9c4; }
.lr-head { font-size: 19px; font-weight: 600; margin: 0 0 2px; color: #ffe9c4; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.lr-head-en { font-size: 12px; font-weight: 400; letter-spacing: 0.18em; color: #9c8d75; }
.lr-tag { font-size: 13px; color: #b3a58d; margin: 2px 0 0; line-height: 1.6; }
.lr-note { font-size: 13px; color: #93876f; margin: 10px 0 0; line-height: 1.65; }
.lr-dim { font-size: 12.5px; color: #9c8d75; margin: 6px 0 0; }
.lr-warm { color: #f0b45c; }
.lr-steps { margin: 12px 0 0; padding: 0; list-style: none; }
.lr-steps li { font-size: 13.5px; color: #cfc2a8; padding: 7px 0 7px 30px; position: relative; line-height: 1.55; }
.lr-steps b { color: #ffe9c4; font-weight: 600; }
.lr-step-n { position: absolute; left: 0; top: 7px; width: 20px; height: 20px; border-radius: 50%; background: rgba(245,179,80,0.16); border: 1px solid rgba(245,179,80,0.45); color: #f0b45c; font-size: 11px; display: flex; align-items: center; justify-content: center; }
.lr-dots { display: flex; gap: 5px; margin-top: 10px; flex-wrap: wrap; }
.lr-dots i { width: 7px; height: 7px; border-radius: 50%; background: #f0b45c; box-shadow: 0 0 8px rgba(240,180,92,0.8); }
.lr-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
.lr-form { display: flex; flex-direction: column; gap: 12px; margin-top: 14px; }
.lr-input { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,220,160,0.18); border-radius: 10px; padding: 11px 13px; color: #ede6d8; font-size: 14px; width: 100%; font-family: inherit; box-sizing: border-box; }
.lr-input::placeholder { color: #6d6350; }
.lr-input:focus { outline: none; border-color: rgba(245,179,80,0.6); }
.lr-swatches { display: flex; gap: 10px; }
.lr-swatch { width: 30px; height: 30px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.lr-swatch.lr-active { border-color: #ffe9c4; box-shadow: 0 0 10px rgba(255,233,196,0.5); }
.lr-err { color: #ff9a8a; font-size: 12.5px; margin: -4px 0 0; }
.lr-toast { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); background: rgba(24,19,12,0.94); border: 1px solid rgba(245,179,80,0.4); color: #ffe9c4; padding: 11px 22px; border-radius: 30px; font-size: 13.5px; z-index: 30; box-shadow: 0 8px 32px -8px rgba(0,0,0,0.8); transition: opacity .3s ease; white-space: nowrap; max-width: calc(100% - 40px); overflow: hidden; text-overflow: ellipsis; }
.lr-toast.lr-hidden { opacity: 0; pointer-events: none; }
@media (max-width: 560px) {
  .lr-hud h1 { font-size: 20px; }
  .lr-cta { top: auto; bottom: 20px; right: 20px; }
}
`
