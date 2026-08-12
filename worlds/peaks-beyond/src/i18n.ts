/**
 * Bilingual strings. `ctx.lang` is a base code ('zh' | 'en' | …); anything
 * that is not 'zh' falls back to English, per the platform contract.
 */

export interface Strings {
  title: string
  w1: string
  w2: string
  w3: string
  begin: string
  how: string
  sound: string
  arc: string
  restart: string
  close: string
  alt: string
  stoneN: (i: number, n: number) => string
  placedN: (n: number) => string
  perfect: string
  comboX: (n: number) => string
  falls: string
  wind: string
  toPav: (n: number) => string
  trail: string
  fallNote: string
  frontierHint: string
  placedToast: string
  m1Note: string
  you: string
  pav: string[]
  rules: string[]
  commStones: (n: number) => string
  todayDone: string
  signInToPlace: string
  stoneSaved: string
  stoneSaveFail: string
  alreadyToday: string
  quotaFull: string
  slowDown: string
  markTitle: string
  markPh: string
  markSave: string
  markSkip: string
  bellHang: string
  bellTake: string
  bellDup: string
  bellQuota: string
  bellDone: string
  bellBack: string
  signInToBell: string
}

const zh: Strings = {
  title: '山外山',
  w1: '长按蓄力，松手起跳',
  w2: '路的尽头，落脚的地方会生出你的石头',
  w3: '摔进云海不算失败，云会把你送回起跳的石头',
  begin: '上路',
  how: '玩法',
  sound: '铃声',
  arc: '落点预判',
  restart: '从山脚重走',
  close: '收起',
  alt: '海拔',
  stoneN: (i, n) => `第 ${i} / ${n} 块`,
  placedN: (n) => `你放了 ${n} 块`,
  perfect: '完美',
  comboX: (n) => ` · 连击 ×${n}`,
  falls: '跌落',
  wind: '今日风',
  toPav: (n) => ` · 距下一亭 ${n} 块`,
  trail: ' · 你在开路',
  fallNote: '摔落回到起跳的石头',
  frontierHint: '路到这儿了，往雾里跳',
  placedToast: '石头落成',
  m1Note: '每人每天一块石 · 石头会留在山上给所有人',
  you: '你',
  pav: ['初亭', '云亭', '风亭'],
  commStones: (n) => `共修 ${n} 石`,
  todayDone: '今日的石已放下 · 明天再来',
  signInToPlace: '登录后落脚才会留下石头',
  stoneSaved: '石头留在了山上',
  stoneSaveFail: '这块石没能立住（稍后再试）',
  alreadyToday: '今天已经放过一块石了',
  quotaFull: '山上的石头满了，等平台清点',
  slowDown: '慢一点，风太急',
  markTitle: '给这块石刻一句话（可跳过）',
  markPh: '至多 14 字',
  markSave: '刻上',
  markSkip: '不刻了',
  bellHang: '挂风铃',
  bellTake: '取回风铃',
  bellDup: '你在这块石上已挂过铃',
  bellQuota: '12 枚风铃都挂出去了，先取回一枚',
  bellDone: '风铃挂上了',
  bellBack: '风铃收回了',
  signInToBell: '登录后才能挂风铃',
  rules: [
    '长按蓄力，松手起跳；蓄得越久跳得越远。',
    '落在石头正中算完美，连续完美有连击。',
    '差一点会扒住石缘爬上来，只断连击不摔落。',
    '摔进云海由云接住，送回起跳的石头。',
    '走到路的尽头往雾里跳，落脚处会生出你的石头。',
    '正式版每人每天一块石；太宽的深谷要多人接力搭桥。',
    '亭子是公共检查点，路修到哪就对所有人开到哪。',
  ],
}

const en: Strings = {
  title: 'Peaks Beyond',
  w1: 'Hold to charge, release to leap',
  w2: 'At the path’s end, a stone is born where you land',
  w3: 'Falling is safe — the cloud sea carries you back',
  begin: 'Set out',
  how: 'How to play',
  sound: 'Bells',
  arc: 'Landing preview',
  restart: 'From the foothills',
  close: 'Close',
  alt: 'Alt.',
  stoneN: (i, n) => `stone ${i} / ${n}`,
  placedN: (n) => `you placed ${n}`,
  perfect: 'perfect',
  comboX: (n) => ` · combo ×${n}`,
  falls: 'falls',
  wind: 'wind',
  toPav: (n) => ` · pavilion in ${n}`,
  trail: ' · you are pathfinding',
  fallNote: 'falls return you to your last stone',
  frontierHint: 'the path ends here — leap into the mist',
  placedToast: 'your stone is set',
  m1Note: 'one stone per person per day · stones stay on the mountain for everyone',
  you: 'you',
  pav: ['First Rest', 'Cloud Rest', 'Wind Rest'],
  commStones: (n) => `${n} stones together`,
  todayDone: 'today’s stone is placed · return tomorrow',
  signInToPlace: 'sign in and your landing will leave a stone',
  stoneSaved: 'your stone rests on the mountain',
  stoneSaveFail: 'the stone did not hold (try again soon)',
  alreadyToday: 'you already placed a stone today',
  quotaFull: 'the mountain is full of stones — the platform will tidy up',
  slowDown: 'easy — the wind is too sharp',
  markTitle: 'Carve a line on this stone (optional)',
  markPh: 'up to 14 chars',
  markSave: 'Carve',
  markSkip: 'Skip',
  bellHang: 'Hang a bell',
  bellTake: 'Take bell back',
  bellDup: 'your bell already hangs on this stone',
  bellQuota: 'all 12 bells are out — take one back first',
  bellDone: 'the bell is hung',
  bellBack: 'the bell is back in your pack',
  signInToBell: 'sign in to hang a bell',
  rules: [
    'Hold to charge, release to leap; longer holds jump farther.',
    'Landing dead-center is a perfect; chains build a combo.',
    'Barely missing grabs the edge — you climb up, only the combo breaks.',
    'Fall and the cloud sea catches you, returning you to your last stone.',
    'At the path’s end, leap into the mist — a stone is born where you land.',
    'In the live build: one stone per person per day; wide chasms take relays.',
    'Pavilions are communal checkpoints — the path opens them for everyone.',
  ],
}

export function strings(lang: string): Strings {
  return lang === 'zh' ? zh : en
}
