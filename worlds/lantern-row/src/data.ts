/**
 * The street: which plots exist, in what order, and what lives on each.
 *
 * Live stalls are BAKED IN rather than stored — a stall is an editorial,
 * reviewed decision (it advertises another world), so it changes by PR, the
 * same gate every world already passes through. Records hold only what
 * visitors add on top: lamps (per-stall appreciation) and intent lanterns
 * (leads on the empty plots).
 */
export type ScreenKey =
  | 'peaks'
  | 'isles'
  | 'drift'
  | 'abyss'
  | 'atlas'
  | 'predict'
  | 'guest'
  | 'bounce'

export type PlotKind = 'live' | 'demo' | 'empty' | 'ghost'

export interface StallDef {
  id: string
  kind: PlotKind
  nameZh: string
  nameEn: string
  /** Small caption under/beside the name on cards. */
  caption: string
  tagZh: string
  tagEn: string
  color: string
  screen: ScreenKey
  /** Human-readable home path, shown as text (the sandbox cannot navigate). */
  path: string
}

export interface WishView {
  id: string
  name: string
  note: string
  mine: boolean
}

export interface PreviewData {
  name: string
  tag: string
  color: string
}

/** Runtime state layered over a definition; one per plot on the street. */
export interface Plot extends StallDef {
  x: number
  seed: number
  heat: number
  flash: number
  lamps: number
  myLamp: boolean
  wishes: WishView[]
  myWishId: string | null
  preview: PreviewData | null
  /** Staged build-up animation for a fresh preview booth; 1 = fully built. */
  buildT: number
}

export const PLOT_W = 250
export const STEP = 360
export const PLOT0 = 820
export const GATE_X = 300
export const BOARD_X = 620

const def = (d: StallDef) => d
const empty = (id: string): StallDef =>
  def({ id, kind: 'empty', nameZh: '', nameEn: '', caption: '', tagZh: '', tagEn: '', color: '#8a7a5a', screen: 'bounce', path: '' })

/** Every stall advertises a real, live world from this repo's registry. */
export const STREET: StallDef[] = [
  def({
    id: 'peaks-beyond', kind: 'demo',
    nameZh: '山外山', nameEn: 'Peaks Beyond', caption: 'PEAKS BEYOND',
    tagZh: '跳一跳式共修山径 · 示范摊', tagEn: 'Hop-by-hop communal ridge · showcase stall',
    color: '#5a8fd4', screen: 'peaks', path: 'arena42.ai/worlds/peaks-beyond',
  }),
  def({
    id: 'myriad-isles', kind: 'live',
    nameZh: '千屿', nameEn: 'Myriad Isles', caption: 'MYRIAD ISLES',
    tagZh: '建岛策略 · 千屿之海', tagEn: 'Island-building strategy · a sea of isles',
    color: '#4bbd82', screen: 'isles', path: 'arena42.ai/worlds/myriad-isles',
  }),
  def({
    id: 'drift-bottle', kind: 'live',
    nameZh: '漂流瓶', nameEn: 'Drift Bottle', caption: 'DRIFT BOTTLE',
    tagZh: '把心事装进瓶子,交给海流', tagEn: 'Seal a thought in a bottle, trust the current',
    color: '#4aa8c0', screen: 'drift', path: 'arena42.ai/worlds/drift-bottle',
  }),
  empty('e1'),
  def({
    id: 'abyssal-bloom', kind: 'live',
    nameZh: '渊光', nameEn: 'Abyssal Bloom', caption: 'ABYSSAL BLOOM',
    tagZh: '深海养成 · 共创花园', tagEn: 'Deep-sea raising · a garden made together',
    color: '#9a74d8', screen: 'abyss', path: 'arena42.ai/worlds/abyssal-bloom',
  }),
  def({
    id: 'celestial-atlas', kind: 'live',
    nameZh: '星图', nameEn: 'Celestial Atlas', caption: 'CELESTIAL ATLAS',
    tagZh: '共绘星球 · 点灯相认', tagEn: 'Draw planets together, light lamps to greet',
    color: '#7a8ae0', screen: 'atlas', path: 'arena42.ai/worlds/celestial-atlas',
  }),
  def({ id: 'you', kind: 'ghost', nameZh: '', nameEn: '', caption: 'YOUR BOOTH', tagZh: '', tagEn: '', color: '#55c8d8', screen: 'bounce', path: '' }),
  def({
    id: 'predictmy', kind: 'live',
    nameZh: 'PredictMy', nameEn: 'PredictMy', caption: 'WORLD CUP AI',
    tagZh: '足球战术预测 · AI 教练', tagEn: 'Football tactics prediction · AI coach',
    color: '#4bb86a', screen: 'predict', path: 'arena42.ai/worlds/predictmy',
  }),
  def({
    id: 'guestbook', kind: 'live',
    nameZh: '留言簿', nameEn: 'Guestbook', caption: 'GUESTBOOK',
    tagZh: '到此一游,落笔为记', tagEn: 'You were here — leave a line',
    color: '#c8a05a', screen: 'guest', path: 'arena42.ai/worlds/guestbook',
  }),
  empty('e2'),
]

export function makePlots(): Plot[] {
  return STREET.map((d, i) => ({
    ...d,
    x: PLOT0 + i * STEP,
    seed: i * 7 + 3,
    heat: 6,
    flash: 0,
    lamps: 0,
    myLamp: false,
    wishes: [],
    myWishId: null,
    preview: null,
    buildT: 1,
  }))
}

export const WORLD_W = PLOT0 + STREET.length * STEP + 240
