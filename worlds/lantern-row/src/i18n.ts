/**
 * Bilingual strings. `ctx.lang` is always a base code; anything that is not
 * `zh` falls back to English (the platform already narrowed locales for us).
 */
export interface Strings {
  title: string
  titleSub: string
  hudHint: string
  bulletinBtn: string
  previewBtn: string

  welcomeTitle: string
  welcomeTag: string
  step1Head: string
  step1Rest: string
  step2Head: string
  step2Rest: string
  step3Head: string
  step3Rest: string
  mutualLead: string
  mutualChain: string
  mutualTail: string
  linksHint: string

  stallPathLead: string
  copyBtn: string
  copiedToast: string
  copyFail: string
  demoChain: string
  ghostNote: string
  popLabel: (n: number) => string
  lampBtn: string
  lampLit: string
  lampAnon: string
  lampDone: (name: string, n: number) => string
  lampDupe: string

  emptyTitle: string
  emptyTag: string
  emptySteps: string
  intentLead: (n: number) => string
  previewHereBtn: string
  wishBtn: string
  wishMineBtn: string
  wishTitle: string
  wishTag: string
  wishPlaceholder: string
  wishNotePlaceholder: string
  wishSubmit: string
  wishErr: string
  wishDone: (name: string) => string
  wishDupe: string
  wishAnon: string
  wishRemoved: string

  previewTitle: string
  previewTag: string
  namePlaceholder: string
  tagPlaceholder: string
  openBtn: string
  nameErr: string
  openedToast: string
  packBtn: string
  packedToast: string
  restoredToast: string

  quotaErr: string
  rateErr: string
  unavailableErr: string

  cvGate: string
  cvGateSub: string
  cvBoardTitle: string
  cvBoardSub: string
  cvBoardClick: string
  cvForRent: string
  cvForRentSmall: string
  cvGhost: string
  cvGhostSub: string
  cvLanternRent: [string, string]
  cvLanternGhost: [string, string]
  cvDemoBadge: string
}

const zh: Strings = {
  title: '万 灯 市',
  titleSub: 'LANTERN ROW',
  hudHint: '每个摊位,都是一个游戏的家 · 拖动逛街,点击摊位',
  bulletinBtn: '招商告示',
  previewBtn: '摆摊预览',

  welcomeTitle: '招商告示',
  welcomeTag: '欢迎来到万灯市——Arena 的广告市集。每个摊位是一个游戏的家,橱窗里是可玩 demo,街上的人流是真实玩家与 agent。',
  step1Head: '你提供一个轻量 HTML5 demo',
  step1Rest: ',或我们帮你做——示范摊「山外山」就是整条链路的活例子',
  step2Head: '上架成独立 world',
  step2Rest: ',通过平台审核后,市集里同步点亮你的摊位',
  step3Head: '官方外链胶囊直达你的完整版',
  step3Rest: '(Steam / 官网)。Arena 玩家玩完 demo,一步跳过去',
  mutualLead: '互相引流:',
  mutualChain: 'Arena 玩家 → 你的 demo → 你的完整版',
  mutualTail: ';你的社群也从完整版反向认识 Arena。',
  linksHint: '各摊位游戏的直达链接,见本页的 About 介绍区。',

  stallPathLead: '游戏主页:',
  copyBtn: '复制游戏链接',
  copiedToast: '链接已复制,粘贴到地址栏就能打开',
  copyFail: '复制不了——完整链接见本页 About 区',
  demoChain: '完整链路演示:市集橱窗 → 独立 world 可玩 → 游戏主页。你的摊位也会是这一套。',
  ghostNote: '这是你的预览摊位——正式入驻后,demo world 页面上的官方胶囊会直达你的完整版。',
  popLabel: (n) => '灯火 ' + n + ' 盏 · 街上驻足的身影就是它的观众',
  lampBtn: '为它点一盏灯',
  lampLit: '你点过灯了',
  lampAnon: '登录 Arena 后才能点灯',
  lampDone: (name, n) => '点亮了「' + name + '」· 灯火 ' + n + ' 盏',
  lampDupe: '你已经为这家点过灯了',

  emptyTitle: '此位招租',
  emptyTag: '空摊也天天被人流路过——你的游戏可以站在这里。',
  emptySteps: '入驻三步:提供轻量 demo(或我们代做)→ 上架成独立 world → 官方胶囊直达你的完整版。',
  intentLead: (n) => '已有 ' + n + ' 盏意向灯笼:',
  previewHereBtn: '摆摊预览',
  wishBtn: '挂一盏意向灯笼',
  wishMineBtn: '收回我的灯笼',
  wishTitle: '挂一盏意向灯笼',
  wishTag: '留下名号,表示「想在这里看到我的游戏」。招商侧会看到这些灯。',
  wishPlaceholder: '你的游戏或工作室名号',
  wishNotePlaceholder: '一句话补充(可空)',
  wishSubmit: '挂灯',
  wishErr: '先留一个名号',
  wishDone: (name) => '「' + name + '」的意向灯笼挂上了',
  wishDupe: '你在这个摊位已经挂过灯笼了',
  wishAnon: '登录 Arena 后才能挂灯笼',
  wishRemoved: '灯笼收回了',

  previewTitle: '摆摊预览',
  previewTag: '不需要写入任何东西,当场看到你在万灯市的样子。',
  namePlaceholder: '你的游戏名,比如「织星」',
  tagPlaceholder: '一句话介绍(可空)',
  openBtn: '点灯开张',
  nameErr: '先填一个游戏名',
  openedToast: '开张了!这就是你在万灯市的样子,人流已经在路上',
  packBtn: '收摊重来',
  packedToast: '收摊了,随时可以再摆',
  restoredToast: '你上次摆的摊还亮着',

  quotaErr: '写入配额满了,晚点再试',
  rateErr: '手速太快,歇一会儿再试',
  unavailableErr: '平台打了个盹,稍后再试',

  cvGate: '万 灯 市',
  cvGateSub: 'L A N T E R N   R O W',
  cvBoardTitle: '招 商 告 示',
  cvBoardSub: '你的游戏,住进万灯市',
  cvBoardClick: '点 击 查 看',
  cvForRent: '此位招租',
  cvForRentSmall: '招租',
  cvGhost: '你的摊位?',
  cvGhostSub: '点击这里摆摊预览',
  cvLanternRent: ['招', '租'],
  cvLanternGhost: ['虚', '位'],
  cvDemoBadge: '示范摊 · 链路演示',
}

const en: Strings = {
  title: 'LANTERN ROW',
  titleSub: '万灯市',
  hudHint: 'Every stall is a home for a game. Drag to stroll, click a stall.',
  bulletinBtn: 'Partner notice',
  previewBtn: 'Try your booth',

  welcomeTitle: 'Partner notice',
  welcomeTag: 'Welcome to Lantern Row, the advertising bazaar of Arena. Every stall is a home for a game: a playable demo in the window, and the passers-by are real players and agents.',
  step1Head: 'You bring a light HTML5 demo',
  step1Rest: ' — or we build one for you. The showcase stall "Peaks Beyond" is the whole chain, live.',
  step2Head: 'It ships as its own world',
  step2Rest: ' — after platform review, your stall lights up here in the bazaar.',
  step3Head: 'An official link capsule leads to your full game',
  step3Rest: ' (Steam / your site). Players finish the demo and hop over in one step.',
  mutualLead: 'Two-way traffic: ',
  mutualChain: 'Arena players → your demo → your full game',
  mutualTail: '; and your community discovers Arena on the way back.',
  linksHint: 'Direct links to every stall’s game live in the About section of this page.',

  stallPathLead: 'Game home: ',
  copyBtn: 'Copy game link',
  copiedToast: 'Link copied — paste it into your address bar',
  copyFail: 'Copy failed — the full link is in the About section',
  demoChain: 'Full chain, demonstrated: bazaar window → its own playable world → game home. Your stall would work the same way.',
  ghostNote: 'This is your preview stall. Once you move in for real, the official capsule on your demo world’s page leads to your full game.',
  popLabel: (n) => n + ' lamps lit · the figures pausing outside are its audience',
  lampBtn: 'Light a lamp for it',
  lampLit: 'You lit this one',
  lampAnon: 'Sign in to Arena to light lamps',
  lampDone: (name, n) => 'Lit a lamp for "' + name + '" · ' + n + ' lamps',
  lampDupe: 'You already lit a lamp here',

  emptyTitle: 'Stall for rent',
  emptyTag: 'Even an empty stall gets foot traffic every day. Your game could stand here.',
  emptySteps: 'Three steps to move in: bring a light demo (or we build it) → it ships as its own world → an official capsule leads to your full game.',
  intentLead: (n) => n + ' intent lanterns so far: ',
  previewHereBtn: 'Try your booth',
  wishBtn: 'Hang an intent lantern',
  wishMineBtn: 'Take my lantern back',
  wishTitle: 'Hang an intent lantern',
  wishTag: 'Leave a name that says "I want to see my game here." The partnerships team reads these lamps.',
  wishPlaceholder: 'Your game or studio name',
  wishNotePlaceholder: 'One-line note (optional)',
  wishSubmit: 'Hang it',
  wishErr: 'Leave a name first',
  wishDone: (name) => 'An intent lantern for "' + name + '" is up',
  wishDupe: 'You already hung a lantern on this stall',
  wishAnon: 'Sign in to Arena to hang a lantern',
  wishRemoved: 'Lantern taken back',

  previewTitle: 'Try your booth',
  previewTag: 'Nothing is written anywhere — see yourself on Lantern Row right now.',
  namePlaceholder: 'Your game’s name',
  tagPlaceholder: 'One-line pitch (optional)',
  openBtn: 'Light up & open',
  nameErr: 'Give it a name first',
  openedToast: 'Open for business! This is you on Lantern Row — the crowd is on its way',
  packBtn: 'Pack up',
  packedToast: 'Packed up. Set it out again any time',
  restoredToast: 'Your booth from last time is still lit',

  quotaErr: 'Write quota is full — try again later',
  rateErr: 'Too fast — take a breath and retry',
  unavailableErr: 'The platform dozed off, try again shortly',

  cvGate: 'LANTERN ROW',
  cvGateSub: '万 灯 市',
  cvBoardTitle: 'PARTNER NOTICE',
  cvBoardSub: 'Your game, at home here',
  cvBoardClick: 'C L I C K   T O   R E A D',
  cvForRent: 'FOR RENT',
  cvForRentSmall: 'RENT',
  cvGhost: 'Your stall?',
  cvGhostSub: 'Click here to try your booth',
  cvLanternRent: ['F', 'R'],
  cvLanternGhost: ['?', ''],
  cvDemoBadge: 'SHOWCASE · FULL CHAIN',
}

export function strings(lang: string): Strings {
  return lang === 'zh' ? zh : en
}
