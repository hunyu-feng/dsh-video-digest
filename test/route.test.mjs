import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configPath, readPluginConfig, resolveRoute } from '../lib/summarize.js';

/** Fake host ctx: only `agentDefaultModel` matters for routing. */
function fakeCtx(selection) {
  return {
    get(service) {
      if (service === 'agentDefaultModel') return { currentSelection: () => selection };
      if (service === 'llm') return { listProviders: () => [] };
      return undefined;
    },
  };
}

function withConfigFile(content, run) {
  const dir = mkdtempSync(join(tmpdir(), 'video-digest-route-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(content), 'utf8');
  const previous = process.env.DSH_VIDEO_DIGEST_CONFIG;
  process.env.DSH_VIDEO_DIGEST_CONFIG = file;
  try {
    return run(file);
  } finally {
    if (previous === undefined) delete process.env.DSH_VIDEO_DIGEST_CONFIG;
    else process.env.DSH_VIDEO_DIGEST_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveRoute falls back to the harness default without a config file', () => {
  const previous = process.env.DSH_VIDEO_DIGEST_CONFIG;
  // Point at a path that does not exist so a real ~/.dsh-video-digest/config.json
  // on the developer machine cannot influence the assertion.
  process.env.DSH_VIDEO_DIGEST_CONFIG = join(tmpdir(), `video-digest-missing-${Date.now()}.json`);
  try {
    const route = resolveRoute(fakeCtx({ provider: 'deepseek-account', model: 'deepseek-flash' }));
    assert.deepEqual(route, { provider: 'deepseek-account', model: 'deepseek-flash' });
  } finally {
    if (previous === undefined) delete process.env.DSH_VIDEO_DIGEST_CONFIG;
    else process.env.DSH_VIDEO_DIGEST_CONFIG = previous;
  }
});

test('resolveRoute prefers the plugin config file over the harness default', () => {
  withConfigFile({ provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'max' }, () => {
    const route = resolveRoute(fakeCtx({ provider: 'deepseek-account', model: 'deepseek-flash' }));
    assert.deepEqual(route, { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'max' });
  });
});

test('readPluginConfig ignores a broken file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-digest-route-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, '{ not json', 'utf8');
  const previous = process.env.DSH_VIDEO_DIGEST_CONFIG;
  process.env.DSH_VIDEO_DIGEST_CONFIG = file;
  try {
    assert.equal(readPluginConfig(), null);
    assert.equal(configPath(), file);
    const route = resolveRoute(fakeCtx({ provider: 'deepseek-account', model: 'deepseek-flash' }));
    assert.equal(route.model, 'deepseek-flash');
  } finally {
    if (previous === undefined) delete process.env.DSH_VIDEO_DIGEST_CONFIG;
    else process.env.DSH_VIDEO_DIGEST_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
