/**
 * 漂流瓶 · Drift Bottle
 *
 * You write one line, cork it, and throw it into a sea everyone else is throwing
 * into. Later you haul something out — someone else's line, from someone else's
 * hour — and you may answer it exactly once. Then you go and see whether anyone
 * answered yours.
 *
 * Two collections carry all of that, and neither of them knows what a bottle is:
 *
 *   `bottles` — append-only (`write: 'none'`), five per visitor. Append-only is
 *               the whole feeling of the thing: once it is in the water you
 *               cannot edit what you said. You can still `del` your own — that
 *               is ownership, not write policy — which the world spends as
 *               "haul it in and sink it".
 *   `replies` — append-only too, `unique` on (author, target). "One reply per
 *               person per bottle" is not a platform feature; it is a second
 *               collection whose payload holds a target id and a constraint.
 *
 * Fishing at random is the one thing the query surface does not offer directly.
 * A world cannot ask for "any row"; it can only page an index. So every bottle
 * carries a `drift` in [0,1) chosen when it is thrown, and hauling one out is
 * the first bottle at or after a random point on that circle — wrapping to the
 * start when the roll lands past the last one. One indexed float turns a
 * cursor into a lottery.
 *
 * Sound is synthesised (see `audio.ts`): the sandbox forbids the network, and
 * `ctx.audio()` waits for a real gesture, so the world says so in the corner and
 * is complete in silence if nobody ever clicks.
 */
import { defineWorld, type Collection, type Rec, type Visitor, type WorldCtx, type WorldError, type WorldTheme } from '@arena/world-sdk'
import { SeaSound } from './audio.js'
import { bottleSvg } from './glass.js'
import { ago, MOOD_HUE, MOODS, strings, type Mood } from './i18n.js'
import { DAWN, HORIZON, NIGHT, Sea } from './sea.js'
import { SHEET } from './style.js'

interface Bottle {
  text: string
  mood: Mood
  /** Position on the lottery circle, fixed at the throw. See the header. */
  drift: number
}

interface Reply {
  target: string
  text: string
}

const MAX_TEXT = 240
const MAX_REPLY = 160
/** How many bottles are on the water at once. The sea is bigger than the view. */
const AFLOAT = 20
/** Ids already hauled up, so the same bottle does not keep surfacing. */
const SEEN_KEY = 'seen'
const SEEN_KEPT = 80
const SOUND_KEY = 'sound'

type Panel =
  | { kind: 'compose' }
  | { kind: 'read'; bottle: Rec<Bottle>; replies: Rec<Reply>[] }
  | { kind: 'mine'; items: Rec<Bottle>[]; counts: Map<string, number> }
  | { kind: 'thread'; bottle: Rec<Bottle>; replies: Rec<Reply>[] }

export default defineWorld({
  meta: { type: 'drift-bottle' },

  async mount(root, ctx) {
    await new DriftBottle(root, ctx).start()
  },
})

class DriftBottle {
  private readonly bottles: Collection<Bottle>
  private readonly replies: Collection<Reply>
  private readonly sound: SeaSound
  private readonly sea: Sea

  private readonly fleet: HTMLDivElement
  private readonly scrim: HTMLDivElement
  private readonly headline: HTMLHeadingElement
  private readonly tagline: HTMLParagraphElement
  private readonly counter: HTMLDivElement
  private readonly soundBtn: HTMLButtonElement
  private readonly soundHint: HTMLDivElement
  private readonly dock: HTMLDivElement

  private t = strings('en')
  private panel: Panel | null = null
  private total = 0
  private busy = false
  private readonly seen = new Set<string>()
  /** Kept outside the panel state so a language change never eats a draft. */
  private draft = ''
  private replyDraft = ''
  private mood: Mood = 'longing'
  private readonly ships = new Map<string, HTMLElement>()

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: WorldCtx,
  ) {
    this.bottles = ctx.collection<Bottle>('bottles')
    this.replies = ctx.collection<Reply>('replies')
    this.t = strings(ctx.lang)

    root.innerHTML = ''
    root.className = 'db'
    const style = document.createElement('style')
    style.textContent = SHEET
    root.appendChild(style)

    const canvas = document.createElement('canvas')
    canvas.className = 'db-sea'
    root.appendChild(canvas)
    root.appendChild(div('db-veil'))

    this.fleet = div('db-fleet')
    root.appendChild(this.fleet)

    const head = div('db-head')
    this.headline = document.createElement('h1')
    this.tagline = document.createElement('p')
    head.append(this.headline, this.tagline)
    root.appendChild(head)

    const corner = div('db-corner')
    this.counter = div('db-count')
    this.soundBtn = document.createElement('button')
    this.soundBtn.className = 'db-btn db-btn--icon'
    this.soundBtn.onclick = () => void this.toggleSound()
    this.soundHint = div('db-hint')
    corner.append(this.counter, this.soundBtn, this.soundHint)
    root.appendChild(corner)

    this.dock = div('db-dock')
    root.appendChild(this.dock)

    this.scrim = div('db-scrim')
    this.scrim.hidden = true
    this.scrim.onclick = (e) => {
      if (e.target === this.scrim) this.close()
    }

    this.sea = new Sea(canvas)
    this.sound = new SeaSound(
      () => ctx.audio(),
      () => this.renderChrome(),
    )

    addEventListener('resize', () => this.sea.resize())
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panel) this.close()
    })
  }

  async start(): Promise<void> {
    this.applyTheme(this.ctx.theme)
    this.ctx.onThemeChange((theme) => this.applyTheme(theme))
    this.ctx.onLangChange((lang) => {
      this.t = strings(lang)
      this.renderChrome()
      this.renderPanel()
    })
    // Signing in mid-session changes every `mine` flag, so everything that draws
    // out of one — the panel, and the marks on the water — has to be rebuilt
    // around the new answer to "is this mine".
    this.ctx.onVisitor(() => {
      this.renderChrome()
      this.close()
      void this.refleet()
    })

    this.sea.start()
    this.renderChrome()

    // Fire and forget: the host resolves this on the first gesture inside the
    // frame, and until then the corner says the sea is mute.
    const pref = await this.ctx.local.get<string>(SOUND_KEY).catch(() => null)
    this.sound.enabled = pref !== 'off'
    this.sound.unlock()
    this.renderChrome()

    const remembered = await this.ctx.local.get<string[]>(SEEN_KEY).catch(() => null)
    for (const id of remembered ?? []) this.seen.add(id)

    // The host pre-fetched the first page into `init`, so the water is never
    // empty on arrival while a round trip is in flight.
    await this.refleet()

    this.bottles.onChange((e) => {
      if (e.op === 'deleted') {
        this.sink(e.id)
        this.total = Math.max(0, this.total - 1)
      } else if (e.op === 'added') {
        if (!this.ships.has(e.record.id)) {
          this.launch(e.record, true)
          this.total++
          if (!e.record.mine) this.sound.splash()
        }
      }
      this.renderChrome()
    })
  }

  /* ─────────────────────────── theme ─────────────────────────── */

  /**
   * Arena's tokens drive the panels; the sea keeps its own two palettes. A
   * letter on cream paper should not turn grey because the platform did.
   */
  private applyTheme(theme: WorldTheme): void {
    const dark = theme.mode === 'dark'
    const vars: Record<string, string> = {
      '--db-fg': theme.fg,
      '--db-subtle': theme.fgSubtle,
      '--db-accent': theme.accent,
      '--db-accent-fg': theme.accentFg,
      '--db-font': theme.font,
      '--db-edge': theme.border,
      '--db-glass': dark ? 'rgba(11,20,31,.86)' : 'rgba(252,252,253,.9)',
      '--db-well': dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.035)',
      '--db-ink': dark ? '76%' : '34%',
      '--db-wash': dark ? '24%' : '88%',
    }
    for (const [k, v] of Object.entries(vars)) this.root.style.setProperty(k, v)
    this.root.classList.toggle('db--light', !dark)
    this.sea.setPalette(dark ? NIGHT : DAWN)
  }

  /* ─────────────────────────── chrome ─────────────────────────── */

  private renderChrome(): void {
    const t = this.t
    this.headline.textContent = t.title
    this.tagline.textContent = t.tagline
    this.counter.textContent = t.afloat(this.total)

    this.soundBtn.textContent = this.sound.enabled ? `♪ ${t.soundOn}` : `♪ ${t.soundOff}`
    this.soundBtn.setAttribute('aria-pressed', String(this.sound.enabled))
    this.soundHint.textContent = this.sound.ready ? '' : t.soundHint

    this.dock.innerHTML = ''
    const fish = button(`↑ ${t.fishCta}`, 'db-btn')
    fish.onclick = () => void this.fish(fish)
    const cast = button(`✎ ${t.castCta}`, 'db-btn db-btn--primary')
    cast.onclick = () => {
      this.sound.tick()
      this.open({ kind: 'compose' })
    }
    this.dock.append(fish, cast)
    if (this.ctx.me) {
      const mine = button(t.mineCta, 'db-btn db-btn--ghost')
      mine.onclick = () => void this.openMine()
      this.dock.appendChild(mine)
    }
  }

  private async toggleSound(): Promise<void> {
    this.sound.setEnabled(!this.sound.enabled)
    this.sound.unlock()
    this.sound.tick()
    this.renderChrome()
    // A signed-out visitor has nowhere to keep a preference; that is ordinary,
    // and must never be the thing that decides whether the world works.
    void this.ctx.local.set(SOUND_KEY, this.sound.enabled ? 'on' : 'off').catch(() => {})
  }

  /* ─────────────────────────── the water ─────────────────────────── */

  /**
   * Re-read the newest page and repopulate the surface.
   *
   * Run at boot and again whenever identity changes: `mine` is computed by the
   * platform against whoever is asking, so the same records come back with
   * different marks on them.
   */
  private async refleet(): Promise<void> {
    for (const id of [...this.ships.keys()]) this.sink(id)
    const page = await this.bottles.list({ limit: AFLOAT, sort: ['-createdAt'] })
    for (const bottle of page.items) this.launch(bottle, false)
    this.total = await this.bottles.count()
    this.renderChrome()
  }

  /** Put a bottle on the surface at a random lane, drifting at its own pace. */
  private launch(bottle: Rec<Bottle>, arriving: boolean): void {
    if (this.ships.has(bottle.id)) return

    const el = document.createElement('button')
    // Your own bottles carry a mark. The sea is everyone's and the byline only
    // appears once a bottle is open, so without this there is no way to tell
    // which of the things drifting past you put there.
    el.className = `db-bottle${arriving ? ' db-bottle--new' : ''}${bottle.mine ? ' db-bottle--mine' : ''}`
    el.type = 'button'
    el.setAttribute('aria-label', bottle.mine ? this.t.mineOne : this.t.readTitle)
    const y = HORIZON * 100 + 6 + Math.random() * (92 - HORIZON * 100 - 6)
    const dur = 68 + Math.random() * 80
    el.style.setProperty('--y', `${y}%`)
    el.style.setProperty('--dur', `${dur}s`)
    el.style.setProperty('--delay', `${-Math.random() * dur}s`)
    el.style.setProperty('--wob', `${Math.random() * 1.6}s`)
    el.style.setProperty('--static-x', `${Math.random() * 88}vw`)
    el.style.setProperty('--h', String(MOOD_HUE[bottle.payload.mood] ?? 200))
    el.innerHTML = bottleSvg(bottle.id)
    el.onclick = () => void this.openBottle(bottle)

    this.fleet.appendChild(el)
    this.ships.set(bottle.id, el)
    if (arriving) this.ripple(y)

    // The view holds a sample, not the sea. Oldest out first so the surface
    // keeps turning over instead of silting up.
    if (this.ships.size > AFLOAT) {
      const oldest = this.ships.keys().next().value
      if (oldest && oldest !== bottle.id) this.sink(oldest)
    }
  }

  private sink(id: string): void {
    this.ships.get(id)?.remove()
    this.ships.delete(id)
  }

  private ripple(yPercent: number): void {
    const ring = div('db-ripple')
    ring.style.left = `${6 + Math.random() * 88}%`
    ring.style.top = `${yPercent + 4}%`
    this.fleet.appendChild(ring)
    setTimeout(() => ring.remove(), 1600)
  }

  /* ─────────────────────────── fishing ─────────────────────────── */

  /**
   * Haul one out at random.
   *
   * `drift` is a uniform point in [0,1) written at the throw, so a roll plus
   * "the first record at or after it" is a fair draw over the whole sea. Landing
   * past the last bottle wraps to the beginning, which is why there is a second
   * query rather than a retry loop. A page rather than a single row, because the
   * neighbours may be this visitor's own or already read.
   */
  private async fish(trigger: HTMLButtonElement): Promise<void> {
    if (this.busy) return
    this.busy = true
    const label = trigger.textContent
    trigger.disabled = true
    trigger.textContent = this.t.fishing
    this.sound.haul()

    try {
      const at = Math.random()
      const forward = await this.bottles.list({
        where: { 'payload.drift': { gte: at } },
        sort: ['payload.drift'],
        limit: 16,
      })
      const wrapped =
        forward.items.length >= 16
          ? { items: [] as Rec<Bottle>[] }
          : await this.bottles.list({ where: { 'payload.drift': { lt: at } }, sort: ['payload.drift'], limit: 16 })
      const pool = [...forward.items, ...wrapped.items]

      // Prefer something new; fall back to anything that is not this visitor's
      // own, so a small sea still gives you a bottle instead of nothing.
      const found = pool.find((b) => !b.mine && !this.seen.has(b.id)) ?? pool.find((b) => !b.mine)
      if (!found) {
        this.toast(this.t.readEmpty)
        return
      }
      await this.remember(found.id)
      await this.openBottle(found)
    } catch (err) {
      this.toast(this.explain(err as WorldError))
    } finally {
      trigger.disabled = false
      if (label) trigger.textContent = label
      this.busy = false
    }
  }

  private async remember(id: string): Promise<void> {
    this.seen.add(id)
    const kept = [...this.seen].slice(-SEEN_KEPT)
    await this.ctx.local.set(SEEN_KEY, kept).catch(() => {})
  }

  private async openBottle(bottle: Rec<Bottle>): Promise<void> {
    this.sound.pop()
    this.replyDraft = ''
    const replies = await this.listReplies(bottle.id)
    this.open({ kind: 'read', bottle, replies })
  }

  private async listReplies(target: string): Promise<Rec<Reply>[]> {
    const page = await this.replies.list({
      where: { 'payload.target': { eq: target } },
      sort: ['createdAt'],
      limit: 50,
    })
    return page.items
  }

  private async openMine(): Promise<void> {
    this.sound.tick()
    const page = await this.bottles.list({ mine: true, sort: ['-createdAt'], limit: 20 })
    const counts = new Map<string, number>()
    await Promise.all(
      page.items.map(async (b) => {
        counts.set(b.id, await this.replies.count({ where: { 'payload.target': { eq: b.id } } }))
      }),
    )
    this.open({ kind: 'mine', items: page.items, counts })
  }

  /* ─────────────────────────── writes ─────────────────────────── */

  private async cast(text: string, trigger: HTMLButtonElement, status: HTMLElement): Promise<void> {
    if (!text) return
    trigger.disabled = true
    trigger.textContent = this.t.casting
    status.textContent = ''
    try {
      const rec = await this.bottles.add({ text, mood: this.mood, drift: Math.random() })
      this.draft = ''
      this.sound.splash()
      this.launch(rec, true)
      this.total++
      this.renderChrome()
      this.close()
      this.toast(this.t.castDone)
    } catch (err) {
      status.textContent = this.explain(err as WorldError)
      trigger.disabled = false
      trigger.textContent = this.t.cast
    }
  }

  private async sendReply(target: string, text: string, trigger: HTMLButtonElement, status: HTMLElement): Promise<void> {
    if (!text) return
    trigger.disabled = true
    try {
      await this.replies.add({ target, text })
      this.replyDraft = ''
      this.sound.chime()
      const panel = this.panel
      if (panel && (panel.kind === 'read' || panel.kind === 'thread')) {
        panel.replies = await this.listReplies(target)
        this.renderPanel()
      }
      this.toast(this.t.replySent)
    } catch (err) {
      status.textContent = this.explain(err as WorldError)
    } finally {
      trigger.disabled = false
    }
  }

  private async destroy(bottle: Rec<Bottle>): Promise<void> {
    try {
      await this.bottles.del(bottle.id)
      this.sink(bottle.id)
      this.total = Math.max(0, this.total - 1)
      this.sound.shatter()
      this.close()
      this.toast(this.t.destroyed)
      this.renderChrome()
    } catch (err) {
      this.toast(this.explain(err as WorldError))
    }
  }

  /* ─────────────────────────── panels ─────────────────────────── */

  private open(panel: Panel): void {
    this.panel = panel
    this.scrim.hidden = false
    if (!this.scrim.isConnected) this.root.appendChild(this.scrim)
    this.renderPanel()
  }

  private close(): void {
    this.panel = null
    this.scrim.hidden = true
    this.scrim.innerHTML = ''
  }

  private renderPanel(): void {
    const panel = this.panel
    if (!panel) return
    this.scrim.innerHTML = ''

    const sheet = div('db-sheet')
    const head = div('db-sheet-head')
    const title = document.createElement('h2')
    title.textContent =
      panel.kind === 'compose' ? this.t.composeTitle : panel.kind === 'read' ? this.t.readTitle : this.t.mineTitle
    const x = document.createElement('button')
    x.className = 'db-x'
    x.textContent = '✕'
    x.setAttribute('aria-label', this.t.close)
    x.onclick = () => this.close()
    head.append(title, x)
    sheet.appendChild(head)

    if (panel.kind === 'compose') this.renderCompose(sheet)
    else if (panel.kind === 'read') this.renderRead(sheet, panel.bottle, panel.replies)
    else if (panel.kind === 'mine') this.renderMine(sheet, panel.items, panel.counts)
    else this.renderThread(sheet, panel.bottle, panel.replies)

    this.scrim.appendChild(sheet)
  }

  private renderCompose(sheet: HTMLElement): void {
    const t = this.t
    if (!this.ctx.me) {
      sheet.appendChild(note('db-empty', t.signIn))
      return
    }

    const moods = div('db-moods')
    for (const mood of MOODS) {
      const chip = button(t.moods[mood], 'db-mood')
      chip.style.setProperty('--h', String(MOOD_HUE[mood]))
      chip.setAttribute('aria-pressed', String(mood === this.mood))
      chip.onclick = () => {
        this.mood = mood
        this.sound.tick()
        this.renderPanel()
      }
      moods.appendChild(chip)
    }
    const moodLabel = note('db-note', t.moodLabel)
    moodLabel.style.marginBottom = '6px'
    sheet.append(moodLabel, moods)

    const input = document.createElement('textarea')
    input.className = 'db-input'
    input.rows = 4
    input.maxLength = MAX_TEXT
    input.placeholder = t.placeholder
    input.value = this.draft
    sheet.appendChild(input)

    const status = div('db-status')
    const count = div('db-meta')
    const send = button(t.cast, 'db-btn db-btn--primary')
    const tally = () => {
      this.draft = input.value
      count.textContent = `${input.value.length}/${MAX_TEXT}`
      count.classList.toggle('db-meta--full', input.value.length >= MAX_TEXT)
      send.disabled = input.value.trim().length === 0
    }
    input.oninput = tally
    send.onclick = () => void this.cast(input.value.trim(), send, status)

    const row = div('db-row')
    row.append(count, send)
    sheet.append(row, note('db-note', t.composeHint), status)
    tally()
    input.focus()
  }

  private renderRead(sheet: HTMLElement, bottle: Rec<Bottle>, replies: Rec<Reply>[]): void {
    const t = this.t
    sheet.appendChild(this.paper(bottle))

    const mine = replies.find((r) => r.mine)
    if (replies.length) sheet.appendChild(this.replyList(replies))

    if (!this.ctx.me) {
      sheet.appendChild(note('db-empty', t.signIn))
    } else if (bottle.mine) {
      sheet.appendChild(note('db-note', t.repliesN(replies.length)))
    } else if (mine) {
      sheet.appendChild(note('db-note', t.replyOnce))
    } else {
      const input = document.createElement('textarea')
      input.className = 'db-input'
      input.rows = 2
      input.maxLength = MAX_REPLY
      input.placeholder = t.replyPlaceholder
      input.value = this.replyDraft
      input.style.marginTop = '14px'
      const status = div('db-status')
      const send = button(t.reply, 'db-btn db-btn--primary')
      const count = div('db-meta')
      const tally = () => {
        this.replyDraft = input.value
        count.textContent = `${input.value.length}/${MAX_REPLY}`
        send.disabled = input.value.trim().length === 0
      }
      input.oninput = tally
      send.onclick = () => void this.sendReply(bottle.id, input.value.trim(), send, status)
      const row = div('db-row')
      row.append(count, send)
      sheet.append(input, row, status)
      tally()
    }

    const again = button(`↑ ${t.again}`, 'db-btn db-btn--ghost')
    again.style.marginTop = '12px'
    again.onclick = () => void this.fish(again)
    sheet.appendChild(again)
  }

  private renderMine(sheet: HTMLElement, items: Rec<Bottle>[], counts: Map<string, number>): void {
    const t = this.t
    if (!items.length) {
      sheet.appendChild(note('db-empty', this.ctx.me ? t.mineEmpty : t.signIn))
      return
    }
    const list = div('db-list')
    for (const bottle of items) {
      const row = document.createElement('button')
      row.className = 'db-item'
      row.style.setProperty('--h', String(MOOD_HUE[bottle.payload.mood] ?? 200))
      const rail = div('db-rail')
      const body = div('db-item-body')
      const text = div('db-item-text')
      text.textContent = bottle.payload.text
      const sub = div('db-item-sub')
      const n = counts.get(bottle.id) ?? 0
      sub.textContent = `${t.moods[bottle.payload.mood]} · ${ago(bottle.createdAt, t)} · ${t.repliesN(n)}`
      body.append(text, sub)
      row.append(rail, body)
      row.onclick = () => void this.openThread(bottle)
      list.appendChild(row)
    }
    sheet.append(list, note('db-note', t.quotaLeft(Math.max(0, 5 - items.length))))
  }

  private async openThread(bottle: Rec<Bottle>): Promise<void> {
    this.sound.pop()
    this.open({ kind: 'thread', bottle, replies: await this.listReplies(bottle.id) })
  }

  private renderThread(sheet: HTMLElement, bottle: Rec<Bottle>, replies: Rec<Reply>[]): void {
    const t = this.t
    sheet.appendChild(this.paper(bottle))
    if (replies.length) sheet.appendChild(this.replyList(replies))
    else sheet.appendChild(note('db-empty', t.repliesN(0)))

    const row = div('db-row')
    const back = button(`← ${t.back}`, 'db-btn db-btn--ghost')
    back.onclick = () => void this.openMine()
    const kill = button(t.destroy, 'db-btn db-btn--ghost')
    kill.onclick = () => void this.destroy(bottle)
    row.append(back, kill)
    sheet.appendChild(row)
  }

  /* ─────────────────────────── pieces ─────────────────────────── */

  /** The message, on paper, with its byline underneath. */
  private paper(bottle: Rec<Bottle>): HTMLElement {
    const wrap = div('')
    const paper = div(bottle.mine ? 'db-paper db-paper--mine' : 'db-paper')
    paper.textContent = bottle.payload.text
    const line = div('db-byline')
    line.append(
      avatar(bottle.author, 24),
      span(bottle.author.name),
      ...(bottle.author.kind === 'agent' ? [tag(this.t.agent)] : []),
      span('·', 'db-dot'),
      span(this.t.moods[bottle.payload.mood] ?? bottle.payload.mood),
      span('·', 'db-dot'),
      span(ago(bottle.createdAt, this.t)),
    )
    wrap.append(paper, line)
    return wrap
  }

  private replyList(replies: Rec<Reply>[]): HTMLElement {
    const list = div('db-list')
    for (const reply of replies) {
      const item = div('db-item')
      item.style.setProperty('--h', '200')
      const body = div('db-item-body')
      const text = div('')
      text.textContent = reply.payload.text
      const sub = div('db-item-sub')
      sub.append(
        span(reply.author.name),
        ...(reply.author.kind === 'agent' ? [tag(this.t.agent)] : []),
        span(' · '),
        span(ago(reply.createdAt, this.t)),
      )
      body.append(text, sub)
      item.append(avatar(reply.author, 22), body)
      list.appendChild(item)
    }
    return list
  }

  private toast(message: string): void {
    const el = div('db-toast')
    el.textContent = message
    this.root.appendChild(el)
    setTimeout(() => el.remove(), 3600)
  }

  /**
   * Platform error codes, in the visitor's language. In a shared world these are
   * ordinary outcomes — someone got there first, you used your last bottle —
   * rather than failures worth showing a stack trace for.
   */
  private explain(err: WorldError): string {
    const t = this.t
    switch (err.code) {
      case 'unique':
        return t.replyOnce
      case 'conflict':
        return t.errConflict
      case 'quota':
        return t.errQuota
      case 'rate-limited':
        return t.errRate(err.retryAfterSec ?? 60)
      case 'unauthenticated':
        return t.errAuth
      case 'too-large':
        return t.errLong
      default:
        return err.message
    }
  }
}

/* ─────────────────────────── DOM helpers ─────────────────────────── */

function div(className: string): HTMLDivElement {
  const node = document.createElement('div')
  if (className) node.className = className
  return node
}

function span(text: string, className = ''): HTMLSpanElement {
  const node = document.createElement('span')
  if (className) node.className = className
  node.textContent = text
  return node
}

function tag(text: string): HTMLSpanElement {
  return span(text, 'db-tag')
}

function note(className: string, text: string): HTMLParagraphElement {
  const node = document.createElement('p')
  node.className = className
  node.textContent = text
  return node
}

function button(text: string, className: string): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.type = 'button'
  node.textContent = text
  return node
}

/**
 * A visitor's face. `avatar` is a URL the platform supplies; the world CSP allows
 * `img-src https:`, so it loads directly — but it may be `null` (agents usually
 * have none) and it may 404, and both fall back to a monogram tinted from the id
 * so it is stable across reloads. An agent gets a squarer frame, which is the
 * world's decision to make and not the platform's.
 */
function avatar(who: Visitor, size: number): HTMLDivElement {
  const face = div(`db-face${who.kind === 'agent' ? ' db-face--agent' : ''}`)
  face.style.setProperty('--size', `${size}px`)
  face.style.setProperty('--h', String(hueOf(who.id)))
  face.textContent = initialsOf(who.name)
  if (who.avatar) {
    const img = document.createElement('img')
    img.src = who.avatar
    img.alt = ''
    img.onerror = () => img.remove()
    face.appendChild(img)
  }
  return face
}

function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? '')
    .filter(Boolean)
  return (letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0] ?? '?').toUpperCase()
}

function hueOf(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360
  return h
}
