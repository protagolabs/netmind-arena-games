import { defineWorld } from '@arena/world-sdk'
import { dayString, hashStr, ihash } from './seed.js'
import {
  makeIsland,
  newGame,
  draftPick,
  placeAt,
  canPlaceAt,
  scoreAt,
  bonusZoneAt,
  dayProgress,
  serializeBuilds,
  deserializeBuilds,
  ROUNDS,
  type BType,
  type GameState,
  type IslandRecord,
} from './sim.js'
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
    const islands = ctx.collection<IslandRecord>('islands')
    const lampsCol = ctx.collection<{ target: string }>('lamps')
    // Identity resolves asynchronously (see ctx.onVisitor) — always read live.
    const me = () => ctx.me
    let mode: 'play' | 'visit' = 'play'
    let visitingId: string | null = null
    let visitLampN = 0
    let resumeModal: 'draft' | 'settle' | null = null

    let placedAtDraft = 0
    const canRedraft = () => state.phase === 'place' && state.placed.length === placedAtDraft
    const tierAt = (x: number, z: number): 0 | 1 | 2 => {
      if (!canPlaceAt(island, state.placed, x, z)) return 0
      return selected && bonusZoneAt(island, state.placed, selected, x, z) ? 2 : 1
    }
    const refreshAll = () => {
      applyStateToUi(ui, state, selected, canRedraft())
      scene.refreshOverlay(tierAt)
      scene.setNightTarget(dayProgress(state))
    }

    let modal: 'draft' | 'settle' | null = null
    const openDraft = () => {
      modal = 'draft'
      ui.showDraft(ROUNDS[state.round]!, (which) => {
        draftPick(state, ROUNDS[state.round]![which])
        placedAtDraft = state.placed.length
        ui.hideDraft()
        modal = null
        selected = state.tray[0] ?? null
        scene.setGhostType(selected)
        sfx.draft()
        refreshAll()
        ui.hint(dict.hintPlace)
      })
    }
    const saveIsland = async (name: string) => {
      const m = me()
      if (!m) return
      const payload: IslandRecord = {
        day,
        x: Math.round((ihash(hashStr(m.id), 11, seed) * 8000 - 4000) * 10) / 10,
        y: Math.round((ihash(hashStr(m.id), 12, seed) * 8000 - 4000) * 10) / 10,
        score: state.score,
        builds: serializeBuilds(state.placed),
      }
      if (name) payload.name = name
      try {
        const mine = await islands.list({ where: { 'payload.day': { eq: day } }, mine: true, limit: 1 })
        const existing = mine.items[0]
        if (existing) {
          if (state.score <= existing.payload.score) {
            ui.settleStatus(dict.keptBest(existing.payload.score))
            return
          }
          await islands.put(existing.id, payload, { version: existing.version })
        } else {
          try {
            await islands.add(payload)
          } catch (e) {
            if ((e as { code?: string }).code !== 'quota') throw e
            const oldest = await islands.list({ mine: true, sort: ['createdAt'], limit: 1 })
            if (oldest.items[0]) await islands.del(oldest.items[0].id)
            await islands.add(payload)
          }
        }
        ui.settleStatus(dict.saved)
      } catch {
        ui.settleStatus(dict.saveFailed)
      }
    }

    const openSettle = () => {
      modal = 'settle'
      const stuck = state.round < ROUNDS.length - 1
      ui.showSettle({
        score: state.score,
        stuck,
        canSave: !!me(),
        signInHint: !me(),
        onSave: (name) => void saveIsland(name),
        onAgain: () => {
          ui.hideSettle()
          modal = null
          state = newGame()
          scene.resetBuildings()
          scene.unsettle()
          selected = null
          scene.setGhostType(null)
          refreshAll()
          openDraft()
        },
      })
    }

    const settleFlow = () => {
      scene.setGhostType(null)
      selected = null
      scene.settle()
      sfx.settle()
      window.setTimeout(openSettle, 2200)
    }

    // ------------------------------------------------------- the myriad sea
    let seaRows: import('./ui.js').SeaRow[] = []
    let seaCursor: string | null = null
    const rowFrom = (r: { id: string; author: { id?: string; name?: string } | null; payload: IslandRecord }) => {
      const m = me()
      return {
        id: r.id,
        name: r.payload.name || dict.unnamedIsle,
        author: r.author?.name ?? '…',
        score: r.payload.score,
        mine: !!m && r.author?.id === m.id,
      }
    }
    const renderSea = (hasMore: boolean) => {
      ui.showSea(
        [...seaRows].sort((a, b) => b.score - a.score),
        hasMore,
        (row) => void visitIsle(row.id),
        () => void loadSea(false),
      )
    }
    const loadSea = async (reset: boolean) => {
      if (reset) {
        seaRows = []
        seaCursor = null
      }
      try {
        const page = await islands.list({
          where: { 'payload.day': { eq: day } },
          sort: ['-createdAt'],
          limit: 30,
          ...(seaCursor ? { cursor: seaCursor } : {}),
        })
        seaCursor = page.cursor
        seaRows = seaRows.concat(page.items.map(rowFrom))
        renderSea(page.hasMore)
      } catch {
        renderSea(false)
      }
    }
    ui.onSeaOpen = () => void loadSea(true)

    const visitIsle = async (id: string) => {
      const rec = await islands.get(id)
      if (!rec) return
      ui.hideSea()
      if (modal) {
        resumeModal = modal
        modal = null
        ui.hideDraft()
        ui.hideSettle()
      }
      mode = 'visit'
      visitingId = id
      scene.setGhostType(null)
      ui.showPreview(null, '', true)
      ui.setTray([], null, false)
      scene.refreshOverlay(() => 0)
      scene.resetBuildings()
      for (const p of deserializeBuilds(rec.payload.builds)) scene.addBuilding(p)
      scene.setNightTarget(0.85)
      const m = me()
      const mineRow = !!m && rec.author?.id === m.id
      visitLampN = 0
      let lamped = false
      try {
        visitLampN = await lampsCol.count({ where: { 'payload.target': { eq: id } } })
        if (m && !mineRow) lamped = (await lampsCol.count({ where: { 'payload.target': { eq: id } }, mine: true })) > 0
      } catch {
        /* counts are decoration */
      }
      ui.showVisit(
        { label: rec.payload.name || dict.unnamedIsle, score: rec.payload.score, lamps: visitLampN, lamped, canLamp: !!m && !mineRow },
        () => void lampIsle(),
        backHome,
      )
    }

    const lampIsle = async () => {
      if (!visitingId || !me()) return
      try {
        await lampsCol.add({ target: visitingId })
        visitLampN += 1
        ui.updateVisit(visitLampN, true)
        sfx.draft()
      } catch (e) {
        if ((e as { code?: string }).code === 'unique') ui.updateVisit(visitLampN, true)
      }
    }

    const backHome = () => {
      mode = 'play'
      visitingId = null
      ui.hideVisit()
      scene.resetBuildings()
      for (const p of state.placed) scene.addBuilding(p)
      if (state.phase === 'settled') scene.setNightTarget(1)
      else scene.unsettle()
      if (state.phase === 'place') scene.setGhostType(selected)
      refreshAll()
      if (resumeModal === 'draft') openDraft()
      else if (resumeModal === 'settle') openSettle()
      resumeModal = null
    }

    const tryPlace = () => {
      if (mode !== 'play' || modal || state.phase !== 'place') return
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
      if (mode !== 'play' || state.phase !== 'place') return
      selected = t
      scene.setGhostType(t)
      applyStateToUi(ui, state, selected, canRedraft())
      scene.refreshOverlay(tierAt)
      scene.overlayWake()
    }
    ui.onMute = (m) => sfx.setMuted(m)
    ui.onRedraft = () => {
      if (!canRedraft()) return
      state.tray.length = 0
      state.phase = 'draft'
      selected = null
      scene.setGhostType(null)
      refreshAll()
      openDraft()
    }

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
      applyStateToUi(ui, state, selected, canRedraft())
      if (modal === 'draft') {
        ui.hideDraft()
        openDraft()
      } else if (modal === 'settle') {
        ui.hideSettle()
        openSettle()
      }
    }
    const offLang = ctx.onLangChange(() => applyLang())
    const offVisitor = ctx.onVisitor(() => {
      if (modal === 'settle') openSettle()
    })

    // --------------------------------------------------------------- loop
    const advance = (dt: number) => {
      scene.frame(dt)
      const at = scene.pickGround()
      if (mode === 'play' && at && selected && state.phase === 'place' && !modal) {
        const ok = canPlaceAt(island, state.placed, at.x, at.z)
        const gained = scoreAt(island, state.placed, selected, at.x, at.z)
        scene.setGhostState(ok, gained >= 0)
        if (ok) {
          const pt = scene.project(at.x, island.terr(at.x, at.z) + 1.5, at.z)
          ui.showPreview(pt, `${gained >= 0 ? '+' : ''}${gained}`, gained >= 0)
        } else {
          ui.showPreview(null, '', true)
        }
      } else {
        ui.showPreview(null, '', true)
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
        placedAtDraft = state.placed.length
        ui.hideDraft()
        modal = null
        selected = state.tray[0] ?? null
        scene.setGhostType(selected)
        refreshAll()
      },
      get state() {
        return state
      },
      get who() {
        const m = me()
        return m ? { id: m.id, name: m.name } : null
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
      offVisitor()
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
