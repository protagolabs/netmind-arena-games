/**
 * One sheet for the whole world.
 *
 * `style-src 'unsafe-inline'` is what makes this legal in the sandbox; no font is
 * fetched, `--db-font` is whatever Arena is already using around the frame. Two
 * families of variables carry everything: `--db-*`, rewritten on every
 * `onThemeChange`, and per-element `--h` / `--y` / `--dur`, so one rule serves
 * every bottle on the water.
 */
export const SHEET = `
.db {
  position: absolute; inset: 0; overflow: hidden;
  color: var(--db-fg); font-family: var(--db-font);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
.db-sea { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
/* keeps the chrome legible over whatever the water is doing under it */
.db-veil {
  position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(180deg, rgba(0,0,0,.42), transparent 22%),
    linear-gradient(0deg, rgba(0,0,0,.46), transparent 26%);
}
.db--light .db-veil {
  background:
    linear-gradient(180deg, rgba(10,30,45,.28), transparent 22%),
    linear-gradient(0deg, rgba(10,30,45,.34), transparent 26%);
}

/* ── chrome ───────────────────────────────────────────────────────── */

.db-head { position: absolute; top: 26px; left: 30px; max-width: 46vw; }
.db-head h1 {
  margin: 0; font-size: 26px; font-weight: 600; letter-spacing: .04em;
  color: #f4f7fb; text-shadow: 0 2px 14px rgba(0,0,0,.55);
}
.db-head p {
  margin: 7px 0 0; font-size: 13px; line-height: 1.6; color: rgba(238,246,255,.72);
  text-shadow: 0 1px 10px rgba(0,0,0,.5);
}

.db-corner {
  position: absolute; top: 26px; right: 30px;
  display: flex; flex-direction: column; align-items: flex-end; gap: 9px;
}
.db-count {
  font-size: 11.5px; letter-spacing: .09em; text-transform: uppercase;
  color: rgba(238,246,255,.66); text-shadow: 0 1px 10px rgba(0,0,0,.5);
  font-variant-numeric: tabular-nums;
}
.db-hint { font-size: 11px; color: rgba(238,246,255,.5); max-width: 200px; text-align: right; }

/* Dawn puts the chrome over a pale sky, where white-on-white stops being text. */
.db--light .db-head h1 { color: #0a2233; text-shadow: 0 1px 12px rgba(255,255,255,.5); }
.db--light .db-head p { color: rgba(12,40,58,.78); text-shadow: 0 1px 10px rgba(255,255,255,.45); }
.db--light .db-count { color: rgba(12,40,58,.72); text-shadow: 0 1px 10px rgba(255,255,255,.45); }
.db--light .db-hint { color: rgba(12,40,58,.6); }

.db-dock {
  position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center;
}

/* ── buttons ──────────────────────────────────────────────────────── */

.db-btn {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 11px 20px; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.22);
  background: rgba(9,22,36,.5); color: #eef5ff;
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  font: inherit; font-size: 13.5px; font-weight: 500; letter-spacing: .02em;
  box-shadow: 0 10px 30px rgba(0,0,0,.28);
  transition: background .18s, border-color .18s, transform .18s;
}
.db-btn:hover { background: rgba(15,38,60,.66); border-color: rgba(255,255,255,.4); transform: translateY(-1px); }
.db-btn:active { transform: translateY(0); }
.db-btn:disabled { opacity: .5; cursor: default; transform: none; }
.db-btn--primary {
  background: var(--db-accent); color: var(--db-accent-fg);
  border-color: transparent; font-weight: 600;
}
.db-btn--primary:hover { background: var(--db-accent); filter: brightness(1.08); }
.db-btn--ghost { padding: 8px 14px; font-size: 12.5px; background: transparent; box-shadow: none; }
/* The dock's buttons sit over deep water and are always light-on-dark. A panel's
   sit on a themed surface, so they follow the theme instead. */
.db-sheet .db-btn {
  background: var(--db-well); border-color: var(--db-edge); color: var(--db-fg); box-shadow: none;
}
.db-sheet .db-btn:hover { background: var(--db-well); border-color: color-mix(in srgb, var(--db-accent) 45%, var(--db-edge)); }
.db-sheet .db-btn--primary {
  background: var(--db-accent); color: var(--db-accent-fg); border-color: transparent;
}
.db-btn--icon { padding: 8px 13px; font-size: 12px; }
.db-btn:focus-visible { outline: 2px solid #cfe6ff; outline-offset: 2px; }

/* ── the fleet ────────────────────────────────────────────────────── */

.db-fleet { position: absolute; inset: 0; pointer-events: none; }
.db-bottle {
  position: absolute; left: 0; top: var(--y); width: 44px; height: 84px;
  pointer-events: auto; cursor: pointer; border: none; background: none; padding: 0;
  animation: db-drift var(--dur) linear infinite;
  animation-delay: var(--delay);
  will-change: transform;
}
.db-bottle-inner {
  display: block; width: 100%; height: 100%;
  animation: db-bob calc(2.6s + var(--wob)) ease-in-out infinite alternate;
  filter: drop-shadow(0 6px 12px rgba(0,0,0,.45));
  transition: filter .2s;
}
.db-bottle:hover .db-bottle-inner,
.db-bottle:focus-visible .db-bottle-inner {
  filter: drop-shadow(0 0 14px hsl(var(--h) 90% 70% / .9)) drop-shadow(0 6px 12px rgba(0,0,0,.45));
}
.db-bottle:focus-visible { outline: none; }
.db-bottle--new { animation: db-drift var(--dur) linear infinite, db-arrive .9s ease-out; }
/* A marker ring on the water under your own bottles, so you can pick them out of
   a sea that belongs to everyone. It does not bob with the glass — it is the
   waterline, not the bottle. */
.db-bottle--mine::after {
  content: ''; position: absolute; left: 50%; bottom: -7px; transform: translateX(-50%);
  width: 28px; height: 7px; border-radius: 50%;
  border: 1px solid rgba(226,240,255,.6); background: rgba(226,240,255,.12);
}
.db-bottle--mine .db-bottle-inner {
  filter: drop-shadow(0 0 9px hsl(var(--h) 90% 72% / .5)) drop-shadow(0 6px 12px rgba(0,0,0,.45));
}

@keyframes db-drift { from { transform: translateX(-12vw); } to { transform: translateX(112vw); } }
@keyframes db-bob { from { transform: translateY(-5px) rotate(-9deg); } to { transform: translateY(5px) rotate(9deg); } }
@keyframes db-arrive { from { opacity: 0; } to { opacity: 1; } }

.db-ripple {
  position: absolute; width: 18px; height: 18px; margin: -9px 0 0 -9px;
  border-radius: 50%; border: 1.5px solid rgba(210,236,255,.85);
  pointer-events: none; animation: db-ring 1.5s ease-out forwards;
}
@keyframes db-ring {
  from { transform: scale(.3); opacity: .9; }
  to { transform: scale(7) scaleY(.35); opacity: 0; }
}

/* ── panels ───────────────────────────────────────────────────────── */

.db-scrim {
  position: absolute; inset: 0; display: grid; place-items: center; padding: 24px;
  background: rgba(3,10,18,.5); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  animation: db-fade .22s ease-out;
  overflow-y: auto;
}
/* \`display: grid\` above outranks the UA's \`[hidden] { display: none }\`, and a
   scrim that is only invisible still blurs the whole sea behind it. */
.db-scrim[hidden] { display: none; }
@keyframes db-fade { from { opacity: 0; } to { opacity: 1; } }
.db-sheet {
  width: min(470px, 100%); box-sizing: border-box;
  padding: 22px 22px 20px; border-radius: 20px;
  border: 1px solid var(--db-edge);
  background: var(--db-glass);
  backdrop-filter: blur(22px) saturate(1.2); -webkit-backdrop-filter: blur(22px) saturate(1.2);
  box-shadow: 0 26px 70px rgba(0,0,0,.45);
  animation: db-rise .28s cubic-bezier(.2,.9,.3,1);
  user-select: text;
}
@keyframes db-rise { from { transform: translateY(14px); opacity: 0; } to { transform: none; opacity: 1; } }
.db-sheet h2 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .02em; }
.db-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.db-note { margin: 0; font-size: 12px; line-height: 1.6; color: var(--db-subtle); }
.db-x {
  flex: none; width: 28px; height: 28px; border-radius: 50%; cursor: pointer;
  border: 1px solid var(--db-edge); background: transparent; color: var(--db-subtle);
  font: inherit; font-size: 15px; line-height: 1;
}
.db-x:hover { color: var(--db-fg); }

/* the message itself: paper, in either theme — a letter is not a UI surface */
.db-paper {
  position: relative; padding: 18px 18px 16px; border-radius: 10px;
  background:
    repeating-linear-gradient(180deg, transparent 0 26px, rgba(120,96,60,.13) 26px 27px),
    linear-gradient(150deg, #fbf2dd, #f2e4c6);
  color: #3b3021; box-shadow: inset 0 0 40px rgba(150,120,70,.18), 0 6px 20px rgba(0,0,0,.25);
  font-size: 15px; line-height: 27px; white-space: pre-wrap; word-break: break-word;
}
.db-paper--mine { background: linear-gradient(150deg, #f6f0e2, #ece2cc); }

.db-byline { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 12px; color: var(--db-subtle); }
.db-face {
  --size: 24px; --h: 200;
  position: relative; flex: none; box-sizing: border-box;
  width: var(--size); height: var(--size); border-radius: 999px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: hsl(var(--h) 40% var(--db-wash)); color: hsl(var(--h) 55% var(--db-ink));
  font-size: calc(var(--size) * .4); font-weight: 600; line-height: 1;
  box-shadow: inset 0 0 0 1px var(--db-edge);
}
.db-face--agent { border-radius: calc(var(--size) * .3); }
.db-face img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.db-tag {
  flex: none; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--db-edge);
  color: var(--db-subtle); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase;
}
.db-dot { color: var(--db-subtle); }

/* mood chips */
.db-moods { display: flex; flex-wrap: wrap; gap: 7px; margin: 4px 0 12px; }
.db-mood {
  --h: 200;
  padding: 6px 13px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 12.5px;
  border: 1px solid var(--db-edge); background: transparent; color: var(--db-subtle);
  transition: color .16s, border-color .16s, background .16s;
}
.db-mood:hover { color: var(--db-fg); }
.db-mood[aria-pressed='true'] {
  color: hsl(var(--h) 70% var(--db-ink));
  border-color: hsl(var(--h) 60% 55% / .6);
  background: hsl(var(--h) 60% 50% / .14);
}

.db-input {
  width: 100%; box-sizing: border-box; resize: none; display: block;
  padding: 13px 14px; border-radius: 12px;
  border: 1px solid var(--db-edge); background: var(--db-well); color: var(--db-fg);
  font: inherit; font-size: 14px; line-height: 1.65;
}
.db-input::placeholder { color: var(--db-subtle); }
.db-input:focus { outline: none; border-color: color-mix(in srgb, var(--db-accent) 65%, transparent); }
.db-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.db-meta { font-size: 11.5px; color: var(--db-subtle); font-variant-numeric: tabular-nums; }
.db-meta--full { color: var(--db-accent); }
.db-status { min-height: 17px; margin-top: 10px; font-size: 12px; color: var(--db-subtle); }

/* replies, and the shelf of your own bottles */
.db-list { display: grid; gap: 9px; margin-top: 14px; max-height: 40vh; overflow-y: auto; }
.db-item {
  display: flex; gap: 10px; align-items: flex-start; width: 100%; box-sizing: border-box;
  padding: 11px 13px; border-radius: 12px; text-align: left;
  border: 1px solid var(--db-edge); background: var(--db-well); color: var(--db-fg);
  font: inherit; font-size: 13px; line-height: 1.6;
}
button.db-item { cursor: pointer; transition: border-color .16s, background .16s; }
button.db-item:hover { border-color: color-mix(in srgb, var(--db-accent) 45%, var(--db-edge)); }
.db-item-body { min-width: 0; flex: 1; }
.db-item-text { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.db-item-sub { margin-top: 4px; font-size: 11px; color: var(--db-subtle); }
.db-rail { flex: none; width: 3px; align-self: stretch; border-radius: 2px; background: hsl(var(--h) 60% 58%); }
.db-empty { padding: 16px; border: 1px dashed var(--db-edge); border-radius: 12px; font-size: 12.5px; color: var(--db-subtle); }

.db-toast {
  position: absolute; left: 50%; bottom: 106px; transform: translateX(-50%);
  padding: 9px 17px; border-radius: 999px; font-size: 12.5px; white-space: nowrap;
  border: 1px solid rgba(255,255,255,.2); background: rgba(9,22,36,.72); color: #eef5ff;
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  animation: db-toast 3.4s ease-out forwards; pointer-events: none;
}
@keyframes db-toast {
  0% { opacity: 0; transform: translate(-50%, 8px); }
  10%, 78% { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, -6px); }
}

@media (max-width: 620px) {
  .db-head { top: 18px; left: 18px; max-width: 62vw; }
  .db-head h1 { font-size: 21px; }
  .db-head p { display: none; }
  .db-corner { top: 18px; right: 18px; }
  .db-dock { bottom: 22px; gap: 8px; }
  .db-btn { padding: 10px 15px; font-size: 12.5px; }
}
@media (prefers-reduced-motion: reduce) {
  .db-bottle, .db-bottle-inner, .db-ripple, .db-sheet, .db-scrim, .db-toast { animation: none; }
  .db-bottle { transform: translateX(var(--static-x)); }
  .db-ripple { display: none; }
  .db-btn:hover { transform: none; }
}
`
