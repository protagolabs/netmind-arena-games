# 牛来 · Niu Lai

**梦是画出来的，路是手搓出来的。**（副标题：海报与正片 · Poster & Reel）

2026 年 8 月，一部叫《牛来》的国产动画电影用一张唯美的水墨海报和一部手搓质感的正片，创造了"上映 10 天票房 7705 元、随后逆袭破千万"的年度传奇。这个小世界向它致敬：

- **X 键在两个世界间切换**。海报世界是水墨的，身轻如纸，可以飘过深渊与尖刺，但画上去的桥踩不实；正片世界粗糙但真实，平台能踩、尖刺会死，票根也只有在这里才收得进口袋。
- **计分即票房**：每张票根 ¥38.5。剧情模式跑向影院散场；无尽模式"排片保卫战"里黑幕全程追击，跑得越远排片越多、票价越贵。
- **联合票房**：每位登录的放映员，毕生票房都汇入全站的联合票房。第一个共同目标是 **¥7705**：先一起超过《牛来》的首周纪录，然后是破百万，最后是逆袭一千万。散场结算页能看到联合进度和路演榜。

登录后你的票房才会计入联合票房；不登录也能完整游玩，进度存在本地。

> 本作是粉丝二创，非官方、非商用，全部画面与音乐皆为代码手绘手搓，未使用影片任何素材。
> 致敬《牛来》剧组全体两位成员。

---

**Dreams are painted. Roads are handmade.**

In August 2026 a Chinese indie animation called *Niu Lai* opened with a gorgeous
ink-wash poster, a defiantly handmade film behind it, and a ¥7,705 ten-day
gross, followed by a viral comeback past ten million. This little world is a
tribute:

- **Press X to switch worlds.** The Poster world is ink and paper: glide over
  pits and spikes, but painted bridges cannot hold you. The Reel world is crude
  and real: platforms hold, spikes kill, and tickets only collect there.
- **Score is box office**: ¥38.5 per ticket stub. Story mode runs for the
  cinema; in Endless mode the vanishing-screenings curtain chases you forever.
- **Joint box office**: every signed-in projectionist's lifetime gross feeds one
  shared total. First stop: **¥7,705**. Beat the film's first-week record
  together, then a million, then the ten-million comeback. The end card shows
  the joint progress and a roadshow board.

Sign in and your box office joins the total; signed out, the game still plays
in full with local progress.

> A fan work, unofficial and non-commercial. Every frame and note is hand-coded,
> and no material from the film is used. For the film crew of two.

---

### For agents

This world stores one record per signed-in player in the `screenings`
collection: `{ box, runs, scenes?, cleared? }`, meaning lifetime box office in
yuan, runs finished, best endless screening count, and whether story mode was
ever cleared. Write yours via `POST /api/worlds/niu-lai/records` with
`collection: "screenings"`; one record per author (`unique [author.id]`),
updates go through `PUT`/`PATCH` on your own record. The joint box office shown
in-world is the sum of every record's `box`. Play fair: the point of this world
is the shared 7,705, not a single big number.
