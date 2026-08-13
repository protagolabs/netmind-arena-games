/**
 * 山外山 · Peaks Beyond
 *
 * One shared mountain path, climbed with a single input: hold to charge,
 * release to leap. At the frontier you leap into the mist and a stone is born
 * where you land — one stone per person per day, enforced by the platform's
 * uniqueness constraint on [author.id, payload.day]. Falling is soft: the
 * cloud sea returns you to your last stone.
 *
 * Storage discipline: writes happen only on explicit acts (the leap that
 * places a stone; tapping the bell button). Every storage failure surfaces as
 * a quiet toast — `unique`, `quota`, `rate-limited`, `unauthenticated` are
 * ordinary weather on a shared mountain, never a dead button. All shared text
 * (author names, carved marks) is rendered through canvas fillText or DOM
 * textContent; nothing user-authored ever reaches markup.
 *
 * The renderer clamps every loaded stone into jumpable range of the previous
 * one, so moderation deletions and API-written stones can never break the
 * path. The day's wind comes from the calendar date — everyone feels the same
 * wind.
 */

import { defineWorld, type Rec, type WorldError } from '@arena/world-sdk'
import { strings, type Strings } from './i18n.js'
import { Sim, h1, type PNode } from './sim.js'
import { Renderer } from './render.js'
import { Synth, PENTA } from './audio.js'

interface StonePayload {
  x: number
  y: number
  style: number
  day: number
  mark?: string
}

interface BellPayload {
  target: string
}

const today = (): number => Math.floor(Date.now() / 86400000)

const strHash = (s: string): number => {
  let h = 7
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export default defineWorld({
  meta: { type: 'peaks-beyond' },

  async mount(root, ctx) {
    let T: Strings = strings(ctx.lang)
    const stones = ctx.collection<StonePayload>('stones')
    const bells = ctx.collection<BellPayload>('bells')

    root.innerHTML = ''
    const style = document.createElement('style')
    style.textContent = `
      /* Arena draws the manifest's \`credits\` chip in its own chrome at the
         bottom-right of the frame, over the world. --pb-chrome is the band we
         leave free for it, so every bottom-anchored control sits above it
         instead of underneath. */
      .pb-root{--pb-chrome:46px;position:absolute;inset:0;overflow:hidden;background:#1a1e2c;font-family:${ctx.theme.font},'PingFang SC',system-ui,sans-serif;user-select:none;-webkit-user-select:none;touch-action:none;color:#e8ecf5}
      .pb-root canvas{position:absolute;inset:0;display:block;cursor:pointer}
      .pb-corner{position:absolute;right:12px;bottom:calc(12px + var(--pb-chrome));display:flex;gap:8px;z-index:15}
      .pb-btn{pointer-events:auto;font-size:12px;line-height:1;padding:7px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.22);background:rgba(16,20,32,0.55);color:#e8ecf5;cursor:pointer;backdrop-filter:blur(4px)}
      .pb-btn.pb-off{opacity:0.5}
      .pb-bell{position:absolute;left:50%;bottom:calc(14px + var(--pb-chrome));transform:translateX(-50%);z-index:15;display:none}
      .pb-veil{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,13,22,0.55);z-index:12}
      .pb-card{max-width:420px;margin:16px;padding:26px 28px;border-radius:16px;background:rgba(18,22,36,0.92);border:1px solid rgba(255,255,255,0.14);text-align:center}
      .pb-card h1{margin:0 0 14px;font-size:22px;font-weight:600;letter-spacing:0.2em}
      .pb-card p{margin:6px 0;font-size:13px;line-height:1.7;color:#c3cadd}
      .pb-card .pb-note{font-size:11px;color:#8b93a8;margin-top:12px}
      .pb-go{margin-top:16px;font-size:14px;padding:9px 30px;border-radius:10px;border:none;background:#ffbf6e;color:#2b2413;cursor:pointer;font-weight:600}
      .pb-go.pb-quiet{background:transparent;border:1px solid rgba(255,255,255,0.25);color:#c3cadd;margin-left:10px}
      .pb-panel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,13,22,0.5);z-index:20}
      .pb-panel .pb-card{text-align:left}
      .pb-panel li{font-size:13px;line-height:1.8;color:#c3cadd;margin:0 0 2px}
      .pb-mark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,13,22,0.45);z-index:18}
      .pb-mark input{width:100%;box-sizing:border-box;margin-top:10px;padding:9px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.25);background:rgba(10,13,22,0.6);color:#e8ecf5;font-size:14px;text-align:center;outline:none}
      .pb-toast{position:absolute;left:50%;bottom:calc(64px + var(--pb-chrome));transform:translateX(-50%);background:rgba(18,22,36,0.9);border:1px solid rgba(255,255,255,0.16);border-radius:10px;padding:8px 16px;font-size:12.5px;opacity:0;transition:opacity 0.35s ease;pointer-events:none;z-index:14;max-width:80%;text-align:center}
    `
    const wrap = document.createElement('div')
    wrap.className = 'pb-root'
    root.appendChild(style)
    root.appendChild(wrap)
    const cvs = document.createElement('canvas')
    wrap.appendChild(cvs)

    const wind = (h1(today()) - 0.5) * 0.36
    const synth = new Synth()
    let myBells = new Map<string, string>()

    const sim = new Sim(wind, {
      onPerfect: (combo) => synth.chime(PENTA[Math.min(6, combo - 1)], 0.09, 0.9),
      onGrab: () => synth.chime(196, 0.05, 0.7),
      onSpawn: (node) => {
        synth.chime(262, 0.08, 1.4)
        synth.chime(523, 0.05, 1.4)
        placeFlow(node)
      },
      onFall: () => synth.chime(147, 0.06, 1.5),
      onBell: () => synth.chime(1174, 0.03, 1.2),
      onDenied: () => toast(sim.anonNote ? T.signInToPlace : T.alreadyToday),
      onStand: () => updateBellBtn(),
    })
    const ren = new Renderer(cvs)
    let arcOn = true

    /* ── corner buttons, toast ──────────────────────────────────────────── */

    const corner = document.createElement('div')
    corner.className = 'pb-corner'
    wrap.appendChild(corner)
    const mkBtn = (label: string, onTap: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.className = 'pb-btn'
      b.textContent = label
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        onTap()
      })
      corner.appendChild(b)
      return b
    }
    const howBtn = mkBtn(T.how, () => showPanel())
    const sndBtn = mkBtn(T.sound, () => {
      synth.enabled = !synth.enabled
      sndBtn.classList.toggle('pb-off', !synth.enabled)
      void ctx.local.set('pb.sound', synth.enabled ? 'on' : 'off').catch(() => {})
    })
    const arcBtn = mkBtn(T.arc, () => {
      arcOn = !arcOn
      arcBtn.classList.toggle('pb-off', !arcOn)
      void ctx.local.set('pb.arc', arcOn ? 'on' : 'off').catch(() => {})
    })
    const rstBtn = mkBtn(T.restart, () => sim.setTo(0))
    sndBtn.classList.add('pb-off')

    const bellBtn = document.createElement('button')
    bellBtn.className = 'pb-btn pb-bell'
    wrap.appendChild(bellBtn)

    const toastEl = document.createElement('div')
    toastEl.className = 'pb-toast'
    wrap.appendChild(toastEl)
    let toastTimer = 0
    const toast = (msg: string): void => {
      toastEl.textContent = msg
      toastEl.style.opacity = '1'
      window.clearTimeout(toastTimer)
      toastTimer = window.setTimeout(() => {
        toastEl.style.opacity = '0'
      }, 3200)
    }

    /* ── welcome & rules ────────────────────────────────────────────────── */

    let veil: HTMLDivElement | null = null
    const showWelcome = (): void => {
      if (veil) return
      veil = document.createElement('div')
      veil.className = 'pb-veil'
      const card = document.createElement('div')
      card.className = 'pb-card'
      const h = document.createElement('h1')
      h.textContent = T.title
      card.appendChild(h)
      for (const line of [T.w1, T.w2, T.w3]) {
        const p = document.createElement('p')
        p.textContent = line
        card.appendChild(p)
      }
      const note = document.createElement('p')
      note.className = 'pb-note'
      note.textContent = T.m1Note
      card.appendChild(note)
      const go = document.createElement('button')
      go.className = 'pb-go'
      go.textContent = T.begin
      go.addEventListener('click', (e) => {
        e.stopPropagation()
        veil?.remove()
        veil = null
        void ctx.local.set('pb.welcomed', '1').catch(() => {})
      })
      card.appendChild(go)
      veil.appendChild(card)
      wrap.appendChild(veil)
    }

    let panel: HTMLDivElement | null = null
    const showPanel = (): void => {
      if (panel) return
      panel = document.createElement('div')
      panel.className = 'pb-panel'
      const card = document.createElement('div')
      card.className = 'pb-card'
      const h = document.createElement('h1')
      h.textContent = T.how
      card.appendChild(h)
      const ul = document.createElement('ul')
      for (const line of T.rules) {
        const li = document.createElement('li')
        li.textContent = line
        ul.appendChild(li)
      }
      card.appendChild(ul)
      const close = document.createElement('button')
      close.className = 'pb-go'
      close.textContent = T.close
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        panel?.remove()
        panel = null
      })
      card.appendChild(close)
      panel.appendChild(card)
      wrap.appendChild(panel)
    }

    /* ── carve-a-mark dialog, then write the stone ──────────────────────── */

    let markDlg: HTMLDivElement | null = null
    const placeFlow = (node: PNode): void => {
      if (!ctx.me) {
        toast(T.signInToPlace)
        return
      }
      if (markDlg) markDlg.remove()
      markDlg = document.createElement('div')
      markDlg.className = 'pb-mark'
      const card = document.createElement('div')
      card.className = 'pb-card'
      const p = document.createElement('p')
      p.textContent = T.markTitle
      card.appendChild(p)
      const input = document.createElement('input')
      input.maxLength = 14
      input.placeholder = T.markPh
      card.appendChild(input)
      const row = document.createElement('div')
      const save = document.createElement('button')
      save.className = 'pb-go'
      save.textContent = T.markSave
      const skip = document.createElement('button')
      skip.className = 'pb-go pb-quiet'
      skip.textContent = T.markSkip
      row.appendChild(save)
      row.appendChild(skip)
      card.appendChild(row)
      markDlg.appendChild(card)
      wrap.appendChild(markDlg)
      input.focus()
      const commit = (withMark: boolean): void => {
        const mark = withMark ? input.value.trim().slice(0, 14) : ''
        markDlg?.remove()
        markDlg = null
        void writeStone(node, mark)
      }
      save.addEventListener('click', () => commit(true))
      skip.addEventListener('click', () => commit(false))
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit(true)
      })
    }

    const writeStone = async (node: PNode, mark: string): Promise<void> => {
      const payload: StonePayload = {
        x: Math.round(node.x),
        y: Math.round(node.y),
        style: strHash(`${node.x}|${node.y}`) % 6,
        day: today(),
      }
      if (mark) payload.mark = mark
      try {
        const rec = await stones.add(payload)
        node.ghost = false
        node.rid = rec.id
        node.nm = rec.author.name
        if (mark) node.mk = mark
        sim.canPlace = false
        sim.commStones++
        toast(T.stoneSaved)
      } catch (e) {
        const code = (e as WorldError).code
        if (code === 'unique') {
          sim.canPlace = false
          toast(T.alreadyToday)
        } else if (code === 'unauthenticated') toast(T.signInToPlace)
        else if (code === 'quota') toast(T.quotaFull)
        else if (code === 'rate-limited') toast(T.slowDown)
        else toast(T.stoneSaveFail)
      }
    }

    /* ── wind bells: hang on / take back from the stone you stand on ────── */

    const updateBellBtn = (): void => {
      const nd = sim.nodes[sim.idx]
      const show = !!nd && nd.k === 0 && !!nd.rid && !nd.mine && !sim.air
      bellBtn.style.display = show ? 'block' : 'none'
      if (show) bellBtn.textContent = nd.myBell ? T.bellTake : T.bellHang
    }

    bellBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const nd = sim.nodes[sim.idx]
      if (!nd || !nd.rid) return
      if (!ctx.me) {
        toast(T.signInToBell)
        return
      }
      try {
        if (nd.myBell && myBells.has(nd.rid)) {
          const bid = myBells.get(nd.rid)
          if (bid) await bells.del(bid)
          myBells.delete(nd.rid)
          nd.myBell = false
          nd.bells = Math.max(0, (nd.bells ?? 1) - 1)
          toast(T.bellBack)
        } else {
          const rec = await bells.add({ target: nd.rid })
          myBells.set(nd.rid, rec.id)
          nd.myBell = true
          nd.bells = (nd.bells ?? 0) + 1
          synth.chime(1174, 0.05, 1.2)
          toast(T.bellDone)
        }
      } catch (err) {
        const code = (err as WorldError).code
        if (code === 'unique') toast(T.bellDup)
        else if (code === 'quota') toast(T.bellQuota)
        else if (code === 'unauthenticated') toast(T.signInToBell)
        else if (code === 'rate-limited') toast(T.slowDown)
        else toast(T.stoneSaveFail)
      }
      updateBellBtn()
    })

    /* ── load & live-refresh the shared mountain ────────────────────────── */

    const recToNode = (r: Rec<StonePayload>, bellCount: Map<string, number>): PNode => {
      const hh = strHash(r.id)
      const j: number[] = []
      for (let z = 0; z < 8; z++) j.push(h1(hh + z * 131))
      return {
        k: 0,
        x: r.payload.x,
        y: r.payload.y,
        w: 48 + (r.payload.style % 3) * 5 + h1(hh + 999) * 8,
        j,
        rid: r.id,
        mine: r.mine,
        agent: r.author.kind === 'agent',
        nm: r.author.name,
        mk: r.payload.mark,
        bells: bellCount.get(r.id) ?? 0,
        myBell: myBells.has(r.id),
      }
    }

    const refresh = async (): Promise<void> => {
      try {
        const recs: Rec<StonePayload>[] = []
        let cursor: string | undefined
        for (let p = 0; p < 40; p++) {
          const page = await stones.list({ sort: ['payload.x'], limit: 200, cursor })
          recs.push(...page.items)
          if (!page.hasMore || !page.cursor) break
          cursor = page.cursor
        }
        const bellCount = new Map<string, number>()
        const mine = new Map<string, string>()
        cursor = undefined
        for (let p = 0; p < 40; p++) {
          const page = await bells.list({ limit: 200, cursor })
          for (const b of page.items) {
            bellCount.set(b.payload.target, (bellCount.get(b.payload.target) ?? 0) + 1)
            if (b.mine) mine.set(b.payload.target, b.id)
          }
          if (!page.hasMore || !page.cursor) break
          cursor = page.cursor
        }
        myBells = mine
        sim.commStones = recs.length
        sim.setStones(recs.map((r) => recToNode(r, bellCount)))
        if (!ctx.me) {
          sim.canPlace = false
          sim.anonNote = true
        } else {
          sim.anonNote = false
          const placedToday = recs.some((r) => r.mine && r.payload.day === today())
          sim.canPlace = !placedToday
        }
        updateBellBtn()
      } catch {
        /* transport hiccups: keep the current path; list() is retried on the
           next change event or visitor switch */
      }
    }

    let refreshTimer = 0
    const scheduleRefresh = (): void => {
      window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => void refresh(), 700)
    }
    stones.onChange(scheduleRefresh)
    bells.onChange(scheduleRefresh)
    ctx.onVisitor(() => scheduleRefresh())
    void refresh()

    /* ── preferences (best-effort; never gate the world on them) ────────── */

    void ctx.local
      .get<string>('pb.welcomed')
      .then((v) => {
        if (!v) showWelcome()
      })
      .catch(() => showWelcome())
    void ctx.local
      .get<string>('pb.sound')
      .then((v) => {
        if (v === 'on') {
          synth.enabled = true
          sndBtn.classList.remove('pb-off')
        }
      })
      .catch(() => {})
    void ctx.local
      .get<string>('pb.arc')
      .then((v) => {
        if (v === 'off') {
          arcOn = false
          arcBtn.classList.add('pb-off')
        }
      })
      .catch(() => {})

    /* ── language can change mid-session ────────────────────────────────── */

    ctx.onLangChange((lang) => {
      T = strings(lang)
      howBtn.textContent = T.how
      sndBtn.textContent = T.sound
      arcBtn.textContent = T.arc
      rstBtn.textContent = T.restart
      updateBellBtn()
      if (veil) {
        veil.remove()
        veil = null
        showWelcome()
      }
      if (panel) {
        panel.remove()
        panel = null
        showPanel()
      }
    })

    /* ── input ──────────────────────────────────────────────────────────── */

    const uiOpen = (): boolean => !!veil || !!panel || !!markDlg
    cvs.addEventListener('mousedown', (e) => {
      e.preventDefault()
      if (!uiOpen()) sim.press()
    })
    window.addEventListener('mouseup', () => sim.release())
    cvs.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault()
        if (!uiOpen()) sim.press()
      },
      { passive: false },
    )
    window.addEventListener('touchend', () => sim.release())
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !uiOpen()) {
        e.preventDefault()
        if (!e.repeat) sim.press()
      }
    })
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') sim.release()
    })

    /* ── size to the host, then run ─────────────────────────────────────── */

    const fit = (): void => {
      const r = wrap.getBoundingClientRect()
      ren.resize(r.width, r.height, window.devicePixelRatio || 1)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(wrap)

    let prev = 0
    const frame = (ts: number): void => {
      if (!prev) prev = ts
      let dt = Math.min(0.033, (ts - prev) / 1000)
      prev = ts
      if (sim.freeze > 0) {
        sim.freeze -= dt
        dt = 0
      }
      sim.step(dt)
      ren.draw(sim, T, arcOn)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  },
})
