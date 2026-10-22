# dsh-video-digest · 视频速读

把视频链接丢给 DSH，拿回一份**带依据的**总结：它读什么、没读到什么，都会写在结果里。

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 插件，注册两个工具：

| 工具 | 作用 |
| --- | --- |
| `video_digest` | 链接 → 抓取可读材料 → 调用当前默认模型 → 结构化总结（标题、一句话结论、正文、要点、时间线、依据、置信度） |
| `video_transcript` | 链接 → 只取带时间码的字幕逐字稿，不调用模型 |

支持 B 站（BV/av、多分 P、`b23.tv` 短链）、YouTube，以及任何带视频元信息的普通网页；装了 yt-dlp 之后还能抓更多站点的字幕。

## 它到底"看"了什么

这是本插件最重要的设计取舍：**它不解码画面和音频**（那需要 ffmpeg + 语音识别模型，代价和失败率都高得多），而是按可用性从高到低找材料，然后在结果里如实标注用了哪一档。

| 材料 | 需要什么 | 强度 |
| --- | --- | --- |
| 字幕逐字稿 | B 站登录 cookie（`SESSDATA`）/ yt-dlp | 高 —— 真正逐字读完 |
| B 站官方 AI 总结 | B 站登录 cookie | 高 |
| 章节（`view_points`）、简介、标签 | 不需要 | 中 |
| 弹幕采样 + 热评 | 不需要 | 低，只作侧写 |
| 页面正文 / OG 元信息 | 不需要 | 视页面而定 |

因此输出里永远有 `basis`（依据）和 `confidence`（high / medium / low），没有任何字幕时 `warnings` 会写明"未获得逐字稿"。**它不会假装自己看了视频。**

弹幕不是原样塞给模型：先按长度和内容过滤掉"哈哈""1""？"这类噪音并去重，再沿整条时间轴均匀采样，让模型看到的是全程走向而不是开场刷屏。

## 安装

插件以 bundle 形式声明（`package.json` 里的 `dsh.bundle.patch` → `cordis.patch.yml`），装进 DSH 的 profile 即可：

1. 在 DSH 里打开 **插件 → 安装本地插件包**（或让 agent 调用 `plugin_manager` 的 `install_bundle`）；
2. 包目录选择本仓库根目录；
3. 重启会话后，工具列表里出现 `video_digest` 和 `video_transcript`。

卸载：在插件列表里禁用或移除 `dsh-video-digest` 即可，工具会随之卸载（插件是 fiber 作用域）。

## 用法

直接用自然语言：

> 帮我总结这个视频 https://www.bilibili.com/video/BV1Xdnc6jEbL

> 这个视频的核心论点是什么？只看技术细节 https://youtu.be/xxxxxxxxxxx

模型会调用 `video_digest`。需要原文引用时：

> 把 BV1Xdnc6jEbL 的字幕原文取出来

调用 `video_transcript`。

参数：

- `url`（必填）：视频页链接
- `focus`：想看的角度，例如"核心论证""代码实现"
- `language`：输出语言，默认简体中文
- `detail`：`brief` / `standard` / `detailed`（detailed 会送更多逐字稿进模型）
- `page`：B 站多分 P 时看第几 P
- `cookie`：B 站 `SESSDATA`，建议改用环境变量

## 配置

| 环境变量 | 作用 |
| --- | --- |
| `BILI_COOKIE` | B 站 `SESSDATA`（可只填值，也可填完整 cookie 串）。设置后解锁字幕逐字稿与官方 AI 总结 |
| `YT_DLP_PATH` | 指向 `yt-dlp` 可执行文件。设置后 YouTube 及其他站点走 yt-dlp 抓字幕；B 站没拿到字幕时也会尝试用它补 |
| `VIDEO_DIGEST_PROVIDER` + `VIDEO_DIGEST_MODEL` | 覆盖总结用的模型路由；默认跟随 DSH 当前的 `agentDefaultModel` |

插件自己**不保存任何 API key**：总结走 DSH 已经在用的 provider/model，所以你换了默认模型它也照常工作。

## 输出示例

```json
{
  "title": "中文已死：为什么我们越来越不敢好好说话？",
  "platform": "bilibili",
  "author": "大圆镜科普",
  "durationSeconds": 427,
  "headline": "用热梗代替表达，让语言在省力中磨损",
  "summary": "……",
  "keyPoints": ["……"],
  "chapters": [{ "time": "0:00", "title": "热梗是压缩包", "startSeconds": 0 }],
  "basis": "基于章节、弹幕、热评（未获得逐字稿）",
  "confidence": "medium",
  "warnings": ["未登录 B 站，看不到字幕列表（字幕接口需要 SESSDATA）。"],
  "model": "deepseek-account/deepseek-flash"
}
```

## 开发

```bash
node --test            # 21 个单元测试：URL 解析、wbi 签名、弹幕 inflate/XML、VTT、JSON 还原
node scripts/smoke.mjs https://www.bilibili.com/video/BV1Xdnc6jEbL   # 真实抓取，不调用模型
BILI_COOKIE=... node scripts/smoke.mjs <url>                         # 顺便验证字幕路径
```

代码结构：

```
index.js          插件入口：注册 video_digest / video_transcript，声明输出 schema
lib/index.js      分发器：平台识别、yt-dlp 兜底、digest 流水线
lib/bilibili.js   B 站：view → player/v2 → 字幕 / AI 总结 / 章节 / 弹幕 / 热评，含 wbi 签名
lib/web.js        YouTube oEmbed、通用网页元信息、yt-dlp、VTT / json3 字幕解析
lib/evidence.js   材料 → 提示词文本；依据、置信度、时间码格式化
lib/prompt.js     提示词、JSON 还原、结果规范化、markdown 渲染
lib/summarize.js  模型路由解析与流式调用（复用宿主 llm 服务）
lib/http.js       带超时/体积上限的 fetch，统一错误码
```

## 局限

- 无登录时 B 站字幕接口返回空列表——这是接口行为，不是 bug；
- 无法直连 YouTube 的网络里，YouTube 链接会明确报错并给出提示；
- 不下载、不转写音频，因此没有字幕的视频只能得到侧写式总结；
- 依赖平台未公开接口，平台改版时可能失效，`scripts/smoke.mjs` 是最快的自查手段。

## License

MIT
