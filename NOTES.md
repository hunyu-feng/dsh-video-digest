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

- 源码目录：`C:\Users\wang7\Documents\deepseek-harness\default-workspace\plugins\dsh-video-digest`
- `package.json` 依赖：`"dsh-video-digest": "file:C:/Users/wang7/Documents/deepseek-harness/default-workspace/plugins/dsh-video-digest"`
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
→ **插件配置文件** → `agentDefaultModel.currentSelection()` → `llm.listProviders()[0]`。

插件配置文件（只影响本插件，不动全局默认）：

```
~/.dsh-video-digest/config.json     # 或 $DSH_VIDEO_DIGEST_CONFIG
{ "provider": "deepseek-account", "model": "deepseek-v4-pro", "reasoningEffort": "max" }
```

`reasoningEffort` 可选；省略时用模型默认档位。改完不需要重启宿主——每次调用都会重新读文件。

### 第三个坑：推理模型会先把 token 预算吃掉

默认模型是带 reasoning 的 `deepseek-flash`（`reasoningEffort: max`）。`maxTokens` 只给
900 / 1600 时，思考阶段就把额度用完，`text-delta` 一个都没有，工具会报
`E_MODEL_EMPTY`（"模型返回了空内容"）；给到 2400 时能出正文，但 JSON 被截断在中间。

所以 `DETAIL_MAX_TOKENS` 现在是 `brief 3000 / standard 5000 / detailed 8000`，并且在
`finish.reason.kind === 'max-tokens'` 时往 `warnings` 里写一条"总结可能被截断"。
换更省 token 的模型或调低 reasoningEffort 后，这三个数可以再压。

## 抖音：无头浏览器渲染（以及它的坑）

抖音对普通 HTTP 请求返回的是 72KB 的 JS 挑战脚本（body 为空），`iesdouyin` 旧接口返回空，
`aweme/v1/web/aweme/detail` 直接 403，oEmbed 也是空。所以 `lib/browser.js` 走浏览器渲染：

```
msedge --headless=new --no-sandbox --dump-dom --virtual-time-budget=10000 <url>
```

- 用**临时 profile**（`mkdtemp` 在系统临时目录），不碰用户自己的浏览器配置；不需要 cookie。
- 解析 `data-e2e="detail-video-info"` 里的 `<h1>` 取文案、`live-avatar` 的 `alt` 取作者、
  `detail-video-publish-time` 取发布时间，话题从 `#...` 里补全。
- **坑**：在 DSH 桌面宿主里 `child_process.spawn(msedge.exe)` 会立刻退出（exit 0、无输出、
  约 100–500ms），走 `ctx.subprocess` 服务也一样，`--no-sandbox` 与换 cwd 都无效；
  同样的命令在终端里（`node scripts/smoke.mjs <链接>`）完全正常。判断是宿主进程环境不允许
  直接拉起浏览器。插件因此把抖音失败降级成一条 warning，并给出 CLI 兜底提示。
- 排查时看 `%TEMP%\dsh-video-digest-render.log`：每次渲染的 `phase`、`mode`（service/node）、
  `exitCode`、`bytes`、stderr 尾部都在里面。
- 抖音没有字幕，插件也不做语音转写，所以拿到的是文案/话题/发布时间，而不是逐字稿。

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
- 2026-10-22（晚）：工作区被清空、profile 被重置，源码从 GitHub tarball 恢复到
  `plugins/dsh-video-digest` 后重新 `install_bundle`；同时把 token 预算调大（见上文第三个坑）。
