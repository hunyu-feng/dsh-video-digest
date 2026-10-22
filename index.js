/**
 * dsh-video-digest — hand it a video link, get back a structured summary.
 *
 * Two tools:
 *   video_digest      link → what can be read → model summary (+ the basis it used)
 *   video_transcript  link → timestamped transcript only, no model call
 *
 * The plugin holds no API keys: summaries run on the provider/model the harness
 * already uses (`agentDefaultModel`), so it keeps working after a model switch.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runDigest, readTranscript } from './lib/index.js';
import { renderDigest } from './lib/prompt.js';

export const name = 'video-digest';
export const inject = ['tools'];

const DETAIL_VALUES = ['brief', 'standard', 'detailed'];

/**
 * A Bilibili login cookie raises the ceiling a lot: the subtitle list and the
 * platform AI recap are both login-gated. Accept it from the tool argument or
 * from the environment so the secret can stay out of the conversation.
 * @param {string | undefined} explicit
 * @returns {string}
 */
function resolveBiliCookie(explicit) {
  const raw =
    String(explicit ?? '').trim() ||
    String(process.env.BILI_COOKIE ?? '').trim() ||
    String(process.env.BILIBILI_COOKIE ?? '').trim();
  if (!raw) return '';
  return /(^|;\s*)SESSDATA=/.test(raw) ? raw : `SESSDATA=${raw}`;
}

/**
 * Turn a pipeline failure into one message the model can act on.
 * @param {unknown} error
 * @returns {Error}
 */
function toToolError(error) {
  if (error instanceof Error) {
    const hint = /** @type {{ hint?: string }} */ (error).hint;
    const code = /** @type {{ code?: string }} */ (error).code;
    return new Error(`${code ? `[${code}] ` : ''}${error.message}${hint ? `\n提示：${hint}` : ''}`);
  }
  return new Error(String(error));
}

/**
 * @param {{ get(service: string): any }} ctx plugin fiber context
 * @returns {object}
 */
function createDigestTool(ctx) {
  return defineTool({
    name: 'video_digest',
    description:
      'Watch a video link and summarize it. Supports Bilibili (BV/av links, multi-part videos, b23.tv short links), ' +
      'YouTube, and ordinary pages that expose video metadata. With a Bilibili login cookie it reads the subtitle ' +
      'transcript and the platform AI recap; without one it works from chapters, description, danmaku samples and top ' +
      'comments, and states that reduced basis in `warnings`/`confidence` instead of pretending it saw the video. ' +
      'Set YT_DLP_PATH to enable yt-dlp caption extraction for other sites. Returns a structured digest: headline, ' +
      'summary, key points, timeline, plus the basis and confidence it rests on.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Video page link (http/https). Bilibili, YouTube and generic pages are detected automatically.',
      },
      focus: {
        type: 'string',
        description: 'Optional angle to emphasize, e.g. "核心论点" or "代码实现细节".',
      },
      language: {
        type: 'string',
        description: 'Language for the summary. Defaults to 简体中文.',
      },
      detail: {
        type: 'string',
        enum: DETAIL_VALUES,
        description: 'brief | standard | detailed. Defaults to standard; detailed also reads more of the transcript.',
      },
      page: {
        type: 'integer',
        description: 'For multi-part Bilibili videos, which part to digest (1-based). Defaults to 1.',
      },
      cookie: {
        type: 'string',
        description:
          'Optional Bilibili SESSDATA value (or a full cookie string) to unlock subtitles and the AI recap. ' +
          'Prefer the BILI_COOKIE environment variable so the secret never enters the conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Video title' },
          url: { type: 'string', description: 'Canonical video URL' },
          platform: { type: 'string', description: 'bilibili | youtube | web | yt-dlp' },
          author: { type: 'string', description: 'Uploader / channel' },
          durationSeconds: { type: 'integer', description: 'Duration in seconds, 0 when unknown' },
          publishedAt: { type: 'string', description: 'Publish date when the source exposes one' },
          headline: { type: 'string', description: 'One-line takeaway' },
          summary: { type: 'string', description: 'The summary body' },
          keyPoints: { type: 'array', items: { type: 'string' }, description: 'Bullet points' },
          chapters: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'string', description: 'Timestamp, e.g. 02:15' },
                title: { type: 'string', description: 'Chapter title' },
                startSeconds: { type: 'integer', description: 'Start offset in seconds' },
              },
            },
            description: 'Timeline; real chapter marks when the source has them',
          },
          basis: { type: 'string', description: 'What evidence the summary was built from' },
          confidence: { type: 'string', description: 'high | medium | low' },
          transcriptChars: { type: 'integer', description: 'Characters of transcript available (0 when none)' },
          warnings: { type: 'array', items: { type: 'string' }, description: 'Degradations and caveats' },
          model: { type: 'string', description: 'provider/model that wrote the summary' },
          elapsedMs: { type: 'integer', description: 'Wall time for the whole call' },
          detail: { type: 'string', description: 'Detail level used' },
          evidenceChars: { type: 'integer', description: 'Characters of material sent to the model' },
          evidenceKinds: { type: 'array', items: { type: 'string' }, description: 'Evidence kinds actually found' },
          truncated: { type: 'boolean', description: 'Whether the transcript was trimmed to fit' },
          error: { type: 'string', description: 'Failure code when the summary fell back to raw material, else empty' },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: renderDigest(value) }];
      },
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      try {
        return await runDigest(
          ctx,
          {
            url: args.url,
            focus: args.focus,
            language: args.language,
            detail: args.detail,
            page: args.page,
            cookie: resolveBiliCookie(args.cookie),
          },
          { signal: exec?.signal },
        );
      } catch (error) {
        throw toToolError(error);
      }
    },
  });
}

/**
 * @param {{ get(service: string): any }} ctx plugin fiber context
 * @returns {object}
 */
function createTranscriptTool(ctx) {
  return defineTool({
    name: 'video_transcript',
    description:
      "Fetch a video's transcript (subtitle/caption track) as timestamped text, without summarizing it. Same sources " +
      'as video_digest. Use this when you want the raw words to quote, search, or analyze yourself. Reports ' +
      'hasTranscript=false when no caption track is reachable — Bilibili subtitles require a login cookie, and YouTube ' +
      'captions require yt-dlp.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Video page link (http/https).',
      },
      page: {
        type: 'integer',
        description: 'For multi-part Bilibili videos, which part to read (1-based). Defaults to 1.',
      },
      maxChars: {
        type: 'integer',
        description: 'Character cap; the middle is trimmed first. Defaults to 20000, hard cap 120000.',
      },
      cookie: {
        type: 'string',
        description: 'Optional Bilibili SESSDATA value. Prefer the BILI_COOKIE environment variable.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Video title' },
          url: { type: 'string', description: 'Canonical video URL' },
          platform: { type: 'string', description: 'bilibili | youtube | web | yt-dlp' },
          author: { type: 'string', description: 'Uploader / channel' },
          durationText: { type: 'string', description: 'Duration as mm:ss' },
          source: { type: 'string', description: 'Which caption source produced the transcript' },
          language: { type: 'string', description: 'Transcript language' },
          cueCount: { type: 'integer', description: 'Number of cues' },
          chars: { type: 'integer', description: 'Characters before trimming' },
          truncated: { type: 'boolean', description: 'Whether the middle was trimmed' },
          hasTranscript: { type: 'boolean', description: 'False when no caption track was reachable' },
          text: { type: 'string', description: 'Timestamped transcript lines' },
          warnings: { type: 'array', items: { type: 'string' }, description: 'Why a track may be missing' },
          basis: { type: 'string', description: 'What was actually read' },
        },
      },
      render(_args, value) {
        const header = `## ${value.title || '（无标题）'}${value.author ? ` · ${value.author}` : ''}`;
        if (!value.hasTranscript) {
          return [
            {
              type: 'text',
              text: `${header}\n\n没有取到字幕。${value.warnings.length ? `\n\n原因：${value.warnings.join('；')}` : ''}`,
            },
          ];
        }
        const shown =
          value.text.length > 6000 ? `${value.text.slice(0, 6000)}\n…（显示已截断，完整 ${value.chars} 字）` : value.text;
        return [
          { type: 'text', text: `${header}\n_${value.cueCount} 条字幕 · ${value.language || '未知语言'}_\n\n${shown}` },
        ];
      },
    },
    timeoutMs: 180_000,
    async execute(args, exec) {
      try {
        return await readTranscript(
          { url: args.url, page: args.page, maxChars: args.maxChars, cookie: resolveBiliCookie(args.cookie) },
          { signal: exec?.signal },
        );
      } catch (error) {
        throw toToolError(error);
      }
    },
  });
}

/** @param {{ tools: { register(tool: unknown): void }, get(service: string): any }} ctx */
export function apply(ctx) {
  ctx.tools.register(createDigestTool(ctx));
  ctx.tools.register(createTranscriptTool(ctx));
}
