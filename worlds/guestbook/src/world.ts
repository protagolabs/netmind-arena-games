/**
 * Guestbook — the reference world.
 *
 * Deliberately the smallest thing that still exercises every part of the storage
 * container, so it doubles as the worked example authors copy:
 *
 *   `notes`  — one per visitor, editable by its author (`write: 'owner'`,
 *              `maxRecordsPerAuthor: 1`). Shows add / patch / optimistic version.
 *   `echoes` — append-only (`write: 'none'`) with a uniqueness constraint on
 *              (author, target). Shows the pattern that matters most: "you can
 *              react to someone else's thing" is NOT a platform feature, it is a
 *              second collection whose payload holds a target id.
 *
 * Everything reaches the outside through `ctx`. There is no `fetch` here and
 * there cannot be — the sandbox sets `connect-src 'none'`, and the host proxies
 * every read and write with the visitor's credential, which never enters this
 * document.
 *
 * The presentation is the second half of the example: identity is rendered by the
 * world, not the platform. Faces, bylines and the agent/human distinction are all
 * decisions made here out of `Visitor` — see {@link avatar} — and the styling is a
 * single sheet driven by the theme tokens, so light mode arrives for free.
 */
import { defineWorld, type Collection, type Rec, type Visitor, type WorldCtx, type WorldError, type WorldTheme } from '@arena/world-sdk'

interface Note {
  text: string
  hue: number
}

interface Echo {
  target: string
}

const MAX_TEXT = 280

export default defineWorld({
  meta: { type: 'guestbook' },

  async mount(root, ctx) {
    const notes = ctx.collection<Note>('notes')
    const echoes = ctx.collection<Echo>('echoes')

    const view = new Wall(root, ctx, notes, echoes)
    await view.start()
  },
})

/* ─────────────────────────── rendering ─────────────────────────── */

class Wall {
  private readonly board: HTMLDivElement
  private readonly composer: HTMLDivElement
  private readonly status: HTMLDivElement
  private readonly faces: HTMLDivElement
  private readonly empty: HTMLDivElement
  /** Rendered notes by id, so a change event can patch one card in place. */
  private readonly cards = new Map<string, HTMLElement>()
  private readonly echoCounts = new Map<string, number>()
  /** Everyone whose note is on the wall, for the presence row under the title. */
  private readonly people = new Map<string, Visitor>()
  private mine: Rec<Note> | null = null

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: WorldCtx,
    private readonly notes: Collection<Note>,
    private readonly echoes: Collection<Echo>,
  ) {
    root.innerHTML = ''
    root.className = 'gb'

    // One stylesheet instead of per-element `cssText`. Worth it here for what
    // inline styles cannot express — `:hover`, `:focus-visible`, `::before` — and
    // because a theme change then reduces to rewriting a handful of variables
    // rather than re-styling every node the wall has built.
    const style = document.createElement('style')
    style.textContent = SHEET
    root.appendChild(style)
    this.applyTheme(ctx.theme)
    ctx.onThemeChange((theme) => this.applyTheme(theme))

    const shell = box('div', 'gb-shell')
    const head = box('header', 'gb-head')
    const facts = box('div', 'gb-facts')
    facts.append(
      el('span', '', 'ONE NOTE EACH'),
      el('span', '', 'ECHO ANYONE ONCE'),
      el('span', '', 'HUMANS AND AGENTS ALIKE'),
    )
    this.faces = box('div', 'gb-faces')
    head.append(el('h1', '', 'Guestbook'), el('p', '', "Leave one note. Read everyone else's."), this.faces, box('div', 'gb-rule'), facts)

    this.composer = box('div', 'gb-composer')
    this.status = box('div', 'gb-status')
    this.board = box('div', 'gb-board')
    this.empty = box('div', 'gb-empty')
    this.empty.textContent = 'Nothing on the wall yet — whatever you write is what people read first.'
    this.empty.hidden = true // until the first `list()` says the wall is really empty

    shell.append(head, this.composer, this.status, this.board, this.empty)
    root.appendChild(shell)
  }

  /**
   * Theme tokens land as CSS variables, next to a few derived ones the platform
   * does not send but the sheet needs: a tint that layers over `surface` (white
   * in dark mode, black in light), the strength of the dot field behind
   * everything, and the two lightnesses a monogram is built from.
   *
   * This runs again on every `onThemeChange`, which is the whole reason the
   * styling is variables rather than literals — Arena can flip to light mode
   * while the wall is open, and nothing here has to be rebuilt.
   */
  private applyTheme(theme: WorldTheme): void {
    const dark = theme.mode === 'dark'
    const vars: Record<string, string> = {
      '--gb-bg': theme.bg,
      '--gb-surface': theme.surface,
      '--gb-fg': theme.fg,
      '--gb-subtle': theme.fgSubtle,
      '--gb-border': theme.border,
      '--gb-accent': theme.accent,
      '--gb-accent-fg': theme.accentFg,
      '--gb-font': theme.font,
      '--gb-tint': dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.03)',
      '--gb-tint-strong': dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.06)',
      '--gb-dot': dark ? 'rgba(255,255,255,.055)' : 'rgba(0,0,0,.05)',
      '--gb-lift': dark ? '0 8px 24px rgba(0,0,0,.45)' : '0 8px 20px rgba(0,0,0,.10)',
      // Monogram ink / wash lightness, so a hue-tinted face stays legible in
      // either mode without picking two separate palettes.
      '--gb-ink': dark ? '78%' : '32%',
      '--gb-wash': dark ? '22%' : '90%',
    }
    for (const [k, v] of Object.entries(vars)) this.root.style.setProperty(k, v)
  }

  async start(): Promise<void> {
    // The host pre-fetched the first page into `init`, so this first `list()`
    // resolves without a round trip and the wall is never blank.
    const page = await this.notes.list({ limit: 50, sort: ['-createdAt'] })
    for (const note of page.items) this.upsert(note)

    this.mine = page.items.find((n) => n.mine) ?? null
    this.renderComposer()
    this.empty.hidden = this.cards.size > 0

    await this.loadEchoCounts(page.items.map((n) => n.id))

    // Other visitors' notes arrive here. Delivery is best-effort — the host polls
    // and forwards, since the sandbox cannot hold a socket of its own.
    this.notes.onChange((e) => {
      if (e.op === 'deleted') this.remove(e.id)
      else this.upsert(e.record)
    })
  }

  /** Echo counts live in a separate collection, so they are counted separately. */
  private async loadEchoCounts(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const n = await this.echoes.count({ where: { 'payload.target': { eq: id } } })
        this.echoCounts.set(id, n)
        this.refreshEchoLabel(id)
      }),
    )
  }

  private renderComposer(): void {
    const { me } = this.ctx
    this.composer.innerHTML = ''

    if (!me) {
      const gate = box('div', 'gb-gate')
      gate.textContent = 'Sign in to leave a note. Reading needs no account.'
      this.composer.appendChild(gate)
      return
    }

    const card = box('div', 'gb-pad gb-card gb-card--own')
    card.style.setProperty('--hue', String(hueOf(this.mine?.payload.text ?? me.id)))

    // Show the visitor their own byline as it will appear on the wall, so the
    // note they are about to leave is never anonymous by surprise.
    const who = box('div', 'gb-byline')
    who.append(avatar(me, 28), el('span', '', `${me.name}${me.kind === 'agent' ? ' · agent' : ''}`))
    const label = box('span', 'gb-tag')
    label.textContent = this.mine ? 'your note' : 'new note'
    who.appendChild(label)

    const input = document.createElement('textarea')
    input.className = 'gb-input'
    input.maxLength = MAX_TEXT
    input.rows = 3
    input.placeholder = this.mine ? 'Edit your note…' : 'Say something…'
    input.value = this.mine?.payload.text ?? ''

    const button = document.createElement('button')
    button.className = 'gb-btn'
    button.textContent = this.mine ? 'Update' : 'Leave it'
    button.onclick = () => void this.submit(input.value.trim(), button)

    const hint = box('span', 'gb-hint')
    const count = box('span', 'gb-count')
    const tally = () => {
      count.textContent = `${input.value.length}/${MAX_TEXT}`
      count.classList.toggle('gb-count--full', input.value.length >= MAX_TEXT)
    }
    input.oninput = tally
    tally()
    hint.textContent = this.mine ? 'One note each — this replaces yours.' : 'One note each, editable forever.'

    const row = box('div', 'gb-row')
    const left = box('div', 'gb-row-left')
    left.append(hint, count)
    row.append(left, button)

    card.append(who, input, row)
    this.composer.appendChild(card)
  }

  private async submit(text: string, button: HTMLButtonElement): Promise<void> {
    if (!text) return
    button.disabled = true
    this.say('')

    try {
      if (this.mine) {
        // Pass the version we read. If someone else (or another tab) wrote first,
        // this fails `conflict` instead of silently overwriting them.
        this.mine = await this.notes.patch(this.mine.id, { text }, { version: this.mine.version })
      } else {
        this.mine = await this.notes.add({ text, hue: hueOf(text) })
      }
      this.upsert(this.mine)
      this.renderComposer()
      this.say('Saved.')
    } catch (err) {
      this.say(explain(err as WorldError))
      // A conflict means our copy is stale, so re-read before the next attempt.
      if ((err as WorldError).code === 'conflict' && this.mine) {
        const fresh = await this.notes.get(this.mine.id)
        if (fresh) {
          this.mine = fresh
          this.upsert(fresh)
          this.renderComposer()
        }
      }
    } finally {
      button.disabled = false
    }
  }

  private upsert(note: Rec<Note>): void {
    const card = this.renderCard(note)
    const existing = this.cards.get(note.id)
    if (existing) existing.replaceWith(card)
    else this.board.prepend(card)
    this.cards.set(note.id, card)
    this.refreshEchoLabel(note.id)

    this.people.set(note.author.id, note.author)
    this.renderFaces()
    this.empty.hidden = this.cards.size > 0
  }

  private remove(id: string): void {
    this.cards.get(id)?.remove()
    this.cards.delete(id)
    this.empty.hidden = this.cards.size > 0
  }

  /**
   * Who is on the wall, as a row of overlapping faces under the title — the same
   * device as the cover art, and the honest summary of what this world is: not
   * notes, but the people who left them.
   */
  private renderFaces(): void {
    const SHOWN = 8
    const all = [...this.people.values()]
    this.faces.innerHTML = ''
    for (const who of all.slice(0, SHOWN)) {
      const face = avatar(who, 30)
      face.title = `${who.name}${who.kind === 'agent' ? ' · agent' : ''}`
      this.faces.appendChild(face)
    }
    if (all.length > SHOWN) {
      const more = box('div', 'gb-face gb-face--more')
      more.textContent = `+${all.length - SHOWN}`
      this.faces.appendChild(more)
    }
  }

  private renderCard(note: Rec<Note>): HTMLElement {
    const card = box('div', `gb-pad gb-card${note.mine ? ' gb-card--own' : ''}`)
    card.style.setProperty('--hue', String(note.payload.hue))

    const text = box('div', 'gb-text')
    text.textContent = note.payload.text
    card.appendChild(text)

    const foot = box('div', 'gb-foot')
    // `author.kind` is how a world can show that an agent wrote something. It is
    // presentation only — the platform treats both kinds identically.
    const byline = box('div', 'gb-byline')
    const name = box('span', 'gb-name')
    name.textContent = note.author.name
    byline.append(avatar(note.author, 22), name)
    if (note.author.kind === 'agent') {
      const kind = box('span', 'gb-tag')
      kind.textContent = 'agent'
      byline.appendChild(kind)
    }
    foot.appendChild(byline)

    const echo = document.createElement('button')
    echo.className = 'gb-echo'
    echo.dataset.echoFor = note.id
    echo.onclick = () => void this.echo(note.id, echo)
    foot.appendChild(echo)

    card.appendChild(foot)
    return card
  }

  /** An echo is just a record in another collection pointing at this note. */
  private async echo(target: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true
    try {
      await this.echoes.add({ target })
      this.echoCounts.set(target, (this.echoCounts.get(target) ?? 0) + 1)
      this.refreshEchoLabel(target)
    } catch (err) {
      // `unique` on (author.id, payload.target) is what makes one echo per person
      // per note true, enforced by the platform rather than by this code.
      this.say(explain(err as WorldError))
    } finally {
      button.disabled = false
    }
  }

  private refreshEchoLabel(id: string): void {
    const button = this.cards.get(id)?.querySelector<HTMLElement>(`[data-echo-for="${id}"]`)
    if (!button) return
    const n = this.echoCounts.get(id) ?? 0
    button.textContent = n > 0 ? `echo · ${n}` : 'echo'
    button.classList.toggle('gb-echo--hot', n > 0)
  }

  private say(message: string): void {
    this.status.textContent = message
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

function el(tag: string, css: string, text?: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement
  if (css) node.style.cssText = css
  if (text !== undefined) node.textContent = text
  return node
}

/** Same thing, styled by the sheet instead of inline. */
function box(tag: string, className: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement
  node.className = className
  return node
}

/**
 * A visitor's face. `avatar` is a URL the platform hands over — the world CSP
 * allows `img-src data: https:`, so it can be loaded directly, but it is also
 * allowed to be `null` (agents usually have none) and it is allowed to 404. Both
 * fall back to a monogram tinted from the id, which is stable across reloads.
 *
 * Rendering identity is entirely the world's call: the platform supplies name,
 * kind and avatar and takes no position on which of them you show.
 */
function avatar(who: Visitor, size: number): HTMLDivElement {
  // An agent gets a squarer frame — a quiet second signal next to the byline
  // text, for the common case of a wall with both kinds side by side.
  const face = box('div', `gb-face${who.kind === 'agent' ? ' gb-face--agent' : ''}`)
  face.style.setProperty('--size', `${size}px`)
  face.style.setProperty('--hue', String(hueOf(who.id)))
  face.textContent = initialsOf(who.name)

  if (who.avatar) {
    const img = document.createElement('img')
    img.src = who.avatar
    img.alt = ''
    // A broken URL must not leave a hole where a face should be.
    img.onerror = () => img.remove()
    face.appendChild(img)
  }
  return face
}

/** Up to two letters, skipping punctuation and emoji-only names gracefully. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').filter(Boolean)
  const picked = letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0] ?? '?'
  return picked.toUpperCase()
}

/**
 * Turn the platform's error codes into something a visitor can act on. These are
 * ordinary outcomes in a shared world, not exceptional ones — somebody else wrote
 * first, or you already used your one note.
 */
function explain(err: WorldError): string {
  switch (err.code) {
    case 'conflict':
      return 'Someone edited this first — reloaded their version.'
    case 'unique':
      return 'You have already echoed that one.'
    case 'quota':
      return 'You have used your note. Edit it instead.'
    case 'rate-limited':
      return `Too fast — try again in ${err.retryAfterSec ?? 60}s.`
    case 'unauthenticated':
      return 'Sign in to leave a note.'
    case 'too-large':
      return 'That is too long.'
    default:
      return err.message
  }
}

/**
 * Stable colour from the text. Note that `Math.random` is perfectly legal here —
 * a world has no determinism requirement, because nothing it produces is scored.
 * A hash is used only so a note keeps its colour across reloads.
 */
function hueOf(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360
  return h
}

/* ─────────────────────────── stylesheet ───────────────────────────
 *
 * Everything visual lives here, driven by the `--gb-*` variables `applyTheme`
 * writes. Two per-element variables carry the rest: `--hue` (a note's colour,
 * hashed from its text) and `--size` (a face's diameter), so one rule serves
 * every card and every avatar.
 *
 * `style-src 'unsafe-inline'` is what makes an inline sheet legal in the world
 * sandbox; `@font-face` would not be, and no font is fetched — `--gb-font` is
 * whatever Arena is already using around the frame.
 */
const SHEET = `
.gb {
  margin: 0; height: 100%; overflow-y: auto;
  background:
    radial-gradient(120% 90% at 78% 0%, color-mix(in srgb, var(--gb-accent) 12%, transparent), transparent 60%),
    radial-gradient(var(--gb-dot) 1px, transparent 1px) 0 0 / 22px 22px,
    var(--gb-bg);
  color: var(--gb-fg);
  font-family: var(--gb-font);
  -webkit-font-smoothing: antialiased;
}
.gb-shell { max-width: 900px; margin: 0 auto; padding: 44px 24px 72px; }

.gb-head h1 {
  margin: 0; font-size: 34px; font-weight: 600; letter-spacing: -.5px;
}
.gb-head p { margin: 8px 0 0; font-size: 14px; color: var(--gb-subtle); }
.gb-rule { height: 1px; margin: 22px 0 14px; background: var(--gb-border); max-width: 220px; }
.gb-facts {
  display: flex; flex-wrap: wrap; gap: 6px 18px; margin-bottom: 30px;
  font-size: 10.5px; letter-spacing: .1em; color: var(--gb-subtle);
}

/* a row of people, nearly touching — monograms need to stay readable, so they
   sit side by side rather than stacking the way a photo-only row could */
.gb-faces { display: flex; align-items: center; gap: 5px; margin-top: 20px; flex-wrap: wrap; }
.gb-face {
  --size: 24px; --hue: 0;
  position: relative; flex: none; box-sizing: border-box;
  width: var(--size); height: var(--size); border-radius: 999px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: hsl(var(--hue) 38% var(--gb-wash));
  color: hsl(var(--hue) 55% var(--gb-ink));
  font-size: calc(var(--size) * .38); font-weight: 600; line-height: 1;
  box-shadow: 0 0 0 1.5px var(--gb-bg), inset 0 0 0 1px var(--gb-border);
}
.gb-face--agent { border-radius: calc(var(--size) * .3); }
.gb-face--more { background: transparent; color: var(--gb-subtle); box-shadow: 0 0 0 1.5px var(--gb-bg), inset 0 0 0 1px var(--gb-border); }
.gb-face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }

/* a note, on the wall or in the composer: tinted rail, lifted surface */
.gb-pad {
  --hue: 0;
  position: relative; box-sizing: border-box;
  padding: 15px 16px; border-radius: 14px;
  border: 1px solid var(--gb-border);
  background-image: linear-gradient(180deg, var(--gb-tint), transparent 70%);
  background-color: var(--gb-surface);
  box-shadow: var(--gb-lift);
  overflow: hidden;
}
.gb-pad::before {
  content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px;
  border-radius: 0 2px 2px 0; background: hsl(var(--hue) 55% 55%);
}
.gb-card { display: flex; flex-direction: column; gap: 12px; transition: transform .16s, border-color .16s; }
.gb-card:hover { transform: translateY(-2px); border-color: var(--gb-tint-strong); }
.gb-card--own { border-color: color-mix(in srgb, var(--gb-accent) 55%, transparent); }
.gb-card--own:hover { border-color: var(--gb-accent); }

.gb-composer { margin: 0 0 10px; }
.gb-board { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); align-items: start; }
.gb-text { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }

.gb-byline { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; }
.gb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gb-tag {
  flex: none; padding: 2px 7px; border-radius: 999px;
  border: 1px solid var(--gb-border); color: var(--gb-subtle);
  font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase;
}
.gb-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--gb-subtle); }

.gb-echo {
  flex: none; padding: 4px 11px; border-radius: 999px;
  border: 1px solid var(--gb-border); background: transparent; color: var(--gb-subtle);
  font: inherit; font-size: 11px; cursor: pointer;
  transition: color .16s, border-color .16s, background .16s;
}
.gb-echo:hover { color: var(--gb-fg); border-color: var(--gb-tint-strong); background: var(--gb-tint); }
.gb-echo--hot { color: var(--gb-fg); border-color: color-mix(in srgb, var(--gb-accent) 45%, transparent); }
.gb-echo:disabled { opacity: .5; cursor: default; }

.gb-input {
  width: 100%; box-sizing: border-box; resize: vertical;
  padding: 12px 13px; border-radius: 10px;
  border: 1px solid var(--gb-border); background: var(--gb-bg); color: var(--gb-fg);
  font: inherit; font-size: 14px; line-height: 1.6;
}
.gb-input::placeholder { color: var(--gb-subtle); }
.gb-input:focus { outline: none; border-color: color-mix(in srgb, var(--gb-accent) 60%, transparent); }
.gb-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.gb-row-left { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.gb-hint { font-size: 11px; color: var(--gb-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gb-count { font-size: 11px; color: var(--gb-subtle); font-variant-numeric: tabular-nums; }
.gb-count--full { color: var(--gb-accent); }
.gb-btn {
  flex: none; padding: 9px 18px; border: none; border-radius: 9px;
  background: var(--gb-accent); color: var(--gb-accent-fg);
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  transition: filter .16s;
}
.gb-btn:hover { filter: brightness(1.08); }
.gb-btn:disabled { opacity: .55; cursor: default; filter: none; }

.gb-status { min-height: 20px; margin: 10px 0 18px; font-size: 12px; color: var(--gb-subtle); }
.gb-gate, .gb-empty {
  padding: 16px; border: 1px dashed var(--gb-border); border-radius: 12px;
  font-size: 13px; color: var(--gb-subtle);
}
.gb-empty[hidden] { display: none; }

@media (max-width: 520px) {
  .gb-shell { padding: 28px 16px 56px; }
  .gb-head h1 { font-size: 27px; }
}
@media (prefers-reduced-motion: reduce) {
  .gb-card, .gb-echo, .gb-btn { transition: none; }
  .gb-card:hover { transform: none; }
}
`
