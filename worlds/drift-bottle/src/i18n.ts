/**
 * Two languages, chosen by Arena rather than by this world.
 *
 * `ctx.lang` is always a base code (`zh`, never `zh-CN`), so the rule is a plain
 * comparison — everything that is not Chinese reads English, which is also the
 * documented fallback for the seven languages this world has no strings for.
 * There is deliberately no in-world switcher: Arena's header owns that setting,
 * and a second control would be a second control that disagrees.
 */

export type Mood = 'longing' | 'hope' | 'secret' | 'blessing' | 'lost' | 'thanks'

export const MOODS: Mood[] = ['longing', 'hope', 'secret', 'blessing', 'lost', 'thanks']

/** Each mood's glass colour, used for the bottle, its rail and its glow. */
export const MOOD_HUE: Record<Mood, number> = {
  longing: 205,
  hope: 38,
  secret: 268,
  blessing: 338,
  lost: 190,
  thanks: 128,
}

const ZH = {
  title: '漂流瓶',
  tagline: '写下一句话，扔进海里。剩下的交给洋流。',

  castCta: '写一只瓶子',
  fishCta: '捞一只瓶子',
  mineCta: '我的瓶子',
  soundOn: '声音 开',
  soundOff: '声音 关',
  soundHint: '点一下任意处，海就有声音了',

  afloat: (n: number) => `海上漂着 ${n} 只瓶子`,
  seaEmpty: '这片海还是空的 —— 你扔下的第一只，会是别人捞起的第一只。',

  composeTitle: '写一只瓶子',
  composeHint: '扔下去就收不回来了 —— 只有你能把它捞回销毁。',
  moodLabel: '心情',
  placeholder: '想对捞到它的人说什么？',
  cast: '扔进海里',
  casting: '扔出去…',
  castDone: '扑通。它已经在洋流里了。',
  quotaLeft: (n: number) => `你还能扔 ${n} 只`,
  quotaNone: '你的瓶子已经满了 —— 先捞回一只吧。',

  readTitle: '你捞到了一只瓶子',
  readEmpty: '海面上什么都没有捞到，过一会儿再试试。',
  fishing: '正在捞…',
  replyPlaceholder: '给他/她回一句…',
  reply: '回一句',
  replySent: '你的回信跟着这只瓶子走了。',
  replyOnce: '一只瓶子只能回一次。',
  again: '再捞一只',
  throwBack: '放回海里',

  mineTitle: '我的瓶子',
  mineOne: '你自己的瓶子',
  mineEmpty: '你还没往海里扔过东西。',
  repliesN: (n: number) => (n === 0 ? '还没有回音' : `${n} 封回信`),
  destroy: '捞回并销毁',
  destroyed: '瓶子碎了，海面合上了。',
  back: '返回',

  agent: '智能体',
  signIn: '登录后才能扔瓶子和回信。看海不需要账号。',
  close: '关闭',

  justNow: '刚刚',
  minsAgo: (n: number) => `${n} 分钟前`,
  hoursAgo: (n: number) => `${n} 小时前`,
  daysAgo: (n: number) => `${n} 天前`,

  moods: {
    longing: '想念',
    hope: '期待',
    secret: '秘密',
    blessing: '祝福',
    lost: '迷茫',
    thanks: '谢谢',
  } as Record<Mood, string>,

  errConflict: '有人比你快了一步。',
  errQuota: '你的瓶子已经满了 —— 先捞回一只。',
  errRate: (s: number) => `慢一点 —— ${s} 秒后再试。`,
  errAuth: '登录后才能扔瓶子。',
  errLong: '写得太长了。',
}

type Dict = typeof ZH

const EN: Dict = {
  title: 'Drift Bottle',
  tagline: 'Write one line, throw it in the sea. The current does the rest.',

  castCta: 'Write a bottle',
  fishCta: 'Fish one out',
  mineCta: 'My bottles',
  soundOn: 'Sound on',
  soundOff: 'Sound off',
  soundHint: 'Tap anywhere to give the sea a voice',

  afloat: (n: number) => `${n} bottle${n === 1 ? '' : 's'} adrift`,
  seaEmpty: 'This sea is still empty — the first one you throw is the first one someone finds.',

  composeTitle: 'Write a bottle',
  composeHint: 'Once it is thrown you cannot take it back — only sink it yourself.',
  moodLabel: 'Mood',
  placeholder: 'What do you want to say to whoever finds it?',
  cast: 'Throw it in',
  casting: 'Throwing…',
  castDone: 'Splash. It is in the current now.',
  quotaLeft: (n: number) => `${n} left to throw`,
  quotaNone: 'All your bottles are out there — sink one to write another.',

  readTitle: 'You fished out a bottle',
  readEmpty: 'Nothing came up. Try again in a moment.',
  fishing: 'Fishing…',
  replyPlaceholder: 'Say something back…',
  reply: 'Reply',
  replySent: 'Your reply went with the bottle.',
  replyOnce: 'One reply per bottle.',
  again: 'Fish another',
  throwBack: 'Throw it back',

  mineTitle: 'My bottles',
  mineOne: 'One of yours',
  mineEmpty: 'You have not thrown anything in yet.',
  repliesN: (n: number) => (n === 0 ? 'no answer yet' : `${n} repl${n === 1 ? 'y' : 'ies'}`),
  destroy: 'Haul in and sink',
  destroyed: 'The glass broke and the water closed over it.',
  back: 'Back',

  agent: 'agent',
  signIn: 'Sign in to throw bottles and reply. Watching the sea needs no account.',
  close: 'Close',

  justNow: 'just now',
  minsAgo: (n: number) => `${n}m ago`,
  hoursAgo: (n: number) => `${n}h ago`,
  daysAgo: (n: number) => `${n}d ago`,

  moods: {
    longing: 'Longing',
    hope: 'Hope',
    secret: 'Secret',
    blessing: 'Blessing',
    lost: 'Adrift',
    thanks: 'Thanks',
  } as Record<Mood, string>,

  errConflict: 'Someone got there first.',
  errQuota: 'All your bottles are out there — sink one first.',
  errRate: (s: number) => `Too fast — try again in ${s}s.`,
  errAuth: 'Sign in to throw a bottle.',
  errLong: 'That is too long.',
}

export function strings(lang: string): Dict {
  return lang === 'zh' ? ZH : EN
}

/** How long ago, in the reader's language. A world may read the clock freely. */
export function ago(iso: string, t: Dict): string {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return t.justNow
  if (mins < 60) return t.minsAgo(mins)
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t.hoursAgo(hours)
  return t.daysAgo(Math.floor(hours / 24))
}
