/**
 * 渊光 · Abyssal Bloom
 *
 * A dive, not a score. You raise a mote of light into a creature — pointer to
 * swim, motes to grow, evolutions to choose — and carry it down through four
 * bands of water to the Abyssal Garden, where releasing it writes one record.
 * Everyone's released creatures live there together; tapping one adds a
 * `resonance` record (unique per visitor per creature) that brightens it.
 *
 * Shared strings (creature names, author names) are always rendered with
 * `textContent`. All storage failures surface as quiet in-world toasts —
 * `quota`, `unique`, `rate-limited` are ordinary weather in a shared sea.
 */

import { defineWorld, type Rec, type WorldError } from '@arena/world-sdk'
import { strings, type Strings } from './i18n.js'
import { ALL_TRAITS, drawCreature, headRadius, mulberry32, type Genome, type Trait } from './genome.js'
import { Sim, Dweller, WORLD_W, WORLD_H, GARDEN_TOP, bandAt } from './sim.js'
import { Renderer } from './render.js'
import { Synth } from './audio.js'

interface CreaturePayload {
  seed: number
  hue: number
  hue2: number
  segs: number
  motes: number
  traits: string[]
  name?: string
}

interface ResonancePayload {
  target: string
}

interface Spark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  age: number
  hue: number
}

type Mode = 'intro' | 'dive' | 'evolve' | 'ceremony' | 'garden'

const RELEASE_MIN_MOTES = 10

const payloadToGenome = (p: CreaturePayload): Genome => ({
  seed: p.seed,
  hue: p.hue,
  hue2: p.hue2,
  segs: Math.max(4, Math.min(30, p.segs)),
  motes: Math.max(0, Math.min(240, p.motes)),
  traits: p.traits.filter((t): t is Trait => (ALL_TRAITS as string[]).includes(t)).slice(0, 6),
})

export default defineWorld({
  meta: { type: 'abyssal-bloom' },

  async mount(root, ctx) {
    let T: Strings = strings(ctx.lang)

    const creatures = ctx.collection<CreaturePayload>('creatures')
    const resonance = ctx.collection<ResonancePayload>('resonance')

    /* ── DOM scaffold ──────────────────────────────────────────────────── */

    root.innerHTML = ''
    const style = document.createElement('style')
    style.textContent = `
      .ab-root{position:absolute;inset:0;overflow:hidden;background:#03121f;font-family:${ctx.theme.font},'Avenir Next','PingFang SC',system-ui,sans-serif;user-select:none;-webkit-user-select:none;touch-action:none;color:#d4ecf5}
      .ab-root canvas{position:absolute;inset:0;display:block}
      .ab-hud{position:absolute;inset:0;pointer-events:none;display:block}
      .ab-hud *{pointer-events:none}
      .ab-hud .ab-btn{pointer-events:auto}
      .ab-title{position:absolute;top:18px;left:20px;letter-spacing:.35em;font-size:13px;opacity:.66;text-transform:uppercase}
      .ab-band{position:absolute;top:40px;left:20px;font-size:12px;color:#9fd7e8;opacity:0;transition:opacity 1.2s ease;letter-spacing:.2em}
      .ab-gcount{position:absolute;top:60px;left:20px;font-size:11px;color:#7fb3c4;opacity:0;transition:opacity 1.2s ease}
      .ab-motes{position:absolute;left:20px;bottom:18px;font-size:13px;color:#cfeef8;opacity:.9;text-shadow:0 0 12px rgba(110,220,255,.6)}
      .ab-hint{position:absolute;left:50%;bottom:72px;transform:translateX(-50%);font-size:13px;color:#a8cfdd;opacity:0;transition:opacity .9s ease;text-align:center;max-width:80vw;text-shadow:0 1px 8px rgba(0,10,20,.8)}
      .ab-toast{position:absolute;left:50%;bottom:110px;transform:translateX(-50%);font-size:13px;color:#eaf7fc;background:rgba(8,30,46,.78);border:1px solid rgba(130,215,255,.28);border-radius:20px;padding:8px 18px;opacity:0;transition:opacity .4s ease;max-width:78vw;text-align:center}
      .ab-btnrow{position:absolute;top:14px;right:16px;display:flex;gap:8px}
      .ab-btn{pointer-events:auto;cursor:pointer;background:rgba(9,32,48,.6);border:1px solid rgba(130,205,240,.3);color:#cfeef8;border-radius:18px;padding:7px 14px;font-size:12px;font-family:inherit;transition:background .25s,border-color .25s}
      .ab-btn:hover{background:rgba(16,52,74,.8);border-color:rgba(160,225,255,.55)}
      .ab-btn:disabled{opacity:.4;cursor:default}
      .ab-release{position:absolute;left:50%;transform:translateX(-50%);bottom:18px;font-size:13px;padding:10px 22px;border-radius:22px;background:rgba(10,44,60,.72);border:1px solid rgba(140,230,255,.4)}
      .ab-release.ready{background:rgba(16,74,92,.85);border-color:rgba(170,245,255,.85);box-shadow:0 0 22px rgba(90,220,255,.35);animation:ab-breathe 2.6s ease-in-out infinite}
      @keyframes ab-breathe{50%{box-shadow:0 0 34px rgba(120,235,255,.55)}}
      .ab-modal{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(1,8,16,.55);opacity:0;pointer-events:none;transition:opacity .5s ease;z-index:5}
      .ab-modal.open{opacity:1;pointer-events:auto}
      .ab-card{background:rgba(6,24,38,.92);border:1px solid rgba(130,205,240,.3);border-radius:16px;padding:28px 30px;max-width:420px;width:min(86vw,420px);text-align:center;box-shadow:0 8px 60px rgba(0,6,14,.7)}
      .ab-card h1{font-size:26px;margin:0 0 6px;font-weight:500;letter-spacing:.14em}
      .ab-card h2{font-size:17px;margin:0 0 14px;font-weight:500;letter-spacing:.06em}
      .ab-card p{font-size:13px;line-height:1.8;color:#a8cfdd;margin:0 0 18px}
      .ab-card input{width:100%;box-sizing:border-box;background:rgba(3,14,24,.9);border:1px solid rgba(130,205,240,.35);border-radius:10px;color:#e8f7fc;padding:10px 12px;font-size:14px;font-family:inherit;outline:none;margin-bottom:16px;text-align:center}
      .ab-card input:focus{border-color:rgba(170,235,255,.7)}
      .ab-choices{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-bottom:14px}
      .ab-choice{pointer-events:auto;cursor:pointer;flex:1 1 108px;max-width:130px;background:rgba(9,34,50,.85);border:1px solid rgba(130,205,240,.32);border-radius:12px;padding:12px 10px;color:#d4ecf5;font-family:inherit;transition:transform .2s,border-color .2s,box-shadow .2s}
      .ab-choice:hover{transform:translateY(-3px);border-color:rgba(170,240,255,.8);box-shadow:0 6px 24px rgba(70,200,255,.25)}
      .ab-choice b{display:block;font-size:14px;font-weight:500;margin:6px 0 6px}
      .ab-choice span{font-size:11px;line-height:1.6;color:#93bccb;display:block}
      .ab-choice canvas{width:64px;height:44px;display:block;margin:0 auto}
      .ab-row{display:flex;gap:10px;justify-content:center}
      .ab-help li{font-size:13px;color:#a8cfdd;text-align:left;line-height:1.9}
      .ab-inspect{position:absolute;z-index:4;background:rgba(6,26,40,.9);border:1px solid rgba(130,215,255,.35);border-radius:12px;padding:12px 16px;min-width:170px;text-align:center;display:none;box-shadow:0 6px 40px rgba(0,8,16,.6)}
      .ab-inspect .nm{font-size:15px;color:#eefaff;margin-bottom:2px;text-shadow:0 0 14px rgba(120,225,255,.6)}
      .ab-inspect .by{font-size:11px;color:#8fb8c8;margin-bottom:4px}
      .ab-inspect .rs{font-size:11px;color:#ffd9a0;margin-bottom:10px}
      .ab-fade{animation:ab-fadein .6s ease}
      @keyframes ab-fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    `
    root.appendChild(style)

    const wrap = document.createElement('div')
    wrap.className = 'ab-root'
    root.appendChild(wrap)

    const canvas = document.createElement('canvas')
    wrap.appendChild(canvas)

    const hud = document.createElement('div')
    hud.className = 'ab-hud'
    wrap.appendChild(hud)

    const el = (cls: string, parent: HTMLElement = hud) => {
      const d = document.createElement('div')
      d.className = cls
      parent.appendChild(d)
      return d
    }

    const titleEl = el('ab-title')
    const bandEl = el('ab-band')
    const gcountEl = el('ab-gcount')
    const motesEl = el('ab-motes')
    const hintEl = el('ab-hint')
    const toastEl = el('ab-toast')

    const btnRow = document.createElement('div')
    btnRow.className = 'ab-btnrow'
    btnRow.style.pointerEvents = 'auto'
    hud.appendChild(btnRow)
    const soundBtn = document.createElement('button')
    soundBtn.className = 'ab-btn'
    const helpBtn = document.createElement('button')
    helpBtn.className = 'ab-btn'
    btnRow.append(soundBtn, helpBtn)

    const releaseBtn = document.createElement('button')
    releaseBtn.className = 'ab-btn ab-release'
    releaseBtn.style.display = 'none'
    hud.appendChild(releaseBtn)

    const inspectEl = document.createElement('div')
    inspectEl.className = 'ab-inspect'
    wrap.appendChild(inspectEl)

    const modal = document.createElement('div')
    modal.className = 'ab-modal'
    wrap.appendChild(modal)

    /* ── state ─────────────────────────────────────────────────────────── */

    const sim = new Sim()
    const renderer = new Renderer(canvas)
    const dwellers = new Map<string, Dweller>()
    const resCounts = new Map<string, number>()
    const myResonated = new Set<string>()
    let gardenTotal = 0
    let mode: Mode = 'intro'
    let synth: Synth | null = null
    let soundOn = true
    let camX = 0
    let camY = 0
    let camSnapped = false
    let focusId: string | null = null
    let sparks: Spark[] = []
    let toastTimer = 0
    let hintTimer = 0
    let bandTimer = 0
    let lastNow = performance.now()
    let evolveOptions: string[] = []
    let panRef: { px: number; py: number; cx: number; cy: number } | null = null
    let releasedFocus: string | null = null

    const rand = mulberry32((Math.random() * 2 ** 31) | 0)

    /* ── tiny UI helpers ───────────────────────────────────────────────── */

    const toast = (msg: string, ms = 2600) => {
      toastEl.textContent = msg
      toastEl.style.opacity = '1'
      toastTimer = ms / 1000
    }

    const hint = (msg: string, ms = 5000) => {
      hintEl.textContent = msg
      hintEl.style.opacity = '1'
      hintTimer = ms / 1000
    }

    const errorToast = (err: unknown, fallback: string) => {
      const code = (err as WorldError)?.code
      if (code === 'rate-limited') toast(T.rateLimited)
      else if (code === 'unauthenticated') toast(fallback)
      else if (code === 'unique') toast(T.alreadyResonated)
      else toast(T.storeUnavailable)
    }

    const applyLang = () => {
      T = strings(ctx.lang)
      // in Chinese the wordmark pairs 渊光 with the English name; in English
      // that pairing would just repeat itself
      titleEl.textContent = ctx.lang === 'zh' ? `${T.title} · ABYSSAL BLOOM` : 'ABYSSAL BLOOM'
      soundBtn.textContent = soundOn ? T.soundOn : T.soundOff
      helpBtn.textContent = T.helpBtn
      releaseBtn.textContent = T.releaseBtn
      gcountEl.textContent = T.gardenCount(gardenTotal)
      const band = bandAt(mode === 'garden' ? camY + renderer.h / 2 : sim.player.head.y)
      bandEl.textContent = T.bandNames[band]
    }

    /* ── audio ─────────────────────────────────────────────────────────── */

    const ensureAudio = () => {
      if (synth) return
      try {
        void ctx
          .audio()
          .then((ac) => {
            if (!synth) {
              synth = new Synth(ac)
              synth.setEnabled(soundOn)
            }
          })
          .catch(() => {})
      } catch {
        // a host without audio support must never block the dive itself
      }
    }

    void ctx.local
      .get<boolean>('sound')
      .then((v) => {
        if (v === false) {
          soundOn = false
          synth?.setEnabled(false)
          soundBtn.textContent = T.soundOff
        }
      })
      .catch(() => {})

    soundBtn.onclick = () => {
      soundOn = !soundOn
      soundBtn.textContent = soundOn ? T.soundOn : T.soundOff
      synth?.setEnabled(soundOn)
      ensureAudio()
      void ctx.local.set('sound', soundOn).catch(() => {})
    }

    /* ── modals ────────────────────────────────────────────────────────── */

    const closeModal = () => {
      modal.classList.remove('open')
      modal.style.opacity = '0'
      modal.style.pointerEvents = 'none'
      modal.innerHTML = ''
    }

    const openModal = (build: (card: HTMLElement) => void) => {
      modal.innerHTML = ''
      modal.onclick = null
      const card = document.createElement('div')
      card.className = 'ab-card ab-fade'
      modal.appendChild(card)
      build(card)
      modal.classList.add('open')
      modal.style.opacity = '1'
      modal.style.pointerEvents = 'auto'
    }

    const button = (label: string, primary: boolean, onClick: () => void) => {
      const b = document.createElement('button')
      b.className = 'ab-btn'
      if (primary) {
        b.style.borderColor = 'rgba(170,240,255,.8)'
        b.style.background = 'rgba(16,68,88,.9)'
      }
      b.textContent = label
      b.onclick = onClick
      return b
    }

    const beginDive = () => {
      ensureAudio()
      synth?.uiTick()
      closeModal()
      mode = 'dive'
      hint(T.moveHint, 6000)
    }

    const showIntro = () => {
      mode = 'intro'
      openModal((card) => {
        const h = document.createElement('h1')
        h.textContent = T.title
        const p = document.createElement('p')
        p.textContent = T.tagline
        card.append(h, p, button(T.begin, true, beginDive))
        // the whole veil is the affordance — any touch starts the dive
        modal.onclick = (e) => {
          if (e.target === modal) beginDive()
        }
      })
    }

    const showHelp = () => {
      openModal((card) => {
        const h = document.createElement('h2')
        h.textContent = T.title
        const ul = document.createElement('ul')
        ul.className = 'ab-help'
        for (const line of T.helpBody) {
          const li = document.createElement('li')
          li.textContent = line
          ul.appendChild(li)
        }
        card.append(h, ul, button(T.helpClose, true, closeModal))
      })
    }
    helpBtn.onclick = () => {
      ensureAudio()
      showHelp()
    }

    /* evolution — slow the water, offer three futures */

    /** Little live portrait: the current creature, optionally with one more trait. */
    const traitPreview = (extra: string | null): HTMLCanvasElement => {
      const c = document.createElement('canvas')
      c.width = 128
      c.height = 88
      const g = c.getContext('2d')!
      g.globalCompositeOperation = 'lighter'
      const addTrait = extra !== null && (ALL_TRAITS as string[]).includes(extra) ? [extra as Trait] : []
      const genome: Genome = {
        ...sim.player.genome,
        traits: [...sim.player.genome.traits, ...addTrait].slice(0, 6),
        segs: extra === 'grow' ? Math.min(30, sim.player.genome.segs + 5) : sim.player.genome.segs,
        motes: Math.max(10, sim.player.genome.motes),
      }
      const spine = []
      const n = Math.min(genome.segs, 14)
      for (let i = 0; i < n; i++) {
        spine.push({ x: 92 - i * 5.4, y: 44 + Math.sin(i * 0.5) * 7 })
      }
      drawCreature(g, genome, spine, 1.8, { glow: 0.9, scale: 0.62 })
      return c
    }

    const showEvolve = () => {
      mode = 'evolve'
      const owned = sim.player.genome.traits
      const pool = ALL_TRAITS.filter((t) => !owned.includes(t))
      const picks: string[] = []
      while (picks.length < 2 && pool.length > 0) {
        const t = pool.splice(Math.floor(rand() * pool.length), 1)[0]
        picks.push(t)
      }
      picks.push('grow')
      evolveOptions = picks
      synth?.evolve()
      openModal((card) => {
        const h = document.createElement('h2')
        h.textContent = T.evolveTitle
        card.appendChild(h)
        const row = document.createElement('div')
        row.className = 'ab-choices'
        for (const opt of evolveOptions) {
          const b = document.createElement('button')
          b.className = 'ab-choice'
          b.appendChild(traitPreview(opt))
          const name = document.createElement('b')
          name.textContent = opt === 'grow' ? T.growName : T.traitNames[opt]
          const desc = document.createElement('span')
          desc.textContent = opt === 'grow' ? T.growDesc : T.traitDescs[opt]
          b.append(name, desc)
          b.onclick = () => {
            sim.player.applyChoice(opt)
            closeModal()
            mode = 'dive'
            synth?.uiTick()
            if (opt !== 'grow') toast(T.evolvedToast(T.traitNames[opt]))
          }
          row.appendChild(b)
        }
        card.appendChild(row)
        card.appendChild(
          button(T.evolveSkip, false, () => {
            sim.player.applyChoice('skip')
            closeModal()
            mode = 'dive'
          }),
        )
      })
    }

    /* release — the one write that matters */

    const spawnDweller = (rec: Rec<CreaturePayload>, justReleased: boolean) => {
      if (dwellers.has(rec.id)) return
      const d = new Dweller(
        rec.id,
        payloadToGenome(rec.payload),
        rec.payload.name?.trim() || null,
        rec.author.name || T.anonymous,
        rec.mine,
        justReleased,
      )
      d.haloTarget = haloFor(resCounts.get(rec.id) ?? 0)
      dwellers.set(rec.id, d)
    }

    const haloFor = (count: number) => Math.min(1, count / 12)

    const doRelease = (name: string) => {
      const g = sim.player.genome
      const payload: CreaturePayload = {
        seed: g.seed,
        hue: Math.round(g.hue),
        hue2: Math.round(g.hue2),
        segs: g.segs,
        motes: g.motes,
        traits: g.traits,
      }
      const nm = name.trim().slice(0, 18)
      if (nm) payload.name = nm
      closeModal()
      creatures
        .add(payload)
        .then((rec) => {
          gardenTotal++
          gcountEl.textContent = T.gardenCount(gardenTotal)
          spawnDweller(rec, true)
          releasedFocus = rec.id
          mode = 'ceremony'
          synth?.release()
          const d = dwellers.get(rec.id)
          if (d) {
            for (let i = 0; i < 46; i++) {
              const a = rand() * Math.PI * 2
              const sp = 30 + rand() * 150
              sparks.push({
                x: d.anchorX,
                y: d.anchorY,
                vx: Math.cos(a) * sp,
                vy: Math.sin(a) * sp,
                life: 1.6 + rand() * 1.8,
                age: 0,
                hue: rand() > 0.5 ? g.hue : g.hue2,
              })
            }
          }
          toast(T.releasedToast, 3400)
          setTimeout(() => {
            if (mode === 'ceremony') showAfterRelease()
          }, 3600)
        })
        .catch((err: WorldError) => {
          if (err?.code === 'quota') showQuota(nm)
          else errorToast(err, T.signInToRelease)
        })
    }

    const showAfterRelease = () => {
      mode = 'garden'
      openModal((card) => {
        const h = document.createElement('h2')
        h.textContent = T.releasedToast
        const row = document.createElement('div')
        row.className = 'ab-row'
        row.append(
          button(T.newDive, true, () => {
            closeModal()
            sim.rebirth()
            mode = 'dive'
            camSnapped = false
            hint(T.moveHint, 5000)
          }),
          button(T.stayGarden, false, closeModal),
        )
        card.append(h, row)
      })
    }

    /** Quota hit mid-release: offer to retire the oldest creature, then finish
     * the original release with the name the visitor already typed. */
    const showQuota = (pendingName: string) => {
      openModal((card) => {
        const h = document.createElement('h2')
        h.textContent = T.quotaTitle
        const p = document.createElement('p')
        p.textContent = T.quotaBody
        const row = document.createElement('div')
        row.className = 'ab-row'
        row.append(
          button(T.quotaReplace, true, () => {
            closeModal()
            creatures
              .list({ mine: true, limit: 10, sort: ['createdAt'] })
              .then((page) => {
                const oldest = page.items[0]
                if (!oldest) return
                return creatures.del(oldest.id).then(() => {
                  dwellers.delete(oldest.id)
                  gardenTotal = Math.max(0, gardenTotal - 1)
                  gcountEl.textContent = T.gardenCount(gardenTotal)
                  doRelease(pendingName)
                })
              })
              .catch((err: WorldError) => errorToast(err, T.signInToRelease))
          }),
          button(T.quotaKeep, false, closeModal),
        )
        card.append(h, p, row)
      })
    }

    const showReleaseDialog = () => {
      openModal((card) => {
        const h = document.createElement('h2')
        h.textContent = T.releaseTitle
        const preview = traitPreview(null)
        preview.style.width = '128px'
        preview.style.height = '88px'
        preview.style.margin = '0 auto 10px'
        const input = document.createElement('input')
        input.placeholder = T.releaseNamePh
        input.maxLength = 18
        const row = document.createElement('div')
        row.className = 'ab-row'
        row.append(
          button(T.releaseConfirm, true, () => doRelease(input.value)),
          button(T.releaseCancel, false, () => {
            closeModal()
            mode = 'dive'
          }),
        )
        card.append(h, preview, input, row)
        setTimeout(() => input.focus(), 60)
      })
    }

    releaseBtn.onclick = () => {
      if (mode === 'garden') {
        // the same slot doubles as "raise another light" while browsing
        sim.rebirth()
        mode = 'dive'
        camSnapped = false
        hint(T.moveHint, 5000)
        return
      }
      if (!releaseEligible()) {
        toast(T.releaseLocked)
        return
      }
      if (!ctx.me) {
        toast(T.signInToRelease)
        return
      }
      showReleaseDialog()
    }

    const releaseEligible = () =>
      mode === 'dive' && sim.player.genome.motes >= RELEASE_MIN_MOTES && bandAt(sim.player.head.y) === 3

    /* inspect — tap a dweller, resonate with it */

    const closeInspect = () => {
      inspectEl.style.display = 'none'
      focusId = null
    }

    const openInspect = (d: Dweller) => {
      focusId = d.id
      inspectEl.innerHTML = ''
      const nm = document.createElement('div')
      nm.className = 'nm'
      nm.textContent = d.name ?? (ctx.lang === 'zh' ? '无名之光' : 'unnamed light')
      const by = document.createElement('div')
      by.className = 'by'
      by.textContent = d.mine ? T.myCreature : T.byline(d.authorName)
      const rs = document.createElement('div')
      rs.className = 'rs'
      rs.textContent = T.resonanceCount(resCounts.get(d.id) ?? 0)
      inspectEl.append(nm, by, rs)
      const row = document.createElement('div')
      row.className = 'ab-row'
      row.style.pointerEvents = 'auto'
      if (d.mine) {
        row.appendChild(
          button(T.removeBtn, false, () => {
            row.innerHTML = ''
            row.append(
              button(T.removeConfirm, true, () => {
                creatures
                  .del(d.id)
                  .then(() => {
                    dwellers.delete(d.id)
                    gardenTotal = Math.max(0, gardenTotal - 1)
                    gcountEl.textContent = T.gardenCount(gardenTotal)
                    closeInspect()
                  })
                  .catch((err: WorldError) => errorToast(err, T.storeUnavailable))
              }),
              button(T.removeCancel, false, () => openInspect(d)),
            )
          }),
        )
      } else {
        const done = myResonated.has(d.id)
        const rb = button(done ? T.alreadyResonated : T.resonateBtn, !done, () => {
          if (myResonated.has(d.id)) return
          if (!ctx.me) {
            toast(T.signInToResonate)
            return
          }
          resonance
            .add({ target: d.id })
            .then(() => {
              myResonated.add(d.id)
              const c = (resCounts.get(d.id) ?? 0) + 1
              resCounts.set(d.id, c)
              d.haloTarget = haloFor(c)
              d.halo = Math.min(1.4, d.haloTarget + 0.5)
              rs.textContent = T.resonanceCount(c)
              rb.textContent = T.alreadyResonated
              synth?.resonate()
              toast(T.resonated)
            })
            .catch((err: WorldError) => {
              if (err?.code === 'unique') {
                myResonated.add(d.id)
                rb.textContent = T.alreadyResonated
              }
              errorToast(err, T.signInToResonate)
            })
        })
        row.appendChild(rb)
      }
      inspectEl.appendChild(row)
      inspectEl.style.display = 'block'
      inspectEl.style.pointerEvents = 'auto'
    }

    /* ── records: initial load + live changes ──────────────────────────── */

    const loadGarden = async () => {
      const page = await creatures.list({ limit: 50, sort: ['-createdAt'] })
      const ids = page.items.map((r) => r.id)
      gardenTotal = await creatures.count().catch(() => page.items.length)
      gcountEl.textContent = T.gardenCount(gardenTotal)

      if (ids.length > 0) {
        let cursor: string | undefined
        for (let p = 0; p < 12; p++) {
          const rp = await resonance
            .list({ where: { 'payload.target': { in: ids } }, limit: 50, cursor })
            .catch(() => null)
          if (!rp) break
          for (const r of rp.items) {
            resCounts.set(r.payload.target, (resCounts.get(r.payload.target) ?? 0) + 1)
            if (r.mine) myResonated.add(r.payload.target)
          }
          if (!rp.hasMore || !rp.cursor) break
          cursor = rp.cursor
        }
      }
      for (const rec of page.items) spawnDweller(rec, false)
    }

    await loadGarden().catch(() => toast(T.storeUnavailable))

    creatures.onChange((e) => {
      if (e.op === 'added') {
        if (dwellers.has(e.record.id)) return // my own add already arrived locally
        gardenTotal++
        gcountEl.textContent = T.gardenCount(gardenTotal)
        spawnDweller(e.record, true)
      } else if (e.op === 'deleted') {
        if (dwellers.delete(e.id)) {
          gardenTotal = Math.max(0, gardenTotal - 1)
          gcountEl.textContent = T.gardenCount(gardenTotal)
          if (focusId === e.id) closeInspect()
        }
      } else {
        const d = dwellers.get(e.record.id)
        if (d) {
          dwellers.delete(e.record.id)
          spawnDweller(e.record, false)
        }
      }
    })

    resonance.onChange((e) => {
      if (e.op !== 'added') return
      const id = e.record.payload.target
      const c = (resCounts.get(id) ?? 0) + 1
      resCounts.set(id, c)
      if (e.record.mine) myResonated.add(id)
      const d = dwellers.get(id)
      if (d) {
        d.haloTarget = haloFor(c)
        d.halo = Math.min(1.4, d.haloTarget + 0.4)
      }
    })

    ctx.onVisitor(() => {
      // `mine` flags on dwellers and my resonance set both depend on identity
      myResonated.clear()
      resCounts.clear()
      dwellers.clear()
      void loadGarden().catch(() => {})
      if (focusId) closeInspect()
    })

    ctx.onLangChange(applyLang)
    applyLang()

    /* ── input ─────────────────────────────────────────────────────────── */

    const toWorld = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect()
      return { x: clientX - r.left + camX, y: clientY - r.top + camY }
    }

    let downAt = { x: 0, y: 0, t: 0 }
    let pointerHeld = false

    canvas.style.pointerEvents = 'auto'

    // Mouse + touch rather than pointer events: every real browser fires these,
    // and so do automation pipelines that never synthesise PointerEvents.
    const steer = (clientX: number, clientY: number, fromTouch: boolean) => {
      const w = toWorld(clientX, clientY)
      if (mode === 'dive' && (!fromTouch || pointerHeld)) {
        sim.player.targetX = w.x
        sim.player.targetY = w.y
        sim.player.hasTarget = true
      }
      if (mode === 'garden' && panRef && pointerHeld) {
        camX = Math.max(0, Math.min(WORLD_W - renderer.w, panRef.cx - (clientX - panRef.px)))
        camY = Math.max(GARDEN_TOP - 200, Math.min(WORLD_H - renderer.h, panRef.cy - (clientY - panRef.py)))
      }
    }

    const onDown = (clientX: number, clientY: number, fromTouch: boolean) => {
      ensureAudio()
      pointerHeld = true
      downAt = { x: clientX, y: clientY, t: performance.now() }
      panRef = { px: clientX, py: clientY, cx: camX, cy: camY }
      steer(clientX, clientY, fromTouch)
    }

    const onUp = (clientX: number, clientY: number) => {
      pointerHeld = false
      panRef = null
      const dt = performance.now() - downAt.t
      const dist = Math.hypot(clientX - downAt.x, clientY - downAt.y)
      if (dt < 320 && dist < 9) {
        const w = toWorld(clientX, clientY)
        let hit: Dweller | null = null
        let hitD = 1e9
        for (const d of dwellers.values()) {
          const r = headRadius(d.genome) * 3 + 26
          const dd = Math.hypot(d.spine[0].x - w.x, d.spine[0].y - w.y)
          if (dd < r && dd < hitD) {
            hit = d
            hitD = dd
          }
        }
        if (hit) {
          openInspect(hit)
          synth?.uiTick()
        } else if (focusId) {
          closeInspect()
        }
      }
    }

    // The target persists after the cursor leaves or the finger lifts: the
    // creature glides to the last asked-for spot and rests there.
    canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY, false))
    canvas.addEventListener('mousemove', (e) => steer(e.clientX, e.clientY, false))
    canvas.addEventListener('mouseup', (e) => onUp(e.clientX, e.clientY))
    canvas.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault()
        const t0 = e.touches[0]
        if (t0) onDown(t0.clientX, t0.clientY, true)
      },
      { passive: false },
    )
    canvas.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault()
        const t0 = e.touches[0]
        if (t0) steer(t0.clientX, t0.clientY, true)
      },
      { passive: false },
    )
    canvas.addEventListener('touchend', (e) => {
      const t0 = e.changedTouches[0]
      if (t0) onUp(t0.clientX, t0.clientY)
    })
    canvas.addEventListener('touchcancel', () => {
      pointerHeld = false
      panRef = null
      sim.player.hasTarget = false
    })

    /* ── resize ────────────────────────────────────────────────────────── */

    const doResize = () => {
      const r = wrap.getBoundingClientRect()
      renderer.resize(Math.max(320, r.width), Math.max(240, r.height), window.devicePixelRatio || 1)
    }
    doResize()
    const ro = new ResizeObserver(doResize)
    ro.observe(wrap)

    /* ── main loop ─────────────────────────────────────────────────────── */

    let hinted = { eat: false, garden: false }
    let simTime = 0

    /** One frame of the world. `dtOverride` lets a test driver advance game
     * time without depending on rAF cadence (hidden tabs pause rAF entirely). */
    const advance = (dtOverride?: number) => {
      const now = performance.now()
      let dt = dtOverride ?? Math.min(0.05, (now - lastNow) / 1000)
      lastNow = now
      simTime += dt
      const t = simTime

      if (mode === 'evolve') dt *= 0.12
      if (mode === 'dive' || mode === 'evolve') sim.step(dt)
      for (const d of dwellers.values()) d.step(dt, t)

      /* events */
      for (const ev of sim.drainEvents()) {
        if (ev.kind === 'eat') {
          synth?.eat(ev.streak)
          if (!hinted.eat) {
            hinted.eat = true
            hint(T.eatHint, 4200)
          }
        } else if (ev.kind === 'sting') {
          synth?.sting()
          toast(T.stungToast, 1800)
        } else if (ev.kind === 'evolve-ready') {
          if (mode === 'dive') showEvolve()
        } else if (ev.kind === 'band') {
          bandEl.textContent = T.bandNames[ev.band]
          bandEl.style.opacity = '1'
          bandTimer = 3.2
          gcountEl.style.opacity = ev.band === 3 ? '1' : '0'
          if (ev.band === 3 && !hinted.garden) {
            hinted.garden = true
            hint(T.gardenHint, 5200)
          }
          if (ev.band === 2 && sim.player.genome.motes >= 6) hint(T.descendHint, 3600)
        }
      }

      /* camera */
      let wantX = camX
      let wantY = camY
      if (mode === 'dive' || mode === 'evolve' || mode === 'intro') {
        wantX = sim.player.head.x - renderer.w / 2
        wantY = sim.player.head.y - renderer.h * 0.44
      } else if (mode === 'ceremony' && releasedFocus) {
        const d = dwellers.get(releasedFocus)
        if (d) {
          wantX = d.spine[0].x - renderer.w / 2
          wantY = d.spine[0].y - renderer.h * 0.5
        }
      } else if (mode === 'garden' && !panRef) {
        wantX = camX
        wantY = camY
      }
      wantX = Math.max(0, Math.min(WORLD_W - renderer.w, wantX))
      wantY = Math.max(0, Math.min(WORLD_H - renderer.h, wantY))
      if (!camSnapped) {
        camX = wantX
        camY = wantY
        camSnapped = true
      } else if (!panRef) {
        const k = Math.min(1, dt * 2.6)
        camX += (wantX - camX) * k
        camY += (wantY - camY) * k
      }

      /* sparks */
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i]
        s.age += dt
        s.x += s.vx * dt
        s.y += s.vy * dt
        s.vx *= Math.pow(0.5, dt)
        s.vy = s.vy * Math.pow(0.5, dt) - 18 * dt
        if (s.age >= s.life) sparks.splice(i, 1)
      }

      /* HUD timers */
      if (toastTimer > 0) {
        toastTimer -= dt
        if (toastTimer <= 0) toastEl.style.opacity = '0'
      }
      if (hintTimer > 0) {
        hintTimer -= dt
        if (hintTimer <= 0) hintEl.style.opacity = '0'
      }
      if (bandTimer > 0) {
        bandTimer -= dt
        if (bandTimer <= 0 && bandAt(sim.player.head.y) !== 3) bandEl.style.opacity = '0'
      }

      const playing = mode === 'dive' || mode === 'evolve'
      motesEl.textContent = playing ? `✦ ${sim.player.genome.motes} ${T.motesLabel}` : ''
      if (playing && sim.player.genome.motes >= 4) {
        releaseBtn.style.display = 'block'
        releaseBtn.textContent = T.releaseBtn
        releaseBtn.classList.toggle('ready', releaseEligible())
      } else if (mode === 'garden') {
        releaseBtn.style.display = 'block'
        releaseBtn.textContent = T.newDive
        releaseBtn.classList.remove('ready')
      } else {
        releaseBtn.style.display = 'none'
      }

      synth?.setDepth(Math.min(1, (camY + renderer.h / 2) / WORLD_H))

      /* draw */
      renderer.frame(
        {
          time: t,
          camX,
          camY,
          sim,
          dwellers: [...dwellers.values()],
          playerVisible: playing,
          focusId,
        },
        (g) => {
          renderer.drawMotes(g, sim, t, camY)
          renderer.drawMedusae(g, sim, t, camY)
          for (const d of dwellers.values()) {
            const hy = d.spine[0].y
            if (hy < camY - 400 || hy > camY + renderer.h + 400) continue
            drawCreature(g, d.genome, d.spine, t + d.phase, {
              glow: 0.62 * d.bloom + d.halo * 0.3,
              halo: d.halo,
              scale: 0.4 + 0.6 * d.bloom,
            })
            if (focusId === d.id) renderer.drawFocusRing(g, d.spine, headRadius(d.genome), t)
          }
          if (playing) {
            drawCreature(g, sim.player.genome, sim.player.spine, t, {
              glow: sim.player.stingCooldown > 1.6 ? 0.5 + 0.5 * Math.sin(t * 26) : 1,
            })
          }
          renderer.drawRings(g, sim)
          for (const s of sparks) {
            const k = 1 - s.age / s.life
            renderer.drawSpark(g, s.x, s.y, 6 + k * 10, s.hue, k * 0.8)
          }
        },
      )

      /* keep the inspect card pinned to its creature */
      if (focusId) {
        const d = dwellers.get(focusId)
        if (d) {
          const sx = d.spine[0].x - camX
          const sy = d.spine[0].y - camY
          const rect = inspectEl.getBoundingClientRect()
          inspectEl.style.left = `${Math.max(8, Math.min(renderer.w - rect.width - 8, sx - rect.width / 2))}px`
          inspectEl.style.top = `${Math.max(8, Math.min(renderer.h - rect.height - 8, sy + headRadius(d.genome) * 3 + 18))}px`
        } else {
          closeInspect()
        }
      }
    }

    const tick = () => {
      advance()
      requestAnimationFrame(tick)
    }

    showIntro()
    requestAnimationFrame(tick)
  },
})
