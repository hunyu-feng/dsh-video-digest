/**
 * Bilibili extractor.
 *
 * Two facts shaped this module:
 *   1. Everything works without a cookie except subtitles and the native AI
 *      recap — those need a logged-in `SESSDATA`.
 *   2. Without a login the site still exposes a surprisingly good outline:
 *      chapters (`view_points`), tags, the full description, live danmaku and
 *      top comments. That is what the summarizer falls back to, and it says so
 *      in its caveat instead of pretending it watched the video.
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

import { DigestError, getJson, getText, request } from './http.js';

const API = {
  view: 'https://api.bilibili.com/x/web-interface/view',
  player: 'https://api.bilibili.com/x/player/v2',
  conclusion: 'https://api.bilibili.com/x/web-interface/view/conclusion/get',
  tags: 'https://api.bilibili.com/x/tag/archive/tags',
  replies: 'https://api.bilibili.com/x/v2/reply',
  danmaku: 'https://api.bilibili.com/x/v1/dm/list.so',
  nav: 'https://api.bilibili.com/x/web-interface/nav',
};

/** Requests to the content API look like they came from the video page itself. */
const SITE_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
};

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn']);

/**
 * Does this URL belong to Bilibili?
 * @param {string} raw
 * @returns {boolean}
 */
export function isBilibiliUrl(raw) {
  try {
    const { hostname } = new URL(raw);
    return /(^|\.)bilibili\.com$/i.test(hostname) || SHORT_HOSTS.has(hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Read the video id out of any Bilibili video URL shape.
 * @param {string} raw
 * @returns {{ bvid?: string, aid?: string, page: number, short: boolean, url: string } | null}
 */
export function parseBilibiliUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) return { page: 1, short: true, url: url.href };

  const pageParam = Number(url.searchParams.get('p'));
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

  const match = url.pathname.match(/\/(?:video|list)\/(BV[0-9A-Za-z]{10}|av\d+)/i);
  if (!match) return null;
  const id = match[1];
  if (/^BV/i.test(id)) return { bvid: id, page, short: false, url: url.href };
  return { aid: id.slice(2), page, short: false, url: url.href };
}

/**
 * Bilibili signs `wbi` endpoints with md5(sorted params + a per-session mixin
 * key). Reproducing it is the only way to reach the AI recap endpoint.
 * @param {Record<string, string | number>} params
 * @param {string} mixinKey
 * @returns {string} query string including `wts` and `w_rid`
 */
export function signWbi(params, mixinKey) {
  const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(withTs)
    .sort()
    .map((key) => {
      const value = String(withTs[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const rid = createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${rid}`;
}

/**
 * Derive the mixin key from the two keys advertised by `nav`.
 * @param {string} imgKey
 * @param {string} subKey
 * @returns {string}
 */
export function mixinKeyFrom(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32);
}

let mixinCache = { value: '', expiresAt: 0 };

/**
 * Fetch (and cache) the current mixin key. `nav` answers without a cookie.
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function currentMixinKey(signal) {
  if (mixinCache.value && mixinCache.expiresAt > Date.now()) return mixinCache.value;
  const nav = await getJson(API.nav, { headers: SITE_HEADERS, signal, timeoutMs: 12_000 });
  const imgUrl = nav?.data?.wbi_img?.img_url ?? '';
  const subUrl = nav?.data?.wbi_img?.sub_url ?? '';
  const keyOf = (value) => value.split('/').pop()?.split('.')[0] ?? '';
  const mixin = mixinKeyFrom(keyOf(imgUrl), keyOf(subUrl));
  if (mixin.length === 32) mixinCache = { value: mixin, expiresAt: Date.now() + 2 * 60 * 60 * 1000 };
  return mixin;
}

/** Strip the CDATA-ish wrappers danmaku text occasionally carries. */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Danmaku XML arrives as a raw-deflate buffer (older path) or plain text.
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeDanmakuBuffer(buffer) {
  if (buffer.length === 0) return '';
  const head = buffer.subarray(0, 2).toString('latin1');
  if (buffer.subarray(0, 5).toString('latin1') === '<?xml') return buffer.toString('utf8');
  const attempts = [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync];
  for (const inflate of attempts) {
    try {
      const text = inflate(buffer).toString('utf8');
      if (text.includes('<d ') || text.includes('<?xml')) return text;
    } catch {
      /* try the next codec */
    }
  }
  if (head === '<d' || head === '<i') return buffer.toString('utf8');
  return buffer.toString('utf8');
}

/**
 * Parse `<d p="time,mode,size,color,ts,mode2,uid,...">text</d>` entries.
 * @param {string} xml
 * @returns {{ t: number, text: string }[]}
 */
export function parseDanmakuXml(xml) {
  const out = [];
  const pattern = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const seconds = Number(match[1].split(',')[0]);
    const text = decodeEntities(match[2].replace(/<[^>]+>/g, '')).trim();
    if (!Number.isFinite(seconds) || text === '') continue;
    out.push({ t: seconds, text });
  }
  return out;
}

/**
 * Build a readable, timeline-anchored danmaku sample. Raw dumps are dominated
 * by memes ("哈哈", "1"); the sample keeps lines that carry actual words and
 * spaces them across the whole runtime so the model sees the whole arc.
 * @param {{ t: number, text: string }[]} entries
 * @param {{ limit?: number, minLength?: number }} [options]
 * @returns {{ t: number, text: string }[]}
 */
export function sampleDanmaku(entries, options = {}) {
  const { limit = 80, minLength = 6 } = options;
  const seen = new Set();
  const useful = entries
    .map((entry) => ({ t: entry.t, text: entry.text.replace(/\s+/g, ' ').trim() }))
    .filter((entry) => {
      if (entry.text.length < minLength) return false;
      if (/^[\d\s.。?？!！哈啊哦额嗯～~]+$/.test(entry.text)) return false;
      if (seen.has(entry.text)) return false;
      seen.add(entry.text);
      return true;
    })
    .sort((a, b) => a.t - b.t);
  if (useful.length <= limit) return useful;
  const step = useful.length / limit;
  const sample = [];
  for (let index = 0; index < limit; index += 1) {
    sample.push(useful[Math.floor(index * step)]);
  }
  return sample;
}

/**
 * Download and normalize one subtitle track.
 * @param {{ subtitle_url: string, lan: string, lan_doc: string }} track
 * @param {{ cookie?: string, signal?: AbortSignal }} options
 * @returns {Promise<{ source: string, language: string, cues: { start: number, end: number, text: string }[] }>}
 */
async function fetchSubtitleTrack(track, options) {
  const url = track.subtitle_url.startsWith('//') ? `https:${track.subtitle_url}` : track.subtitle_url;
  const payload = await getJson(url, {
    headers: { ...SITE_HEADERS, ...(options.cookie ? { Cookie: options.cookie } : {}) },
    signal: options.signal,
    timeoutMs: 15_000,
  });
  const cues = (payload?.body ?? [])
    .map((line) => ({
      start: Number(line.from) || 0,
      end: Number(line.to) || Number(line.from) || 0,
      text: String(line.content ?? '').trim(),
    }))
    .filter((line) => line.text !== '');
  return {
    source: 'bilibili-subtitle',
    language: track.lan_doc || track.lan || 'unknown',
    cues,
  };
}

/**
 * Prefer human-made Mandarin subtitles, then any human track, then the AI one.
 * @param {{ lan: string, lan_doc: string, subtitle_url: string }[]} tracks
 */
export function pickSubtitleTrack(tracks) {
  const rank = (track) => {
    const ai = /^ai-/i.test(track.lan) ? 1 : 0;
    const chinese = /^zh/i.test(track.lan) || /中文|汉语|简体|繁体/.test(track.lan_doc) ? 0 : 1;
    return ai * 10 + chinese;
  };
  return [...tracks].filter((track) => track.subtitle_url).sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The native "AI 视频总结" payload, when the caller supplied a login cookie.
 * @param {{ bvid: string, cid: number, upMid: number, cookie: string, signal?: AbortSignal }} input
 */
async function fetchAiRecap(input) {
  const mixinKey = await currentMixinKey(input.signal);
  const query = signWbi({ bvid: input.bvid, cid: input.cid, up_mid: input.upMid }, mixinKey);
  const payload = await getJson(`${API.conclusion}?${query}`, {
    headers: { ...SITE_HEADERS, Cookie: input.cookie },
    signal: input.signal,
    timeoutMs: 15_000,
  });
  if (payload?.code !== 0) return { summary: '', outline: [], reason: payload?.message ?? `code ${payload?.code}` };
  const result = payload?.data?.model_result;
  if (payload?.data?.code !== 0 || !result) {
    return { summary: '', outline: [], reason: payload?.data?.message ?? '该视频暂无 AI 总结' };
  }
  const outline = (result.outline ?? []).map((chapter) => ({
    title: String(chapter.title ?? '').trim(),
    points: (chapter.part_outline ?? []).map((point) => ({
      time: Number(point.timestamp) || 0,
      text: String(point.content ?? '').trim(),
    })),
  }));
  return { summary: String(result.summary ?? '').trim(), outline, reason: '' };
}

/**
 * Everything we can learn about one Bilibili video.
 * @param {{
 *   url: string,
 *   page?: number,
 *   cookie?: string,
 *   signal?: AbortSignal,
 *   withComments?: boolean,
 * }} input
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchBilibili(input) {
  const parsed = parseBilibiliUrl(input.url);
  if (!parsed) throw new DigestError('E_URL', '无法从链接中识别出 B 站视频号（支持 /video/BV… 或 /video/av…）');

  let target = parsed;
  if (parsed.short) {
    // b23.tv short links only resolve through a redirect.
    const hop = await request(parsed.url, { headers: SITE_HEADERS, signal: input.signal, maxBytes: 256 * 1024 });
    target = parseBilibiliUrl(hop.url) ?? { page: 1, short: false, url: hop.url };
    if (!target.bvid && !target.aid) {
      throw new DigestError('E_URL', `短链接未能解析到视频页：${hop.url}`);
    }
  }

  const viewQuery = target.bvid ? `bvid=${target.bvid}` : `aid=${target.aid}`;
  const view = await getJson(`${API.view}?${viewQuery}`, {
    headers: SITE_HEADERS,
    signal: input.signal,
    timeoutMs: 15_000,
  });
  if (view?.code !== 0 || !view?.data) {
    const hint =
      view?.code === -404
        ? '视频不存在、已删除，或需要登录才能观看。'
        : view?.code === -403
          ? '该视频对当前地区或未登录用户不可见。'
          : '可能是风控拦截，稍后重试或换一个链接。';
    throw new DigestError('E_BILIBILI', `B 站接口返回 ${view?.code ?? '?'}：${view?.message ?? '未知错误'}`, { hint });
  }

  const data = view.data;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const pageIndex = Math.min(Math.max((input.page ?? target.page ?? 1) - 1, 0), Math.max(pages.length - 1, 0));
  const page = pages[pageIndex] ?? { cid: data.cid, part: data.title, duration: data.duration };
  const cid = Number(page.cid ?? data.cid);
  const warnings = [];
  const cookieHeaders = input.cookie ? { ...SITE_HEADERS, Cookie: input.cookie } : SITE_HEADERS;

  const player = await getJson(`${API.player}?bvid=${data.bvid}&cid=${cid}`, {
    headers: cookieHeaders,
    signal: input.signal,
    timeoutMs: 15_000,
  }).catch((error) => {
    warnings.push(`播放器接口不可用：${error.message}`);
    return null;
  });

  const subtitleTracks = player?.data?.subtitle?.subtitles ?? [];
  const viewPoints = player?.data?.view_points ?? [];

  const chapters =
    viewPoints.length > 0
      ? viewPoints.map((point) => ({ start: Number(point.from) || 0, title: String(point.content ?? '').trim() }))
      : (data.desc_v2?.[0]?.desc ?? data.desc ?? '')
          .split('\n')
          .map((line) => line.match(/^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–—:：]?\s*(.+)$/))
          .filter(Boolean)
          .map((match) => ({
            start:
              match[3] === undefined
                ? Number(match[1]) * 60 + Number(match[2])
                : Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
            title: match[4].trim(),
          }));

  let transcript = null;
  const track = pickSubtitleTrack(subtitleTracks);
  if (track) {
    try {
      const downloaded = await fetchSubtitleTrack(track, { cookie: input.cookie, signal: input.signal });
      if (downloaded.cues.length > 0) transcript = downloaded;
      else warnings.push('字幕轨道为空，未能获得逐字稿。');
    } catch (error) {
      warnings.push(`字幕下载失败：${error.message}`);
    }
  } else if (!input.cookie) {
    warnings.push('未登录 B 站，看不到字幕列表（字幕接口需要 SESSDATA）。');
  }

  let aiSummary = null;
  if (input.cookie) {
    try {
      const recap = await fetchAiRecap({
        bvid: data.bvid,
        cid,
        upMid: Number(data.owner?.mid) || 0,
        cookie: input.cookie,
        signal: input.signal,
      });
      if (recap.summary) aiSummary = recap;
      else if (recap.reason) warnings.push(`B 站 AI 总结不可用：${recap.reason}`);
    } catch (error) {
      warnings.push(`B 站 AI 总结请求失败：${error.message}`);
    }
  }

  const evidence = {
    platform: 'bilibili',
    url: `https://www.bilibili.com/video/${data.bvid}${pages.length > 1 ? `?p=${pageIndex + 1}` : ''}`,
    id: data.bvid,
    title: String(data.title ?? '').trim(),
    author: String(data.owner?.name ?? '').trim(),
    authorUrl: data.owner?.mid ? `https://space.bilibili.com/${data.owner.mid}` : '',
    durationSeconds: Number(page.duration ?? data.duration) || 0,
    publishedAt: data.pubdate ? new Date(Number(data.pubdate) * 1000).toISOString() : '',
    description: String(data.desc ?? '').trim(),
    tags: [],
    cover: String(data.pic ?? ''),
    stats: {
      views: Number(data.stat?.view) || 0,
      likes: Number(data.stat?.like) || 0,
      coins: Number(data.stat?.coin) || 0,
      favorites: Number(data.stat?.favorite) || 0,
      shares: Number(data.stat?.share) || 0,
      danmaku: Number(data.stat?.danmaku) || 0,
      replies: Number(data.stat?.reply) || 0,
    },
    parts:
      pages.length > 1
        ? pages.map((item, index) => ({ index: index + 1, title: String(item.part ?? '').trim(), duration: Number(item.duration) || 0 }))
        : [],
    selectedPart: pages.length > 1 ? pageIndex + 1 : 0,
    chapters,
    aiSummary,
    transcript,
    danmaku: [],
    comments: [],
    warnings,
  };

  const tasks = [];
  tasks.push(
    getJson(`${API.tags}?bvid=${data.bvid}`, { headers: SITE_HEADERS, signal: input.signal, timeoutMs: 12_000 })
      .then((tags) => {
        if (tags?.code === 0 && Array.isArray(tags.data)) {
          evidence.tags = tags.data.map((tag) => String(tag.tag_name ?? '').trim()).filter(Boolean).slice(0, 20);
        }
      })
      .catch(() => {}),
  );

  if (!transcript && !aiSummary) {
    if (input.withDanmaku !== false) {
      tasks.push(
        request(`${API.danmaku}?oid=${cid}`, {
          headers: SITE_HEADERS,
          signal: input.signal,
          timeoutMs: 20_000,
          maxBytes: 8 * 1024 * 1024,
        })
          .then(({ buffer }) => {
            // The endpoint answers raw-deflate XML, not JSON.
            const parsedDanmaku = parseDanmakuXml(decodeDanmakuBuffer(buffer));
            evidence.danmaku = sampleDanmaku(parsedDanmaku);
          })
          .catch(() => {}),
      );
    }
    if (input.withComments !== false) {
      tasks.push(
        getJson(`${API.replies}?type=1&oid=${data.aid}&sort=2&ps=20&pn=1`, {
          headers: SITE_HEADERS,
          signal: input.signal,
          timeoutMs: 15_000,
        })
          .then((payload) => {
            const replies = payload?.data?.replies ?? [];
            evidence.comments = replies
              .map((reply) => ({
                author: String(reply.member?.uname ?? '').trim(),
                text: String(reply.content?.message ?? '').replace(/\s+/g, ' ').trim(),
                likes: Number(reply.like) || 0,
              }))
              .filter((reply) => reply.text !== '')
              .sort((a, b) => b.likes - a.likes)
              .slice(0, 10)
              .map((reply) => ({ ...reply, text: reply.text.slice(0, 180) }));
          })
          .catch(() => {}),
      );
    }
  }

  await Promise.allSettled(tasks);
  return evidence;
}
