/**
 * 牛来 · Niu Lai (海报与正片): host wiring.
 *
 * The engine (game.ts) knows nothing about the platform. This file owns every
 * ctx capability:
 *
 *   ctx.local        — per-visitor save (lifetime box office, bests). Best-effort:
 *                      signed-out visitors keep a session-only save.
 *   `screenings`     — one record per signed-in player, mirroring their lifetime
 *                      box office. The JOINT box office — every projectionist's
 *                      total summed — is this world's shared goal: ¥7705, the
 *                      film's real 10-day gross, then the million-and-beyond
 *                      milestones of its real-life comeback.
 *   ctx.audio        — resolves after the first real gesture; the engine treats
 *                      sound as best-effort throughout.
 *   ctx.lang         — zh/en live switch, re-rendering DOM and canvas strings.
 *
 * Storage failures are ordinary here (anonymous visitors, quota, transport) —
 * every write is caught, the game itself never blocks on the platform.
 */
import { defineWorld, type WorldError } from '@arena/world-sdk'
import { createGame, type GameHandle, type JointEntry, type SaveData } from './game.js'
import { stringsFor, type Strings } from './i18n.js'

interface Screening {
  box: number
  runs: number
  scenes?: number
  cleared?: boolean
}

const SAVE_KEY = 'save:v1'
const TARGET = 7705
const M1 = 1_000_000
const M2 = 10_000_000
const SUM_PAGE_LIMIT = 10 // 10 pages × 50 records — far beyond a plausible crowd

export default defineWorld({
  meta: { type: 'niu-lai' },

  async mount(root, ctx) {
    let L: Strings = stringsFor(ctx.lang)

    let audioCtx: AudioContext | null = null
    ctx.audio().then(a => { audioCtx = a }).catch(() => { /* stays silent */ })

    const scr = ctx.collection<Screening>('screenings')

    // ---- per-visitor save -------------------------------------------------
    const save: SaveData = { total: 0, ach: false, bestScenes: 0, bestTime: 0 }
    const stored = await ctx.local.get<Partial<SaveData>>(SAVE_KEY).catch(() => null)
    if (stored) {
      save.total = typeof stored.total === 'number' ? stored.total : 0
      save.ach = !!stored.ach
      save.bestScenes = typeof stored.bestScenes === 'number' ? stored.bestScenes : 0
      save.bestTime = typeof stored.bestTime === 'number' ? stored.bestTime : 0
    }

    // My screening record, when signed in.
    let myRec: { id: string; version: number; payload: Screening } | null = null
    async function loadMyRec(): Promise<void> {
      if (!ctx.me) { myRec = null; return }
      try {
        const page = await scr.list({ mine: true, limit: 1 })
        const rec = page.items[0]
        myRec = rec ? { id: rec.id, version: rec.version, payload: rec.payload } : null
        if (myRec && myRec.payload.box > save.total) {
          // Another device knew more than this one — adopt it.
          save.total = myRec.payload.box
          save.bestScenes = Math.max(save.bestScenes, myRec.payload.scenes ?? 0)
          void ctx.local.set(SAVE_KEY, save).catch(() => {})
        }
      } catch { myRec = null }
    }
    await loadMyRec()

    // ---- the game ---------------------------------------------------------
    const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
    const handle: GameHandle = createGame(root, {
      L: () => L,
      initial: save,
      save: d => {
        save.total = d.total; save.ach = d.ach
        save.bestScenes = d.bestScenes; save.bestTime = d.bestTime
        void ctx.local.set(SAVE_KEY, d).catch(() => {})
      },
      onRunEnd: stats => {
        void syncRecord(stats.total, stats.bestScenes, stats.cleared)
          .then(() => refreshJoint())
      },
      getAudio: () => audioCtx,
      isTouch,
    })

    // ---- record upkeep ----------------------------------------------------
    async function syncRecord(total: number, bestScenes: number, cleared: boolean): Promise<void> {
      if (!ctx.me) return
      const payload: Screening = {
        box: Math.round(total * 10) / 10,
        runs: (myRec?.payload.runs ?? 0) + 1,
        scenes: Math.max(bestScenes, myRec?.payload.scenes ?? 0),
        cleared: cleared || (myRec?.payload.cleared ?? false),
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (myRec) {
            const rec = await scr.put(myRec.id, payload, { version: myRec.version })
            myRec = { id: rec.id, version: rec.version, payload: rec.payload }
          } else {
            const rec = await scr.add(payload)
            myRec = { id: rec.id, version: rec.version, payload: rec.payload }
          }
          return
        } catch (e) {
          const code = (e as WorldError).code
          if (code === 'conflict' || code === 'unique') {
            // Another device wrote first — merge by taking the larger numbers.
            await loadMyRec()
            payload.box = Math.max(payload.box, myRec?.payload.box ?? 0)
            payload.runs = Math.max(payload.runs, myRec?.payload.runs ?? 0)
            payload.scenes = Math.max(payload.scenes ?? 0, myRec?.payload.scenes ?? 0)
            payload.cleared = payload.cleared || (myRec?.payload.cleared ?? false)
            continue
          }
          return // unauthenticated / quota / unavailable — the run still counted locally
        }
      }
    }

    // ---- joint box office ------------------------------------------------
    let lastSum = -1
    let refreshing = false
    let refreshQueued = false
    async function refreshJoint(): Promise<void> {
      if (refreshing) { refreshQueued = true; return }
      refreshing = true
      try {
        const players = await scr.count()
        let sum = 0
        let partial = false
        const top: JointEntry[] = []
        let cursor: string | undefined
        for (let page = 0; page < SUM_PAGE_LIMIT; page++) {
          const res = await scr.list({ limit: 50, sort: ['-payload.box'], cursor })
          for (const rec of res.items) {
            sum += typeof rec.payload.box === 'number' ? rec.payload.box : 0
            if (top.length < 5) top.push({ name: rec.author.name, box: rec.payload.box, mine: rec.mine })
          }
          if (!res.cursor || !res.hasMore) { cursor = undefined; break }
          cursor = res.cursor
          partial = true // provisional; cleared when the loop breaks before the cap
        }
        if (cursor === undefined) partial = false
        sum = Math.round(sum * 10) / 10

        if (lastSum >= 0) {
          if (lastSum < TARGET && sum >= TARGET) handle.toast(L.toast7705)
          else if (lastSum < M1 && sum >= M1) handle.toast(L.toastM1)
          else if (lastSum < M2 && sum >= M2) handle.toast(L.toastM2)
        }
        lastSum = sum
        handle.setJoint({ sum, players, top, signedIn: !!ctx.me, partial })
      } catch { /* transport hiccup — keep the last numbers */ }
      refreshing = false
      if (refreshQueued) { refreshQueued = false; void refreshJoint() }
    }
    void refreshJoint()

    let changeTimer: ReturnType<typeof setTimeout> | null = null
    scr.onChange(() => {
      if (changeTimer) return
      changeTimer = setTimeout(() => { changeTimer = null; void refreshJoint() }, 4000)
    })

    // ---- live platform state ----------------------------------------------
    ctx.onLangChange(lang => {
      L = stringsFor(lang)
      handle.applyLang()
    })
    ctx.onVisitor(() => {
      void (async () => {
        await loadMyRec()
        if (ctx.me && save.total > (myRec?.payload.box ?? 0)) {
          // Signed in mid-session: carry the anonymous progress into the record.
          await syncRecord(save.total, save.bestScenes, myRec?.payload.cleared ?? false)
        }
        void refreshJoint()
      })()
    })
  },
})
