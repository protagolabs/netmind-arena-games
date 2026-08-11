/**
 * PredictMy.ai — the deployed simulator, running on Arena.
 *
 * This is a PORT, not a reinterpretation. The stylesheet, the markup, the copy
 * and the whole 11v11 engine come verbatim from the shipped build (see
 * `tools/extract.mjs`). The broadcast chrome, the claimable dots, the remote's
 * player and chat panes, the ability radar, the vision and referee toggles, the
 * cinematic filter, the seed, the 100-run prediction — all of it is the source's
 * own code, unchanged.
 *
 * This file only does what the sandbox makes necessary:
 *
 *   1. resolve the three images to inlined `data:` URIs, since nothing may be
 *      fetched from an opaque origin
 *   2. give the page the storage it expects, backed by `ctx.local`
 *   3. install the local `/api` router (see `shim.ts`) and boot the vendored
 *      entry AFTER the markup exists, matching the deferred module the real
 *      page loads
 *
 * Rebuilt rather than ported: the assistant coach's model. On predictmy.ai the
 * tactics chat reaches a server-side LLM over `/api/chat`; here it reaches
 * Arena's, through `ctx.ai`, billed to the signed-in visitor's own NetMind
 * account. The call sites are the source's own — this file only supplies what
 * the site kept on its server and no browser ever received: the system prompt
 * and the tool definition. That is the one place this port had to write instead
 * of copy, and `src/coach.ts` says exactly which parts of it are read out of the
 * vendored build and which are reconstructed.
 *
 * When there is no model — nobody signed in, the visitor declined, the platform
 * has it switched off — `shim.ts` answers 429 and the page falls back to the
 * bilingual rule parser it ships with. The chat still reads orders and still
 * moves the same numbers, using code that shipped with the design.
 *
 * Dropped: analytics, and the invite-code gate. Neither is part of the
 * simulator, and Arena is not an acquisition surface for a third party.
 *
 * Handed to the platform: language and theme. The page's own switchers are
 * hidden and Arena's header drives both, because two controls for one setting
 * are two controls that disagree. Its nine languages are Arena's nine, so
 * nothing is lost — see "Language and theme" in docs/worlds.md.
 *
 * Not carried: World Cup mode, the adventure game, and the three written
 * documents. A world is one screen and those are separate pages of the site, so
 * every control that pointed at one now opens a prompt naming the address — see
 * `showOffsite`. A sandboxed document cannot open a link, so the address is
 * offered to COPY; Arena's own attribution link, in the chrome around this
 * frame, is the one real link out.
 *
 * REBUILT rather than carried: online versus. It is a separate page on the site
 * too, and it is the one that could be brought over, because what it needs is
 * not a second screen but a relay — and `ctx.channel` is one. None of the site's
 * versus code exists here; the room, the seats, the lockstep and the panel are
 * all Arena's, and `src/versus.ts` explains what that costs. `about.md` says so
 * plainly, beside the score bar.
 *
 * ADDED, which nothing else here is: a running score bar. The source shows the
 * score only inside the coach panel, so a visitor who has selected nobody
 * watches ninety minutes without being told what it is — and on Arena most
 * visitors come to watch. It renders the source's own numbers and the source's
 * own words (`tools/extract.mjs` publishes the handles); the decision to always
 * show them is ours, and `about.md` says so.
 */
import { defineWorld, type WorldCtx } from '@arena/world-sdk'
import { CSS, MARKUP, ASSET_TOKEN } from './original.js'
import { installShims, type MatchState } from './shim.js'
import { COACH_TOOL, coachSystem } from './coach.js'
import { mountVersus } from './versus.js'

/** The page's own preference keys. */
const LANG_KEY = 'aa_lang'
const THEME_KEY = 'aa_theme'

/**
 * The nine languages the page ships strings for.
 *
 * The same nine Arena supports, which is why `ctx.lang` can be handed over
 * as-is. Kept as a guard rather than assumed: the sets agreeing today is a
 * coincidence of two independent lists, and if Arena adds a tenth this falls
 * back to English instead of asking the page for strings it does not have.
 */
const LANGS = new Set(['en', 'zh', 'es', 'ru', 'fr', 'de', 'pt', 'ja', 'ko'])

/** Where the page's preferences live between visits. */
const STORE_KEY = 'prefs'

type Prefs = Record<string, string>

export default defineWorld({
  meta: { type: 'predictmy' },

  async mount(root, ctx) {
    /**
     * Never let a preference read decide whether the world opens: an anonymous
     * visitor has no private storage, and that must degrade to defaults rather
     * than to a failed mount.
     */
    // Must exist before the vendored bundle draws its first frame.
    installBannerFit()

    const stored = await ctx.local.get<Prefs>(STORE_KEY).catch(() => null)
    const prefs: Prefs = { ...(stored ?? {}) }

    /**
     * Arena owns language and theme; this world follows.
     *
     * Not seeded-once-then-independent: Arena already has one control for each in
     * its header, and a second pair inside the frame would be two switches for
     * one setting — the kind that disagree. So the page's own controls are hidden
     * (`HIDDEN` in `tools/extract.mjs`) and these values are imposed on every
     * change instead.
     */
    const fromArena = (): Prefs => ({
      // `ctx.lang` is guaranteed to be a base code — the platform narrows
      // `zh-CN` to `zh` and falls back to `en` itself — so it is compared
      // directly. Splitting a locale here, or indexing the page's language array
      // by position, is how a world ends up rendering a different language from
      // the one it read.
      [LANG_KEY]: LANGS.has(ctx.lang) ? ctx.lang : 'en',
      [THEME_KEY]: ctx.theme.mode,
    })
    Object.assign(prefs, fromArena())

    installShims({
      persisted: prefs,
      // Remembering a preference is a courtesy, not a requirement: a signed-out
      // visitor has nowhere to put it, and the session must work regardless.
      save: (all) => void ctx.local.set(STORE_KEY, all).catch(() => {}),
      /**
       * The coach's model, when the platform can offer one.
       *
       * `null` here is not a failure path, it is one of the two normal shapes of
       * this world: `shim.ts` answers the page's own 429 branch, which runs the
       * bilingual rule parser the source ships. See `src/coach.ts` for why the
       * prompt and tool live in this repo at all.
       */
      chat: ctx.ai
        ? async ({ messages, context }) => {
            const reply = await ctx.ai!.chat({
              system: coachSystem(ctx.lang, withRealTeams(context)),
              // The page owns this array — it appends the assistant's blocks and
              // the tool results itself and replays the whole thing next turn,
              // which is what makes its four-round tool loop work. Passing it
              // through untouched is what keeps that the source's logic.
              messages: messages as never,
              tools: [COACH_TOOL],
            })
            return { content: reply.content, stop_reason: reply.stopReason }
          }
        : null,
    })

    const style = document.createElement('style')
    style.textContent = withAssets(CSS, ctx)
    document.head.appendChild(style)

    /**
     * The markup expects to BE the page — it pins `#stadium`, `#topbar` and the
     * remote to the viewport — and `root` is the document body, so it lands
     * exactly where the original put it.
     */
    root.innerHTML = withAssets(MARKUP, ctx)
    document.documentElement.lang = prefs[LANG_KEY] ?? 'en'
    if (prefs[THEME_KEY] === 'light') document.documentElement.classList.add('light')

    /**
     * Everything that tried to leave the document ends up here.
     *
     * Two routes reach it: the markup's own `<a href="/wcmode/">` links, and the
     * nav menus, whose `location.href = <path>` assignments `tools/extract.mjs`
     * rewrites to `__arenaOffsite`. Both are dead from an opaque origin, and a
     * control that silently does nothing reads as a broken port rather than as a
     * boundary.
     *
     * All of them land in one place now: a prompt naming the address. The
     * documents, World Cup mode, online versus, the remote's own "predict this
     * match" button — everything the source reaches for by leaving the page.
     */
    /**
     * Online versus is the ONE of those destinations that now has somewhere to
     * go.
     *
     * It used to land in the same prompt as the rest, because a relay needs a
     * server and a world has none. `ctx.channel` is that relay — see
     * `src/versus.ts` — so the nav entry opens a real screen instead of an
     * address to copy. Everything else in the menu still leaves.
     */
    const versus = mountVersus(ctx)
    globalThis.__arenaOffsite = (href) => {
      if (typeof href === 'string' && href.startsWith('/versus')) versus.open()
      else showOffsite(ctx)
    }
    for (const el of Array.from(root.querySelectorAll('[data-arena-offsite]'))) {
      el.addEventListener('click', (e: Event) => {
        e.preventDefault()
        e.stopPropagation()
        // The element's own destination, so the letter link in the markup opens
        // the letter instead of the generic "it lives elsewhere" line.
        globalThis.__arenaOffsite(el.getAttribute('href') ?? '')
      })
    }

    mountScoreBar(ctx)

    /**
     * Re-impose Arena's choice after boot.
     *
     * The source reads `aa_lang` from storage once, at startup, and thereafter
     * only re-renders when its own button calls its apply function. Writing
     * storage alone therefore changes nothing on screen — so `vendor/main.js`
     * publishes that function as `__arenaApplyLang`, and this calls it. It is one
     * appended statement at the point the source already invokes it itself.
     *
     * Theme is a class on the root element, which the stylesheet keys off
     * directly, so it needs no equivalent.
     */
    const applyEnv = () => {
      const next = fromArena()
      globalThis.arenaLS?.setItem(LANG_KEY, next[LANG_KEY]!)
      globalThis.arenaLS?.setItem(THEME_KEY, next[THEME_KEY]!)
      // Not `documentElement.lang`: the source's own apply function sets it, to
      // a full locale (`zh-CN`), one line after this. Setting it here too would
      // be a write nobody reads.
      document.documentElement.classList.toggle('light', next[THEME_KEY] === 'light')
      tagChatEmpty()
      globalThis.__arenaApplyLang?.(next[LANG_KEY]!)
    }

    ctx.onThemeChange(applyEnv)
    ctx.onLangChange(applyEnv)

    /**
     * Boot the source last, and dynamically.
     *
     * A static import would be hoisted to the top of the bundle and run before
     * `mount` — the page would look for `#pitch` in an empty document and die.
     * esbuild inlines this import at build time, so it stays one self-contained
     * document; all the `await` does is hold execution until the markup and the
     * globals are in place, which is the same guarantee the real page gets from
     * loading its entry as a deferred module.
     */
    await import('./vendor/main.js')

    /**
     * Apply once, now that the source has booted — the documented pattern is
     * `applyLang(); ctx.onLangChange(applyLang)`, and subscribing alone is not
     * enough.
     *
     * The page picks its own language at startup: it prefers stored `aa_lang`,
     * but falls back to sniffing `navigator.languages`. Seeding storage before
     * boot is supposed to win that race, and when it does this call changes
     * nothing. When it does not — because the visitor's browser prefers a
     * language Arena is not set to, or because storage was read before the seed
     * landed — the page comes up in the browser's language and stays there,
     * since nothing else re-applies until the visitor changes Arena's setting.
     * That failure shows up as a world stuck in a language nobody asked for.
     */
    applyEnv()
  },
})

/* ────────────────────────────── leaving the world ────────────────────────────── */

const SITE = 'https://predictmy.ai/'

/** The one string this prompt needs, in the nine languages the page speaks. */
const OFFSITE_COPY: Record<
  string,
  { title: string; body: string; copy: string; copied: string; manual: string; close: string }
> = {
  en: {
    title: 'This part lives on predictmy.ai',
    body: 'World Cup mode, the adventure game and the written docs are separate pages of the original site. An Arena world is a single screen, so they stay where they are. Online versus does not — it was rebuilt here, and the nav entry opens it.',
    copy: 'Copy address',
    copied: 'Copied',
    manual: 'Selected — press ⌘C / Ctrl+C',
    close: 'Back to the match',
  },
  zh: {
    title: '这部分在 predictmy.ai 上',
    body: '世界杯模式、闯关游戏和几篇文档，都是原站独立的页面。Arena 里的世界只有一屏，所以它们留在原处。联网对战不在此列 —— 它在这里重做了一份，菜单里那一项直接打开。',
    copy: '复制网址',
    copied: '已复制',
    manual: '已选中，按 ⌘C / Ctrl+C',
    close: '回到比赛',
  },
}

let offsiteEl: HTMLElement | null = null

/**
 * Tell the visitor where the rest of predictmy.ai is, and give them a way to act
 * on it.
 *
 * ## Why it cannot simply be a link
 *
 * The document runs in an `iframe sandbox` with neither `allow-popups` nor
 * `allow-top-navigation`. An `<a target="_blank">` here is not blocked with a
 * message — it is silently inert, which is worse than no link at all. So the
 * address is presented as something to COPY, which is the one outbound action a
 * sandboxed document can actually complete. Arena's own attribution link, in the
 * chrome around this frame, is the other way there and it is a real link.
 *
 * ## Why a dialog and not a toast
 *
 * This used to be a line that faded in at the bottom of the screen for three
 * seconds. It was missable, unreadable at a glance, and — being
 * `pointer-events: none` — could not even be selected, so the address it named
 * was of no use to anyone. A visitor who clicked something and got nothing they
 * could act on has been told less than nothing.
 */
function showOffsite(ctx: WorldCtx): void {
  const c = OFFSITE_COPY[ctx.lang] ?? OFFSITE_COPY.en!

  if (!offsiteEl) {
    const css = document.createElement('style')
    css.textContent = `
      #arena-offsite { position: fixed; inset: 0; z-index: 500; display: flex;
        align-items: center; justify-content: center; padding: 20px;
        background: rgba(4,6,10,0.72); backdrop-filter: blur(3px); }
      #arena-offsite[hidden] { display: none; }
      #arena-offsite .card { width: min(440px, 100%); border-radius: 14px; padding: 22px 22px 18px;
        background: linear-gradient(178deg, #262a31 0%, #16181d 60%, #101115 100%);
        border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 24px 60px rgba(0,0,0,0.6);
        font: 14px/1.6 ui-sans-serif, system-ui; color: #e6edf3; }
      #arena-offsite h3 { margin: 0 0 8px; font-size: 17px; font-weight: 700; color: #ffd23f; }
      #arena-offsite p { margin: 0 0 16px; color: #adbac7; }
      /* Selectable on purpose: copying is the fallback when the button cannot. */
      #arena-offsite .url { display: block; user-select: all; margin-bottom: 14px; padding: 11px 13px;
        border-radius: 9px; background: rgba(0,0,0,0.42); border: 1px solid rgba(255,210,63,0.35);
        font: 600 15px ui-monospace, monospace; color: #ffe071; word-break: break-all; }
      #arena-offsite .row { display: flex; gap: 9px; }
      #arena-offsite button { flex: 1; padding: 9px 0; border-radius: 9px; font: 600 13px inherit;
        cursor: pointer; border: 1px solid rgba(255,255,255,0.18); background: none; color: #d7dbe0; }
      #arena-offsite button.go { border-color: #f5b73a; background: linear-gradient(180deg,#ffe071,#f5b73a); color: #12151a; }
    `
    document.head.appendChild(css)

    offsiteEl = document.createElement('div')
    offsiteEl.id = 'arena-offsite'
    offsiteEl.innerHTML =
      `<div class="card"><h3></h3><p></p><code class="url"></code>` +
      `<div class="row"><button class="go"></button><button class="dismiss"></button></div></div>`
    document.body.appendChild(offsiteEl)

    // Clicking the dimmed backdrop closes, as every dialog does; clicking the
    // card must not.
    offsiteEl.addEventListener('click', (e) => {
      if (e.target === offsiteEl) hideOffsite()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideOffsite()
    })
  }

  const card = offsiteEl
  card.querySelector('h3')!.textContent = c.title
  card.querySelector('p')!.textContent = c.body
  card.querySelector('.url')!.textContent = SITE

  const go = card.querySelector('.go') as HTMLButtonElement
  go.textContent = c.copy
  go.onclick = () => {
    void copyText(SITE).then((ok) => {
      if (ok) {
        go.textContent = c.copied
        return
      }
      /**
       * Both copy routes can be refused here — this is an opaque origin, and the
       * Clipboard API's permission check is not guaranteed to pass on one.
       *
       * A button that silently does nothing is the worst of the three outcomes,
       * so the failure has a job: select the address and say which keys finish
       * it. That works everywhere, and it leaves the visitor one keystroke from
       * where they were going.
       */
      const url = card.querySelector('.url')!
      const range = document.createRange()
      range.selectNodeContents(url)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      go.textContent = c.manual
    })
  }

  const dismiss = card.querySelector('.dismiss') as HTMLButtonElement
  dismiss.textContent = c.close
  dismiss.onclick = hideOffsite

  card.hidden = false
}

function hideOffsite(): void {
  if (offsiteEl) offsiteEl.hidden = true
}

/**
 * Copy, by whichever route this sandbox allows.
 *
 * The async Clipboard API is the right one and is often unavailable here: an
 * opaque origin fails its permission check in some browsers. `execCommand`
 * is deprecated and still works in exactly the case that defeats the modern API,
 * so it stays as the fallback rather than as the primary.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fall through */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.cssText = 'position:fixed;top:-100px;opacity:0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

/* ────────────────────────────── the score bar ────────────────────────────── */

/**
 * A running score, which the source does not have.
 *
 * This is the one place the port ADDS to the design rather than carrying it. On
 * predictmy.ai the score exists only inside the coach panel, so a visitor who
 * has not selected anyone watches ninety minutes without being told what it is —
 * and on Arena, where people arrive to watch rather than to manage, that is most
 * visitors. `about.md` says the bar is ours.
 *
 * Everything it renders is the source's: the score and the clock from the live
 * match state, the team names and the phase from the source's own i18n table,
 * both published by `tools/extract.mjs`. It invents no vocabulary.
 */
function mountScoreBar(ctx: WorldCtx): void {
  /**
   * It goes INSIDE the screen, because that is what it is: a scorebug, the
   * graphic a broadcast keeps in the corner of the picture. Floating it over the
   * page would make it a website's status bar sitting on top of a television —
   * two different objects, one obviously pasted onto the other.
   *
   * So it borrows the vocabulary the source already uses for on-screen chrome:
   * the same translucent black, the same hairline border and blur as the channel
   * badge in the opposite corner, the same monospace with wide tracking. Top
   * centre is the one place in the picture the source left empty — the channel
   * badge holds the left, the match tags hold the right.
   */
  const screen = document.getElementById('screen') ?? document.body

  const css = document.createElement('style')
  css.textContent = `
    #arena-score { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); z-index: 20;
      display: none; align-items: center; gap: 9px; padding: 5px 11px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.45);
      backdrop-filter: blur(4px); pointer-events: none; white-space: nowrap; line-height: 1;
      font: 600 11px ui-monospace, monospace; letter-spacing: 1.5px; color: rgba(255,255,255,0.88); }
    #arena-score .sc { color: #fff; font-size: 13px; letter-spacing: 1px; }
    #arena-score .tm { display: inline-flex; align-items: center; gap: 5px; }
    /* Sized and ringed like the players' own dots, so the eye matches it to the
       pitch without being told to. */
    #arena-score .sw { width: 8px; height: 8px; border-radius: 50%; flex: none;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.55); }
    #arena-score .cl { color: #ffd23f; }
    /* A hairline between the score and the clock, like the divider a broadcast
       graphic uses instead of punctuation. */
    #arena-score .dv { width: 1px; height: 11px; background: rgba(255,255,255,0.22); }
    /* The cinema filter letterboxes the picture with a 46px black bar, and the
       source's own badges sit inside it. Drop below it so this does too. */
    #screen.f-cinema #arena-score { top: 54px; }
    html.light #arena-score { background: rgba(0,0,0,0.55); }
  `
  document.head.appendChild(css)

  const bar = document.createElement('div')
  bar.id = 'arena-score'
  screen.appendChild(bar)

  /** The source's own clock arithmetic, so the bar and the coach panel agree. */
  const minuteOf = (m: MatchState): number =>
    Math.min(90, (m.phase === '2H' || m.phase === 'FT' ? 45 : 0) + Math.floor((m.halfElapsed / Math.max(1, m.halfLength)) * 45))

  const PHASE: Record<string, string> = {
    INTRO: 'phaseIntro',
    '1H': 'phase1H',
    HT: 'phaseHT',
    '2H': 'phase2H',
    FT: 'phaseFT',
  }

  const draw = () => {
    const m = globalThis.__arenaMatch?.()
    const t = globalThis.__arenaT
    // The handles arrive with the vendored bundle, which boots after this. Until
    // then — and if a future extraction ever loses them — the bar simply stays
    // hidden rather than drawing a score nobody can trust.
    if (!m || !t || !Array.isArray(m.score)) {
      bar.style.display = 'none'
      return
    }
    bar.style.display = 'flex'
    const phase = PHASE[m.phase] ? t(PHASE[m.phase]!) : m.phase
    // Before kick-off there is no clock to show, only where we are.
    const clock = m.phase === 'INTRO' || m.phase === 'FT' ? phase : `${minuteOf(m)}'`

    /**
     * Who is actually playing — NOT `t('team0')` / `t('team1')`.
     *
     * Those keys are the DEMO match's team names. Change the channel to a real
     * fixture and the engine plays USA against Bosnia while the i18n table still
     * says Portugal and Argentina, so a bar built from the table announces the
     * wrong two countries over the right score, with a broadcast graphic's air of
     * authority. The code getter is reset with every fixture load, and it is what
     * the source builds its own team labels from.
     *
     * Codes rather than names is also simply what a scorebug does — and it is the
     * only form that stays short when the fixture is "Bosnia and Herzegovina".
     */
    /**
     * The same names the source's own banners use.
     *
     * Not `t('team0')` — those are the DEMO match's names and do not change with
     * the channel, so a bar built from them announces Portugal and Argentina over
     * a USA fixture. And not the three-letter codes either, which is what this
     * bar showed first: broadcast practice, but it left the kickoff card saying
     * "Bosnia and Herzegovina" and this bar saying "BAH" about the same team, and
     * the visitor doing the matching. One name, everywhere.
     */
    const name = globalThis.__arenaTeamName
    const home = name?.(0) ?? t('team0')
    const away = name?.(1) ?? t('team1')

    // `textContent` per part, never innerHTML: these strings come from the
    // fixture data, and a broadcast graphic is not worth an injection sink even
    // when today's data is all plain words.
    bar.replaceChildren(
      team(0, home),
      span('sc', `${m.score[0]} : ${m.score[1]}`),
      team(1, away),
      span('dv', ''),
      span('cl', clock),
    )
  }

  draw()
  // A quarter second: the score changes rarely and the clock once a minute, so
  // anything faster is redraw for its own sake.
  window.setInterval(draw, 250)
  ctx.onLangChange(draw)
}

/**
 * Correct the two team names in the match snapshot before it reaches the model.
 *
 * The source builds that snapshot with `teams: [t('team0'), t('team1')]` — the
 * DEMO match's names, which do not change when the channel does. So on a real
 * fixture it tells the coach it is watching Portugal against Argentina while USA
 * are playing Bosnia, and every judgement it makes about the opposition is made
 * about the wrong country. Harmless on the source's own server; not harmless
 * here, where this snapshot is most of what the model knows.
 *
 * Corrected on the way out rather than in the vendored code: the prompt is ours
 * to build (see `src/coach.ts`), so this is our field to get right.
 */
function withRealTeams(context: unknown): unknown {
  const name = globalThis.__arenaTeamName
  if (!name || !context || typeof context !== 'object') return context
  return { ...(context as Record<string, unknown>), teams: [name(0), name(1)] }
}

/** One styled part of the scorebug. */
function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement('span')
  if (cls) el.className = cls
  el.textContent = text
  return el
}

/**
 * A team's name behind a dot in that team's colour.
 *
 * Naming the two sides still leaves the question the pitch actually asks — which
 * of them is the yellow one. The swatch is the engine's OWN fill for that side,
 * the same value it paints the players with, so the bar and the dots cannot
 * disagree even when the fixture changes underneath them.
 */
function team(side: number, name: string): HTMLSpanElement {
  const wrap = document.createElement('span')
  wrap.className = 'tm'
  const fill = globalThis.__arenaTeamFill?.(side)
  if (fill) {
    const dot = document.createElement('span')
    dot.className = 'sw'
    dot.style.background = fill
    wrap.appendChild(dot)
  }
  wrap.appendChild(document.createTextNode(name))
  return wrap
}

/**
 * Finish the calculation the source's phase banner starts.
 *
 * `drawPhaseBanner` scales its layout by `min(1, cssW/1000)` — it means to fit,
 * it just never measures the text. The kickoff card draws each team's full name
 * outward from the centre at 46px, so a long one runs off the picture: "Bosnia
 * and Herzegovina" wants 577px of the 500px a half-width allows, and lands on
 * screen as "Bosnia and Herzegovi".
 *
 * This narrows the scale until both names fit, and touches nothing else — the
 * other phases keep the source's figure exactly, and so does the kickoff card
 * whenever the names are short enough, which is nearly always. `tools/extract.mjs`
 * rewrites the source to call this, with the original expression as its fallback.
 */
function installBannerFit(): void {
  // One offscreen context, reused: this runs inside a canvas repaint.
  const measure = document.createElement('canvas').getContext('2d')

  globalThis.__arenaFitBanner = (cssW: number): number => {
    const base = Math.min(1, cssW / 1000)
    const phase = globalThis.__arenaMatch?.().phase
    const name = globalThis.__arenaTeamName
    // Only the kickoff card lays names out from the centre outward; half-time and
    // full time draw one centred line that the source's own figure already fits.
    if (phase !== 'INTRO' || !name || !measure) return base

    measure.font = 'bold 46px sans-serif'
    // 46px is the gap the source leaves between the centre and each name.
    const need = 46 + Math.max(measure.measureText(name(0)).width, measure.measureText(name(1)).width)
    if (need <= 0) return base
    // A margin, not a flush fit. Scaling to exactly the half-width puts the last
    // letter and its underline against the bezel, which reads as "only just got
    // away with it" rather than as a designed card.
    return Math.min(base, (cssW / 2 - 24) / need)
  }
}

/**
 * Let the source's own translator reach the tactics chat's empty state.
 *
 * That block — "chat tactics with the AI coach; pick a player first" — is built
 * in JS with `textContent = t('chatEmpty')` and rendered once, when the chat
 * pane opens or is cleared. The source's apply-language function re-renders
 * `[data-i18n]`, `[data-i18n-ph]` and `[data-i18n-title]` and then calls a dozen
 * specific redraws by hand; the chat empty state is in none of them. So it keeps
 * whatever language it was first drawn in while every other string on the page
 * changes around it.
 *
 * That is the SOURCE's defect, not the port's — the same thing happens on
 * predictmy.ai — but it is far more visible here: Arena's header drives the
 * language, so a visitor switching it watches the whole page follow except this
 * one paragraph.
 *
 * The fix borrows the source's own mechanism rather than adding a second one:
 * tagging the element makes the existing `[data-i18n]` loop pick it up. Nothing
 * here knows what the string SAYS, in any language — which is what keeps this a
 * patch rather than a rewrite.
 *
 * Side effect worth naming: `textContent` replaces children, so the invite-code
 * link the source appends inside the block is dropped on the first switch. It is
 * already `display: none` here (`tools/extract.mjs` hides it — nothing in this
 * world is gated), so nothing visible changes.
 */
function tagChatEmpty(): void {
  document.querySelector('.chat-empty')?.setAttribute('data-i18n', 'chatEmpty')
}

/** Swap `__ARENA_ASSET__<path>__` for the inlined `data:` URI. */
function withAssets(text: string, ctx: WorldCtx): string {
  return text.replace(ASSET_TOKEN, (whole, rel: string) => {
    try {
      return ctx.asset(rel)
    } catch {
      // A missing asset should cost a backdrop, not the match.
      return whole
    }
  })
}

