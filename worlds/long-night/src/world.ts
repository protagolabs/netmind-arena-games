/**
 * 长夜 · The Long Night — a shared night, survived alone.
 *
 * Every competitor in a season walks the SAME twenty-four hours. That single
 * decision shapes everything else here: because the weather is not yours, a
 * longer night is unambiguously a better night, and the leaderboard is a
 * comparison rather than a lottery. It also means the page can show you the
 * forecast other people are up against, which is what makes a stranger's line
 * worth reading.
 *
 * The rules live in `rules.ts` and are used twice — bundled here so the browser
 * can show a person what a choice costs, and submitted to Arena as the L1 scorer
 * so the platform decides what a run was worth. Two copies of a rule set drift,
 * and drift here reads as being told you survived and then scored as though you
 * had not.
 *
 * Nothing in this file talks to the network. The sandbox sets `connect-src
 * 'none'`; every read and write goes through `ctx`, which the host performs with
 * the visitor's credential — that credential never enters this document.
 */
import { defineWorld, type Collection, type Rec, type Visitor, type WorldCtx, type WorldTheme } from '@arena/world-sdk'
import { ACTIONS, HOURS, scoreOf, simulate, type Action, type NightResult } from './rules.js'

/** A finished night, kept so the ridge can remember who made it through. */
interface Lamp {
  /** Hours survived, 0-24. */
  hours: number
  /** Whether they saw the sun. */
  dawn: boolean
  /** The line they walked, so a visitor can read someone else's night. */
  line: string
}

/** A submitted run. The scorer replays `actions`; nothing else here counts. */
interface Run {
  actions: Action[]
}

export default defineWorld({
  meta: { type: 'long-night' },

  async mount(root, ctx) {
    const runs = ctx.collection<Run>('runs')
    const lamps = ctx.collection<Lamp>('lamps')
    await new Night(root, ctx, runs, lamps).start()
  },
})

/* ─────────────────────────── the night ─────────────────────────── */

const WEATHER_GLYPH: Record<string, string> = { clear: '·', wind: '≈', rain: '/', frost: '✦' }
const ACTION_LABEL: Record<Action, { en: string; zh: string; hint: string }> = {
  gather: { en: 'Gather', zh: '拾柴', hint: '+fuel, out in the cold' },
  shelter: { en: 'Shelter', zh: '避风', hint: 'guard the flame' },
  tend: { en: 'Tend', zh: '添火', hint: 'burn fuel for warmth' },
  rest: { en: 'Rest', zh: '歇息', hint: 'a little back, slowly' },
}

class Night {
  private readonly stage: HTMLDivElement
  private readonly hoursEl: HTMLDivElement
  private readonly statsEl: HTMLDivElement
  private readonly actionsEl: HTMLDivElement
  private readonly ridgeEl: HTMLDivElement
  private readonly statusEl: HTMLDivElement

  private me: Visitor | null = null
  private chosen: Action[] = []
  private result: NightResult

  constructor(
    private readonly root: HTMLElement,
    private readonly ctx: WorldCtx,
    private readonly runs: Collection<Run>,
    private readonly lamps: Collection<Lamp>,
  ) {
    this.root.innerHTML = TEMPLATE
    this.stage = root.querySelector('#ln-stage')!
    this.hoursEl = root.querySelector('#ln-hours')!
    this.statsEl = root.querySelector('#ln-stats')!
    this.actionsEl = root.querySelector('#ln-actions')!
    this.ridgeEl = root.querySelector('#ln-ridge')!
    this.statusEl = root.querySelector('#ln-status')!
    this.result = simulate([], this.season())
  }

  /**
   * The season the weather is drawn from.
   *
   * `ctx.season` is the key the PLATFORM will hand the scorer, so simulating with
   * it is what makes the night on screen the night that gets scored. Falling back
   * to `'open'` keeps the page playable before any season exists — and the scorer
   * falls back to the same string, so the two still agree.
   */
  private season(): string {
    return this.ctx.season ?? 'open'
  }

  async start(): Promise<void> {
    this.applyTheme(this.ctx.theme)
    this.ctx.onThemeChange((theme) => this.applyTheme(theme))
    this.ctx.onVisitor((me) => {
      this.me = me
      this.paintStatus()
    })
    this.me = this.ctx.me

    this.buildActions()
    this.paint()
    await this.paintRidge()

    // Somebody else finished a night while this one is open. The ridge is the
    // only shared surface here, so it is the only thing that has to re-read.
    this.lamps.onChange(() => void this.paintRidge())
  }

  /* ── theme ── */

  private applyTheme(theme: WorldTheme): void {
    const s = this.root.style
    s.setProperty('--ln-bg', theme.bg)
    s.setProperty('--ln-surface', theme.surface)
    s.setProperty('--ln-fg', theme.fg)
    s.setProperty('--ln-subtle', theme.fgSubtle)
    s.setProperty('--ln-border', theme.border)
    s.setProperty('--ln-accent', theme.accent)
    s.setProperty('--ln-font', theme.font)
    // The flame is the one colour that does not come from the theme. It is the
    // subject of the picture, and a light-mode accent would make it disappear.
    s.setProperty('--ln-flame', theme.mode === 'dark' ? '#ffb454' : '#e07a1f')
    this.root.dataset.mode = theme.mode
  }

  /* ── the hour strip ── */

  private buildActions(): void {
    for (const action of ACTIONS) {
      const label = ACTION_LABEL[action]
      const button = document.createElement('button')
      button.className = 'ln-act'
      button.dataset.action = action
      button.innerHTML = `<span class="ln-act-zh"></span><span class="ln-act-en"></span><span class="ln-act-hint"></span>`
      button.querySelector('.ln-act-zh')!.textContent = label.zh
      button.querySelector('.ln-act-en')!.textContent = label.en
      button.querySelector('.ln-act-hint')!.textContent = label.hint
      button.addEventListener('click', () => void this.take(action))
      this.actionsEl.appendChild(button)
    }
  }

  private async take(action: Action): Promise<void> {
    if (this.chosen.length >= HOURS || !this.alive()) return
    this.chosen.push(action)
    this.result = simulate(this.chosen, this.season())
    this.paint()

    const done = this.chosen.length >= HOURS || !this.alive()
    if (done) await this.finish()
  }

  /**
   * Still going.
   *
   * `simulate` always plays a full night, padding unchosen hours with `rest`, so
   * its `hoursSurvived` describes a hypothetical night rather than the one being
   * played. Death truncates the trace, so the honest test is whether the trace
   * still reaches the hour we are actually on.
   */
  private alive(): boolean {
    return this.result.trace.length >= this.chosen.length
  }

  private paint(): void {
    const { trace, sky } = this.result
    // Only the hours actually chosen are lived. The rest of `trace` is the
    // padding `simulate` adds, and drawing it would show a player a night they
    // have not walked yet — with every hour already marked "rest".
    const lived = Math.min(this.chosen.length, trace.length)
    const now = lived > 0 ? trace[lived - 1] : undefined

    // The strip: every hour of the night, past lit and future dim.
    this.hoursEl.textContent = ''
    for (let h = 0; h < HOURS; h++) {
      const cell = document.createElement('div')
      const played = h < lived
      cell.className = 'ln-hour' + (played ? ' is-past' : '') + (h === lived ? ' is-now' : '')
      cell.dataset.weather = sky[h]!
      const glyph = document.createElement('span')
      glyph.className = 'ln-sky'
      glyph.textContent = WEATHER_GLYPH[sky[h]!] ?? '·'
      cell.appendChild(glyph)
      if (played) {
        const mark = document.createElement('span')
        mark.className = 'ln-mark'
        mark.textContent = trace[h]!.action[0]!.toUpperCase()
        cell.appendChild(mark)
      }
      this.hoursEl.appendChild(cell)
    }

    const warmth = now ? now.warmth : 60
    const fuel = now ? now.fuel : 8
    const flame = now ? now.flame : 3
    this.stage.style.setProperty('--ln-flame-size', String(Math.max(0.2, Math.min(1.6, flame / 4))))
    this.stage.dataset.cold = warmth < 30 ? 'yes' : 'no'

    this.statsEl.innerHTML = ''
    this.stat('体温 Warmth', warmth, 100, 'warmth')
    this.stat('柴 Fuel', fuel, 20, 'fuel')
    this.stat('火 Flame', flame, 6, 'flame')

    for (const button of Array.from(this.actionsEl.children) as HTMLButtonElement[]) {
      button.disabled = !this.alive() || this.chosen.length >= HOURS
    }
    this.paintStatus()
  }

  private stat(label: string, value: number, max: number, kind: string): void {
    const row = document.createElement('div')
    row.className = 'ln-stat'
    row.dataset.kind = kind
    const name = document.createElement('span')
    name.className = 'ln-stat-name'
    name.textContent = label
    const bar = document.createElement('span')
    bar.className = 'ln-bar'
    const fill = document.createElement('span')
    fill.className = 'ln-bar-fill'
    fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`
    bar.appendChild(fill)
    const num = document.createElement('span')
    num.className = 'ln-stat-num'
    num.textContent = String(value)
    row.append(name, bar, num)
    this.statsEl.appendChild(row)
  }

  private paintStatus(): void {
    const hours = Math.min(this.chosen.length, this.result.trace.length)
    if (!this.alive()) {
      this.statusEl.textContent = `火灭了。你撑了 ${hours} 小时。 The fire went out after ${hours} hours.`
      return
    }
    if (this.chosen.length >= HOURS) {
      this.statusEl.textContent = '天亮了。 Morning.'
      return
    }
    if (!this.me) {
      this.statusEl.textContent = '登录后你的这一夜会被记录。 Sign in and your night will be scored.'
      return
    }
    this.statusEl.textContent = `第 ${this.chosen.length + 1} 小时 · hour ${this.chosen.length + 1} of ${HOURS}`
  }

  /* ── the end of the night ── */

  private async finish(): Promise<void> {
    if (!this.me) {
      this.statusEl.textContent = '这一夜没有被记录——登录后再来一次。 Not recorded. Sign in to be scored.'
      return
    }
    const line = this.chosen.map((a) => a[0]!.toUpperCase()).join('')
    try {
      // The run is what Arena scores; the lamp is what the world remembers.
      // What is submitted is what was chosen. `this.result` describes a padded
      // night; the scorer will replay these actions and pad identically.
      const played = simulate(this.chosen, this.season())
      await this.runs.add({ actions: this.chosen })
      await this.lamps.add({ hours: played.hoursSurvived, dawn: played.survived, line })
      this.statusEl.textContent = this.result.survived
        ? `你把灯留在了山脊上。 ${scoreOf(this.result)} points.`
        : `记下了。撑了 ${this.result.hoursSurvived} 小时。 ${scoreOf(this.result)} points.`
      await this.paintRidge()
    } catch (err) {
      // Every one of these is an ordinary outcome. `unique` is the common one:
      // one night per person per world, by manifest.
      const code = (err as { code?: string }).code
      this.statusEl.textContent =
        code === 'unauthenticated'
          ? '登录后才能记录。 Sign in to be scored.'
          : code === 'unique' || code === 'quota'
            ? '你今夜已经走过一次了。 You have already walked tonight.'
            : ((err as { message?: string }).message ?? '没能记下来。 Could not record that.')
    }
  }

  /* ── the ridge: everyone who got through ── */

  private async paintRidge(): Promise<void> {
    let page: { items: Rec<Lamp>[] }
    try {
      page = await this.lamps.list({ sort: ['-payload.hours'], limit: 24 })
    } catch {
      return
    }
    this.ridgeEl.textContent = ''
    for (const rec of page.items) {
      const lamp = document.createElement('div')
      lamp.className = 'ln-lamp' + (rec.payload.dawn ? ' is-dawn' : '')
      lamp.style.setProperty('--ln-lamp-h', String(Math.max(0.25, rec.payload.hours / HOURS)))
      const flame = document.createElement('span')
      flame.className = 'ln-lamp-flame'
      const who = document.createElement('span')
      who.className = 'ln-lamp-who'
      who.textContent = rec.author.name
      lamp.append(flame, who)
      lamp.title = `${rec.author.name} — ${rec.payload.hours}h  ${rec.payload.line}`
      this.ridgeEl.appendChild(lamp)
    }
    if (page.items.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'ln-empty'
      empty.textContent = '山脊上还没有灯。 No lamps on the ridge yet.'
      this.ridgeEl.appendChild(empty)
    }
  }
}

/* ─────────────────────────── markup ─────────────────────────── */

const TEMPLATE = `
<style>
  .ln {
    --ln-ink: color-mix(in srgb, var(--ln-fg) 88%, transparent);
    position: relative; min-height: 100%; box-sizing: border-box;
    padding: clamp(16px, 3vw, 32px);
    font-family: var(--ln-font); color: var(--ln-fg);
    background:
      radial-gradient(120% 80% at 76% 6%, color-mix(in srgb, var(--ln-accent) 10%, transparent) 0%, transparent 60%),
      radial-gradient(90% 60% at 24% 96%, color-mix(in srgb, var(--ln-flame) 14%, transparent) 0%, transparent 55%),
      var(--ln-bg);
    display: grid; gap: clamp(14px, 2.4vw, 26px);
    grid-template-rows: auto auto 1fr auto;
  }
  .ln-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .ln-title { font-size: clamp(15px, 2vw, 19px); font-weight: 620; letter-spacing: .14em; margin: 0; }
  .ln-title small { display: block; font-size: 11px; letter-spacing: .2em; opacity: .5; font-weight: 400; margin-top: 3px; }
  .ln-status { font-size: 12px; color: var(--ln-subtle); text-align: right; min-height: 1.2em; }

  /* the strip of hours */
  .ln-hours { display: grid; grid-template-columns: repeat(24, 1fr); gap: 3px; }
  .ln-hour {
    position: relative; aspect-ratio: 1 / 2.1; border-radius: 3px;
    background: color-mix(in srgb, var(--ln-surface) 70%, transparent);
    border: 1px solid color-mix(in srgb, var(--ln-border) 60%, transparent);
    display: flex; flex-direction: column; align-items: center; justify-content: space-between;
    padding: 3px 0; opacity: .35; transition: opacity .25s, background .25s;
  }
  .ln-hour.is-past { opacity: 1; background: color-mix(in srgb, var(--ln-flame) 12%, var(--ln-surface)); }
  .ln-hour.is-now { opacity: .8; border-color: var(--ln-flame); box-shadow: 0 0 0 1px var(--ln-flame); }
  .ln-hour[data-weather="frost"] .ln-sky { color: #9fc8ff; }
  .ln-hour[data-weather="rain"]  .ln-sky { color: #7f9ac8; }
  .ln-hour[data-weather="wind"]  .ln-sky { color: var(--ln-subtle); }
  .ln-sky { font-size: 10px; line-height: 1; opacity: .9; }
  .ln-mark { font-size: 9px; font-weight: 700; color: var(--ln-flame); letter-spacing: .04em; }

  /* the fire */
  .ln-stage {
    position: relative; display: grid; place-items: center; min-height: clamp(120px, 22vh, 190px);
  }
  .ln-fire {
    width: clamp(40px, 7vw, 64px); aspect-ratio: 1 / 1.6;
    transform: scale(var(--ln-flame-size, 1)); transform-origin: 50% 100%;
    transition: transform .45s cubic-bezier(.4,0,.2,1);
    background:
      radial-gradient(50% 55% at 50% 68%, color-mix(in srgb, var(--ln-flame) 92%, #fff) 0%, transparent 70%),
      radial-gradient(60% 70% at 50% 78%, var(--ln-flame) 0%, transparent 72%);
    clip-path: polygon(50% 0%, 78% 34%, 88% 66%, 72% 94%, 50% 100%, 28% 94%, 12% 66%, 22% 34%);
    animation: ln-flicker 2.6s ease-in-out infinite;
  }
  .ln-stage::after {
    content: ''; position: absolute; inset: auto 0 22% 0; height: 1px;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ln-flame) 45%, transparent), transparent);
  }
  .ln-stage[data-cold="yes"] .ln-fire { filter: saturate(.55) brightness(.8); }
  @keyframes ln-flicker {
    0%, 100% { transform: scale(var(--ln-flame-size, 1)) translateY(0); }
    50%      { transform: scale(calc(var(--ln-flame-size, 1) * 1.06)) translateY(-2px); }
  }
  @media (prefers-reduced-motion: reduce) { .ln-fire { animation: none; } }

  /* stats + actions */
  .ln-panel { display: grid; gap: 10px; grid-template-columns: minmax(180px, 1fr) minmax(220px, 1.3fr); align-items: start; }
  @media (max-width: 560px) { .ln-panel { grid-template-columns: 1fr; } }
  .ln-stat { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; font-size: 11px; }
  .ln-stat + .ln-stat { margin-top: 5px; }
  .ln-stat-name { color: var(--ln-subtle); white-space: nowrap; }
  .ln-stat-num { font-variant-numeric: tabular-nums; font-weight: 600; }
  .ln-bar { height: 4px; border-radius: 99px; background: color-mix(in srgb, var(--ln-border) 70%, transparent); overflow: hidden; }
  .ln-bar-fill { display: block; height: 100%; border-radius: 99px; transition: width .3s; }
  .ln-stat[data-kind="warmth"] .ln-bar-fill { background: var(--ln-flame); }
  .ln-stat[data-kind="fuel"]   .ln-bar-fill { background: color-mix(in srgb, var(--ln-fg) 45%, transparent); }
  .ln-stat[data-kind="flame"]  .ln-bar-fill { background: color-mix(in srgb, var(--ln-flame) 70%, #fff); }

  .ln-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
  .ln-act {
    display: grid; gap: 1px; padding: 8px 6px; border-radius: 7px; cursor: pointer; text-align: center;
    background: color-mix(in srgb, var(--ln-surface) 85%, transparent);
    border: 1px solid color-mix(in srgb, var(--ln-border) 75%, transparent);
    color: inherit; font: inherit; transition: border-color .15s, transform .12s, background .15s;
  }
  .ln-act:hover:not(:disabled) { border-color: var(--ln-flame); transform: translateY(-1px); }
  .ln-act:disabled { opacity: .35; cursor: default; }
  .ln-act-zh { font-size: 13px; font-weight: 600; }
  .ln-act-en { font-size: 10px; letter-spacing: .08em; opacity: .65; }
  .ln-act-hint { font-size: 9px; color: var(--ln-subtle); margin-top: 2px; }

  /* the ridge */
  .ln-ridge {
    display: flex; align-items: flex-end; gap: 5px; min-height: 62px; overflow-x: auto;
    padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--ln-border) 55%, transparent);
  }
  .ln-lamp {
    display: grid; justify-items: center; gap: 3px; flex: none; width: 30px;
    padding-bottom: calc(var(--ln-lamp-h, .5) * 14px);
  }
  .ln-lamp-flame {
    width: 6px; height: 6px; border-radius: 99px; background: var(--ln-flame);
    box-shadow: 0 0 8px 2px color-mix(in srgb, var(--ln-flame) 55%, transparent);
    opacity: calc(.35 + var(--ln-lamp-h, .5) * .65);
  }
  .ln-lamp.is-dawn .ln-lamp-flame { box-shadow: 0 0 12px 4px color-mix(in srgb, var(--ln-flame) 75%, transparent); }
  .ln-lamp-who { font-size: 8px; color: var(--ln-subtle); max-width: 30px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ln-empty { font-size: 11px; color: var(--ln-subtle); margin: 0; }
</style>

<div class="ln">
  <div class="ln-head">
    <h1 class="ln-title">长夜<small>THE LONG NIGHT</small></h1>
    <div class="ln-status" id="ln-status"></div>
  </div>

  <div class="ln-hours" id="ln-hours"></div>

  <div class="ln-stage" id="ln-stage"><div class="ln-fire"></div></div>

  <div class="ln-panel">
    <div id="ln-stats"></div>
    <div class="ln-actions" id="ln-actions"></div>
  </div>

  <div class="ln-ridge" id="ln-ridge"></div>
</div>
`
