import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEvidenceText,
  confidenceOf,
  describeBasis,
  formatClock,
  renderTranscript,
} from '../lib/evidence.js';
import {
  metadataOnlyDigest,
  normalizeDigest,
  parseDigestJson,
  renderDigest,
} from '../lib/prompt.js';

const evidence = {
  platform: 'bilibili',
  url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  id: 'BV1GJ411x7h7',
  title: '测试视频',
  author: 'UP 主',
  durationSeconds: 3725,
  publishedAt: '2024-01-02T03:04:05.000Z',
  description: '这是一个用于测试的简介。',
  tags: ['测试', '视频'],
  stats: { views: 1000, likes: 20 },
  parts: [],
  selectedPart: 0,
  chapters: [{ start: 0, title: '开场' }, { start: 125, title: '主体' }],
  aiSummary: null,
  transcript: null,
  danmaku: [{ t: 3, text: '开场弹幕' }],
  comments: [{ author: 'a', text: '很有用', likes: 9 }],
  warnings: ['未登录 B 站'],
};

test('parseDigestJson tolerates fences and surrounding chatter', () => {
  assert.deepEqual(parseDigestJson('{"headline":"h"}'), { headline: 'h' });
  assert.deepEqual(parseDigestJson('```json\n{"headline":"h"}\n```'), { headline: 'h' });
  assert.deepEqual(parseDigestJson('好的，结果如下：{"headline":"h"} 希望有帮助'), { headline: 'h' });
  assert.equal(parseDigestJson('抱歉我无法完成'), null);
  assert.equal(parseDigestJson('[1,2,3]'), null);
  assert.equal(parseDigestJson('{broken'), null);
});

test('normalizeDigest prefers real chapter marks and caps model output', () => {
  const digest = normalizeDigest({
    raw: JSON.stringify({
      headline: '  一句话  概括 ',
      summary: '正文',
      keyPoints: ['a', ' ', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
      chapters: [{ time: '00:00', title: '模型编的章节' }],
      caveat: '仅凭弹幕推断',
    }),
    evidence,
    model: 'deepseek-account/deepseek-flash',
    elapsedMs: 12,
    basis: '基于弹幕、热评（未获得逐字稿）',
    confidence: 'low',
    transcriptChars: 0,
  });
  assert.equal(digest.headline, '一句话 概括');
  assert.equal(digest.keyPoints.length, 9);
  assert.deepEqual(digest.chapters.map((chapter) => chapter.title), ['开场', '主体']);
  assert.equal(digest.chapters[1].time, '2:05');
  assert.equal(digest.chapters[1].startSeconds, 125);
  assert.deepEqual(digest.warnings, ['未登录 B 站', '仅凭弹幕推断']);
  assert.equal(digest.title, '测试视频');
});

test('normalizeDigest keeps the raw reply when the model ignored the JSON contract', () => {
  const digest = normalizeDigest({
    raw: '这个视频讲了三个问题……',
    evidence,
    model: 'm',
    elapsedMs: 1,
    basis: 'b',
    confidence: 'low',
  });
  assert.equal(digest.summary, '这个视频讲了三个问题……');
  assert.deepEqual(digest.keyPoints, []);
  assert.match(digest.warnings.at(-1), /没有按要求返回 JSON/);
});

test('metadataOnlyDigest still returns usable material', () => {
  const digest = metadataOnlyDigest(evidence, { reason: '模型不可用', basis: 'b', confidence: 'low' });
  assert.equal(digest.summary, '这是一个用于测试的简介。');
  assert.equal(digest.headline, '测试视频');
  assert.equal(digest.model, '');
  assert.equal(digest.warnings.at(-1), '模型不可用');
});

test('renderDigest produces a readable markdown card', () => {
  const markdown = renderDigest(
    normalizeDigest({
      raw: JSON.stringify({ headline: '要点', summary: '正文', keyPoints: ['- 一', '二'], caveat: '' }),
      evidence,
      model: 'm',
      elapsedMs: 1,
      basis: '基于弹幕、热评（未获得逐字稿）',
      confidence: 'low',
    }),
  );
  assert.match(markdown, /^## 测试视频/);
  assert.match(markdown, /> 要点/);
  assert.match(markdown, /\*\*时间线\*\*/);
  assert.match(markdown, /`2:05` 主体/);
  assert.match(markdown, /\*\*依据\*\*：基于弹幕、热评（未获得逐字稿）（置信度 low）/);
  // Warnings are a bullet list, not a run-on sentence joined by semicolons.
  assert.match(markdown, /\*\*说明\*\*\n- /);
  assert.match(markdown, /\*\*链接\*\*：https:\/\/www\.bilibili\.com/);
});

test('confidenceOf and describeBasis track the evidence actually found', () => {
  const transcriptEvidence = {
    ...evidence,
    transcript: { source: 'bilibili-subtitle', language: '中文', cues: [{ start: 0, end: 1, text: 'hi' }] },
  };
  assert.equal(confidenceOf(transcriptEvidence), 'high');
  assert.match(describeBasis(transcriptEvidence), /字幕逐字稿（中文）/);
  assert.equal(confidenceOf(evidence), 'medium');
  assert.match(describeBasis(evidence), /章节、弹幕、热评/);
  assert.match(describeBasis({ ...evidence, chapters: [], danmaku: [], comments: [] }), /仅有标题与简介/);
  assert.equal(confidenceOf({ ...evidence, chapters: [], comments: [] }), 'low');
});

test('formatClock renders minutes and hours', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(3725), '1:02:05');
  assert.equal(formatClock(-3), '0:00');
});

test('renderTranscript keeps both ends and reports the gap', () => {
  const cues = Array.from({ length: 300 }, (_, index) => ({
    start: index * 10,
    end: index * 10 + 9,
    text: `第${index}句字幕，内容长度大约二十个字符左右`,
  }));
  const rendered = renderTranscript({ cues }, { maxChars: 1200 });
  assert.equal(rendered.truncated, true);
  assert.match(rendered.text, /^\[0:00\] 第0句/);
  assert.match(rendered.text, /中间省略 \d+ 条字幕/);
  assert.match(rendered.text, /第299句字幕/);
  assert.ok(rendered.text.length < 1200);
  assert.equal(renderTranscript({ cues: [] }).truncated, false);
});

test('buildEvidenceText assembles the sections the prompt expects', () => {
  const built = buildEvidenceText(evidence);
  assert.match(built.text, /【视频信息】[\s\S]*标题：测试视频/);
  assert.match(built.text, /时长：1:02:05（1 小时 2 分）/);
  assert.match(built.text, /【标签】\n测试 \/ 视频/);
  assert.match(built.text, /【数据】\n播放 1000 · 点赞 20/);
  assert.match(built.text, /【章节】\n0:00 开场\n2:05 主体/);
  assert.match(built.text, /【弹幕采样】\n\[0:03\] 开场弹幕/);
  assert.match(built.text, /【热评】\n- 很有用（9 赞）/);
  assert.equal(built.transcriptChars, 0);
});
