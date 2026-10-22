/**
 * Turns whatever the extractors found into the two things the rest of the
 * plugin needs: a prompt block, and an honest statement of what the summary is
 * standing on.
 */

/**
 * @param {number} seconds
 * @returns {string} `1:02:03` / `2:03`
 */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

/**
 * @param {number} seconds
 * @returns {string} `` / `3 分 12 秒` / `1 小时 2 分`
 */
export function formatDurationText(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ''}`;
  if (minutes > 0) return `${minutes} 分${secs > 0 ? ` ${secs} 秒` : ''}`;
  return `${secs} 秒`;
}

/**
 * Render a transcript with timecodes, trimming the middle when it is too long.
 * Keeping both ends is deliberate: intros state the thesis, outros state the
 * conclusion, and the middle is where long videos pad.
 * @param {{ cues: { start: number, end: number, text: string }[] } | null} transcript
 * @param {{ maxChars?: number }} [options]
 * @returns {{ text: string, chars: number, truncated: boolean }}
 */
export function renderTranscript(transcript, options = {}) {
  const { maxChars = 14_000 } = options;
  if (!transcript || !Array.isArray(transcript.cues) || transcript.cues.length === 0) {
    return { text: '', chars: 0, truncated: false };
  }
  const lines = transcript.cues.map((cue) => `[${formatClock(cue.start)}] ${cue.text}`);
  const full = lines.join('\n');
  if (full.length <= maxChars) return { text: full, chars: full.length, truncated: false };

  const headBudget = Math.floor(maxChars * 0.62);
  const tailBudget = Math.floor(maxChars * 0.3);
  const head = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > headBudget) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail = [];
  used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (used + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return {
    text: `${head.join('\n')}\n…（中间省略 ${omitted} 条字幕）…\n${tail.join('\n')}`,
    chars: full.length,
    truncated: true,
  };
}

/**
 * Which evidence kinds are actually present.
 * @param {Record<string, any>} evidence
 * @returns {string[]}
 */
export function evidenceKinds(evidence) {
  const kinds = [];
  if (evidence.transcript?.cues?.length) kinds.push('transcript');
  if (evidence.aiSummary?.summary) kinds.push('ai-summary');
  if (evidence.chapters?.length) kinds.push('chapters');
  if (evidence.danmaku?.length) kinds.push('danmaku');
  if (evidence.comments?.length) kinds.push('comments');
  if (evidence.pageText) kinds.push('page-text');
  if (evidence.title || evidence.description) kinds.push('metadata');
  return kinds;
}

const KIND_LABELS = {
  transcript: '字幕逐字稿',
  'ai-summary': 'B 站 AI 总结',
  chapters: '章节',
  danmaku: '弹幕',
  comments: '热评',
  'page-text': '页面正文',
  metadata: '元信息',
};

/**
 * How much the summary can be trusted, given what we could read.
 * @param {Record<string, any>} evidence
 * @returns {'high' | 'medium' | 'low'}
 */
export function confidenceOf(evidence) {
  const kinds = evidenceKinds(evidence);
  if (kinds.includes('transcript')) return 'high';
  if (kinds.includes('ai-summary')) return 'high';
  if (kinds.includes('chapters') && (kinds.includes('danmaku') || kinds.includes('comments'))) return 'medium';
  if (kinds.includes('danmaku') || kinds.includes('comments')) return 'low';
  if (kinds.includes('page-text')) return 'medium';
  return 'low';
}

/**
 * Human sentence describing the basis of the summary.
 * @param {Record<string, any>} evidence
 * @returns {string}
 */
export function describeBasis(evidence) {
  const kinds = evidenceKinds(evidence);
  if (kinds.includes('transcript')) {
    const language = evidence.transcript.language ? `（${evidence.transcript.language}）` : '';
    return `基于字幕逐字稿${language}`;
  }
  if (kinds.includes('ai-summary')) return '基于 B 站官方 AI 总结';
  const parts = kinds.filter((kind) => kind !== 'metadata').map((kind) => KIND_LABELS[kind] ?? kind);
  if (parts.length === 0) return '仅有标题与简介，没有可读正文';
  return `基于${parts.join('、')}${evidence.transcript ? '' : '（未获得逐字稿）'}`;
}

/**
 * Compose the block of raw material handed to the model.
 * @param {Record<string, any>} evidence
 * @param {{ maxChars?: number }} [options]
 * @returns {{ text: string, transcriptChars: number, truncated: boolean }}
 */
export function buildEvidenceText(evidence, options = {}) {
  const { maxChars = 14_000 } = options;
  const sections = [];
  const info = [
    `平台：${evidence.platform}`,
    evidence.id ? `ID：${evidence.id}` : '',
    `标题：${evidence.title || '（无）'}`,
    evidence.author ? `作者：${evidence.author}` : '',
    evidence.durationSeconds ? `时长：${formatClock(evidence.durationSeconds)}（${formatDurationText(evidence.durationSeconds)}）` : '',
    evidence.publishedAt ? `发布：${evidence.publishedAt}` : '',
    evidence.selectedPart && evidence.parts.length > 1 ? `分P：第 ${evidence.selectedPart} P / 共 ${evidence.parts.length} P` : '',
  ]
    .filter(Boolean)
    .join('\n');
  sections.push(`【视频信息】\n${info}`);

  if (evidence.tags?.length) sections.push(`【标签】\n${evidence.tags.join(' / ')}`);

  const statEntries = Object.entries(evidence.stats ?? {}).filter(([, value]) => Number(value) > 0);
  if (statEntries.length > 0) {
    const labels = { views: '播放', likes: '点赞', coins: '投币', favorites: '收藏', shares: '分享', danmaku: '弹幕', replies: '评论' };
    sections.push(`【数据】\n${statEntries.map(([key, value]) => `${labels[key] ?? key} ${value}`).join(' · ')}`);
  }

  if (evidence.description) sections.push(`【简介】\n${evidence.description.slice(0, 1200)}`);

  if (evidence.chapters?.length) {
    sections.push(`【章节】\n${evidence.chapters.map((chapter) => `${formatClock(chapter.start)} ${chapter.title}`).join('\n')}`);
  }

  if (evidence.aiSummary?.summary) {
    const outline = (evidence.aiSummary.outline ?? [])
      .map((chapter) => {
        const points = (chapter.points ?? [])
          .map((point) => `  - ${formatClock(point.time)} ${point.text}`)
          .join('\n');
        return `* ${chapter.title}${points ? `\n${points}` : ''}`;
      })
      .join('\n');
    sections.push(`【B 站官方 AI 总结】\n${evidence.aiSummary.summary}${outline ? `\n\n大纲：\n${outline}` : ''}`);
  }

  const transcript = renderTranscript(evidence.transcript, { maxChars });
  if (transcript.text) sections.push(`【字幕逐字稿】\n${transcript.text}`);

  if (evidence.danmaku?.length) {
    sections.push(
      `【弹幕采样】\n${evidence.danmaku.map((item) => `[${formatClock(item.t)}] ${item.text}`).join('\n')}`,
    );
  }

  if (evidence.comments?.length) {
    sections.push(
      `【热评】\n${evidence.comments
        .map((comment) => `- ${comment.text}${comment.likes ? `（${comment.likes} 赞）` : ''}`)
        .join('\n')}`,
    );
  }

  if (evidence.pageText) sections.push(`【页面正文】\n${evidence.pageText}`);

  if (evidence.parts?.length > 1) {
    sections.push(
      `【分P列表】\n${evidence.parts
        .slice(0, 20)
        .map((part) => `P${part.index} ${part.title}（${formatClock(part.duration)}）`)
        .join('\n')}`,
    );
  }

  return {
    text: sections.join('\n\n'),
    transcriptChars: transcript.chars,
    truncated: transcript.truncated,
  };
}
