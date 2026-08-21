// GENERATED from src/rules.ts by tools/build-scorer.mjs — do not edit.
// Regenerate with: node tools/build-scorer.mjs

const HOURS = 24;
const START = { warmth: 60, fuel: 8, flame: 3 };
const MAX_WARMTH = 100;
const MAX_FLAME = 6;
const ACTIONS = ["gather", "shelter", "tend", "rest"];
const WEATHER = {
  clear: { drain: 5, gust: 0, gatherBonus: 2 },
  wind: { drain: 8, gust: 2, gatherBonus: 1 },
  rain: { drain: 11, gust: 1, gatherBonus: 0 },
  frost: { drain: 17, gust: 0, gatherBonus: 0 }
};
function fnv1a(text) {
  var h = 2166136261;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  var a = seed >>> 0;
  return function() {
    a |= 0;
    a = a + 1831565813 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function forecast(seasonKey) {
  var roll = mulberry32(fnv1a("long-night:" + seasonKey));
  const hours = [];
  for (var h = 0; h < HOURS; h++) {
    var deep = h / HOURS;
    var r = roll();
    if (r < 0.1 + deep * 0.3) hours.push("frost");
    else if (r < 0.3 + deep * 0.35) hours.push("rain");
    else if (r < 0.62) hours.push("wind");
    else hours.push("clear");
  }
  return hours;
}
function simulate(actions, seasonKey) {
  const sky = forecast(seasonKey);
  var warmth = START.warmth;
  var fuel = START.fuel;
  var flame = START.flame;
  const trace = [];
  for (var h = 0; h < HOURS; h++) {
    const weather = WEATHER[sky[h]];
    const action = actions[h] ?? "rest";
    warmth -= weather.drain;
    warmth += Math.min(flame, MAX_FLAME);
    if (action !== "shelter") flame = Math.max(0, flame - weather.gust);
    if (action === "gather") {
      fuel += 2 + weather.gatherBonus;
      warmth -= 4;
      flame = Math.max(0, flame - 1);
    } else if (action === "shelter") {
      warmth += 2;
    } else if (action === "tend") {
      if (fuel > 0) {
        fuel -= 1;
        flame = Math.min(MAX_FLAME, flame + 2);
        warmth += 8;
      } else {
        warmth -= 2;
      }
    } else {
      warmth += 2;
      flame = Math.max(0, flame - 1);
    }
    if (action !== "tend") flame = Math.max(0, flame - 0.5);
    warmth = Math.min(MAX_WARMTH, warmth);
    trace.push({
      hour: h,
      weather: sky[h],
      action,
      warmth: Math.round(warmth),
      fuel,
      flame: Math.round(flame * 10) / 10
    });
    if (warmth <= 0) {
      return { hoursSurvived: h, survived: false, trace, sky, warmth: 0, fuel, flame };
    }
  }
  return {
    hoursSurvived: HOURS,
    survived: true,
    trace,
    sky,
    warmth: Math.round(warmth),
    fuel,
    flame
  };
}
function scoreOf(result) {
  var points = result.hoursSurvived * 100;
  if (result.survived) {
    points += 500;
    points += result.warmth * 2;
    points += result.fuel * 15;
    points += Math.round(result.flame) * 40;
  }
  return points;
}
{
  ACTIONS,
  HOURS,
  forecast,
  scoreOf,
  simulate
};

/**
 * The platform's entry point. `ctx.seasonKey` is injected by Arena from the
 * open season, never read from the submission — the weather is shared, and a
 * player who could name their own season could shop for a mild night.
 */
function score(submission, ctx) {
  const actions = (submission && submission.actions) || []
  if (!Array.isArray(actions)) ctx.reject('actions must be an array')
  if (actions.length > HOURS) ctx.reject('a night is ' + HOURS + ' hours; got ' + actions.length)
  for (let i = 0; i < actions.length; i++) {
    if (ACTIONS.indexOf(actions[i]) === -1) {
      ctx.reject('hour ' + i + ': "' + actions[i] + '" is not one of ' + ACTIONS.join(', '))
    }
  }
  return scoreOf(simulate(actions, ctx.seasonKey || 'open'))
}
