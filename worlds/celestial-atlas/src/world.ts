/**
 * 神明的画笔 · 绢本星图 — the source design, running on Arena.
 *
 * This is a PORT, not a reinterpretation. The stylesheet, the markup, the copy
 * and the logic all come verbatim from the original page (see
 * `tools/extract.mjs`); this file only does the two things the original cannot
 * do by itself:
 *
 *   1. persist planets, so what you paint is still there tomorrow and other
 *      people's planets hang on the same sheet as yours
 *   2. know who you are, so a planet has an owner and a lamp has a giver
 *
 * Everything else — the unrolling prologue, the astrolabe, the four regions and
 * their vertical text, the atelier's brushes, inks and instruments, the wishing
 * star, the shared sky, the minimap, the drifting whispers — is the original's
 * own code, running unchanged.
 *
 * Removed: the ¥1/3/6/9.9 offering tier. Arena is not a payment surface for a
 * third party, and the design already promises the free path is complete.
 */
import { defineWorld, type Collection, type Rec } from '@arena/world-sdk'
import { CSS, MARKUP, SCRIPT } from './original.js'

/** One painted mark: brush, ink, and where it landed on the 1000×1000 planet. */
type Stroke = [string, string, number, number]

/** One sounded note: scale degree, gap since the previous note (ms), instrument. */
type Note = [number, number, string]

interface Planet {
  strokes: Stroke[]
  /**
   * The planet's melody. Kept separately from `strokes` because it is not
   * derivable from them: dragging only sounds a note about a third of the time,
   * and each note carries its own timing and instrument.
   */
  melody?: Note[]
  x: number
  y: number
  title?: string
}

type Lamp = { target: string }

interface BridgeInk {
  get: () => string
  set: (c: string) => void
}

interface BridgeAudio {
  playNote: (deg: number, v?: number) => void
  getInst: () => string
  setInst: (v: string) => void
  unlock: () => unknown
}

type Stamps = Record<string, (x: number, y: number) => void>
type MakeNode = (
  spot: { x: number; y: number; idx: number; lamps?: number; authorName?: string; authorMood?: string },
  canvas?: HTMLCanvasElement,
) => HTMLElement

/**
 * The bridge the patched script calls into.
 *
 * It lives on `window` because the original runs as a real inline `<script>` in
 * global scope — the sandbox CSP allows `'unsafe-inline'` but not
 * `'unsafe-eval'`, so wrapping the source in a function is not available, and
 * this seam is what keeps the port a port instead of a rewrite.
 */
interface Bridge {
  /**
   * The language the page renders in, seeded from Arena before the source script
   * runs — it reads this once, at the top, to initialise its own `LANG`.
   */
  lang: string
  /**
   * Installed by the source script: re-render every string in a new language.
   * The page no longer decides when that happens; Arena does.
   */
  onLang?: (l: string) => void
  rec: (brush: string, color: string, x: number, y: number) => void
  note: (deg: number, dt: number, inst: string) => void
  clear: () => void
  /** Installed by the source script once its audio engine exists. */
  audio?: BridgeAudio
  /**
   * The current brush colour. The stamps read it from module scope, so replaying
   * a saved planet has to set it per stroke — otherwise every planet redraws in
   * whatever colour happens to be selected.
   */
  ink?: BridgeInk
  load: (
    makeNode: MakeNode,
    world: HTMLElement,
    stamps: Stamps,
    pctx: CanvasRenderingContext2D,
    resetPlanet: () => void,
    pc: HTMLCanvasElement,
  ) => void
  save: (makeNode: MakeNode, world: HTMLElement, pc: HTMLCanvasElement, spot: { x: number; y: number }) => void
}

export default defineWorld({
  meta: { type: 'celestial-atlas' },

  async mount(root, ctx) {
    const planets = ctx.collection<Planet>('planets')
    const lamps = ctx.collection<Lamp>('lamps')

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    // The original's markup expects to BE the page — it styles `body` and pins
    // `#chart`, `header` and `#viewport` to the viewport — so it replaces the
    // body's content rather than sitting inside a wrapper.
    root.innerHTML = MARKUP

    const saved = await planets.list({ limit: 60, sort: ['-createdAt'] })
    const mine = saved.items.find((p) => p.mine) ?? null

    // Lamp counts live in their own collection, so they are counted per planet.
    // Without this the source's local counter starts every planet back at zero
    // and lamps look like they were never given.
    const lampCounts = new Map<string, number>(
      await Promise.all(
        saved.items.map(
          async (p) => [p.id, await lamps.count({ where: { 'payload.target': { eq: p.id } } })] as const,
        ),
      ),
    )

    /** This session's strokes and notes, appended as the visitor paints. */
    let log: Stroke[] = mine ? [...mine.payload.strokes] : []
    let tune: Note[] = mine?.payload.melody ? [...mine.payload.melody] : []

    const bridge: Bridge = {
      lang: pick(ctx.lang),

      rec: (brush, color, x, y) => {
        // Rounded: the schema caps a planet at 8KB, and sub-pixel precision on a
        // 1000px sphere is not something anyone can see.
        log.push([brush, color, Math.round(x), Math.round(y)])
      },

      note: (deg, dt, inst) => {
        tune.push([deg, Math.round(dt), inst])
      },

      clear: () => {
        log = []
        tune = []
      },

      load: (makeNode, world, stamps, _pctx, resetPlanet, pc) => {
        saved.items.forEach((rec, i) => {
          const node = makeNode(
            { x: rec.payload.x, y: rec.payload.y, idx: i, lamps: lampCounts.get(rec.id) ?? 0, ...who(rec) },
            replay(rec.payload.strokes, stamps, resetPlanet, pc, bridge.ink),
          )
          node.dataset.recordId = rec.id
          wireLamp(node, rec, lamps)
          addListen(node, rec, bridge)
          world.appendChild(node)
        })
        // Put the visitor's own planet back on the atelier canvas, so 重绘 picks
        // up where they left off instead of handing them a blank sphere.
        if (mine) replay(mine.payload.strokes, stamps, resetPlanet, pc, bridge.ink)
        else resetPlanet()
      },

      // `spot` comes from the original's own placement formula — a ring around
      // the atelier — so planets land where the design puts them. An existing
      // planet keeps the spot it was first given.
      save: (makeNode, world, pc, spot) => {
        const at = mine ? { x: mine.payload.x, y: mine.payload.y } : spot
        const payload: Planet = { strokes: log, melody: tune, x: at.x, y: at.y }

        void (async () => {
          try {
            const rec = mine
              ? // Pass the version we read: if another tab saved first, this
                // fails `conflict` rather than silently discarding that edit.
                await planets.put(mine.id, payload, { version: mine.version })
              : await planets.add(payload)
            // Replace any node already drawn for this planet, so repainting
            // updates the atlas instead of stacking a second sphere on it.
            world.querySelector(`[data-record-id="${rec.id}"]`)?.remove()
            const node = makeNode({ x: at.x, y: at.y, idx: 0, lamps: lampCounts.get(rec.id) ?? 0, ...who(rec) }, pc)
            node.dataset.recordId = rec.id
            wireLamp(node, rec, lamps)
            addListen(node, rec, bridge)
            world.appendChild(node)
          } catch (err) {
            toast(explain(err as { code?: string; message?: string }))
          }
        })()
      },
    }

    ;(window as unknown as { __arena: Bridge }).__arena = bridge

    // A real inline <script>, which `script-src 'unsafe-inline'` permits. The
    // original is written for global scope, and this runs it without changing it.
    const el = document.createElement('script')
    el.textContent = SCRIPT
    document.body.appendChild(el)

    // Language is Arena's, not the world's: the design's 中/EN/日 switcher is gone
    // and all three translations are driven from here instead. Subscribed after
    // the script runs, because `onLang` is what the script installs.
    // `bridge.lang` is kept current rather than left at its boot value, so it
    // always names the language actually on screen.
    ctx.onLangChange((l) => {
      bridge.lang = pick(l)
      bridge.onLang?.(bridge.lang)
    })

    // Re-apply once now. `mount` awaits the saved planets before any of this, and
    // a language that arrived during that wait would otherwise sit in `ctx.lang`
    // unrendered: the page reads `bridge.lang` once, at boot, and the change
    // event for it has already been and gone. Applying is idempotent.
    if (bridge.lang !== pick(ctx.lang)) bridge.onLang?.(pick(ctx.lang))
  },
})

/* ─────────────────────────── helpers ─────────────────────────── */

/** The three languages the design was written in. */
const TRANSLATED = new Set(['zh', 'en', 'ja'])

/**
 * Arena's language, narrowed to one the page has copy for.
 *
 * The platform's contract is a base code — `zh`, not `zh-CN` — but this narrows
 * a full locale anyway. Reading `zh-CN` as "no copy for this" would show a
 * Chinese visitor an English page while Arena's own header says 中文, and that
 * mismatch is both the most likely way the contract gets bent and the hardest
 * to spot: everything renders, just in the wrong language.
 *
 * English is the fallback rather than Chinese. A visitor reading Arena in Korean
 * is likelier to get by in English than in 中文, and the source's own switcher is
 * no longer there to correct a bad guess.
 */
function pick(lang: string | undefined): string {
  const base = (lang ?? '').toLowerCase().split(/[-_]/)[0]!
  return TRANSLATED.has(base) ? base : 'en'
}

/**
 * Redraw a saved planet using the original's own stamp functions, so a replayed
 * planet is made of exactly the same marks as a freshly painted one — not an
 * approximation of it.
 *
 * Returns a snapshot, because the shared atelier canvas is about to be reused
 * for the next planet.
 */
function replay(
  strokes: Stroke[],
  stamps: Stamps,
  resetPlanet: () => void,
  pc: HTMLCanvasElement,
  ink?: BridgeInk,
): HTMLCanvasElement {
  resetPlanet()
  // The stamps read the brush colour from module scope rather than taking it as
  // an argument, so a replay has to put each stroke's colour back before drawing
  // it. Without this every saved planet comes back in the default ink — the
  // colour is in the record, it just never reached the brush.
  const before = ink?.get()
  for (const [brush, colour, x, y] of strokes) {
    const stamp = stamps[brush]
    // An unknown brush means a planet from a later release, not a reason to drop
    // the rest of someone's painting.
    if (!stamp) continue
    ink?.set(colour)
    stamp(x, y)
  }
  if (before !== undefined) ink?.set(before)
  const snapshot = document.createElement('canvas')
  snapshot.width = pc.width
  snapshot.height = pc.height
  snapshot.getContext('2d')!.drawImage(pc, 0, 0)
  return snapshot
}

/**
 * Who painted a planet, in the shape the source's registry keeps.
 *
 * Your own planet is left to the source, which calls it 你的星球 — better than
 * showing you your own email. Everyone else's carries their name, and an agent
 * is marked as one, because a sky that people and agents share should say which
 * is which.
 */
function who(rec: Rec<Planet>): { authorName?: string; authorMood?: string } {
  if (rec.mine) return {}
  const { kind, name, id } = rec.author
  return {
    authorName: rec.payload.title || name,
    // The platform hands over kind, name and id; what to do with them is this
    // world's call. Here an agent gets its id as a subtitle — on a sheet people
    // and agents share, knowing which is which is part of the work.
    authorMood: kind === 'agent' ? `agent · ${id}` : '',
  }
}

/**
 * The original's lamp button, backed by the `lamps` collection.
 *
 * Deliberately never disabled. A disabled button gives no reason, so a visitor
 * who is signed out — or who is looking at their own planet — just finds a
 * control that does nothing. Letting the click through means the platform
 * answers, and the answer can be phrased. (The source lets you light your own
 * planet too; that was a rule I added, and it is not mine to add.)
 */
function wireLamp(node: HTMLElement, rec: Rec<Planet>, lamps: Collection<Lamp>): void {
  const btn = node.querySelector('button.lamp-btn') as HTMLButtonElement | null
  if (!btn) return
  btn.addEventListener('click', () => {
    btn.disabled = true
    void lamps.add({ target: rec.id }).catch((err: { code?: string; message?: string }) => {
      // One lamp per visitor per planet is enforced by the platform's uniqueness
      // rule, so a second attempt fails here rather than being prevented by
      // bookkeeping in the page. The source already incremented its own counter
      // optimistically, so put that back.
      const b = node.querySelector('.lamp-count b')
      if (b) b.textContent = String(Math.max(0, Number(b.textContent ?? '1') - 1))
      toast(explain(err))
      btn.disabled = false
    })
  })
}

/**
 * A listen button on every planet, replaying its saved melody through the
 * source's own audio engine — same notes, same instruments, same envelopes as
 * when it was painted.
 *
 * The original can only play the melody you are painting right now. Hearing
 * someone else's planet is the one capability added here that it does not have,
 * and it is only possible because the melody is stored alongside the strokes.
 */
function addListen(node: HTMLElement, rec: Rec<Planet>, bridge: { audio?: BridgeAudio }): void {
  const tune = rec.payload.melody
  if (!tune || tune.length === 0) return

  const btn = document.createElement('button')
  btn.className = 'lamp-btn'
  btn.setAttribute('data-no-pan', '')
  btn.textContent = '\u542c\u8fd9\u9897\u661f\u7403'
  btn.style.marginTop = '.4rem'

  btn.addEventListener('click', () => {
    const audio = bridge.audio
    if (!audio) return
    // A gesture just happened, which is the only moment a sandboxed frame is
    // allowed to start audio.
    audio.unlock()

    // The same compression the source uses for its own playback: long pauses
    // while someone thought about the next stroke are not replayed literally.
    const total = tune.reduce((sum, n) => sum + n[1], 0) || 1
    const scale = Math.min(1, 8000 / total)
    const previous = audio.getInst()
    let t = 0
    for (const [deg, dt, inst] of tune) {
      t += Math.max(120, dt * scale)
      window.setTimeout(() => {
        audio.setInst(inst)
        audio.playNote(deg, 0.85)
        audio.setInst(previous)
      }, t)
    }
  })

  node.appendChild(btn)
}

/** Reuse the page's own toast, so platform errors look like part of the world. */
function toast(message: string): void {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = message
  el.classList.add('show')
  window.setTimeout(() => el.classList.remove('show'), 2800)
}

/**
 * Platform outcomes, in the world's voice. `quota`, `unique` and `conflict` are
 * ordinary things that happen in a shared sky, not failures.
 */
function explain(err: { code?: string; message?: string; retryAfterSec?: number }): string {
  switch (err.code) {
    case 'unique':
      return '你已经为它点过灯了'
    case 'conflict':
      return '这颗星球刚被改过，请刷新'
    case 'quota':
      return '你已经有一颗星球了，重绘它就好'
    case 'rate-limited': {
      const mins = Math.ceil((err.retryAfterSec ?? 600) / 60)
      return `今天画得很勤 —— ${mins} 分钟后可以继续`
    }
    case 'unauthenticated':
      return '登录后才能落笔、点灯'
    case 'too-large':
      return '笔画太多了'
    default:
      return err.message ?? '出了点问题'
  }
}
