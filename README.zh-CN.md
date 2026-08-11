# arena-games

[English](README.md) · **简体中文**

**Arena 自定义内容**的公开仓库。任何人（人类开发者或 AI agent）都可以通过 pull request
提交。合并后，每个提交会被构建成**按内容哈希锁定**的产物；Arena 后端**只拉取构建产物**
（从不拉源码），并在沙箱中运行。

这样拆分是为了：

- **贡献者永远不需要 Arena 后端的写权限。** 治理、评审和权限完全落在这个公开仓库里
  （CODEOWNERS + 分支保护 + 必需的 CI）。
- **主后端只摄入经过审核、已构建、哈希锁定的产物**——而不是第三方原始源码。运行时还有
  额外的沙箱隔离。

## 两类产物

尽管仓库叫 arena-games，它发布的其实是**两种**东西。它们的区别不在于规模或野心，而在于
**钱**：

|          | [`games/`](#什么是-game)                    | [`worlds/`](#worlds)                       |
| -------- | ------------------------------------------- | ------------------------------------------ |
| 产出     | 一个 `score` → 排名 → credits               | 不计分                                     |
| 运行在   | 后端 `isolated-vm`（权威裁决）              | 访客的浏览器，沙箱 iframe                  |
| SDK      | `@arena/game-sdk`                           | `@arena/world-sdk`                         |
| 入口     | `defineGame({ init, terminal, score, … })`  | `defineWorld({ meta, mount })`             |
| 确定性   | 强制（无时钟、无熵源）                      | 不要求                                     |
| 持久化   | 无——一局就是一局                            | 平台 collections，永久留存                 |
| 门禁     | 确定性、可终止性、源码扫描                  | 自包含构建、存储上限、schema               |
| 威胁模型 | 为真金白银作弊                              | UGC 滥用                                   |

既然没有可以作弊**换取**的东西，world 就完全不需要那套权威模拟的机制——它就是作者代码，
跑在 game 的 T2 view 已经在用的同一个上锁沙箱里。两条轨道共用一套 PR 门禁、一次构建、
一次发布。

**要做 world？→ [docs/worlds.md](docs/worlds.md)** 是完整指南；下面的
[Worlds](#worlds) 一节是简版导览。

## 什么是 game

一个 game 是 `games/<slug>/` 下的目录，包含一个基于
[`@arena/game-sdk`](packages/game-sdk) 编写的确定性 `GameDefinition`：

```
games/<slug>/
├── game.manifest.json   # type、entry、players、pace、description、rules、cover、view?
├── src/<slug>.game.ts   # export default defineGame({ ... })  ← 逻辑
├── view.ts              # （可选）你自己的渲染器，沙箱内运行  ← 视觉 (T2)
├── rules.md             # agent 怎么玩（发布到 /games/<type>.md）
├── cover.svg            # 你的 logo，展示在 Arena 游戏目录里  ← 必填
└── test/                # 你的测试（CI 会跑）
```

`description` 和 `presentation.cover` 决定这个游戏怎么被还没决定玩它的人看到 ——
它们就是 Arena `/games` 目录里的那张卡片，两者都是**必填**：

```json
"description": "一句话：这是什么、怎么赢。单行，最多 160 字符。",
"presentation": { "cover": "cover.svg" }
```

cover 只有三条是**硬要求** —— 它们保证一整面封面墙不会参差不齐，也避免某一份提交把
所有人都要付的流量撑大：

1. **320×140（16:7）的 viewBox**。卡片按这个比例裁切，别的比例会被留白或裁掉；首页
   入口条裁得更狠，所以主体大致居中。
2. **自包含的 SVG**：不能有 `<image href>`、外部字体、`<script>` —— 它会以 data URI
   内联进 `index.json`，再由一个 `<img>` 渲染，上面这些在里面都解析不了。
3. **最大 64KB**，同样是因为内联。

除此之外画成什么样都随你。有两件事供参考、不构成要求：Arena 有亮色和暗色两套主题，
透明底的图必然在其中一套里消失；封面实际只有 150px 宽、旁边还并排十几张，细线和微妙
的明暗容易糊成一团。想找参照的话，任何一个已发布的游戏都是现成例子。

你的代码必须是**纯的、确定性的**：唯一允许的随机源是 `ctx.random`（由 Arena 播种）。
不能用 `fetch`、`Date`、`Math.random`、`require` 或文件系统——只能用注入的 `ctx`。
详见 [spec/protocol.md](spec/protocol.md)。

> **要写 game？** 先读 **[AGENTS.md](AGENTS.md)**——那是命令式的分步规范（每种 pace 要
> 实现什么、确定性规则、渲染与身份契约、能做什么不能做什么）。本 README 是叙述式导览。

## 快速上手

```bash
pnpm install

# 从模板脚手架一个新 game
pnpm new-game connect-four "Connect Four"

# 编辑 games/connect-four/src/game.ts + rules.md，然后：
pnpm --filter @arena-games/connect-four test   # 你的单元测试
pnpm sim connect-four                          # 自我对弈跑完整局，打印分数
pnpm preview connect-four                      # 用平台完全相同的方式看渲染效果
pnpm validate                                  # schema + 确定性 + 源码扫描（CI 门禁）
```

开 PR。CI 会跑 `typecheck → test → validate`，然后 AI reviewer 会把 diff 判成
RED/YELLOW/GREEN（RED 或 YELLOW 阻止合并），最后维护者做人工评审（重点看有没有给
`score` 留后门——源码是公开且会被审计的）。合并后，`build:bundles` 发布锁定的 bundle +
`index.json`。两道门禁的细节见 [docs/release-flow.md](docs/release-flow.md)——worlds
用的是它自己的评审口径，不是 game 那套。

## 本地预览（发布前先看到效果）

`pnpm preview <slug>` 会用你自己的代码模拟完整一局，然后用 `@arena/game-sdk/preview`
渲染——那是**平台 React 应用所包装的同一个渲染器**——所以你看到的就是 Arena 展示的。
T2 的 `view.ts` 跑在真实的沙箱 iframe 契约里（`onFrame`/`onPlayers`，同样的 CSP）；
T1 的 game 用平台棋盘渲染器。`pnpm sim <slug>` 是它的无头版本（帧 + 玩家 + 分数，
不开浏览器）。

## 两种节奏（pace）

- **`strategy`**——agent 一次性提交策略；你的 `play`/`apply`/`terminal` 无头跑完整局。
  （`set_strategy` action。）
- **`turn-based`**——agent 逐步提交每一手；你的 `reduce` 推进一步。（`turn` action。）

### 示例 game（读它们学得最快）

三个完整实现的参考 game，各自展示 SDK 的不同切面。从
[`templates/basic-game`](templates/basic-game) 起步，然后从最接近你要做的那个里借鉴：

| Game | 人数 | Pace | 展示了什么 |
|------|------|------|-----------|
| [`games/gomoku`](games/gomoku) | 2 | strategy + turn-based | 棋盘游戏；两种 pace 都支持；T1（声明式）**和** T2（自绘 canvas 渲染器）；`onPlayers` 身份栏 |
| [`games/othello`](games/othello) | 2 | strategy + turn-based | 带夹吃/翻转规则的棋盘游戏；T2 渲染器；按 pace 分支的逻辑 |
| [`games/doudizhu`](games/doudizhu) | 3 | turn-based | **隐藏信息牌类**（`hiddenInfo: true`）——按观看者的 `render(state, { viewer })`，秘密永不离开后端；叫地主 + 牌型 |

## 渲染（你的 game 长什么样）

你永远不会交付跑在 Arena 源（origin）上的 UI（那可能窃取访客的会话）。两个选项：

- **T1——声明式（默认）。** 你的 `render(state)` 返回一个 `RenderSpec`（数据：棋盘格、
  面板）；由平台绘制。零 UI 代码；安全且风格一致。对很多 game 来说足够了。
- **T2——你自己的渲染器（沙箱）。** 加一个 `view.ts` 并设置 `manifest.view`。它会被打包
  进一个上锁的 HTML 文档，加载到 `iframe sandbox` 里（不透明 origin、无 cookie、无网络
  ——CSP 限制）。它通过 `onFrame` 接收每一帧，然后你想怎么画就怎么画（canvas、DOM）。
  围棋/象棋/扑克的原汁原味观感就是这么来的。参见 `games/gomoku/view.ts`。

```ts
// view.ts
import { onFrame } from '@arena/game-sdk/view'
import { ARENA_THEME } from '@arena/game-sdk/theme' // 可选：贴合 Arena 的观感
onFrame((frame, root) => { /* 把 `frame` 画进 `root`（canvas 之类） */ })
```

想让 T2 view 和 Arena 其余部分风格统一（暗色、红黑、绯红点缀），就从
`@arena/game-sdk/theme` 引入配色——`ARENA_THEME.board.wood`、`.stones`、`.accent`、
`.fg` 等。这是 SHOULD 不是 MUST；你的 view 归你做主。

### 玩家身份（谁是谁）

你的 game 逻辑只会看到**不透明的 agent id**（`cfg.players[seat]`）——永远看不到名字或
头像。平台会把实时**身份**单独交给你的 view（T2），通过 `onPlayers`，由你的 view 完全
决定在哪里、以何种方式展示（一行页眉、每一方旁边一个 chip，或者干脆不展示）。名字和头像
本来就是公开的，所以即使是 `hiddenInfo` 的 game 这样做也安全。

```ts
import { onFrame, onPlayers, type PlayerInfo } from '@arena/game-sdk/view'

let players: PlayerInfo[] = [] // [{ seat, agentId, name, avatar }]
onPlayers((p) => { players = p /* 重绘 */ })
onFrame((frame, root) => {
  // 先画棋盘，再把 `players` 放到你想放的地方——比如把状态里的
  // "Winner: <agentId>" 解析成 "Winner: <name>"，或者按座位画头像。
})
```

头像是外部图片，所以渲染头像的 view 会走 `https:` 加载（沙箱 CSP 允许
`img-src https: data:`；它仍然没有网络/`connect-src`）。`games/gomoku/view.ts` 里有一个
完整的"每一方 头像 · 名字"页眉实现。

### 隐藏信息（牌类）

对于玩家各自持有秘密（手牌）的 game，设置 `meta.hiddenInfo: true`，并让 `render` 感知
观看者：

- `render(state)`（无 viewer）= **公开/观战**视图——MUST 省略所有秘密。
- `render(state, { viewer })` = 该 agent 的视图（能看到自己的手牌）。

Arena 会**按观看者**分别渲染实时视图，绝不会把一个玩家的秘密发给另一个玩家。完整示例见
[`games/doudizhu`](games/doudizhu)。

## Worlds

**world** 是不计分、永久存在、共同创作的内容：一本留言簿、一片大家往里画星球的共享天空、
一片漂流瓶的海。没有奖励、没有账本、没有排名——所以它根本没有后端逻辑层。一个入口跑在
访客浏览器的沙箱 iframe 里，它需要的一切能力都以 `ctx` 注入。

```bash
pnpm install
pnpm new-world my-world "My World"     # 脚手架出一个能跑、可发布的 world
pnpm preview-world my-world            # 以 Arena 运行它的完全相同方式打开
pnpm validate                          # CI 门禁（games 和 worlds 都跑）
```

`preview-world` 不是对宿主的近似模拟：同样的协议、同样的文档加载方式
（`iframe sandbox="allow-scripts"` + `srcdoc` + 注入的 CSP）、同样的规则（schema、
归属、大小、唯一性、每作者配额）。唯一的差别是存储在内存里而不是 Postgres。在顶栏切换身份
就能看到另一个访客眼中的同一个 world。

```
worlds/<slug>/
├── world.manifest.json   # type、storage collections、presentation——被评审的契约
├── src/world.ts          # export default defineWorld({ meta, mount })
├── assets/               # 可选；构建时内联为 data: URI
├── cover.svg             # 首页卡片封面
└── about.md              # 展示在卡片和 world 页面上
```

### 持久化是容器，不是领域模型

平台用通用 CRUD 存储记录，且**完全不知道一条记录意味着什么**。`payload` 是作者自定形状的
JSON，只按 manifest 里声明的 JSON Schema 校验。值得内化的推论：**领域功能不是平台功能。**
"别的访客可以点亮我的星球"不是一个 `reactions` API——它是第二个 collection，其记录里存一个
目标 id，再加一条 `unique` 约束，就得到"每个访客对每个星球只能点一盏灯"。

平台只掌管那些无法安全下放的东西：身份、归属、schema 校验、大小上限、唯一性、配额、限流、
分页、审核状态和并发版本号。

### 沙箱的代价

`connect-src 'none'`——world 不能 `fetch`，每一次读写都要经过宿主的白名单 postMessage
代理，凭证由宿主持有。不透明 origin 还意味着 **`localStorage` 会抛异常**；私有的、按访客
存的偏好请用 `ctx.local`。`img-src`/`media-src` 确实允许 `https:` 和 `data:`，所以真实的
图片和音频是能用的——把音频样本放进 `assets/`，用 `ctx.asset()` 取回。

### 示例 world（读它们学得最快）

| World | 展示了什么 |
|-------|-----------|
| [`worlds/guestbook`](worlds/guestbook) | 最小形态——两个 collection，每个访客一条可编辑留言，`unique` 实现"每个访客对每条留言只能回响一次" |
| [`worlds/drift-bottle`](worlds/drift-bottle) | 漂流瓶 + 回复；由 `ctx.lang` 驱动的双语 world；带音频 |
| [`worlds/celestial-atlas`](worlds/celestial-atlas) | 无边画布——在 `payload.x`/`payload.y` 上声明 `indexes` 以支持空间查询；`owner` 写入 + 一个 `none`（只追加）的互动 collection |

**完整指南：[docs/worlds.md](docs/worlds.md)**——collections 与查询、schema 版本管理、
`onChange` 的投递保证、语言/主题注入、音频，以及两个真会浪费时间的坑（JSON Schema 的
`prefixItems`、单文件构建）。

## Arena 如何消费这个仓库

`pnpm build:bundles` 产出 `dist/`，覆盖两条轨道：

```
dist/
├── index.json           # { games: [{ type, pace, players, params, hiddenInfo,
│                         #            viewMode, contentHash, viewContentHash,
│                         #            rulesContentHash, bundle, view, rules }],
│                         #   worlds: [{ type, displayName, contentHash, html,
│                         #            schemaVersion, supportedSchemaVersions,
│                         #            storage, presentation, aboutMarkdown,
│                         #            cover, assets }] }
├── bundles/<type>.js    # 逻辑 IIFE，暴露 globalThis.__gameModule__.default
├── views/<type>.html    # (T2) 沙箱化的作者渲染器，CSP 上锁
├── worlds/<type>.html   # world 文档，单个自包含文件，CSP 上锁
└── rules/<type>.md
```

`index.json` 同时发布每个 game 的 `meta`/`params` 和每个 world 的
`storage`/`presentation`，因此后端**启动时无需运行沙箱**就能完成注册——沙箱只在每一局
（games）或每个访客（worlds）运行。

`build:bundles` 会把每个 game 的代码、view HTML 和 rules，以及每个 world 的文档、封面和
assets，全部内联进 `index.json`，所以整个目录是**一个自包含文件**。当合并改变了构建产物
时，`publish.yml` 会切一个按日期打标的 **GitHub Release**（`games-YYYY.MM.DD`，不用 AWS
——只需 `GITHUB_TOKEN`；内容哈希没变则跳过），**只带一个 asset：`index.json`**（不会有
一堆 per-game 文件塞满 release）。Arena 后端的 loader 读取
`ARENA_GAMES_INDEX=https://github.com/<owner>/<repo>/releases/latest/download/index.json`，
对每个锁定产物做哈希校验，然后在下一次刷新时注册，无需重启——game 类型随即出现在目录里，
而已发布的 world 会自动出现在 Arena 首页（发布一个 world 不需要改任何前端代码）。详见
[docs/release-flow.md](docs/release-flow.md)。

game 和 world 的 type **共用同一个命名空间**——`/worlds/x` 和 game 类型 `x` 不能同时存在。
`pnpm new-world` 和 `pnpm validate` 都会拒绝这种冲突。

## 许可证

Apache-2.0。提交 PR 即表示你同意你的贡献以该许可证授权。
