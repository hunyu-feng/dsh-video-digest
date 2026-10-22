/**
 * Prompt construction, JSON recovery, and the markdown renderer.
 *
 * The model is asked for JSON rather than prose so the tool result stays
 * structured for the agent (and for `render`, which the Web UI shows). JSON
 * from a chat model is not guaranteed, so `parseDigestJson` degrades gracefully
 * instead of failing a request that already paid for network and tokens.
 */
import { describeBasis, formatClock } from './evidence.js';

export const SYSTEM_PROMPT = [
  '你是一位严谨的视频内容分析员。用户会给你一个视频的可读材料（字幕逐字稿、官方 AI 总结、章节、弹幕、热评、简介、页面文字），你负责产出结构化笔记。',
  '',
  '硬性规则：',
  '1. 只使用材料中出现的信息。不要补充材料之外的事实、数字、人名、时间或画面描述。',
  '2. 判断材料强度：有逐字稿或官方总结时按真实内容提炼；只有章节、弹幕、热评、简介时，只能把它当作“侧写”，措辞要体现推测（例如“从弹幕看”“由章节可知”），并在 caveat 里说明你没有看到画面与语音。',
  '3. 提炼而不是复述：保留关键数字、术语、结论、争议点和反转，丢掉口水话。',
  '4. 默认使用简体中文；用户指定其他语言时按用户要求。',
  '5. 只输出一个 JSON 对象，不要代码块围栏，不要任何解释性文字。',
].join('\n');

/**
 * @param {Record<string, any>} evidence
 * @param {{ focus?: string, language?: string, detail?: 'brief' | 'standard' | 'detailed', evidenceText: string }} options
 * @returns {string}
 */
export function buildUserPrompt(evidence, options) {
  const { focus, language = '简体中文', detail = 'standard', evidenceText } = options;
  const lengthHint = {
    brief: 'summary 控制在 120-180 字，keyPoints 3-4 条。',
    standard: 'summary 控制在 250-400 字，keyPoints 4-6 条。',
    detailed: 'summary 控制在 450-700 字并分 2-3 段，keyPoints 6-9 条。',
  }[detail] ?? 'summary 控制在 250-400 字，keyPoints 4-6 条。';

  const chapterRule = evidence.chapters?.length
    ? '材料里已给出【章节】，chapters 必须原样引用这些时间点与标题，不要新增或改写时间。'
    : '若材料能支撑时间线，用时间码描述；否则 chapters 返回空数组，不要编造时间点。';

  return [
    '请为下面这个视频写结构化笔记。',
    focus ? `用户特别关注：${focus}` : '',
    `详细程度：${detail}。${lengthHint}`,
    `输出语言：${language}。`,
    chapterRule,
    '',
    '输出 JSON，字段如下：',
    '{',
    '  "headline": "一句话概括，不超过 40 字",',
    '  "summary": "分段总结正文",',
    '  "keyPoints": ["要点 1", "要点 2"],',
    '  "chapters": [{"time": "00:00", "title": "小标题"}],',
    '  "caveat": "一句话说明本次总结的依据与局限；没有局限就填空字符串"',
    '}',
    '',
    '===== 材料开始 =====',
    evidenceText,
    '===== 材料结束 =====',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Pull the first JSON object out of a model reply, tolerating code fences and
 * leading chatter.
 * @param {string} text
 * @returns {Record<string, any> | null}
 */
export function parseDigestJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(cleaned);

  for (const candidate of candidates) {
    const direct = tryParse(candidate);
    if (direct) return direct;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const sliced = tryParse(candidate.slice(start, end + 1));
      if (sliced) return sliced;
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {Record<string, any> | null}
 */
function tryParse(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return null;
  } catch {
    return null;
  }
}

const MAX_ITEMS = 9;

/**
 * Coerce a model reply into the tool's stable output shape.
 * @param {{ raw: string, evidence: Record<string, any>, model: string, elapsedMs: number, basis: string, confidence: string }} input
 */
export function normalizeDigest(input) {
  const { raw, evidence, model, elapsedMs, basis, confidence } = input;
  const parsed = parseDigestJson(raw);
  const warnings = [...(evidence.warnings ?? [])];

  if (!parsed) {
    warnings.push('模型没有按要求返回 JSON，已把原始回复作为总结正文。');
    return {
      title: evidence.title,
      url: evidence.url,
      platform: evidence.platform,
      author: evidence.author,
      durationSeconds: evidence.durationSeconds,
      publishedAt: evidence.publishedAt,
      headline: '',
      summary: raw.trim(),
      keyPoints: [],
      chapters: (evidence.chapters ?? []).map((chapter) => ({
        time: formatClock(chapter.start),
        title: chapter.title,
        startSeconds: chapter.start,
      })),
      basis,
      confidence,
      transcriptChars: input.transcriptChars ?? 0,
      warnings,
      model,
      elapsedMs,
    };
  }

  const keyPoints = Array.isArray(parsed.keyPoints)
    ? parsed.keyPoints
        .map((item) => String(item ?? '').replace(/\s+/g, ' ').trim())
        .filter((item) => item !== '')
        .slice(0, MAX_ITEMS)
    : [];

  const chapters = evidence.chapters?.length
    ? evidence.chapters.map((chapter) => ({
        time: formatClock(chapter.start),
        title: chapter.title,
        startSeconds: chapter.start,
      }))
    : Array.isArray(parsed.chapters)
      ? parsed.chapters
          .map((chapter) => ({
            time: String(chapter?.time ?? '').trim(),
            title: String(chapter?.title ?? '').trim(),
          }))
          .filter((chapter) => chapter.title !== '')
          .slice(0, 20)
      : [];

  return {
    title: evidence.title,
    url: evidence.url,
    platform: evidence.platform,
    author: evidence.author,
    durationSeconds: evidence.durationSeconds,
    publishedAt: evidence.publishedAt,
    headline: String(parsed.headline ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    summary: String(parsed.summary ?? '').trim(),
    keyPoints,
    chapters,
    basis,
    confidence,
    transcriptChars: input.transcriptChars ?? 0,
    warnings: [...warnings, String(parsed.caveat ?? '').trim()].filter(Boolean),
    model,
    elapsedMs,
  };
}

/**
 * Build a compact fallback when no model is reachable: the caller still gets
 * the extracted material instead of an empty failure.
 * @param {Record<string, any>} evidence
 * @param {{ reason: string, basis: string, confidence: string, transcriptChars?: number }} input
 */
export function metadataOnlyDigest(evidence, input) {
  const lines = [];
  if (evidence.description) lines.push(evidence.description);
  if (evidence.pageText) lines.push(evidence.pageText.slice(0, 800));
  const summary = lines.join('\n\n').trim() || '没有抓取到可总结的正文。';
  return {
    title: evidence.title,
    url: evidence.url,
    platform: evidence.platform,
    author: evidence.author,
    durationSeconds: evidence.durationSeconds,
    publishedAt: evidence.publishedAt,
    headline: evidence.title,
    summary,
    keyPoints: [],
    chapters: (evidence.chapters ?? []).map((chapter) => ({
      time: formatClock(chapter.start),
      title: chapter.title,
      startSeconds: chapter.start,
    })),
    basis: input.basis,
    confidence: input.confidence,
    transcriptChars: input.transcriptChars ?? 0,
    warnings: [...(evidence.warnings ?? []), input.reason],
    model: '',
    elapsedMs: 0,
  };
}

/**
 * Markdown rendering used by the tool's `output.render`.
 * @param {Record<string, any>} value
 * @returns {string}
 */
export function renderDigest(value) {
  const meta = [
    value.platform ? String(value.platform) : '',
    value.author ? String(value.author) : '',
    value.durationSeconds ? formatClock(value.durationSeconds) : '',
  ].filter(Boolean);
  const lines = [];
  lines.push(`## ${value.title || '（无标题）'}${meta.length ? `\n_${meta.join(' · ')}_` : ''}`);
  if (value.headline) lines.push(`> ${value.headline}`);
  if (value.summary) lines.push('', value.summary);
  if (value.keyPoints?.length) {
    lines.push('', '**要点**');
    for (const point of value.keyPoints) lines.push(`- ${point}`);
  }
  if (value.chapters?.length) {
    lines.push('', '**时间线**');
    for (const chapter of value.chapters) lines.push(`- \`${chapter.time}\` ${chapter.title}`);
  }
  lines.push('', `---`, `**依据**：${value.basis}（置信度 ${value.confidence}）`);
  if (value.model) lines.push(`**模型**：${value.model}`);
  if (value.warnings?.length) {
    lines.push('', '**说明**');
    for (const warning of value.warnings) lines.push(`- ${warning}`);
  }
  if (value.url) lines.push('', `**链接**：${value.url}`);
  return lines.join('\n');
}

/**
 * One-line description of the source for the `basis` field.
 * @param {Record<string, any>} evidence
 * @param {{ chars?: number }} [options]
 */
export function basisWithChars(evidence, options = {}) {
  const basis = describeBasis(evidence);
  return options.chars && options.chars > 0 ? `${basis}（${options.chars} 字）` : basis;
}
