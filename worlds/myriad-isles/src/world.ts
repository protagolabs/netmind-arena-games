import { defineWorld } from '@arena/world-sdk'
import { dayString, hashStr, ihash } from './seed.js'
import { makeIsland, newGame, draftPick, placeAt, canPlaceAt, scoreAt, dayProgress, ROUNDS, type BType, type GameState } from './sim.js'
import { createScene, type IsleScene } from './scene.js'
import { makeUi, applyStateToUi, type Ui } from './ui.js'
import { makeI18n } from './i18n.js'
import { makeSfx } from './audio.js'

export default defineWorld({
  meta: { type: 'myriad-isles' },

  async mount(root, ctx) {
    root.style.cssText = 'margin:0;height:100%;overflow:hidden;position:relative;background:#0b1326'
    root.innerHTML = ''
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab'
    root.appendChild(canvas)

    const day = dayString()
    const seed = hashStr(`${day}:myriad-isles:v1`)
    const island = makeIsland(seed)
    let state: GameState = newGame()
    let dict = makeI18n(ctx.lang)
    let selected: BType | null = null

    const scene: IsleScene = createScene(canvas, island)
    const ui: Ui = makeUi(root, dict)
    const sfx = makeSfx(() => ctx.audio())

    const validAt = (x: number, z: number) => canPlaceAt(island, state.placed, x, z)
    const refreshAll = () => {
      applyStateToUi(ui, state, selected)
      scene.refreshOverlay(validAt)
      scene.setNightTarget(dayProgress(state))
    }

    let modal: 'draft' | 'settle' | null = null
    const openDraft = () => {
      modal = 'draft'
      ui.showDraft(ROUNDS[state.round]!, (which) => {
        draftPick(state, ROUNDS[state.round]![which])
        ui.hideDraft()
        modal = null
        selected = state.tray[0] ?? null
        scene.setGhostType(selected)
        sfx.draft()
        refreshAll()
        ui.hint(dict.hintPlace)
      })
    }
    const openSettle = () => {
      modal = 'settle'
      const stuck = state.round < ROUNDS.length - 1
      ui.showSettle(state.score, stuck, () => {
        ui.hideSettle()
        modal = null
        state = newGame()
        scene.resetBuildings()
        scene.unsettle()
        selected = null
        scene.setGhostType(null)
        refreshAll()
        openDraft()
      })
    }

    const settleFlow = () => {
      scene.setGhostType(null)
      selected = null
      scene.settle()
      sfx.settle()
      window.setTimeout(openSettle, 2200)
    }

    const tryPlace = () => {
      if (modal || state.phase !== 'place') return
      const at = scene.pickGround()
      if (!at || !selected) return
      const quarter = selected === 'house' || selected === 'field' || selected === 'fisher'
      const rot = quarter
        ? Math.floor(ihash(Math.round(at.x * 37), Math.round(at.z * 53), seed) * 4) * (Math.PI / 2)
        : ihash(Math.round(at.x * 37), Math.round(at.z * 53), seed) * Math.PI * 2
      const before = selected
      const res = placeAt(state, island, selected, at.x, at.z, rot)
      if (!res.ok) {
        ui.hint(dict.hintBlocked)
        return
      }
      scene.addBuilding(state.placed[state.placed.length - 1]!)
      const pt = scene.project(at.x, island.terr(at.x, at.z) + 2, at.z)
      if (pt) ui.popup(pt.x, pt.y, `${res.gained >= 0 ? '+' : ''}${res.gained}`, res.gained >= 0)
      sfx.plop(res.gained)
      if (!state.tray.includes(before)) selected = state.tray[0] ?? null
      scene.setGhostType(state.phase === 'place' ? selected : null)
      refreshAll()
      if (res.next === 'draft') window.setTimeout(openDraft, 650)
      if (res.next === 'settled') settleFlow()
    }

    // -------------------------------------------------------------- input
    let down = false
    let dragged = false
    let sx = 0
    let sy = 0
    let lx = 0
    let ly = 0
    let sawPointer = false
    const onDown = (cx: number, cy: number) => {
      down = true
      dragged = false
      sx = lx = cx
      sy = ly = cy
      scene.overlayWake()
    }
    const onMove = (cx: number, cy: number) => {
      const r = canvas.getBoundingClientRect()
      scene.setPointer(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1)
      if (down) {
        if (Math.hypot(cx - sx, cy - sy) > 6) dragged = true
        if (dragged) {
          scene.dragging = true
          scene.orbitBy(cx - lx, cy - ly)
        }
      }
      lx = cx
      ly = cy
    }
    const onUp = () => {
      if (down && !dragged) tryPlace()
      down = false
      scene.dragging = false
    }
    const pd = (e: PointerEvent) => {
      sawPointer = true
      onDown(e.clientX, e.clientY)
      try {
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* capture is best-effort */
      }
    }
    const pm = (e: PointerEvent) => onMove(e.clientX, e.clientY)
    const pu = () => onUp()
    const md = (e: MouseEvent) => {
      if (!sawPointer) onDown(e.clientX, e.clientY)
    }
    const mm = (e: MouseEvent) => {
      if (!sawPointer) onMove(e.clientX, e.clientY)
    }
    const mu = () => {
      if (!sawPointer) onUp()
    }
    const td = (e: TouchEvent) => {
      if (sawPointer) return
      const t = e.touches[0]
      if (t) onDown(t.clientX, t.clientY)
      e.preventDefault()
    }
    const tm = (e: TouchEvent) => {
      if (sawPointer) return
      const t = e.touches[0]
      if (t) onMove(t.clientX, t.clientY)
      e.preventDefault()
    }
    const tu = () => {
      if (!sawPointer) onUp()
    }
    canvas.addEventListener('pointerdown', pd)
    canvas.addEventListener('pointermove', pm)
    canvas.addEventListener('pointerup', pu)
    canvas.addEventListener('pointercancel', pu)
    canvas.addEventListener('mousedown', md)
    canvas.addEventListener('mousemove', mm)
    canvas.addEventListener('mouseup', mu)
    canvas.addEventListener('touchstart', td, { passive: false })
    canvas.addEventListener('touchmove', tm, { passive: false })
    canvas.addEventListener('touchend', tu)

    ui.onSelect = (t) => {
      if (state.phase !== 'place') return
      selected = t
      scene.setGhostType(t)
      applyStateToUi(ui, state, selected)
      ui.hint(dict.bHint[t] ?? '')
    }
    ui.onMute = (m) => sfx.setMuted(m)

    // ------------------------------------------------------------- layout
    const size = () => {
      const w = root.clientWidth || 640
      const h = root.clientHeight || 480
      scene.resize(w, h)
    }
    size()
    const ro = new ResizeObserver(size)
    ro.observe(root)

    const applyLang = () => {
      dict = makeI18n(ctx.lang)
      ui.setDict(dict)
      ui.setDay(day)
      applyStateToUi(ui, state, selected)
      if (modal === 'draft') {
        ui.hideDraft()
        openDraft()
      } else if (modal === 'settle') {
        ui.hideSettle()
        openSettle()
      }
    }
    const offLang = ctx.onLangChange(() => applyLang())

    // --------------------------------------------------------------- loop
    const advance = (dt: number) => {
      scene.frame(dt)
      const at = scene.pickGround()
      if (at && selected && state.phase === 'place') {
        const ok = canPlaceAt(island, state.placed, at.x, at.z)
        const positive = ok && scoreAt(island, state.placed, selected, at.x, at.z) >= 0
        scene.setGhostState(ok, positive)
      }
    }
    let raf = 0
    let last = performance.now()
    let alive = true
    const tick = (now: number) => {
      if (!alive) return
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      advance(dt)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // Test hook for sandboxed automation (rAF freezes in hidden panes).
    // TODO(myriad-isles): strip before opening the PR.
    ;(window as unknown as Record<string, unknown>).__mi = {
      advance,
      place: (t: BType, x: number, z: number) => {
        selected = t
        const res = placeAt(state, island, t, x, z, 0)
        if (res.ok) {
          scene.addBuilding(state.placed[state.placed.length - 1]!)
          refreshAll()
          if (res.next === 'draft') openDraft()
          if (res.next === 'settled') settleFlow()
        }
        return res
      },
      pick: (which: 'a' | 'b') => {
        draftPick(state, ROUNDS[state.round]![which])
        ui.hideDraft()
        modal = null
        selected = state.tray[0] ?? null
        scene.setGhostType(selected)
        refreshAll()
      },
      get state() {
        return state
      },
      day,
      seed,
    }

    ui.setDay(day)
    refreshAll()
    ui.hint(dict.hintPlace)
    openDraft()

    this.unmount = () => {
      alive = false
      cancelAnimationFrame(raf)
      ro.disconnect()
      offLang()
      ui.dispose()
      sfx.dispose()
      scene.dispose()
      delete (window as unknown as Record<string, unknown>).__mi
    }
  },

  unmount() {
    /* replaced per-mount */
  },
})
