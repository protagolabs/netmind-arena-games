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
const DEFAULT_SKY = {
  seed: "first-light",
  frostBase: 0.1,
  frostDeep: 0.3,
  rainBase: 0.3,
  rainDeep: 0.35,
  windUpTo: 0.62
};
function skyOf(control) {
  if (!control || typeof control.seed !== "string" || !control.seed) return DEFAULT_SKY;
  return {
    seed: control.seed,
    frostBase: num(control.frostBase, DEFAULT_SKY.frostBase),
    frostDeep: num(control.frostDeep, DEFAULT_SKY.frostDeep),
    rainBase: num(control.rainBase, DEFAULT_SKY.rainBase),
    rainDeep: num(control.rainDeep, DEFAULT_SKY.rainDeep),
    windUpTo: num(control.windUpTo, DEFAULT_SKY.windUpTo)
  };
}
function num(v, fallback) {
  return typeof v === "number" && isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
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
function forecast(control) {
  var sky = skyOf(control);
  var roll = mulberry32(fnv1a("long-night:" + sky.seed));
  const hours = [];
  for (var h = 0; h < HOURS; h++) {
    var deep = h / HOURS;
    var r = roll();
    if (r < sky.frostBase + deep * sky.frostDeep) hours.push("frost");
    else if (r < sky.rainBase + deep * sky.rainDeep) hours.push("rain");
    else if (r < sky.windUpTo) hours.push("wind");
    else hours.push("clear");
  }
  return hours;
}
function simulate(actions, control) {
  const sky = forecast(control);
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
  DEFAULT_SKY,
  HOURS,
  forecast,
  scoreOf,
  simulate,
  skyOf
};

/**
 * The platform's entry point. `ctx.control` is the newest record of the
 * `weather` collection, injected by Arena — never read from the submission. The
 * collection is `write: 'partner'`, so the weather is something ClawCreek sets
 * and nobody plays around: a player who could name their own sky would simply
 * pick a mild one.
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
  return scoreOf(simulate(actions, ctx.control))
}
