import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  decodeDanmakuBuffer,
  isBilibiliUrl,
  mixinKeyFrom,
  parseBilibiliUrl,
  parseDanmakuXml,
  pickSubtitleTrack,
  sampleDanmaku,
  signWbi,
} from '../lib/bilibili.js';
import { parseJson3Captions, parseVtt, parseYouTubeId } from '../lib/web.js';
import { normalizeUrl } from '../lib/index.js';

test('normalizeUrl accepts bare hosts and rejects non-http schemes', () => {
  assert.equal(normalizeUrl('www.bilibili.com/video/BV1GJ411x7h7').href, 'https://www.bilibili.com/video/BV1GJ411x7h7');
  assert.equal(normalizeUrl('  https://youtu.be/dQw4w9WgXcQ ').href, 'https://youtu.be/dQw4w9WgXcQ');
  assert.throws(() => normalizeUrl('ftp://example.com/a.mp4'), /只支持 http/);
  assert.throws(() => normalizeUrl('   '), /缺少视频链接/);
});

test('parseBilibiliUrl reads every video URL shape', () => {
  assert.deepEqual(parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7'), {
    bvid: 'BV1GJ411x7h7',
    page: 1,
    short: false,
    url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  });
  assert.equal(parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3').page, 3);
  assert.equal(parseBilibiliUrl('https://www.bilibili.com/video/av170001').aid, '170001');
  assert.equal(parseBilibiliUrl('https://b23.tv/abc123').short, true);
  assert.equal(parseBilibiliUrl('https://www.bilibili.com/read/cv123'), null);
  assert.equal(parseBilibiliUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
});

test('isBilibiliUrl only claims Bilibili hosts', () => {
  assert.equal(isBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7'), true);
  assert.equal(isBilibiliUrl('https://space.bilibili.com/1'), true);
  assert.equal(isBilibiliUrl('https://b23.tv/abc'), true);
  assert.equal(isBilibiliUrl('https://www.youtube.com/watch?v=x'), false);
  assert.equal(isBilibiliUrl('not a url'), false);
});

test('mixinKeyFrom reorders the advertised keys deterministically', () => {
  const mixin = mixinKeyFrom('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
  assert.equal(mixin.length, 32);
  assert.match(mixin, /^[0-9a-f]{32}$/);
  assert.equal(mixin, mixinKeyFrom('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'));
});

test('signWbi sorts parameters, strips the banned characters and appends w_rid', () => {
  const query = signWbi({ bvid: 'BV1', cid: 42, title: "a!b'c(d)e*f" }, 'f'.repeat(32));
  const params = query.split('&');
  assert.deepEqual(
    params.map((pair) => pair.split('=')[0]),
    ['bvid', 'cid', 'title', 'wts', 'w_rid'],
  );
  assert.equal(params[2].split('=')[1], 'abcdef');
  assert.match(params.at(-1), /^w_rid=[0-9a-f]{32}$/);
  assert.notEqual(query, signWbi({ bvid: 'BV2', cid: 42 }, 'f'.repeat(32)));
});

test('parseDanmakuXml extracts time and text, decoding entities', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?><i><d p="12.5,1,25,16777215,1700000000,0,abc">你好&amp;再见</d>',
    '<d p="99,1,25,16777215,1700000000,0,abc&lt;3</d></i>',
  ].join('');
  // The second entry is deliberately unclosed, so only the first must survive.
  assert.deepEqual(parseDanmakuXml(xml), [{ t: 12.5, text: '你好&再见' }]);
});

test('decodeDanmakuBuffer handles plain, raw-deflate and gzip bodies', () => {
  const xml = '<i><d p="1,1,25,0,0,0,x">hi</d></i>';
  const raw = Buffer.from(xml, 'utf8');
  assert.equal(decodeDanmakuBuffer(raw), xml);
  assert.equal(decodeDanmakuBuffer(zlib.deflateRawSync(raw)), xml);
  assert.equal(decodeDanmakuBuffer(zlib.gzipSync(raw)), xml);
  assert.equal(decodeDanmakuBuffer(Buffer.alloc(0)), '');
});

test('sampleDanmaku drops noise, dedupes, and spreads over the timeline', () => {
  const entries = [];
  for (let index = 0; index < 400; index += 1) entries.push({ t: index, text: `第${index}条弹幕内容` });
  entries.push({ t: 5, text: '第100条弹幕内容' });
  entries.push({ t: 6, text: '哈哈哈' });
  entries.push({ t: 7, text: '😀😀' });
  const sample = sampleDanmaku(entries, { limit: 20 });
  assert.equal(sample.length, 20);
  assert.equal(new Set(sample.map((item) => item.text)).size, 20);
  assert.ok(sample[0].t < 40, `first sample should be early, got ${sample[0].t}`);
  assert.ok(sample.at(-1).t > 300, `last sample should be late, got ${sample.at(-1).t}`);
  assert.ok(sample.every((item) => item.text.includes('条弹幕内容')));
});

test('pickSubtitleTrack prefers human Mandarin over the AI track', () => {
  const tracks = [
    { lan: 'ai-zh', lan_doc: '中文（AI生成）', subtitle_url: '//a' },
    { lan: 'zh-CN', lan_doc: '中文（自动生成）', subtitle_url: '//b' },
    { lan: 'en-US', lan_doc: 'English', subtitle_url: '//c' },
    { lan: 'ja', lan_doc: '日本語', subtitle_url: '' },
  ];
  assert.equal(pickSubtitleTrack(tracks).subtitle_url, '//b');
  assert.equal(pickSubtitleTrack([{ lan: 'en', lan_doc: 'English', subtitle_url: '//c' }]).subtitle_url, '//c');
  assert.equal(pickSubtitleTrack([]), undefined);
});

test('parseYouTubeId covers watch, youtu.be, shorts and embed', () => {
  assert.equal(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(parseYouTubeId('https://www.youtube.com/embed/abcdefghijk'), 'abcdefghijk');
  assert.equal(parseYouTubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseYouTubeId('nope'), null);
});

test('parseVtt turns cues into start/end/text and strips markup', () => {
  const vtt = [
    'WEBVTT',
    '',
    '00:00.000 --> 00:02.500',
    '<c.colorE5E5E5>第一句</c>',
    '',
    '00:00:03.000 --> 00:00:05.000',
    '第二句',
    '',
    'garbage block without timing',
  ].join('\n');
  assert.deepEqual(parseVtt(vtt), [
    { start: 0, end: 2.5, text: '第一句' },
    { start: 3, end: 5, text: '第二句' },
  ]);
});

test('parseJson3Captions reads YouTube json3 events', () => {
  const payload = {
    events: [
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
      { tStartMs: 3500, dDurationMs: 800, segs: [{ utf8: 'again' }] },
    ],
  };
  assert.deepEqual(parseJson3Captions(payload), [
    { start: 0, end: 1.5, text: 'hello world' },
    { start: 3.5, end: 4.3, text: 'again' },
  ]);
  assert.deepEqual(parseJson3Captions({}), []);
});
