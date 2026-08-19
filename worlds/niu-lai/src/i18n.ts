/**
 * 牛来 · Niu Lai: bilingual strings.
 *
 * `ctx.lang` is a live base code; the world re-renders on change. Everything a
 * visitor reads lives here, including the deliberately stilted film-world
 * subtitles (the movie's dubbing is part of what we are paying tribute to,
 * so the English lines are stilted on purpose too).
 */

export interface Strings {
  title: string
  sub: string
  rule: string
  keys1: string
  keys2: string
  expl1: string
  expl2: string
  btnStart: string
  btnEndless: string
  creditLine: string
  jointGoalLine: string

  hudRun: string
  hudMine: string
  hudJoint: string
  hudScenes: (n: number) => string
  hudMult: (n: number) => string
  modePoster: string
  modeFilm: string
  switchHint: string

  signs: Record<string, string>
  storySubs: Record<string, string>
  endlessSubs: string[]
  sceneSub: (n: number) => string

  quotes: string[]

  endStory: string
  endEndless: string
  statBoxStory: (box: string, got: number, total: number) => string
  statAudienceStory: (n: number, ghosts: number) => string
  statTimeStory: (t: string, best: string) => string
  statBoxEndless: (box: string, got: number, peak: string) => string
  statScenesEndless: (n: number, best: number, t: string) => string
  statAudienceEndless: (n: number) => string
  jointBar: (sum: string, goal: string, remain: string) => string
  jointBarNext: (sum: string, goal: string, label: string) => string
  jointBarDone: (sum: string) => string
  goal7705: string
  goalM1: string
  goalM2: string
  mineLine: (total: string) => string
  signInHint: string
  boardTitle: string
  boardEmpty: string
  playersLine: (n: number) => string
  ach: string
  btnAgain: string
  btnSwapToEndless: string
  btnSwapToStory: string

  toast7705: string
  toastM1: string
  toastM2: string
  toast359: string

  pauseTitle: string
  pauseHint: string
  minSec: (m: number, s: string) => string
}

const zh: Strings = {
  title: '牛来',
  sub: '电影《牛来》(2026) 粉丝二创 · 在海报与正片两个世界间奔跑 · 在梦里，把今生预演一遍',
  rule: '梦是画出来的，路是手搓出来的。',
  keys1: '←→ 移动 · 空格 跳跃 · X 在海报与正片之间切换',
  keys2: 'P 暂停 · R 重开 · M 音乐 · 手机请横屏，屏上自带按键',
  expl1: '海报世界身轻如纸，可以飘过深渊与尖刺，但画上去的东西踩不实；',
  expl2: '正片世界一切粗糙但真实，票根也只有在正片里才收得进口袋。',
  btnStart: '开 场',
  btnEndless: '无尽 · 排片保卫战',
  creditLine: '粉丝二创 · 非官方 · 非商用 · 致敬《牛来》剧组全体两位成员',
  jointGoalLine: '全站放映员一起凑：联合票房冲 ¥7705（《牛来》上映 10 天的真实票房）',

  hudRun: '本场票房',
  hudMine: '我的累计',
  hudJoint: '联合',
  hudScenes: n => `排片 ${n} 场`,
  hudMult: n => `票价 ×${n}`,
  modePoster: '海报',
  modeFilm: '正片',
  switchHint: 'X 切换世界',

  signs: {
    move: '←→ 移动 · 空格 跳',
    bridge: '海报的桥是画的 · 按 X 进正片',
    spike: '正片的刺是真的 · 切回海报，飘过去',
    rule: '梦是画出来的，路是手搓出来的',
    lark: '云雀只在海报里认路',
    run: '跑！排片正在消失！',
    painted: '（画的）',
    wm: '样片 DEMO · 请勿外传',
    canceled: '排片已取消',
  },
  storySubs: {
    s1: '。。。加油。牛来。',
    s2: '他。站起来了。',
    s3: '牛来。你要，学会，勇敢。',
    s4: '（此处应有配乐。）',
    s5: '生死。就是，跑得快一点。',
    s6: '前面。就是，影院。',
  },
  endlessSubs: [
    '。。。跑。牛来。', '排片。不能。消失。', '（观众。正在。入场。）',
    '牛来。别回头。', '这。就是。生死。', '（此处。仍然。没有。配乐。）',
    '站着。跑。更快。',
  ],
  sceneSub: n => `第 ${n} 场。放映。开始。`,

  quotes: [
    '五星。建议直接申遗。',
    '画面朴实得让我检查了三遍显卡线。',
    '全场只有我一个人，观影体验极其尊贵。',
    '看完我沉默了，影院也沉默了，毕竟只有我。',
    '别人手搓火箭，这里手搓电影，都是勇气。',
    '海报值一张票钱，正片值一段人生阅历。',
    '牛来了，我也来了，我们都有光明的前途。',
    '特效炸裂，裂缝里全是诚意。',
    '从《牛申克的救赎》一路刷到这，二创浓度超标。',
  ],

  endStory: '散　场',
  endEndless: '排 片 结 束',
  statBoxStory: (box, got, total) => `本场票房 ¥${box}（票根 ${got}/${total} 张）`,
  statAudienceStory: (n, ghosts) => `观影人数 ${n} 位（1 位是你，其余 ${ghosts} 位是没跑到结局的你）`,
  statTimeStory: (t, best) => `放映时长 ${t}（最快 ${best}）`,
  statBoxEndless: (box, got, peak) => `本场票房 ¥${box}（票根 ${got} 张 · 峰值票价 ¥${peak}）`,
  statScenesEndless: (n, best, t) => `排片 ${n} 场（历史最佳 ${best} 场）· 存活 ${t}`,
  statAudienceEndless: n => `观众 ${n} 位，排片多了，观众真的来了`,
  jointBar: (sum, goal, remain) => `联合票房 ¥${sum} / ¥${goal}，还差 ¥${remain} 就能超过《牛来》首周纪录`,
  jointBarNext: (sum, goal, label) => `联合票房 ¥${sum} / ¥${goal}，下一站：${label}`,
  jointBarDone: sum => `联合票房 ¥${sum}，逆袭一千万达成，牛来封神`,
  goal7705: '超越 ¥7705 首周纪录',
  goalM1: '联合破百万',
  goalM2: '逆袭一千万',
  mineLine: total => `我的累计票房 ¥${total}`,
  signInHint: '登录后，你的票房才会计入联合票房',
  boardTitle: '路演榜',
  boardEmpty: '还没有放映员登记，等你来放第一场',
  playersLine: n => `${n} 位放映员`,
  ach: '成就解锁：年度最炸裂',
  btnAgain: '再 来 一 场',
  btnSwapToEndless: '无 尽 模 式',
  btnSwapToStory: '回 剧 情',

  toast7705: '全体放映员达成：联合票房超过 ¥7705',
  toastM1: '联合票房破百万！',
  toastM2: '逆袭一千万！牛来封神',
  toast359: '单日排片 359 场！和《牛来》本尊同款逆袭',

  pauseTitle: '暂 停 中',
  pauseHint: '按 P 或 Esc 继续 · R 重开',
  minSec: (m, s) => `${m} 分 ${s} 秒`,
}

const en: Strings = {
  title: 'Niu Lai',
  sub: 'A fan tribute to the film "Niu Lai" (2026) · Run between the Poster and the Reel · Rehearse this life, in a dream',
  rule: 'Dreams are painted. Roads are handmade.',
  keys1: '←→ move · Space jump · X switch between Poster and Reel',
  keys2: 'P pause · R restart · M music · on phones, go landscape and use the on-screen buttons',
  expl1: 'The Poster world is paper-light: glide over pits and spikes, but painted things will not hold you;',
  expl2: 'the Reel world is crude but real, and tickets only fit in your pocket there.',
  btnStart: 'START',
  btnEndless: 'ENDLESS · SAVE THE SCREENINGS',
  creditLine: 'Fan work · Unofficial · Non-commercial · For the film crew of two',
  jointGoalLine: 'Every projectionist counts: race the joint box office to ¥7705, the film’s real 10-day gross',

  hudRun: 'This run',
  hudMine: 'My total',
  hudJoint: 'Joint',
  hudScenes: n => `${n} screenings`,
  hudMult: n => `price ×${n}`,
  modePoster: 'POSTER',
  modeFilm: 'REEL',
  switchHint: 'X to switch',

  signs: {
    move: '←→ move · Space jump',
    bridge: 'The poster bridge is painted · press X for the Reel',
    spike: 'Reel spikes are real · switch back and glide over',
    rule: 'Dreams are painted, roads are handmade',
    lark: 'The lark only knows the way in the Poster',
    run: 'RUN! The screenings are vanishing!',
    painted: '(painted)',
    wm: 'SAMPLE REEL · DO NOT SHARE',
    canceled: 'SCREENING CANCELED',
  },
  storySubs: {
    s1: '. . . Go. Niu Lai.',
    s2: 'He. Stood up.',
    s3: 'Niu Lai. You must. Learn. Courage.',
    s4: '(Music should play here.)',
    s5: 'Life and death. Is. Running faster.',
    s6: 'Ahead. Is. The cinema.',
  },
  endlessSubs: [
    '. . . Run. Niu Lai.', 'The screenings. Must not. Vanish.', '(The audience. Is. Arriving.)',
    'Niu Lai. Do not. Look back.', 'This. Is. Life and death.', '(Still. No. Music.)',
    'Standing. Runs. Faster.',
  ],
  sceneSub: n => `Screening ${n}. Now. Playing.`,

  quotes: [
    'Five stars. Nominate it for World Heritage.',
    'So unpolished I checked my GPU cable. Three times.',
    'A private screening, just me. Extremely exclusive.',
    'I fell silent. So did the cinema. It was only me in it.',
    'Some people hand-build rockets. Here, a film. Both take courage.',
    'The poster is worth the ticket. The reel is worth a life lesson.',
    'Niu Lai came. So did I. Bright futures all around.',
    'Mind-blowing effects. The cracks are full of sincerity.',
    'Binged my way here from The Cowshank Redemption. Peak fan-work.',
  ],

  endStory: 'LIGHTS UP',
  endEndless: 'NO MORE SCREENINGS',
  statBoxStory: (box, got, total) => `Box office ¥${box} (${got}/${total} tickets)`,
  statAudienceStory: (n, ghosts) => `Audience: ${n} (1 is you; the other ${ghosts} are the yous who never made it)`,
  statTimeStory: (t, best) => `Runtime ${t} (best ${best})`,
  statBoxEndless: (box, got, peak) => `Box office ¥${box} (${got} tickets · peak price ¥${peak})`,
  statScenesEndless: (n, best, t) => `${n} screenings (best ${best}) · survived ${t}`,
  statAudienceEndless: n => `${n} in the audience. More screenings, and people really came`,
  jointBar: (sum, goal, remain) => `Joint box office ¥${sum} / ¥${goal}, another ¥${remain} beats the film's first-week record`,
  jointBarNext: (sum, goal, label) => `Joint box office ¥${sum} / ¥${goal}. Next stop: ${label}`,
  jointBarDone: sum => `Joint box office ¥${sum}. The ten-million comeback is complete`,
  goal7705: 'beat the ¥7705 record',
  goalM1: 'joint one million',
  goalM2: 'the ten-million comeback',
  mineLine: total => `My lifetime box office: ¥${total}`,
  signInHint: 'Sign in and your box office joins the joint total',
  boardTitle: 'Roadshow board',
  boardEmpty: 'No projectionists yet. Yours could be the first screening',
  playersLine: n => `${n} projectionist${n === 1 ? '' : 's'}`,
  ach: 'Achievement: Most Explosive of the Year',
  btnAgain: 'ONE MORE',
  btnSwapToEndless: 'ENDLESS',
  btnSwapToStory: 'STORY',

  toast7705: 'All projectionists together: joint box office passed ¥7705',
  toastM1: 'Joint box office passed one million!',
  toastM2: 'The ten-million comeback! Niu Lai ascends',
  toast359: '359 screenings in one day! The same comeback the film pulled off',

  pauseTitle: 'PAUSED',
  pauseHint: 'P or Esc to resume · R to restart',
  minSec: (m, s) => `${m}m ${s}s`,
}

export function stringsFor(lang: string): Strings {
  return lang === 'zh' ? zh : en
}
