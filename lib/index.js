/**
 * The plugin's core: pick an extractor for the link, read what can be read,
 * then hand the material to the configured model.
 *
 * Everything here is plain functions so `test/` can exercise it without a host.
 * The objects returned by `runDigest` / `readTranscript` are the tool output
 * contract: every key is declared in `index.js`, so keep them in sync.
 */
import { DigestError } from './http.js';
import { fetchBilibili, isBilibiliUrl } from './bilibili.js';
import { fetchDouyin, fetchViaYtdlp, fetchWebPage, fetchYouTube, isDouyinUrl, looksLikeDirectMedia, parseYouTubeId } from './web.js';
import {
  buildEvidenceText,
  confidenceOf,
  describeBasis,
  evidenceKinds,
  formatClock,
  renderTranscript,
} from './evidence.js';
import {
  SYSTEM_PROMPT,
  basisWithChars,
  buildUserPrompt,
  metadataOnlyDigest,
  normalizeDigest,
} from './prompt.js';
import { complete, resolveRoute } from './summarize.js';

// Reasoning models spend part of this budget before emitting the answer, so the
// numbers are deliberately generous: at 900/1600 the JSON reply came back empty
// or cut in half, because the reasoning phase alone used the whole allowance.
const DETAIL_MAX_TOKENS = { brief: 3_000, standard: 5_000, detailed: 8_000 };
const DETAIL_MAX_EVIDENCE_CHARS = { brief: 10_000, standard: 14_000, detailed: 20_000 };
const DETAILS = ['brief', 'standard', 'detailed'];

/**
 * @param {string} raw
 * @returns {URL}
 */
export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    throw new DigestError('E_URL', '缺少视频链接', {
      hint: '传一个 http(s) 链接，例如 https://www.bilibili.com/video/BV…',
    });
  }
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol)) throw new Error('unsupported protocol');
    return url;
  } catch {
    throw new DigestError('E_URL', `无法解析链接：${text}，只支持 http/https 链接`);
  }
}

/** @returns {boolean} */
function ytdlpConfigured() {
  return Boolean(process.env.YT_DLP_PATH?.trim());
}

/**
 * Copy what yt-dlp found into an evidence object that another extractor built.
 * Metadata already present wins: the platform API is more accurate than yt-dlp.
 * @param {Record<string, any>} evidence
 * @param {Record<string, any>} extra
 */
export function mergeEvidence(evidence, extra) {
  const merged = { ...evidence };
  if (!merged.transcript && extra.transcript) merged.transcript = extra.transcript;
  if (!merged.chapters?.length && extra.chapters?.length) merged.chapters = extra.chapters;
  if (!merged.description && extra.description) merged.description = extra.description;
  if (!merged.durationSeconds && extra.durationSeconds) merged.durationSeconds = extra.durationSeconds;
  if (!merged.publishedAt && extra.publishedAt) merged.publishedAt = extra.publishedAt;
  return merged;
}

/**
 * @param {string} url
 * @param {{
 *   cookie?: string,
 *   page?: number,
 *   language?: string,
 *   signal?: AbortSignal,
 *   withDanmaku?: boolean,
 *   withComments?: boolean,
 * }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function extractEvidence(url, options = {}) {
  const href = normalizeUrl(url).href;
  const warnings = [];

  if (isBilibiliUrl(href)) {
    let evidence = await fetchBilibili({
      url: href,
      page: options.page,
      cookie: options.cookie,
      signal: options.signal,
      withDanmaku: options.withDanmaku,
      withComments: options.withComments,
    });
    if (!evidence.transcript && ytdlpConfigured()) {
      try {
        evidence = mergeEvidence(evidence, await fetchViaYtdlp({ url: href, signal: options.signal, language: options.language }));
      } catch (error) {
        if (error?.code === 'E_ABORTED') throw error;
        warnings.push(`yt-dlp 补抓字幕失败：${error.message}`);
      }
    }
    if (warnings.length > 0) evidence.warnings = [...(evidence.warnings ?? []), ...warnings];
    return evidence;
  }

  if (isDouyinUrl(href)) {
    // Douyin only exists after JavaScript runs; render it in headless Edge/Chrome.
    try {
      return await fetchDouyin({ url: href, signal: options.signal, subprocess: options.subprocess });
    } catch (error) {
      if (error?.code === 'E_ABORTED') throw error;
      warnings.push(`抖音页面渲染失败：${error.message}${error.hint ? `（${error.hint}）` : ''}`);
    }
  }

  if (parseYouTubeId(href)) {
    if (ytdlpConfigured()) {
      try {
        return await fetchViaYtdlp({ url: href, signal: options.signal, language: options.language });
      } catch (error) {
        if (error?.code === 'E_ABORTED') throw error;
        warnings.push(`yt-dlp 失败，退回元信息：${error.message}`);
      }
    }
    const evidence = await fetchYouTube({ url: href, signal: options.signal });
    return { ...evidence, warnings: [...(evidence.warnings ?? []), ...warnings] };
  }

  if (ytdlpConfigured()) {
    try {
      return await fetchViaYtdlp({ url: href, signal: options.signal, language: options.language });
    } catch (error) {
      if (error?.code === 'E_ABORTED') throw error;
      warnings.push(`yt-dlp 失败，退回网页抓取：${error.message}`);
    }
  }

  if (looksLikeDirectMedia(href)) {
    throw new DigestError('E_MEDIA', '这是一个媒体直链，插件无法直接转写音视频', {
      hint: '改用平台的视频页链接；或安装 yt-dlp 并设置 YT_DLP_PATH，插件会用它抓字幕。',
    });
  }

  const evidence = await fetchWebPage({ url: href, signal: options.signal });
  return { ...evidence, warnings: [...(evidence.warnings ?? []), ...warnings] };
}

/**
 * Project a digest onto the exact tool-output shape declared in `index.js`.
 * @param {Record<string, any>} base
 * @param {{ detail: string, evidenceChars: number, evidenceKinds: string[], truncated: boolean, error?: string }} extra
 */
function finalizeDigest(base, extra) {
  return {
    title: String(base.title ?? ''),
    url: String(base.url ?? ''),
    platform: String(base.platform ?? ''),
    author: String(base.author ?? ''),
    durationSeconds: Math.max(0, Math.round(Number(base.durationSeconds) || 0)),
    publishedAt: String(base.publishedAt ?? ''),
    headline: String(base.headline ?? ''),
    summary: String(base.summary ?? ''),
    keyPoints: Array.isArray(base.keyPoints) ? base.keyPoints.map(String) : [],
    chapters: Array.isArray(base.chapters)
      ? base.chapters.map((chapter) => ({
          time: String(chapter?.time ?? ''),
          title: String(chapter?.title ?? ''),
          startSeconds: Math.max(0, Math.round(Number(chapter?.startSeconds) || 0)),
        }))
      : [],
    basis: String(base.basis ?? ''),
    confidence: String(base.confidence ?? 'low'),
    transcriptChars: Math.max(0, Math.round(Number(base.transcriptChars) || 0)),
    warnings: Array.isArray(base.warnings) ? base.warnings.map(String) : [],
    model: String(base.model ?? ''),
    elapsedMs: Math.max(0, Math.round(Number(base.elapsedMs) || 0)),
    detail: extra.detail,
    evidenceChars: Math.max(0, Math.round(extra.evidenceChars)),
    evidenceKinds: extra.evidenceKinds,
    truncated: Boolean(extra.truncated),
    error: String(extra.error ?? ''),
  };
}

/**
 * Full pipeline: link → evidence → summary.
 * @param {{ get(service: string): any }} ctx
 * @param {Record<string, any>} args
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function runDigest(ctx, args, options = {}) {
  const startedAt = Date.now();
  const detail = DETAILS.includes(args?.detail) ? args.detail : 'standard';
  const language = String(args?.language ?? '简体中文').trim() || '简体中文';

  const evidence = await extractEvidence(args?.url, {
    cookie: args?.cookie,
    page: args?.page,
    language,
    signal: options.signal,
    subprocess: options.subprocess ?? ctx?.get?.('subprocess'),
  });

  const built = buildEvidenceText(evidence, { maxChars: DETAIL_MAX_EVIDENCE_CHARS[detail] });
  const basis = basisWithChars(evidence, { chars: built.transcriptChars });
  const kinds = evidenceKinds(evidence);
  const confidence = confidenceOf(evidence);
  const extra = {
    detail,
    evidenceChars: built.text.length,
    evidenceKinds: kinds,
    truncated: built.truncated,
  };

  let route;
  try {
    route = resolveRoute(ctx, { provider: args?.provider, model: args?.model });
  } catch (error) {
    return finalizeDigest(
      metadataOnlyDigest(evidence, {
        reason: `没有可用模型，只返回抓取到的材料：${error.message}`,
        basis,
        confidence,
        transcriptChars: built.transcriptChars,
      }),
      { ...extra, error: error?.code ?? 'E_NO_MODEL' },
    );
  }

  const prompt = buildUserPrompt(evidence, {
    focus: args?.focus ? String(args.focus) : '',
    language,
    detail,
    evidenceText: built.text,
  });

  let result;
  try {
    result = await complete({
      ctx,
      route,
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: DETAIL_MAX_TOKENS[detail],
      signal: options.signal,
    });
  } catch (error) {
    if (error?.code === 'E_ABORTED') throw error;
    return finalizeDigest(
      metadataOnlyDigest(evidence, {
        reason: `模型总结失败（${error.message}），下面是抓取到的原始材料。`,
        basis,
        confidence,
        transcriptChars: built.transcriptChars,
        // Keep the diagnostics: which model was tried and how long it took,
        // even though the reply itself was unusable.
        model: `${route.provider}/${route.model}`,
        elapsedMs: Date.now() - startedAt,
      }),
      { ...extra, error: error?.code ?? 'E_MODEL' },
    );
  }

  const digest = normalizeDigest({
    raw: result.text,
    evidence,
    model: `${route.provider}/${route.model}`,
    elapsedMs: Date.now() - startedAt,
    basis,
    confidence,
    transcriptChars: built.transcriptChars,
  });
  if (result.truncated) {
    digest.warnings.push('模型输出达到 maxTokens 上限，总结可能被截断。');
  }
  return finalizeDigest(digest, extra);
}

/**
 * Transcript-only read: no model call.
 * @param {Record<string, any>} args
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function readTranscript(args, options = {}) {
  const evidence = await extractEvidence(args?.url, {
    cookie: args?.cookie,
    page: args?.page,
    signal: options.signal,
    subprocess: options.subprocess ?? null,
    withDanmaku: false,
    withComments: false,
  });

  const requested = Number(args?.maxChars);
  const maxChars = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 120_000) : 20_000;
  const rendered = renderTranscript(evidence.transcript, { maxChars });
  return {
    title: String(evidence.title ?? ''),
    url: String(evidence.url ?? ''),
    platform: String(evidence.platform ?? ''),
    author: String(evidence.author ?? ''),
    durationText: evidence.durationSeconds ? formatClock(evidence.durationSeconds) : '',
    source: String(evidence.transcript?.source ?? ''),
    language: String(evidence.transcript?.language ?? ''),
    cueCount: Math.max(0, Math.round(Number(evidence.transcript?.cues?.length) || 0)),
    chars: Math.max(0, Math.round(rendered.chars)),
    truncated: Boolean(rendered.truncated),
    hasTranscript: rendered.text !== '',
    text: String(rendered.text ?? ''),
    warnings: Array.isArray(evidence.warnings) ? evidence.warnings.map(String) : [],
    basis: describeBasis(evidence),
  };
}
