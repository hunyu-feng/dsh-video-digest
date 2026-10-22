# dsh-video-digest 本地开发备忘

给"在这台机器上继续开发它的人"看的：当前挂在哪、改完怎么生效、怎么验证、有哪些坑。
面向使用者的说明在 [README.md](./README.md)。

## 它是什么

把"一个视频链接"变成"一份有依据的摘要"的 DSH 插件，注册两个工具：

- `video_digest`：抓材料 → 用宿主当前模型总结 → 返回结构化摘要（headline / summary / keyPoints /
  chapters / basis / confidence / warnings / links）。
- `video_transcript`：只要逐字稿，不要摘要。

关键设计是**不假装看过视频**：拿不到字幕时降级成"章节 + 标签 + 简介 + 弹幕采样 + 热评"的推断式总结，
并在 `basis` / `confidence` / `warnings` 里如实写清楚"没有看到画面与语音"。宁可降置信度，
不编造画面内容。

- 包名 / 目录名 / 仓库名统一为 `dsh-video-digest`
- 仓库：https://github.com/hunyu-feng/dsh-video-digest

## 本地挂载状态（desktop profile）

- 源码目录：`C:\Users\wang7\Documents\deepseek-harness\default-workspace\dsh-video-digest`
- `package.json` 依赖：`"dsh-video-digest": "file:C:/Users/wang7/Documents/deepseek-harness/default-workspace/dsh-video-digest"`
- `dsh.profile.bundles` 中包含 `dsh-video-digest`
- 入口 `index.js`（`inject = ['tools']`），实现全在 `lib/`

模块分工：

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | URL 归一化、平台分发（B 站 / YouTube / 普通网页 / 直链媒体）、`runDigest` / `readTranscript`、输出投影 |
| `lib/bilibili.js` | B 站：view / player/v2 / wbi 签名 / 字幕 / 弹幕（raw-deflate XML）/ 热评 / 标签 |
| `lib/web.js` | YouTube（oEmbed + 可选 yt-dlp）与普通网页的元信息、正文、字幕抽取 |
| `lib/evidence.js` | 把材料渲染成给模型的 evidence 文本，算 `basis` / `confidence` |
| `lib/prompt.js` | 系统提示、user prompt、JSON 解析与规范化、markdown 渲染 |
| `lib/summarize.js` | 模型路由（`agentDefaultModel` / 环境变量 / provider 兜底）与流式取文本 |

## 改完代码怎么生效（最容易踩的坑）

**禁用再启用插件不会重新加载代码。** DSH 用 ESM 加载，模块缓存按绝对路径算，
同一个路径再次 import 拿到的还是旧模块 —— 工具还在，但行为还是旧的。

```bash
# 让新代码上线，三选一：
# 1) 重启 DSH 宿主（最稳）
# 2) 换路径：目录改名 + 改 package.json name / cordis.patch.yml id、name
#    → plugin_manager remove_bundle → install_bundle target=file:<新绝对路径>
# 3) dev 副本：cp -r 出 dsh-video-digest-dev，改 name/patch id/工具名加后缀，
#    ln -s ../dsh-video-digest/node_modules node_modules，再 install_bundle
```

改完记得 `remove_bundle` 掉 dev 副本并删目录，否则工具表里会同时出现
`video_digest` 和 `video_digest_dev`，很容易对着旧的那个调试。

## 模型调用：最容易踩的第二个坑

`ctx.llm.stream()` 的 `messages[].content` **必须是内容块数组**：

```js
messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
```

传裸字符串时，DeepSeek provider 会把它报成 `DeepSeek Messages transport failed`
（`code: TRANSPORT`），换 provider 则报 `content.some is not a function` —— 两个报错都
完全没提"格式不对"，所以这条要记住。见 `lib/summarize.js` 的 `complete()`。

模型路由优先级（`resolveRoute`）：显式参数 → `VIDEO_DIGEST_PROVIDER` + `VIDEO_DIGEST_MODEL`
→ `agentDefaultModel.currentSelection()` → `llm.listProviders()[0]`。

## 怎么验证

```bash
# 单元测试（21 个用例，node --test 自动发现 test/）
node --test

# 只抓材料、不调模型（排查抓取问题最快）
node scripts/smoke.mjs https://www.bilibili.com/video/BV1Xdnc6jEbL
```

GUI 里跑一次真实视频：`video_digest` 传一个 B 站 BV 链接，看返回里的 `basis` 与 `warnings`
是否和实际拿到的材料一致。带 `SESSDATA` 时（`BILI_COOKIE`）应能看到 `transcript` 依据升到 high。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `BILI_COOKIE` / `BILIBILI_COOKIE` | B 站 `SESSDATA`（缺 `SESSDATA=` 前缀会自动补）。配上才能拿字幕列表与官方 AI 总结 |
| `YT_DLP_PATH` | yt-dlp 可执行文件路径，用于 YouTube 字幕/其他平台的抓取 |
| `VIDEO_DIGEST_PROVIDER` / `VIDEO_DIGEST_MODEL` | 指定总结用的模型，默认跟随宿主当前选择 |

## 已知限制

- **无 cookie 时 B 站拿不到字幕**（`player/v2` 的 `subtitle.subtitles` 为空），所以中文长视频
  的摘要基于章节/弹幕/热评推断，`confidence` 是 medium，`warnings` 会说明。
- 官方 AI 总结（`conclusion/get`）需要登录，匿名返回 `-101 账号未登录`。
- 本机 `www.youtube.com` 不可达（直连超时），YouTube 路径只在有代理时才有意义；
  直链媒体（mp4 等）会直接抛 `E_MEDIA`，本插件不做下载、转写。
- 没有 ASR：插件不下载音视频、不做语音识别，字幕是唯一的高置信逐字稿来源。
- B 站接口随时可能变（尤其是 wbi 签名与 player/v2 的字段），冒烟脚本要常跑。

## 改名历史

- 2026-10-22：目录 `video-digest` → `dsh-video-digest`，与包名/仓库名统一
  （改名同时也换掉了 ESM 模块路径，让修复后的代码在不停机的情况下上线）。
