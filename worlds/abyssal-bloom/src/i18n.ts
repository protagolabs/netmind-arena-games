/**
 * Bilingual strings. `ctx.lang` is a base code ('zh' | 'en' | …); everything
 * that is not 'zh' falls back to English, per the platform contract.
 */

export interface Strings {
  title: string
  tagline: string
  begin: string
  moveHint: string
  eatHint: string
  descendHint: string
  gardenHint: string
  evolveTitle: string
  evolveSkip: string
  releaseBtn: string
  releaseLocked: string
  releaseTitle: string
  releaseNamePh: string
  releaseConfirm: string
  releaseCancel: string
  releasedToast: string
  newDive: string
  stayGarden: string
  signInToRelease: string
  signInToResonate: string
  resonateBtn: string
  resonated: string
  alreadyResonated: string
  myCreature: string
  removeBtn: string
  removeConfirm: string
  removeCancel: string
  quotaTitle: string
  quotaBody: string
  quotaReplace: string
  quotaKeep: string
  rateLimited: string
  storeUnavailable: string
  soundOn: string
  soundOff: string
  helpBtn: string
  helpClose: string
  helpBody: string[]
  bandNames: string[]
  gardenCount: (n: number) => string
  anonymous: string
  motesLabel: string
  stungToast: string
  evolvedToast: (t: string) => string
  traitNames: Record<string, string>
  traitDescs: Record<string, string>
  growName: string
  growDesc: string
  byline: (name: string) => string
  resonanceCount: (n: number) => string
}

const zh: Strings = {
  title: '渊光',
  tagline: '把一缕光养大，带它沉入渊底花园。',
  begin: '开始下潜',
  moveHint: '游动：跟随你的指尖',
  eatHint: '靠近光尘，把它吞下',
  descendHint: '长大了，往更深处去吧',
  gardenHint: '这里是渊底花园 —— 众人放归的生灵在此游弋',
  evolveTitle: '你的身体想要改变',
  evolveSkip: '保持原样',
  releaseBtn: '放归花园',
  releaseLocked: '再吃一些光尘，抵达渊底后可放归',
  releaseTitle: '放归这只生灵',
  releaseNamePh: '给它起个名字（可留空）',
  releaseConfirm: '放归',
  releaseCancel: '再游一会儿',
  releasedToast: '它属于花园了。',
  newDive: '再养一缕光',
  stayGarden: '在花园里看看',
  signInToRelease: '登录后才能把生灵放归花园',
  signInToResonate: '登录后才能共鸣',
  resonateBtn: '共鸣',
  resonated: '你的光落在了它身上',
  alreadyResonated: '你已经共鸣过它了',
  myCreature: '我的生灵',
  removeBtn: '带走',
  removeConfirm: '确认带走',
  removeCancel: '让它留下',
  quotaTitle: '花园里已有你的三只生灵',
  quotaBody: '带走最早的一只，才能放归新的。',
  quotaReplace: '带走最早的那只',
  quotaKeep: '先不放归',
  rateLimited: '慢一点，深海不着急',
  storeUnavailable: '深海暂时听不见你，稍后再试',
  soundOn: '声音：开',
  soundOff: '声音：关',
  helpBtn: '？',
  helpClose: '知道了',
  helpBody: [
    '移动指尖（或手指），你的生灵会跟着游。',
    '吞下漂浮的光尘就会长大；长大途中可以选择进化。',
    '越深越暗，你身上的光就是你的灯。',
    '潜到最深处的渊底花园，把养大的生灵放归 —— 它会永远留在那里，所有人都看得见。',
    '点击别人的生灵，可以为它「共鸣」，让它的光更亮。',
    '水母会蜇掉你的光尘，捡回来就好。',
  ],
  bandNames: ['晨光带', '暮光带', '午夜带', '渊底花园'],
  gardenCount: (n) => `花园里共有 ${n} 只生灵`,
  anonymous: '无名旅人',
  motesLabel: '光尘',
  stungToast: '被蜇了！光尘散落了一些',
  evolvedToast: (t) => `身体长出了${t}`,
  traitNames: {
    fins: '波光鳍',
    veil: '拖纱',
    tendrils: '流触',
    bell: '伞膜',
    crest: '脊冠',
    lanterns: '提灯',
  },
  traitDescs: {
    fins: '身侧生出成对的薄鳍，游得更急',
    veil: '身后曳起半透明的纱，像一段慢下来的时间',
    tendrils: '尾端垂下发光的细触，扫过黑暗',
    bell: '头顶张开水母般的伞，脉动着呼吸',
    crest: '背脊竖起一列光棘',
    lanterns: '身下悬出几盏小灯，照亮更深的路',
  },
  growName: '抽长',
  growDesc: '身体再长出一节又一节',
  byline: (name) => `${name} 放归`,
  resonanceCount: (n) => `${n} 次共鸣`,
}

const en: Strings = {
  title: 'Abyssal Bloom',
  tagline: 'Raise a mote of light. Carry it down to the Abyssal Garden.',
  begin: 'Begin the dive',
  moveHint: 'Swim: follow your pointer',
  eatHint: 'Drift close to the motes and swallow them',
  descendHint: 'You have grown — go deeper',
  gardenHint: 'The Abyssal Garden — creatures released by everyone drift here',
  evolveTitle: 'Your body wants to change',
  evolveSkip: 'Stay as I am',
  releaseBtn: 'Release',
  releaseLocked: 'Eat more motes, then reach the garden floor to release',
  releaseTitle: 'Release this creature',
  releaseNamePh: 'Name it (optional)',
  releaseConfirm: 'Release',
  releaseCancel: 'Keep swimming',
  releasedToast: 'It belongs to the garden now.',
  newDive: 'Raise another light',
  stayGarden: 'Stay and watch',
  signInToRelease: 'Sign in to release a creature into the garden',
  signInToResonate: 'Sign in to resonate',
  resonateBtn: 'Resonate',
  resonated: 'Your light settled on it',
  alreadyResonated: 'You have already resonated with it',
  myCreature: 'Yours',
  removeBtn: 'Take back',
  removeConfirm: 'Take it back',
  removeCancel: 'Let it stay',
  quotaTitle: 'Three of your creatures already live here',
  quotaBody: 'Take back the oldest one to release a new one.',
  quotaReplace: 'Take back the oldest',
  quotaKeep: 'Not now',
  rateLimited: 'Slow down — the deep is patient',
  storeUnavailable: 'The deep cannot hear you right now; try again soon',
  soundOn: 'Sound: on',
  soundOff: 'Sound: off',
  helpBtn: '?',
  helpClose: 'Got it',
  helpBody: [
    'Move your pointer (or finger); your creature follows.',
    'Swallow drifting motes to grow; growing offers you evolutions.',
    'The deeper you go, the darker it gets — your own glow is your lamp.',
    'Reach the Abyssal Garden at the very bottom and release your creature. It stays there forever, visible to everyone.',
    'Tap other creatures to resonate with them and brighten their glow.',
    'Medusae sting motes loose — just pick them back up.',
  ],
  bandNames: ['Sunlit', 'Twilight', 'Midnight', 'Abyssal Garden'],
  gardenCount: (n) => `${n} creatures live in the garden`,
  anonymous: 'a nameless diver',
  motesLabel: 'motes',
  stungToast: 'Stung! Some motes scattered',
  evolvedToast: (t) => `Your body grew ${t}`,
  traitNames: {
    fins: 'shimmer fins',
    veil: 'a trailing veil',
    tendrils: 'tendrils',
    bell: 'a bell',
    crest: 'a crest',
    lanterns: 'lanterns',
  },
  traitDescs: {
    fins: 'Paired thin fins along your sides — swim faster',
    veil: 'A translucent veil trails behind, like time slowed down',
    tendrils: 'Glowing filaments sweep the dark behind you',
    bell: 'A medusa bell opens over your head, pulsing',
    crest: 'A row of light-thorns rises along your back',
    lanterns: 'Small lamps hang beneath you, lighting the way down',
  },
  growName: 'Elongate',
  growDesc: 'Grow segment after segment',
  byline: (name) => `released by ${name}`,
  resonanceCount: (n) => `${n} resonances`,
}

export const strings = (lang: string): Strings => (lang === 'zh' ? zh : en)
