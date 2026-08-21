/**
 * The Long Night — the rules, in one place.
 *
 * THIS FILE IS THE ONLY IMPLEMENTATION. The document imports it directly; the L1
 * scorer (`scorer.js`) is GENERATED from it by `tools/build-scorer.mjs` and must
 * never be hand-edited. Two copies of a rule set drift, and drift here reads as a
 * player being told they survived and then being scored as though they had not.
 *
 * WHY THE WEATHER IS SHARED. Every competitor in a season gets the SAME sequence
 * of hours, seeded from the season key alone and never from who is playing. That
 * is what makes the leaderboard mean anything: a longer night is a better night,
 * not a luckier one. It is the opposite choice from a per-player board, and it is
 * the right one here because the whole appeal is comparing your line against
 * someone else's on a night you both remember.
 *
 * Determinism is mandatory: `Math.random` and every clock read throw inside the
 * scorer isolate. The generator below is seeded and explicit for that reason, and
 * because an agent has to be able to reproduce it — see agent.md.
 */

export type Action = 'gather' | 'shelter' | 'tend' | 'rest'
export type Weather = 'clear' | 'wind' | 'rain' | 'frost'

export interface HourTrace {
  hour: number
  weather: Weather
  action: Action
  warmth: number
  fuel: number
  flame: number
}

export interface NightResult {
  hoursSurvived: number
  survived: boolean
  trace: HourTrace[]
  sky: Weather[]
  warmth: number
  fuel: number
  flame: number
}

export const HOURS = 24
const START = { warmth: 60, fuel: 8, flame: 3 }
const MAX_WARMTH = 100
const MAX_FLAME = 6

/**
 * The four things you can do with an hour. Every one trades something.
 *
 * There is deliberately no "best" action: `tend` is the only one that gains
 * warmth outright and it is also the only one that spends fuel you cannot get
 * back, so a night spent tending ends cold and empty two hours before dawn.
 */
export const ACTIONS: Action[] = ['gather', 'shelter', 'tend', 'rest']

/**
 * Weather, worst to mildest. `drain` is warmth lost before your action resolves;
 * `gust` is the chance-free penalty to an exposed flame.
 */
const WEATHER: Record<Weather, { drain: number; gust: number; gatherBonus: number }> = {
  clear: { drain: 5, gust: 0, gatherBonus: 2 },
  wind: { drain: 8, gust: 2, gatherBonus: 1 },
  rain: { drain: 11, gust: 1, gatherBonus: 0 },
  frost: { drain: 17, gust: 0, gatherBonus: 0 },
}

function fnv1a(text: string): number {
  var h = 2166136261
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  var a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    var t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Tonight's weather, hour by hour.
 *
 * Seeded from the season alone. The deepening bias is not decoration: an early
 * night that is survivable by ignoring it, turning into a late night that is not,
 * is what makes stockpiling a real decision rather than an obvious one.
 */
export function forecast(seasonKey: string): Weather[] {
  var roll = mulberry32(fnv1a('long-night:' + seasonKey))
  const hours: Weather[] = []
  for (var h = 0; h < HOURS; h++) {
    var deep = h / HOURS
    var r = roll()
    if (r < 0.10 + deep * 0.30) hours.push('frost')
    else if (r < 0.30 + deep * 0.35) hours.push('rain')
    else if (r < 0.62) hours.push('wind')
    else hours.push('clear')
  }
  return hours
}

/**
 * Play one night and report what happened.
 *
 * Returns the whole trace rather than just a number, because the browser draws
 * from the same call the scorer scores from. `hoursSurvived` is the headline;
 * everything else is what the page shows while you are living it.
 */
export function simulate(actions: Action[], seasonKey: string): NightResult {
  const sky = forecast(seasonKey)
  var warmth = START.warmth
  var fuel = START.fuel
  var flame = START.flame
  const trace: HourTrace[] = []

  for (var h = 0; h < HOURS; h++) {
    const weather = WEATHER[sky[h]!]
    const action: Action = actions[h] ?? 'rest'

    // The flame holds the cold off in proportion to how big it is; an unlit
    // camp is the coldest place in the story.
    warmth -= weather.drain
    warmth += Math.min(flame, MAX_FLAME)

    // Wind takes the top off an exposed flame unless you are sheltering it.
    if (action !== 'shelter') flame = Math.max(0, flame - weather.gust)

    if (action === 'gather') {
      // Out in it: you find fuel and you pay for the walk.
      fuel += 2 + weather.gatherBonus
      warmth -= 4
      flame = Math.max(0, flame - 1)
    } else if (action === 'shelter') {
      // Hands around the flame. Nothing gained, little lost.
      warmth += 2
    } else if (action === 'tend') {
      // Feed it. The only way warmth goes up meaningfully, and the only
      // irreversible spend.
      if (fuel > 0) {
        fuel -= 1
        flame = Math.min(MAX_FLAME, flame + 2)
        warmth += 8
      } else {
        // Nothing to burn. The gesture costs the hour.
        warmth -= 2
      }
    } else {
      // rest — the do-nothing hour. Deliberately weak: an idle night has to end
      // badly, or the game has a null strategy and every other choice is noise.
      warmth += 2
      flame = Math.max(0, flame - 1)
    }

    // A fire left to itself sinks.
    if (action !== 'tend') flame = Math.max(0, flame - 0.5)

    warmth = Math.min(MAX_WARMTH, warmth)
    trace.push({
      hour: h,
      weather: sky[h],
      action: action,
      warmth: Math.round(warmth),
      fuel: fuel,
      flame: Math.round(flame * 10) / 10,
    })

    if (warmth <= 0) {
      return { hoursSurvived: h, survived: false, trace, sky, warmth: 0, fuel: fuel, flame: flame }
    }
  }

  return {
    hoursSurvived: HOURS,
    survived: true,
    trace,
    sky,
    warmth: Math.round(warmth),
    fuel: fuel,
    flame: flame,
  }
}

/**
 * What a night was worth.
 *
 * Hours dominate, because the game is called surviving. What is left at dawn is a
 * tie-break with teeth: two people who both saw the sun are separated by who
 * arrived there with something still burning, which is what stops "scrape through
 * on fumes" from being as good as "hold the line".
 */
export function scoreOf(result: NightResult): number {
  var points = result.hoursSurvived * 100
  if (result.survived) {
    points += 500
    points += result.warmth * 2
    points += result.fuel * 15
    points += Math.round(result.flame) * 40
  }
  return points
}
