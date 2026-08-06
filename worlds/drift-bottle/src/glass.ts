/**
 * The glassware.
 *
 * Five silhouettes rather than one, because a sea of identical bottles reads as
 * a repeated sprite instead of as things different people threw in. Colour is
 * still the mood (`--h` on the host element, so one CSS variable repaints the
 * whole bottle); the shape is drawn from the record id instead, which means a
 * bottle keeps its own body across reloads and across visitors.
 *
 * Every shape shares the 44×84 box and bottoms out at y=81, so they sit on the
 * same waterline and the "this one is yours" ring lands under all of them.
 */
interface Silhouette {
  /** The glass outline, filled translucent and stroked bright. */
  body: string
  /** Cork markup — geometry follows each neck, so it cannot be shared. */
  cork: string
  /** Rolled note: `[x, y, width]`, drawn as two stacked bands. */
  paper: [number, number, number][]
  /** One highlight down the shoulder. */
  shine: string
}

const SHAPES: Silhouette[] = [
  // Long-neck: the ordinary message bottle.
  {
    body: 'M18 9h8v10c0 4.5 7.5 8.5 7.5 17.5V71a10 10 0 0 1-10 10h-3a10 10 0 0 1-10-10V36.5C10.5 27.5 18 23.5 18 19V9Z',
    cork: plug(17, 1, 10, 9),
    paper: [
      [16, 45, 12],
      [16, 54, 12],
    ],
    shine: 'M20.5 22c-2.5 4-5.5 7-5.5 15v33',
  },
  // Demijohn: a throat straight onto a round belly, twine over the cork. The
  // belly is a true circle rather than an egg — an egg on a stem reads as a
  // lute, which is a mistake this shape made until it was drawn round.
  {
    body: 'M17 18h10v21.6a21 21 0 1 1-10 0V18Z',
    cork: plug(16, 11, 12, 8) + twine(17.5, 21, 9),
    paper: [
      [13, 56, 18],
      [13, 65, 18],
    ],
    shine: 'M20 46c-6 3-10 8-10 15v9',
  },
  // Apothecary jar: the fattest of them, nearly as wide as the box.
  {
    body: 'M18 10h8v14c0 4 13 6 13 16v33a8 8 0 0 1-8 8H13a8 8 0 0 1-8-8V40c0-10 13-12 13-16V10Z',
    cork: plug(17, 2, 10, 9),
    paper: [
      [14, 52, 16],
      [14, 61, 16],
    ],
    shine: 'M20 27c-6 3-11 6-11 15v33',
  },
  // Square-shouldered medicine bottle — the only one with a corner in it.
  {
    body: 'M19 6h6v14h4a3 3 0 0 1 3 3v55a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V23a3 3 0 0 1 3-3h4V6Z',
    cork: plug(18, -1, 8, 8),
    paper: [
      [15, 48, 14],
      [15, 57, 14],
    ],
    shine: 'M21 24c-4 1-6 2-6 6v45',
  },
  // Tall slim vial — barely wider than its own neck.
  {
    body: 'M19 4h6v18c0 3.5 5.5 5 5.5 11v44a4 4 0 0 1-4 4h-9a4 4 0 0 1-4-4V33c0-6 5.5-7.5 5.5-11V4Z',
    cork: plug(18, -1, 8, 7),
    paper: [
      [16, 51, 12],
      [16, 60, 12],
    ],
    shine: 'M21 25c-3 3-5.5 5-5.5 11v38',
  },
  // Carafe: no shoulder at all, just a straight taper to a wide flat base.
  {
    body: 'M19 6h6v20l13 50a4 4 0 0 1-4 5H10a4 4 0 0 1-4-5l13-50V6Z',
    cork: plug(18, -1, 8, 8),
    paper: [
      [13, 58, 18],
      [13, 67, 18],
    ],
    shine: 'M21 29 12 62v14',
  },
]

/** A cork, lighter across its top face where the light lands. */
function plug(x: number, y: number, w: number, h: number): string {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2.5" fill="#c9a06a"/>` +
    `<rect x="${x}" y="${y}" width="${w}" height="3" rx="1.5" fill="#e0bd8b"/>`
  )
}

/** Twine over the cork, for the two shapes that want to look older. */
function twine(x: number, y: number, w: number): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="1.6" rx=".8" fill="#8d6b45"/>`
}

/**
 * Draw the bottle for a record.
 *
 * `id` picks the silhouette and nothing else — the platform assigns it once, so
 * the choice is stable without storing a shape in the payload, and a payload
 * field would have been a shape everyone's renderer had to keep supporting.
 */
export function bottleSvg(id: string): string {
  const s = SHAPES[hash(id) % SHAPES.length]
  const paper = s.paper
    .map(([x, y, w], i) => `<rect x="${x}" y="${y}" width="${w}" height="6" rx="3" fill="${i % 2 ? '#efe0c0' : '#f6ecd4'}"/>`)
    .join('')

  // Body twice: once as glass over the note, once as the rim on top of it, so
  // the paper reads as being *inside* rather than pasted on the front.
  return (
    `<svg class="db-bottle-inner" viewBox="0 0 44 84" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    s.cork +
    `<path d="${s.body}" fill="hsl(var(--h) 55% 62% / .34)"/>` +
    paper +
    `<path d="${s.body}" stroke="hsl(var(--h) 75% 78% / .75)" stroke-width="1.4"/>` +
    `<path d="${s.shine}" stroke="#ffffff" stroke-opacity=".45" stroke-width="2" stroke-linecap="round"/>` +
    `</svg>`
  )
}

function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 9973
  return h
}
