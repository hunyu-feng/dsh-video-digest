import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDouyinDom, stripTags } from '../lib/browser.js';

const DOM = [
  '<html><body>',
  '<div data-e2e="detail-video-info" data-e2e-aweme-id="7480111616965627173">',
  '<div class="wrap"><h1 class="title"><span><span>DeepSeek API 超详细使用教程！ &amp; 一口气讲完</span></span>',
  '<a href="//www.douyin.com/search/AI?x=1"><span>#AI在抖音</span></a>',
  '<a href="//www.douyin.com/search/DeepSeek"><span>#DeepSeek</span></a>',
  '</h1></div></div>',
  '<div data-e2e="detail-video-publish-time"><span>发布时间：2025-03-10 18:28</span></div>',
  '<div data-e2e="user-info"><div><a href="//www.douyin.com/user/MS4wLjABAAAA">',
  '<span data-e2e="live-avatar" role="listitem"><img src="https://p3.douyinpic.com/a.jpeg" alt="痕继痕迹"></span>',
  '</a></div></div>',
  '</body></html>',
].join('');

test('stripTags removes markup and decodes entities', () => {
  assert.equal(stripTags('<b>a &amp; b</b>'), 'a & b');
  assert.equal(stripTags('<span>发布时间：2025-03-10</span>'), '发布时间：2025-03-10');
});

test('parseDouyinDom reads id, copy, hashtags, publish time and author', () => {
  const info = parseDouyinDom(DOM);
  assert.equal(info.id, '7480111616965627173');
  assert.equal(info.description, 'DeepSeek API 超详细使用教程！ & 一口气讲完');
  assert.deepEqual(info.hashtags, ['AI在抖音', 'DeepSeek']);
  assert.equal(info.publishedText, '2025-03-10 18:28');
  assert.equal(info.author, '痕继痕迹');
});

test('parseDouyinDom degrades to empty fields on an unrelated page', () => {
  const info = parseDouyinDom('<html><body><p>no video here</p></body></html>');
  assert.equal(info.id, '');
  assert.equal(info.description, '');
  assert.deepEqual(info.hashtags, []);
  assert.equal(info.publishedText, '');
  assert.equal(info.author, '');
});
