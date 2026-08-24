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

/**
 * The season key used when the platform reports none.
 *
 * Deliberately not a plausible-looking key. A world whose setup comes from the
 * season MUST NOT quietly substitute one: the player would walk a night nobody
 * else is walking and be scored — if a season later opened — against a different
 * one. Naming it `practice` makes the state visible in the UI and keeps the run
 * out of the standings.
 */
const PRACTICE = 'practice'

/** How many past hours the scene keeps on screen. */
const BEATS_SHOWN = 6

const WEATHER_GLYPH: Record<string, string> = { clear: '·', wind: '≈', rain: '/', frost: '✦' }
/**
 * A drawing per gauge, because three numbers in a row are three numbers.
 *
 * The earlier version was a stack of labelled bars, and the first person to play
 * could not tell at a glance which one was about to kill them. A figure, a
 * woodpile and a flame are distinguishable before they are read.
 */
const GAUGE_ART: Record<string, string> = {
  warmth:
    '<svg width="30" height="40" viewBox="0 0 30 40"><circle cx="15" cy="8" r="6" fill="currentColor"/>' +
    '<rect x="10" y="16" width="10" height="14" rx="4" fill="currentColor"/>' +
    '<rect x="5" y="18" width="4" height="11" rx="2" fill="currentColor" opacity=".75"/>' +
    '<rect x="21" y="18" width="4" height="11" rx="2" fill="currentColor" opacity=".75"/>' +
    '<rect x="11" y="31" width="3.4" height="8" rx="1.7" fill="currentColor" opacity=".85"/>' +
    '<rect x="15.6" y="31" width="3.4" height="8" rx="1.7" fill="currentColor" opacity=".85"/></svg>',
  fuel:
    '<svg width="40" height="34" viewBox="0 0 40 34"><g fill="currentColor">' +
    '<rect x="2" y="26" width="36" height="5" rx="2.5"/>' +
    '<rect x="6" y="19" width="28" height="5" rx="2.5" opacity=".9"/>' +
    '<rect x="10" y="12" width="20" height="5" rx="2.5" opacity=".8"/>' +
    '<rect x="14" y="5" width="12" height="5" rx="2.5" opacity=".7"/></g></svg>',
  flame:
    '<svg width="88" height="122" viewBox="0 0 88 122" aria-hidden="true">    <defs>     <radialGradient id="lnHalo" cx="50%" cy="74%" r="54%">      <stop offset="0" stop-color="#ffb454" stop-opacity=".5"/><stop offset="1" stop-color="#ffb454" stop-opacity="0"/>     </radialGradient>     <linearGradient id="lnO" x1="0" y1="1" x2="0" y2="0">      <stop offset="0" stop-color="#df5f1a"/><stop offset=".55" stop-color="#ff9a34"/><stop offset="1" stop-color="#ffc46a"/>     </linearGradient>     <linearGradient id="lnI" x1="0" y1="1" x2="0" y2="0">      <stop offset="0" stop-color="#ffd98a"/><stop offset="1" stop-color="#fff6da"/>     </linearGradient>    </defs>    <ellipse cx="44" cy="110" rx="42" ry="13" fill="url(#lnHalo)"/>    <path fill="url(#lnO)" d="M44 12 C59 42, 70 58, 64 79 C59 97, 52 106, 44 106 C36 106, 29 97, 24 79 C18 58, 29 42, 44 12 Z"/>    <path fill="url(#lnI)" d="M44 47 C51 64, 56 74, 52 86 C49 94, 46 98, 44 98 C42 98, 39 94, 36 86 C32 74, 37 64, 44 47 Z"/>    <path fill="#251c30" d="M16 108 L72 108 L65 116 L23 116 Z"/>    <path fill="#352840" d="M22 103 L66 103 L60 108 L28 108 Z"/>   </svg>',
}

/** Spelled out in the log, because a glyph is a legend lookup mid-decision. */
const WEATHER_WORD: Record<string, string> = { clear: '晴', wind: '风', rain: '雨', frost: '霜' }
/**
 * What each action costs, spelled out on the button.
 *
 * The earlier hints ("guard the flame") described intent rather than effect, so
 * a player could not compare two options without having read the rules. These
 * are the actual numbers — the only ones a decision needs.
 */
const ACTION_LABEL: Record<Action, { en: string; zh: string; hint: string }> = {
  gather: { en: 'Gather', zh: '拾柴', hint: '柴 +2~4 · 体温 −4' },
  shelter: { en: 'Shelter', zh: '避风', hint: '体温 +2 · 护住火' },
  tend: { en: 'Tend', zh: '添火', hint: '体温 +8 · 火 +2 · 柴 −1' },
  rest: { en: 'Rest', zh: '歇息', hint: '体温 +2 · 火 −1' },
}

class Night {
  private readonly logEl: HTMLDivElement
  private readonly leftEl: HTMLElement
  private readonly nightEl: HTMLElement
  private readonly hoursEl: HTMLDivElement
  private readonly gaugesEl: HTMLDivElement
  private readonly boardEl: HTMLDivElement
  private readonly actionsEl: HTMLDivElement

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
    this.logEl = root.querySelector('#ln-log')!
    this.leftEl = root.querySelector('#ln-left')!
    this.nightEl = root.querySelector('#ln-night')!
    this.hoursEl = root.querySelector('#ln-hours')!
    this.gaugesEl = root.querySelector('#ln-gauges')!
    this.boardEl = root.querySelector('#ln-board-inner')!
    this.actionsEl = root.querySelector('#ln-actions')!
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
    return this.ctx.season ?? PRACTICE
  }

  /** True when there is no open season, so this night counts for nothing. */
  private isPractice(): boolean {
    return !this.ctx.season
  }

  async start(): Promise<void> {
    this.applyTheme(this.ctx.theme)
    this.ctx.onThemeChange((theme) => this.applyTheme(theme))
    this.ctx.onVisitor((me) => {
      this.me = me
      this.paintStatus()
    })
    this.me = this.ctx.me

    // The card sits over everything until it is dismissed. Nothing about the
    // night is discoverable by poking at it, so it is not optional.
    this.showIntro()

    // The board folds out of the right edge instead of sitting under the world.
    const board = this.root.querySelector<HTMLDivElement>('#ln-board')!
    this.root.querySelector('#ln-board-toggle')!.addEventListener('click', () => {
      board.classList.toggle('is-open')
      if (board.classList.contains('is-open')) void this.paintBoard()
    })

    this.buildActions()
    this.paintLegend()
    this.paint()
    await this.paintBoard()

    // Somebody else finished a night while this one is open. The ridge is the
    // only shared surface here, so it is the only thing that has to re-read.
    this.lamps.onChange(() => void this.paintBoard())
  }

  /* ── palette ── */

  /**
   * The world owns its colours; only the typeface comes from Arena.
   *
   * This is the opposite of what a document-shaped world should do — Guestbook is
   * right to take the theme's surfaces, because it IS a page. A world that is a
   * PLACE has its own light, and inheriting the theme meant this one rendered as
   * a white page the first time Arena was in light mode: a world called The Long
   * Night, at noon. `lantern-row` and `abyssal-bloom` hardcode their palettes for
   * the same reason.
   */
  private applyTheme(theme: WorldTheme): void {
    this.root.style.setProperty('--ln-font', theme.font)
  }

  /**
   * The colour key for the forecast strip.
   *
   * The strip encodes weather as colour so it can be read at a glance; the key
   * is what makes that legible the first time rather than the third.
   */
  private paintLegend(): void {
    const el = this.root.querySelector('#ln-legend')!
    el.innerHTML = (['clear', 'wind', 'rain', 'frost'] as const)
      .map((w) => `<em data-w="${w}"></em>${WEATHER_WORD[w]}`)
      .join('  ')
    el.querySelectorAll<HTMLElement>('em').forEach((em) => {
      const w = em.dataset.w!
      em.style.background =
        w === 'frost' ? 'rgba(140,190,255,.55)' : w === 'rain' ? 'rgba(90,130,200,.45)' : w === 'wind' ? 'rgba(150,170,220,.3)' : 'rgba(255,255,255,.12)'
    })
  }

  /** The opening card: goal, how you lose, and what the strip is. */
  private showIntro(): void {
    const veil = document.createElement('div')
    veil.className = 'ln-veil'
    veil.innerHTML =
      '<div class="ln-card">' +
      '<div class="ln-card-title">长夜<span>THE LONG NIGHT</span></div>' +
      '<p class="ln-lead">天黑了,火还在。撑到天亮。</p>' +
      '<p class="ln-lead-en">Keep the fire going until morning.</p>' +
      '<ul class="ln-rules">' +
      '<li><b>体温归零就结束。</b>每小时天气都在夺走体温,火焰挡回来一部分。<span>Warmth hits zero and the night is over.</span></li>' +
      '<li><b>火要烧柴,柴要出去拾。</b>出去就要挨冻——整晚唯一的两难。<span>The fire eats wood; fetching it costs warmth.</span></li>' +
      '<li><b>上面那条是今夜的天气,已经定了。</b>每一夜有编号,同一夜里所有人遇到的天气完全一样——拼的是安排,不是运气。<span>Each night has a number. Everyone on that night gets the same weather.</span></li>' +
      '</ul>' +
      '<div class="ln-legend" id="ln-card-legend"></div>' +
      '<button class="ln-go" type="button">走进夜里 · Begin</button>' +
      '</div>'
    veil.querySelector('button')!.addEventListener('click', () => veil.classList.add('is-gone'))
    this.root.querySelector('.ln')!.appendChild(veil)
    const legend = veil.querySelector('#ln-card-legend')!
    legend.innerHTML = (['clear', 'wind', 'rain', 'frost'] as const)
      .map((w) => `<span><em data-w="${w}"></em>${WEATHER_WORD[w]}</span>`)
      .join('')
    legend.querySelectorAll<HTMLElement>('em').forEach((em) => {
      const w = em.dataset.w!
      em.style.background =
        w === 'frost' ? 'rgba(140,190,255,.55)' : w === 'rain' ? 'rgba(90,130,200,.45)' : w === 'wind' ? 'rgba(150,170,220,.3)' : 'rgba(255,255,255,.12)'
    })
  }

  /* ── the hour strip ── */

  private buildActions(): void {
    for (const action of ACTIONS) {
      const label = ACTION_LABEL[action]
      const button = document.createElement('button')
      button.className = 'ln-act'
      button.dataset.action = action
      button.innerHTML = `<span class="ln-act-zh"></span><span class="ln-act-hint"></span>`
      button.querySelector('.ln-act-zh')!.textContent = `${label.zh} ${label.en}`
      button.querySelector('.ln-act-hint')!.textContent = label.hint
      button.addEventListener('click', () => void this.take(action))
      this.actionsEl.appendChild(button)
    }
  }

  private async take(action: Action): Promise<void> {
    if (this.chosen.length >= HOURS || !this.alive()) return
    const before = this.snapshot()
    this.chosen.push(action)
    this.result = simulate(this.chosen, this.season())
    this.narrate(before, action)
    this.paint()

    const done = this.chosen.length >= HOURS || !this.alive()
    if (done) await this.finish()
  }

  /**
   * Still going.
   *
   * Compared against `hoursSurvived`, NOT `trace.length`. The trace includes the
   * hour you died in — that entry is what shows the negative warmth — so its
   * length is one greater than the hours actually survived. Comparing lengths
   * therefore judged you alive for one extra click, and `take()` refuses to act
   * once dead, so `finish()` was never reached: the night simply stopped with no
   * score, no card, and nothing to press. That is the dead end this comparison
   * caused, and the reason it is spelled out here.
   */
  private alive(): boolean {
    return this.result.hoursSurvived >= this.chosen.length
  }

  /** Warmth / fuel / flame as they stand, for diffing against the next hour. */
  private snapshot(): { warmth: number; fuel: number; flame: number } {
    const t = this.result.trace[Math.min(this.chosen.length, this.result.trace.length) - 1]
    return t ? { warmth: t.warmth, fuel: t.fuel, flame: t.flame } : { warmth: 60, fuel: 8, flame: 3 }
  }

  /**
   * Say what the hour did.
   *
   * Without this the game is four buttons that move three numbers for reasons
   * you cannot see — which is exactly how it read to the first person who tried
   * it. The weather is the half nobody guesses, so it is named first.
   */
  /** The hours already narrated, newest last. Only the tail is drawn. */
  private beats: string[] = []

  private narrate(before: { warmth: number; fuel: number; flame: number }, action: Action): void {
    const t = this.result.trace[Math.min(this.chosen.length, this.result.trace.length) - 1]
    if (!t) return
    const sky = WEATHER_WORD[t.weather] ?? t.weather
    const delta = (now: number, was: number, unit: string): string =>
      now === was ? '' : `<b class="${now > was ? 'up' : 'down'}">${unit} ${now > was ? '+' : ''}${Math.round((now - was) * 10) / 10}</b>`
    this.beats.push(
      `<span class="h">第 ${t.hour + 1} 小时</span><span class="s">${sky}</span>` +
        `<span class="a">${ACTION_LABEL[action].zh}</span>` +
        `${delta(t.warmth, before.warmth, '体温')}${delta(t.fuel, before.fuel, '柴')}${delta(t.flame, before.flame, '火')}`,
    )
    // The last few hours, not just the last one. A single line left the sky
    // empty and gave no sense of where the night had been going — and where it
    // has been going is the whole basis for deciding the next hour.
    this.logEl.innerHTML = this.beats
      .slice(-BEATS_SHOWN)
      .map((b) => `<div class="ln-beat">${b}</div>`)
      .join('')
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
      glyph.className = 'g'
      glyph.textContent = WEATHER_GLYPH[sky[h]!] ?? '·'
      cell.appendChild(glyph)
      if (played) {
        const mark = document.createElement('span')
        mark.className = 'a'
        mark.textContent = trace[h]!.action[0]!.toUpperCase()
        cell.appendChild(mark)
      }
      this.hoursEl.appendChild(cell)
    }

    const warmth = now ? now.warmth : 60
    const fuel = now ? now.fuel : 8
    const flame = now ? now.flame : 3
    // The fire IS the readout: a guttering flame should look guttering before
    // anyone reads the number above it.
    const svg = this.gaugesEl.querySelector<SVGElement>('[data-k="flame"] svg')
    if (svg) {
      svg.style.transform = `scale(${Math.max(0.3, Math.min(1.25, flame / 3.4)).toFixed(3)})`
      svg.style.opacity = flame <= 0 ? '0.28' : '1'
      svg.style.filter = warmth < 28 ? 'saturate(.6) brightness(.82)' : ''
    }

    // Warmth, fire, wood — left to right. The fire in the middle because it is
    // the thing the other two exist to serve.
    this.gauge('warmth', '体温 warmth', warmth, 100, warmth < 28)
    this.gauge('flame', '火 flame', flame, 6, flame < 1)
    this.gauge('fuel', '柴 fuel', fuel, 20, fuel === 0)

    const left = HOURS - lived
    this.leftEl.textContent = this.alive() && left > 0 ? `天亮还有 ${left} 小时` : ''

    for (const button of Array.from(this.actionsEl.children) as HTMLButtonElement[]) {
      button.disabled = !this.alive() || this.chosen.length >= HOURS
    }
    this.paintStatus()
  }

  /**
   * One gauge, drawn once and then updated in place.
   *
   * Rebuilding the row on every hour restarted the bar transition, so a value
   * that had just dropped appeared to have always been there.
   */
  private gauge(kind: string, name: string, value: number, max: number, low: boolean): void {
    let el = this.gaugesEl.querySelector<HTMLDivElement>(`[data-k="${kind}"]`)
    if (!el) {
      el = document.createElement('div')
      el.className = 'ln-gauge'
      el.dataset.k = kind
      el.innerHTML =
        `<span class="ln-gauge-num"></span>` +
        `<span class="ln-gauge-art">${GAUGE_ART[kind] ?? ''}</span>` +
        `<span class="ln-gauge-bar"><i></i></span>` +
        `<span class="ln-gauge-name"></span>`
      el.querySelector('.ln-gauge-name')!.textContent = name
      this.gaugesEl.appendChild(el)
    }
    el.classList.toggle('is-low', low)
    el.querySelector('.ln-gauge-num')!.textContent = String(Math.round(value * 10) / 10)
    el.querySelector<HTMLElement>('.ln-gauge-bar i')!.style.width =
      `${Math.max(0, Math.min(100, (value / max) * 100))}%`
  }

  /**
   * Which night this is, and how much of it is left.
   *
   * The season key used to appear only in a dropdown in Arena's chrome, outside
   * the frame, where it read as an unexplained code next to a leaderboard. It is
   * the identity of the night everybody is comparing — it belongs in the world.
   */
  private paintStatus(): void {
    const lived = Math.min(this.chosen.length, this.result.trace.length)
    const left = HOURS - lived
    // The season key alone is a bare identifier — "第 7 夜" reads as the seventh
    // night of something, which it is not. What a player needs from it is that
    // this particular night is SHARED, so the label says that and the key rides
    // along as its name.
    const practice = this.isPractice()
    this.nightEl.textContent = practice ? '练习夜' : `今夜 #${this.season()}`
    const what = practice ? '没有开放的赛季,这一夜不计分' : '所有人走的都是这一夜'
    this.leftEl.textContent = this.alive()
      ? left > 0
        ? `${what} · 天亮还有 ${left} 小时`
        : `${what} · 天亮了`
      : `${what} · 火灭了`
  }

  /* ── the end of the night ── */

  /**
   * The night is over. Say how it went, record it, and offer another.
   *
   * The two writes are deliberately NOT one operation. The run is the scored
   * thing; the lamp is the world's memory of you and affects no number. Folding
   * them together meant a lamp that could not be written — a second night, when
   * the manifest allows one lamp each — reported the whole finish as a failure,
   * and the player was told they had "already walked tonight" for a night that
   * had in fact just been submitted and scored.
   */
  private async finish(): Promise<void> {
    const played = simulate(this.chosen, this.season())
    const points = scoreOf(played)

    if (this.isPractice()) {
      this.showEnding(
        played,
        points,
        '这是练习夜——现在没有开放的赛季,所以没有记录。',
        'Practice night: no season is open, so nothing was recorded.',
      )
      return
    }

    if (!this.me) {
      this.showEnding(played, points, '这一夜没有被记录。登录后再走一次就能上榜。', 'Not recorded — sign in to be scored.')
      return
    }

    let recorded = false
    let failure = ''
    try {
      await this.runs.add({ actions: this.chosen })
      recorded = true
    } catch (err) {
      const code = (err as { code?: string }).code
      failure =
        code === 'unauthenticated'
          ? '登录后才能记录。 Sign in to be scored.'
          : code === 'rate-limited'
            ? '走得太快了,稍后再来。 Too many nights too fast.'
            : ((err as { message?: string }).message ?? '没能记下来。 Could not record that.')
    }

    // The lamp is decoration and may fail quietly — one per person, so a later
    // night updates the existing one rather than adding a second.
    if (recorded) {
      const line = this.chosen.map((a) => a[0]!.toUpperCase()).join('')
      const lamp = { hours: played.hoursSurvived, dawn: played.survived, line }
      try {
        const mine = await this.lamps.list({ mine: true, limit: 1 })
        const existing = mine.items[0]
        if (existing) {
          if (played.hoursSurvived > existing.payload.hours) await this.lamps.put(existing.id, lamp)
        } else {
          await this.lamps.add(lamp)
        }
      } catch {
        /* the ridge is not the score; a lamp that would not light costs nothing */
      }
      await this.paintBoard()
    }

    this.showEnding(
      played,
      points,
      recorded ? (played.survived ? '你把灯留在了山脊上。' : '记下了。') : failure,
      recorded ? 'Recorded. Your best night stands on the leaderboard.' : '',
    )
  }

  /**
   * The ending card.
   *
   * Without one the night simply stopped: every button greyed out, no score, and
   * no way to try again. The weather is fixed for the whole season by design, so
   * walking it again with a better plan is the intended way to play — that has to
   * be a button, not something a player works out.
   */
  private showEnding(played: NightResult, points: number, zh: string, en: string): void {
    const card = document.createElement('div')
    card.className = 'ln-veil'
    card.innerHTML =
      '<div class="ln-card">' +
      '<div class="ln-end-h"></div>' +
      '<div class="ln-end-sub">撑了 <b></b> 小时 / 24</div>' +
      '<div class="ln-end-score"><b></b> <span>points</span></div>' +
      '<p class="ln-note"></p><p class="ln-note-en"></p>' +
      '<button class="ln-go" type="button">再走一夜 · Walk it again</button>' +
      '<p class="ln-hint">今夜的天气不会变——同一片天,换个走法。<span>Same night, same weather. Try a different line.</span></p>' +
      '</div>'
    card.querySelector('.ln-end-h')!.textContent = played.survived ? '天亮了' : '火灭了'
    card.querySelector('.ln-end-sub b')!.textContent = String(played.hoursSurvived)
    card.querySelector('.ln-end-score b')!.textContent = String(points)
    card.querySelector('.ln-note')!.textContent = zh
    card.querySelector('.ln-note-en')!.textContent = en
    card.querySelector('button')!.addEventListener('click', () => {
      card.remove()
      this.restart()
    })
    this.root.querySelector('.ln')!.appendChild(card)
  }

  /** Another go at the same night. */
  private restart(): void {
    this.chosen = []
    this.result = simulate([], this.season())
    this.beats = []
    this.logEl.textContent = ''
    this.paint()
  }

  /* ── the board, drawn by the world itself ── */

  /**
   * Standings and lamps, in the panel folded into the right edge.
   *
   * Both come from the platform but mean different things, so they sit together
   * rather than in two places: the board is who is winning, the lamps are who
   * got through. Arena used to render the board in its own chrome below the
   * frame, which is what made one page read as two unrelated screens.
   */
  private async paintBoard(): Promise<void> {
    const [board, lamps] = await Promise.all([
      this.ctx.standings({ limit: 12 }),
      this.lamps.list({ sort: ['-payload.hours'], limit: 12 }).catch(() => ({ items: [] as Rec<Lamp>[] })),
    ])

    this.boardEl.textContent = ''

    const head = document.createElement('div')
    head.className = 'ln-board-head'
    const title = document.createElement('span')
    title.className = 'ln-board-title'
    title.textContent = board ? `第 ${board.season.key} 夜` : '排行榜'
    head.appendChild(title)
    if (board?.season.status === 'sealed') {
      const final = document.createElement('span')
      final.className = 'ln-board-final'
      final.textContent = '已封存 final'
      head.appendChild(final)
    }
    this.boardEl.appendChild(head)

    if (!board || board.rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'ln-board-empty'
      empty.textContent = '还没有人走完这一夜。第一个就是你。\nNobody has finished tonight yet.'
      this.boardEl.appendChild(empty)
    } else {
      const rows = document.createElement('div')
      rows.className = 'ln-rows'
      for (const r of board.rows) {
        const row = document.createElement('div')
        row.className = 'ln-row' + (r.mine ? ' is-mine' : '')
        const rank = document.createElement('span')
        rank.className = 'ln-row-rank'
        rank.textContent = String(r.rank)
        const who = document.createElement('span')
        who.className = 'ln-row-who'
        who.textContent = r.authorName
        const score = document.createElement('span')
        score.className = 'ln-row-score'
        score.textContent = String(r.score)
        row.append(rank, who, score)
        rows.appendChild(row)
      }
      this.boardEl.appendChild(rows)
    }

    if (lamps.items.length) {
      const label = document.createElement('div')
      label.className = 'ln-lamps-title'
      label.textContent = '山脊上的灯 · lamps'
      const strip = document.createElement('div')
      strip.className = 'ln-lamps'
      for (const rec of lamps.items) {
        const lamp = document.createElement('div')
        lamp.className = 'ln-lamp' + (rec.payload.dawn ? ' is-dawn' : '')
        lamp.style.setProperty('--h', String(Math.max(0.25, rec.payload.hours / HOURS)))
        lamp.title = `${rec.author.name} — ${rec.payload.hours}h  ${rec.payload.line}`
        const dot = document.createElement('span')
        dot.className = 'ln-lamp-dot'
        const who = document.createElement('span')
        who.className = 'ln-lamp-who'
        who.textContent = rec.author.name
        lamp.append(dot, who)
        strip.appendChild(lamp)
      }
      this.boardEl.append(label, strip)
    }
  }
}

/* ─────────────────────────── markup ─────────────────────────── */

const TEMPLATE = `
<style>
  .ln {
    --sky-far:#050817; --sky-near:#0b1230; --ridge:#060b1c; --ridge-mid:#101a3c;
    --ink:#e2e8ff; --ink-dim:#8290bd; --ember:#ffb454; --ember-hot:#ffe6b8; --frost:#a6ccff;
    position:absolute; inset:0; overflow:hidden; color:var(--ink);
    font-family:var(--ln-font), "PingFang SC", system-ui, sans-serif; user-select:none;
    background:
      radial-gradient(80% 50% at 78% 4%, rgba(150,175,255,.10), transparent 60%),
      radial-gradient(60% 40% at 34% 92%, rgba(255,150,60,.14), transparent 64%),
      linear-gradient(180deg, var(--sky-far) 0%, var(--sky-near) 58%, #0a1028 100%);
    display:flex; align-items:stretch;
  }

  /* ── row 1: title + which night ── */
  .ln-main { flex:1; min-width:0; display:flex; flex-direction:column; }
  .ln-head { display:flex; align-items:center; justify-content:space-between;
             gap:16px; padding:16px 22px 0; z-index:3; }
  .ln-title { margin:0; font-size:17px; font-weight:600; letter-spacing:.28em; }
  .ln-title small { display:block; font-size:8.5px; letter-spacing:.32em; color:var(--ink-dim); margin-top:4px; font-weight:400; }
  /* Which night, said plainly. The season key was only ever visible in a dropdown
     outside the frame, where it read as an unexplained code. */
  .ln-night { display:grid; justify-items:end; gap:2px; }
  .ln-night b { color:var(--ember); font-size:13px; font-weight:600; letter-spacing:.06em; }
  .ln-night i { font-style:normal; font-size:10px; color:var(--ink-dim); }

  /* ── row 2: the forecast ── */
  .ln-strip { flex:none; padding:12px 22px 0; z-index:3; }
  .ln-strip-top { display:flex; justify-content:space-between; font-size:9px; letter-spacing:.18em;
                  text-transform:uppercase; color:rgba(130,144,189,.65); margin-bottom:5px; }
  .ln-hours { display:grid; grid-template-columns:repeat(24,1fr); gap:2px; }
  .ln-hour { position:relative; height:30px; border-radius:3px; background:rgba(255,255,255,.04);
             display:grid; place-items:center; transition:background .3s, box-shadow .3s, transform .2s; }
  /* Weather reads as colour before it reads as a glyph — a frost hour should be
     visible from across the room, not require a legend lookup mid-decision. */
  .ln-hour[data-weather="clear"] { background:rgba(255,255,255,.05); }
  .ln-hour[data-weather="wind"]  { background:rgba(150,170,220,.14); }
  .ln-hour[data-weather="rain"]  { background:rgba(90,130,200,.22); }
  .ln-hour[data-weather="frost"] { background:rgba(140,190,255,.30); }
  .ln-hour .g { font-size:10px; line-height:1; opacity:.75; }
  .ln-hour[data-weather="frost"] .g { color:#dcefff; }
  .ln-hour.is-past { background:linear-gradient(180deg, rgba(255,180,84,.4), rgba(255,140,40,.14)); }
  .ln-hour.is-past .g { display:none; }
  .ln-hour.is-past .a { display:block; }
  .ln-hour.is-now { transform:scaleY(1.22); box-shadow:0 0 0 1.5px var(--ember), 0 4px 14px rgba(255,180,84,.25); z-index:2; }
  .ln-hour .a { display:none; font-size:9px; font-weight:700; color:#3a2405; }

  /* ── row 3: the scene ── */
  /**
   * The sky.
   *
   * Painted, not empty. The cover art has a moon, stars thinning toward the
   * dawn, and a wash of colour on the right; the live world had none of it, so
   * the upper third of the screen read as a layout bug rather than as night.
   * All of it is background-image on one element — a starfield of real nodes
   * would be a hundred divs for something nobody interacts with.
   */
  .ln-scene { flex:1; position:relative; min-height:0;
    background-image:
      radial-gradient(circle at 78% 14%, rgba(201,214,255,.13), rgba(201,214,255,0) 42%),
      linear-gradient(to top right, rgba(42,36,80,0), rgba(107,74,110,.20)),
      radial-gradient(1.4px 1.4px at 6% 12%, rgba(223,231,255,.85), transparent 100%),
      radial-gradient(1px 1px at 13% 26%, rgba(223,231,255,.5), transparent 100%),
      radial-gradient(1.2px 1.2px at 20% 9%, rgba(223,231,255,.7), transparent 100%),
      radial-gradient(1px 1px at 27% 31%, rgba(223,231,255,.42), transparent 100%),
      radial-gradient(1.5px 1.5px at 34% 16%, rgba(223,231,255,.8), transparent 100%),
      radial-gradient(1px 1px at 41% 34%, rgba(223,231,255,.36), transparent 100%),
      radial-gradient(1.2px 1.2px at 47% 11%, rgba(223,231,255,.6), transparent 100%),
      radial-gradient(1px 1px at 55% 29%, rgba(223,231,255,.32), transparent 100%),
      radial-gradient(1.3px 1.3px at 63% 15%, rgba(223,231,255,.48), transparent 100%),
      radial-gradient(1px 1px at 71% 33%, rgba(223,231,255,.26), transparent 100%),
      radial-gradient(1.1px 1.1px at 84% 13%, rgba(223,231,255,.3), transparent 100%),
      radial-gradient(1px 1px at 16% 44%, rgba(223,231,255,.34), transparent 100%),
      radial-gradient(1px 1px at 38% 47%, rgba(223,231,255,.24), transparent 100%);
  }
  /* The fire is one of the three readouts, not a separate ornament. Having both a
     flame gauge and a big flame in the scene meant the same number was drawn
     twice, in two sizes, in two places. */
  /* Laid ON the night, not in a strip beneath it. As its own row the readouts
     were a separate panel that happened to sit under a picture — the seam ran
     right across the middle of the screen. Inside the scene the numbers belong
     to the place they describe, and the sky gets the height back.
     The right third is left clear for the log. */
  .ln-readout { position:absolute; left:0; right:0; bottom:18px; z-index:3;
                display:flex; flex-direction:column; align-items:center; gap:18px; }
  .ln-gauges { width:min(820px,88%); display:grid; grid-template-columns:1fr 1.3fr 1fr;
               align-items:end; gap:clamp(10px,2.5vw,40px); }
  .ln-gauge { display:grid; justify-items:center; gap:6px; }
  .ln-gauge-num { font-size:26px; font-weight:600; font-variant-numeric:tabular-nums; line-height:1; }
  .ln-gauge-art { display:grid; place-items:end center; min-height:52px; }
  .ln-gauge[data-k="flame"] .ln-gauge-art { min-height:96px; }
  .ln-gauge-art svg { display:block; transition:transform .4s cubic-bezier(.4,0,.2,1), filter .4s, opacity .4s; transform-origin:50% 100%; }
  .ln-gauge-bar { width:min(100%,148px); height:4px; border-radius:99px; background:rgba(255,255,255,.10); overflow:hidden; }
  .ln-gauge-bar i { display:block; height:100%; border-radius:99px; transition:width .35s ease; }
  .ln-gauge-name { font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--ink-dim); }
  .ln-gauge[data-k="warmth"] .ln-gauge-num { color:var(--ember-hot); }
  .ln-gauge[data-k="warmth"] i { background:linear-gradient(90deg,#ff7a3c,var(--ember)); }
  .ln-gauge[data-k="warmth"] svg { color:#cfd8ff; }
  .ln-gauge[data-k="fuel"] .ln-gauge-num { color:#dfe6ff; }
  .ln-gauge[data-k="fuel"] i { background:rgba(210,220,255,.55); }
  .ln-gauge[data-k="fuel"] svg { color:#9aa8cf; }
  .ln-gauge[data-k="flame"] .ln-gauge-num { color:var(--ember); }
  .ln-gauge[data-k="flame"] i { background:linear-gradient(90deg,var(--ember),var(--ember-hot)); }
  .ln-gauge.is-low .ln-gauge-num { color:var(--frost); }
  .ln-gauge.is-low .ln-gauge-art { animation:ln-pulse 1.1s ease-in-out infinite; }
  @keyframes ln-pulse { 50% { opacity:.45; } }
  .ln-ridgeline, .ln-ridgeline::after { position:absolute; inset:auto 0 0 0; content:''; }
  .ln-ridgeline { height:66%; background:linear-gradient(180deg, rgba(16,26,60,.8), rgba(11,18,48,.95));
    clip-path:polygon(0% 58%,11% 34%,22% 50%,33% 24%,45% 46%,56% 20%,68% 42%,79% 26%,90% 46%,100% 30%,100% 100%,0% 100%); }
  .ln-ridgeline::after { height:70%; background:linear-gradient(180deg, var(--ridge-mid), var(--ridge) 60%);
    clip-path:polygon(0% 66%,8% 52%,18% 64%,29% 44%,40% 60%,52% 40%,63% 58%,75% 42%,87% 60%,100% 48%,100% 100%,0% 100%); }

  .ln-log { text-align:center; font-size:11.5px;
    display:flex; flex-direction:column; align-items:center; gap:5px;
            color:var(--ink-dim); display:flex; justify-content:center; gap:10px; z-index:3; min-height:1.3em; }
  .ln-log .h { color:var(--ink); font-variant-numeric:tabular-nums; }
  .ln-log .s { color:var(--frost); }
  .ln-log .a { color:var(--ember-hot); font-weight:600; }
  .ln-log b { font-weight:600; font-variant-numeric:tabular-nums; }
  .ln-log .up { color:#84dba6; } .ln-log .down { color:#e59595; }
  /* The night fading behind you: the current hour is legible, the ones before
     it recede rather than competing with it. */
  .ln-beat { display:flex; justify-content:center; gap:9px; white-space:nowrap; }
  .ln-beat:nth-last-child(2) { opacity:.62; }
  .ln-beat:nth-last-child(3) { opacity:.44; }
  .ln-beat:nth-last-child(4) { opacity:.30; }
  .ln-beat:nth-last-child(5) { opacity:.20; }
  .ln-beat:nth-last-child(n+6) { opacity:.12; }

  /* ── row 4: actions ── */
  .ln-actions { flex:none; display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:0 22px 20px; z-index:3; }
  .ln-act { display:grid; gap:2px; padding:10px 6px 11px; border-radius:9px; cursor:pointer; text-align:center;
    background:rgba(255,255,255,.05); border:1px solid rgba(255,255,255,.10); color:inherit; font:inherit;
    transition:border-color .15s, background .15s, transform .12s; }
  .ln-act:hover:not(:disabled) { border-color:rgba(255,180,84,.6); background:rgba(255,180,84,.11); transform:translateY(-1px); }
  .ln-act:disabled { opacity:.3; cursor:default; }
  .ln-act-zh { font-size:13.5px; font-weight:600; letter-spacing:.1em; }
  .ln-act-hint { font-size:9.5px; color:rgba(130,144,189,.85); }

  /* ── the board, folded into the right edge ── */
  .ln-board { flex:none; position:relative; z-index:4; display:flex; align-items:stretch; }
  .ln-board-toggle {
    align-self:flex-start; margin:12px 0 0; padding:10px 7px; border:0; cursor:pointer; font:inherit;
    writing-mode:vertical-rl; letter-spacing:.2em; font-size:9.5px; text-transform:uppercase;
    background:rgba(255,255,255,.05); color:var(--ink-dim); border-radius:8px 0 0 8px;
    border:1px solid rgba(255,255,255,.09); border-right:0; transition:color .15s, background .15s;
  }
  .ln-board-toggle:hover { color:var(--ember); background:rgba(255,180,84,.1); }
  .ln-board-panel {
    width:0; overflow:hidden; transition:width .28s cubic-bezier(.4,0,.2,1);
    background:rgba(8,13,32,.72); backdrop-filter:blur(6px);
    border-left:1px solid rgba(255,255,255,.08);
  }
  .ln-board.is-open .ln-board-panel { width:clamp(196px,22vw,244px); }
  .ln-board-inner { padding:16px 16px 20px; display:grid; gap:10px; align-content:start; height:100%; box-sizing:border-box; }
  .ln-board-head { display:flex; align-items:baseline; justify-content:space-between; }
  .ln-board-title { font-size:10px; letter-spacing:.2em; text-transform:uppercase; color:var(--ink-dim); }
  .ln-board-final { font-size:8.5px; letter-spacing:.14em; color:var(--ember); text-transform:uppercase; }
  .ln-rows { display:grid; gap:1px; }
  .ln-row { display:grid; grid-template-columns:20px 1fr auto; gap:8px; align-items:center;
            padding:6px 7px; border-radius:5px; font-size:11px; }
  .ln-row.is-mine { background:rgba(255,180,84,.14); box-shadow:inset 0 0 0 1px rgba(255,180,84,.3); }
  .ln-row-rank { color:var(--ink-dim); font-variant-numeric:tabular-nums; text-align:right; font-size:10px; }
  .ln-row-who { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ln-row-score { font-variant-numeric:tabular-nums; font-weight:600; color:var(--ember-hot); }
  .ln-board-empty { font-size:10.5px; color:var(--ink-dim); line-height:1.6; }
  .ln-lamps { display:flex; flex-wrap:wrap; gap:8px; padding-top:10px; margin-top:2px;
              border-top:1px solid rgba(255,255,255,.07); }
  .ln-lamps-title { font-size:9px; letter-spacing:.18em; text-transform:uppercase; color:rgba(130,144,189,.6); }
  .ln-lamp { display:grid; justify-items:center; gap:3px; width:38px; }
  .ln-lamp-dot { width:5px; height:5px; border-radius:99px; background:var(--ember);
                 box-shadow:0 0 9px 3px rgba(255,180,84,.4); opacity:calc(.4 + var(--h,.5)*.6); }
  .ln-lamp.is-dawn .ln-lamp-dot { background:var(--ember-hot); box-shadow:0 0 13px 5px rgba(255,205,130,.55); }
  .ln-lamp-who { font-size:7.5px; color:var(--ink-dim); max-width:38px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* ── cards ── */
  .ln-veil { position:absolute; inset:0; z-index:20; display:grid; place-items:center; padding:24px;
             background:rgba(4,7,20,.88); backdrop-filter:blur(4px); transition:opacity .3s; }
  .ln-veil.is-gone { opacity:0; pointer-events:none; }
  .ln-card { max-width:456px; display:grid; gap:13px; background:rgba(11,17,42,.95);
             border:1px solid rgba(255,180,84,.2); border-radius:13px; padding:26px;
             box-shadow:0 26px 64px rgba(0,0,0,.55); }
  .ln-card-title { font-size:20px; font-weight:600; letter-spacing:.24em; }
  .ln-card-title span { display:block; font-size:8.5px; letter-spacing:.32em; color:var(--ink-dim); margin-top:5px; font-weight:400; }
  .ln-lead { margin:0; font-size:15px; color:var(--ember-hot); }
  .ln-lead-en { margin:-9px 0 0; font-size:11px; color:var(--ink-dim); }
  .ln-rules { margin:0; padding:0; list-style:none; display:grid; gap:9px; }
  .ln-rules li { font-size:12px; line-height:1.6; padding-left:14px; position:relative; }
  .ln-rules li::before { content:''; position:absolute; left:0; top:8px; width:4px; height:4px; border-radius:99px; background:var(--ember); }
  .ln-rules b { color:var(--ember-hot); font-weight:600; }
  .ln-rules span { display:block; color:rgba(130,144,189,.8); font-size:10px; margin-top:2px; }
  .ln-legend { display:flex; flex-wrap:wrap; gap:9px; font-size:9.5px; color:var(--ink-dim); }
  .ln-legend em { font-style:normal; display:inline-block; width:16px; height:11px; border-radius:2px; margin-right:4px; vertical-align:-1px; }
  .ln-go { margin-top:3px; padding:11px; border-radius:9px; cursor:pointer; font:inherit; font-size:13px;
           font-weight:600; letter-spacing:.1em; border:0; color:#2a1a06;
           background:linear-gradient(180deg,#ffc86e,#ef8f28); transition:filter .15s; }
  .ln-go:hover { filter:brightness(1.08); }
  .ln-end-h { font-size:23px; font-weight:600; letter-spacing:.2em; color:var(--ember-hot); }
  .ln-end-sub { font-size:12px; color:var(--ink-dim); }
  .ln-end-sub b { color:var(--ink); font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; }
  .ln-end-score { display:flex; align-items:baseline; gap:7px; }
  .ln-end-score b { font-size:36px; font-weight:600; color:var(--ember); font-variant-numeric:tabular-nums; }
  .ln-end-score span { font-size:9.5px; letter-spacing:.2em; color:var(--ink-dim); text-transform:uppercase; }
  .ln-note { margin:0; font-size:12.5px; } .ln-note:empty { display:none; }
  .ln-note-en { margin:-9px 0 0; font-size:10.5px; color:var(--ink-dim); } .ln-note-en:empty { display:none; }
  .ln-hint { margin:1px 0 0; font-size:10.5px; color:rgba(130,144,189,.8); line-height:1.6; }
  .ln-hint span { display:block; color:rgba(130,144,189,.55); font-size:9.5px; }
</style>

<div class="ln">
  <div class="ln-main">
  <div class="ln-head">
    <h1 class="ln-title">长夜<small>THE LONG NIGHT</small></h1>
    <div class="ln-night"><b id="ln-night"></b><i id="ln-left"></i></div>
  </div>

  <div class="ln-strip">
    <div class="ln-strip-top"><span>今夜的天气 · tonight, hour by hour</span><span id="ln-legend"></span></div>
    <div class="ln-hours" id="ln-hours"></div>
  </div>

  <div class="ln-scene" id="ln-scene">
    <div class="ln-ridgeline"></div>
    <div class="ln-readout">
      <div class="ln-log" id="ln-log"></div>
      <div class="ln-gauges" id="ln-gauges"></div>
    </div>
  </div>

  <div class="ln-actions" id="ln-actions"></div>
  </div>

  <div class="ln-board" id="ln-board">
    <button class="ln-board-toggle" id="ln-board-toggle" type="button">排行榜 · board</button>
    <div class="ln-board-panel"><div class="ln-board-inner" id="ln-board-inner"></div></div>
  </div>
</div>
`
