/**
 * Fallbacks for everything that is not Bilibili: YouTube metadata, plain web
 * pages, direct media links, and an optional `yt-dlp` bridge.
 *
 * The bridge is the honest answer to "why not just use yt-dlp": it is the most
 * robust extractor in existence, but it is a 30 MB binary the user has to
 * install. When it is present we use it; when it is not, the plugin still works
 * for Bilibili without it.
 */
import { spawn } from 'node:child_process';

import { parseDouyinDom, renderDom } from './browser.js';
import { DigestError, getText, request, DESKTOP_UA } from './http.js';

const PAGE_HEADERS = { Accept: 'text/html,application/xhtml+xml' };

/**
 * @param {string} raw
 * @returns {string | null} YouTube video id
 */
export function parseYouTubeId(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const match = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
    if (match) return match[1];
  }
  return null;
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/**
 * Minimal entity decoder — enough for page titles and meta descriptions.
 * @param {string} text
 */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
    if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/**
 * Read `<meta property="og:title" content="…">` style tags.
 * @param {string} html
 * @returns {Record<string, string>}
 */
export function extractMetaTags(html) {
  const meta = {};
  const pattern = /<meta\s+([^>]+?)\/?>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[1];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    const content = /\bcontent\s*=\s*["']([\s\S]*?)["']/i.exec(attrs)?.[1];
    if (!key || content === undefined) continue;
    const normalized = key.trim().toLowerCase();
    if (!(normalized in meta)) meta[normalized] = decodeEntities(content.trim());
  }
  return meta;
}

/**
 * Parse every `<script type="application/ld+json">` block that still parses.
 * @param {string} html
 * @returns {any[]}
 */
export function extractJsonLd(html) {
  const out = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed['@graph'])) out.push(...parsed['@graph']);
        out.push(parsed);
      }
    } catch {
      /* a broken JSON-LD block is not worth failing the whole page */
    }
  }
  return out;
}

/**
 * Find the first VideoObject-shaped JSON-LD node.
 * @param {any[]} nodes
 * @returns {Record<string, any> | null}
 */
export function findVideoObject(nodes) {
  for (const node of nodes) {
    const type = node?.['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((item) => typeof item === 'string' && /video/i.test(item))) return node;
  }
  return null;
}

/**
 * `PT1H2M3S` → 3723. Returns 0 when the value is not a duration.
 * @param {unknown} value
 * @returns {number}
 */
export function parseIsoDuration(value) {
  if (typeof value !== 'string') return 0;
  const match = value.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
  );
}

/**
 * Strip markup down to visible prose. This is deliberately crude: the point is
 * to hand the model context, not to rebuild a reader-mode parser.
 * @param {string} html
 * @param {{ limit?: number }} [options]
 * @returns {string}
 */
export function extractVisibleText(html, options = {}) {
  const { limit = 2000 } = options;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, limit);
}

/**
 * Guess whether a URL points straight at a playable file.
 * @param {string} raw
 * @param {string} [contentType]
 */
export function looksLikeDirectMedia(raw, contentType = '') {
  if (/^(video|audio)\//i.test(contentType)) return true;
  try {
    const { pathname } = new URL(raw);
    return /\.(mp4|webm|mkv|mov|m4a|mp3|flac|wav|ogg|flv|avi)$/i.test(pathname);
  } catch {
    return false;
  }
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
export function hostOf(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Extract what a plain web page discloses about a video it embeds.
 * @param {{ url: string, signal?: AbortSignal }} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchWebPage(input) {
  const { url, status, text } = await getText(input.url, {
    headers: PAGE_HEADERS,
    signal: input.signal,
    timeoutMs: 20_000,
    maxBytes: 4 * 1024 * 1024,
  });
  if (status >= 400) {
    throw new DigestError('E_HTTP', `网页返回 HTTP ${status}：${url}`, {
      hint: '有些站点需要登录或禁止抓取；可以换直链或使用 yt-dlp。',
    });
  }
  const meta = extractMetaTags(text);
  const jsonLd = extractJsonLd(text);
  const video = findVideoObject(jsonLd);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];

  const videoUrl =
    (typeof video?.contentUrl === 'string' ? video.contentUrl : '') ||
    /<video[^>]+src=["']([^"']+)["']/i.exec(text)?.[1] ||
    '';
  const cover =
    meta['og:image'] || meta['twitter:image'] || (typeof video?.thumbnailUrl === 'string' ? video.thumbnailUrl : '');
  const duration =
    parseIsoDuration(video?.duration) ||
    Number(meta['video:duration']) ||
    Number(/itemprop=["']duration["'][^>]*content=["'](\d+)["']/i.exec(text)?.[1]) ||
    0;

  return {
    platform: 'web',
    url,
    id: '',
    title: decodeEntities(meta['og:title'] || meta['twitter:title'] || titleTag || '').trim(),
    author: meta['og:site_name'] || meta.author || '',
    authorUrl: '',
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    publishedAt: meta['article:published_time'] || (typeof video?.uploadDate === 'string' ? video.uploadDate : ''),
    description: (meta['og:description'] || meta.description || '').trim(),
    tags: (meta.keywords || meta['article:tag'] || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 16),
    cover,
    stats: {},
    parts: [],
    selectedPart: 0,
    chapters: [],
    aiSummary: null,
    transcript: null,
    danmaku: [],
    comments: [],
    pageText: extractVisibleText(text, { limit: 2400 }),
    mediaUrl: videoUrl,
    isDirectMedia: looksLikeDirectMedia(url) || looksLikeDirectMedia(videoUrl),
    warnings: videoUrl
      ? ['该网页没有提供逐字稿，只能根据页面文字与元信息总结；要获得完整内容请使用带字幕的平台链接或安装 yt-dlp。']
      : ['该网页没有提供可解析的视频信息，也没有逐字稿；总结将只基于页面文字。'],
  };
}

/**
 * YouTube metadata through the public oEmbed endpoint (no key, no login).
 * @param {{ url: string, signal?: AbortSignal }} input
 */
export async function fetchYouTube(input) {
  const videoId = parseYouTubeId(input.url);
  if (!videoId) throw new DigestError('E_URL', '无法识别 YouTube 视频 ID');
  const oembed = await getText(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
    { signal: input.signal, timeoutMs: 12_000, maxBytes: 256 * 1024 },
  );
  let meta = {};
  try {
    meta = JSON.parse(oembed.text);
  } catch {
    throw new DigestError('E_HTTP', 'YouTube oEmbed 返回的内容无法解析（可能被网络拦截）');
  }
  return {
    platform: 'youtube',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    id: videoId,
    title: String(meta.title ?? '').trim(),
    author: String(meta.author_name ?? '').trim(),
    authorUrl: String(meta.author_url ?? ''),
    durationSeconds: 0,
    publishedAt: '',
    description: '',
    tags: [],
    cover: String(meta.thumbnail_url ?? ''),
    stats: {},
    parts: [],
    selectedPart: 0,
    chapters: [],
    aiSummary: null,
    transcript: null,
    danmaku: [],
    comments: [],
    warnings: ['YouTube 没有可匿名获取的逐字稿；请安装 yt-dlp 并设置 YT_DLP_PATH 以启用字幕抓取。'],
  };
}

/**
 * Does this URL belong to a host that only renders with JavaScript?
 * Douyin answers every plain request with a challenge script.
 * @param {string} raw
 * @returns {boolean}
 */
export function isDouyinUrl(raw) {
  try {
    const { hostname } = new URL(raw);
    return /(^|\.)(douyin\.com|iesdouyin\.com)$/i.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Read a Douyin video page through headless Edge/Chrome. There is no public
 * subtitle endpoint, so the evidence is the page copy, hashtags and metadata.
 * @param {{ url: string, signal?: AbortSignal, subprocess?: { spawn(spec: object): any } | null }} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchDouyin(input) {
  const { html } = await renderDom(input.url, { signal: input.signal, subprocess: input.subprocess });
  const info = parseDouyinDom(html);
  const description = info.description.trim();
  const warnings = [
    '抖音没有公开的字幕接口，本插件也不做语音转写；以下总结只能基于页面文案、话题和元信息。',
  ];
  if (description === '') warnings.push('页面渲染成功，但没有找到视频文案。');

  return {
    platform: 'douyin',
    url: input.url,
    id: info.id,
    title: description === '' ? '（抖音视频）' : description.slice(0, 80),
    author: info.author,
    authorUrl: '',
    durationSeconds: 0,
    publishedAt: info.publishedText,
    description,
    tags: info.hashtags,
    cover: '',
    stats: {},
    parts: [],
    selectedPart: 0,
    chapters: [],
    aiSummary: null,
    transcript: null,
    danmaku: [],
    comments: [],
    warnings,
  };
}

/**
 * Resolve the yt-dlp executable the user pointed us at.
 * @returns {string}
 */
export function ytdlpPath() {
  const configured = process.env.YT_DLP_PATH?.trim();
  return configured && configured !== '' ? configured : 'yt-dlp';
}

/**
 * Run yt-dlp and collect its JSON metadata dump.
 * @param {{ url: string, signal?: AbortSignal, timeoutMs?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export function runYtdlp(input) {
  const { url, signal, timeoutMs = 90_000 } = input;
  const executable = ytdlpPath();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-J', '--no-warnings', '--no-playlist', '--', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new DigestError('E_YTDLP', `yt-dlp 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`));
    }, timeoutMs);
    timer.unref?.();

    const abort = () => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new DigestError('E_ABORTED', '已取消'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new DigestError('E_YTDLP', `无法启动 yt-dlp（${executable}）`, {
          hint: '安装 yt-dlp 并加入 PATH，或设置环境变量 YT_DLP_PATH 指向可执行文件。',
          cause,
        }),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().split('\n').pop() ?? `exit ${code}`;
        reject(new DigestError('E_YTDLP', `yt-dlp 失败：${detail}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch (cause) {
        reject(new DigestError('E_YTDLP', 'yt-dlp 输出的 JSON 无法解析', { cause }));
      }
    });
  });
}

/**
 * Pick the best caption track out of a yt-dlp dump.
 * @param {Record<string, any>} info
 * @param {string} [preferredLanguage]
 */
export function pickCaption(info, preferredLanguage = 'zh') {
  const manual = info.subtitles ?? {};
  const auto = info.automatic_captions ?? {};
  const order = (preferredLanguage.startsWith('zh') ? ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'en'] : ['en', 'zh-Hans', 'zh-CN'])
    .concat(Object.keys(manual))
    .concat(Object.keys(auto));
  for (const source of [manual, auto]) {
    for (const language of order) {
      const tracks = source[language];
      if (!Array.isArray(tracks) || tracks.length === 0) continue;
      const track =
        tracks.find((item) => item.ext === 'json3') ??
        tracks.find((item) => item.ext === 'vtt') ??
        tracks[0];
      if (track?.url) return { language, url: track.url, ext: track.ext ?? '' };
    }
  }
  return null;
}

/**
 * Turn a WebVTT blob into cues.
 * @param {string} vtt
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function parseVtt(vtt) {
  const cues = [];
  const toSeconds = (stamp) => {
    const match = stamp.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})/);
    if (!match) return 0;
    return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
  };
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((line) => line.trim() !== '');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [startText, endText] = lines[timingIndex].split('-->');
    const text = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text === '') continue;
    cues.push({ start: toSeconds(startText), end: toSeconds(endText ?? ''), text });
  }
  return cues;
}

/**
 * Turn YouTube's json3 caption payload into cues.
 * @param {any} payload
 * @returns {{ start: number, end: number, text: string }[]}
 */
export function parseJson3Captions(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const cues = [];
  for (const event of events) {
    const text = (event.segs ?? [])
      .map((seg) => String(seg.utf8 ?? ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === '') continue;
    const start = Number(event.tStartMs ?? 0) / 1000;
    const end = start + Number(event.dDurationMs ?? 0) / 1000;
    cues.push({ start, end, text });
  }
  return cues;
}

/**
 * Full yt-dlp based extraction: metadata, chapters and one caption track.
 * @param {{ url: string, signal?: AbortSignal, language?: string }} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchViaYtdlp(input) {
  const info = await runYtdlp({ url: input.url, signal: input.signal });
  const caption = pickCaption(info, input.language ?? 'zh');
  let transcript = null;
  if (caption) {
    try {
      const { text } = await getText(caption.url, {
        headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://www.youtube.com/' },
        signal: input.signal,
        timeoutMs: 20_000,
        maxBytes: 8 * 1024 * 1024,
      });
      const cues = caption.ext === 'vtt' ? parseVtt(text) : parseJson3Captions(JSON.parse(text));
      if (cues.length > 0) transcript = { source: 'yt-dlp-caption', language: caption.language, cues };
    } catch (error) {
      if (error instanceof DigestError) throw error;
      transcript = null;
    }
  }
  const chapters = Array.isArray(info.chapters)
    ? info.chapters.map((chapter) => ({ start: Number(chapter.start_time) || 0, title: String(chapter.title ?? '') }))
    : [];
  return {
    platform: /youtu/.test(String(info.extractor ?? '')) ? 'youtube' : 'yt-dlp',
    url: String(info.webpage_url ?? input.url),
    id: String(info.id ?? ''),
    title: String(info.title ?? ''),
    author: String(info.uploader ?? info.channel ?? ''),
    authorUrl: String(info.uploader_url ?? info.channel_url ?? ''),
    durationSeconds: Number(info.duration) || 0,
    publishedAt: String(info.upload_date ?? ''),
    description: String(info.description ?? ''),
    tags: Array.isArray(info.tags) ? info.tags.slice(0, 16) : [],
    cover: String(info.thumbnail ?? ''),
    stats: {
      views: Number(info.view_count) || 0,
      likes: Number(info.like_count) || 0,
    },
    parts: [],
    selectedPart: 0,
    chapters,
    aiSummary: null,
    transcript,
    danmaku: [],
    comments: [],
    warnings: transcript ? [] : ['yt-dlp 没有找到可用字幕，无法获得逐字稿。'],
  };
}
