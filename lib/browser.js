/**
 * Renderer fallback for pages that only exist after JavaScript runs.
 *
 * Douyin (and friends) answer plain HTTP fetches with a challenge script, so the
 * only honest way to read the page is to let a real browser render it. Edge and
 * Chrome ship a headless mode that prints the resulting DOM:
 *
 *   msedge --headless=new --dump-dom --virtual-time-budget=10000 <url>
 *
 * No automation library, no WebDriver, and - as it turned out - no cookies: a
 * throwaway profile rendered the public video page fine. The profile lives in
 * the temp directory so the user's own browser profile is never touched.
 *
 * One environment detail matters: inside the DSH desktop host a plain
 * `child_process.spawn` of the browser exits immediately (code 0, no output),
 * because the host runs its children inside its own restricted process world.
 * When the host exposes `ctx.subprocess`, that service is used instead - it is
 * the same path the shell tools use, and it can launch a browser.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DigestError } from './http.js';

const MAX_DOM_BYTES = 16 * 1024 * 1024;

/** Browser executables worth trying, in order, plus an explicit override. */
const BROWSER_CANDIDATES = [
  process.env.DSH_RENDER_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

/**
 * @returns {string} executable path, '' when no supported browser is installed
 */
export function findBrowser() {
  return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) ?? '';
}

/**
 * Append one line to a local log. A failed headless render is otherwise
 * invisible from the chat; this file is what makes it diagnosable.
 * @param {Record<string, unknown>} fields
 */
function debugLine(fields) {
  try {
    appendFileSync(join(tmpdir(), 'dsh-video-digest-render.log'), `${new Date().toISOString()} ${JSON.stringify(fields)}\n`);
  } catch {
    /* logging must never break the render */
  }
}

/**
 * @param {string} stderr
 * @returns {string}
 */
function lastLine(stderr) {
  return stderr.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
}

/**
 * Spawn the browser through the host's subprocess service.
 * @param {{ spawn(spec: object): any }} service
 * @param {{ argv: string[], env: Record<string, string | undefined>, cwd: string, signal?: AbortSignal, timeoutMs: number }} input
 * @returns {Promise<{ html: string, stderr: string }>}
 */
function renderWithService(service, input) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let handle;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      handle?.terminate?.();
      done(new DigestError('E_RENDER_TIMEOUT', `浏览器渲染超过 ${Math.round(input.timeoutMs / 1000)} 秒`));
    }, input.timeoutMs);
    timer.unref?.();

    try {
      handle = service.spawn({
        argv: input.argv,
        cwd: input.cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 3000,
        env: input.env,
        signal: input.signal,
      });
    } catch (cause) {
      done(new DigestError('E_RENDER', `无法通过宿主启动浏览器：${cause.message}`, { cause }));
      return;
    }

    let html = '';
    let stderr = '';
    let bytes = 0;
    handle.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_DOM_BYTES) {
        handle.terminate();
        return;
      }
      html += chunk.toString('utf8');
    });
    handle.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });

    handle.done
      .then(({ exitCode }) => {
        debugLine({ phase: 'service-done', exitCode, bytes, stderrTail: lastLine(stderr) });
        if (exitCode === 0) done(null, { html, stderr });
        else done(new DigestError('E_RENDER', `浏览器渲染失败（exit ${exitCode}）${lastLine(stderr) ? `：${lastLine(stderr)}` : ''}`));
      })
      .catch((cause) => done(new DigestError('E_RENDER', `浏览器进程失败：${cause?.message ?? cause}`, { cause })));
  });
}

/**
 * Spawn the browser directly. Used outside the harness (tests, smoke script).
 * @param {{ argv: string[], env: Record<string, string | undefined>, cwd: string, signal?: AbortSignal, timeoutMs: number }} input
 * @returns {Promise<{ html: string, stderr: string }>}
 */
function renderWithNode(input) {
  const [command, ...args] = input.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: input.env,
      cwd: input.cwd,
    });
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (error) {
        child.kill();
        reject(error);
        return;
      }
      resolve({ html: Buffer.concat(chunks).toString('utf8'), stderr });
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(new DigestError('E_RENDER_TIMEOUT', `浏览器渲染超过 ${Math.round(input.timeoutMs / 1000)} 秒`));
    }, input.timeoutMs);
    timer.unref?.();
    const abort = () => finish(new DigestError('E_ABORTED', '已取消'));
    input.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_DOM_BYTES) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (cause) => finish(new DigestError('E_RENDER', `无法启动浏览器：${cause.message}`, { cause })));
    child.on('close', (code) => {
      debugLine({ phase: 'node-close', code, bytes, stderrTail: lastLine(stderr) });
      if (code === 0) finish(null);
      else finish(new DigestError('E_RENDER', `浏览器渲染失败（exit ${code}）${lastLine(stderr) ? `：${lastLine(stderr)}` : ''}`));
    });
  });
}

/**
 * Render one URL in headless mode and return its DOM.
 * @param {string} url
 * @param {{
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   virtualTimeBudgetMs?: number,
 *   subprocess?: { spawn(spec: object): any } | null,
 * }} [options]
 * @returns {Promise<{ html: string, browser: string }>}
 */
export async function renderDom(url, options = {}) {
  const { signal, timeoutMs = 50_000, virtualTimeBudgetMs = 10_000, subprocess } = options;
  const browser = findBrowser();
  if (browser === '') {
    throw new DigestError('E_NO_BROWSER', '这个站点要靠浏览器渲染，但本机没找到 Edge 或 Chrome', {
      hint: '安装 Edge/Chrome，或用 DSH_RENDER_BROWSER 指定浏览器可执行文件。',
    });
  }

  // A throwaway profile in the temp directory: the user's own browser profile
  // is never read or written.
  const profileRoot = tmpdir();
  const profile = await mkdtemp(join(profileRoot, 'dsh-render-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--virtual-time-budget=${virtualTimeBudgetMs}`,
    `--user-data-dir=${profile}`,
    '--dump-dom',
    url,
  ];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  debugLine({ phase: 'start', browser, url, mode: subprocess?.spawn ? 'service' : 'node', cwd: profileRoot });

  try {
    const input = { argv: [browser, ...args], env, cwd: profileRoot, signal, timeoutMs };
    const result = subprocess?.spawn ? await renderWithService(subprocess, input) : await renderWithNode(input);
    if (result.html.trim() === '') {
      const detail = lastLine(result.stderr);
      throw new DigestError('E_RENDER', `浏览器返回了空页面${detail ? `：${detail}` : ''}`, {
        hint: '宿主进程可能不允许直接启动浏览器；可在终端运行 `node scripts/smoke.mjs <链接>` 取内容，或把视频文案贴进来。',
      });
    }
    return { html: result.html, browser };
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * @param {string} text
 * @returns {string}
 */
export function stripTags(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name) => {
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
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the video description, author, hashtags and publish time out of a
 * rendered Douyin page. Kept pure so `test/` can pin the selectors.
 * @param {string} html
 * @returns {{ id: string, description: string, hashtags: string[], publishedText: string, author: string }}
 */
export function parseDouyinDom(html) {
  const id = /data-e2e-aweme-id="(\d+)"/.exec(html)?.[1] ?? '';

  const infoBlock = /data-e2e="detail-video-info"[\s\S]*?(?=data-e2e="|<\/body>)/.exec(html)?.[0] ?? '';
  const rawDescription = infoBlock === '' ? '' : stripTags(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(infoBlock)?.[1] ?? '');
  // Douyin appends the hashtags to the copy itself; keep them separate so the
  // title and the summary are not polluted with "#tag #tag".
  const hashtagTail = /(?:\s*#[^\s#]+)+\s*$/;
  const description = rawDescription.replace(hashtagTail, '').trim();

  const hashtags = [];
  for (const match of infoBlock.matchAll(/<span>#([^<]{1,40})<\/span>/g)) {
    const tag = match[1].trim();
    if (tag !== '' && !hashtags.includes(tag)) hashtags.push(tag);
  }
  for (const match of rawDescription.matchAll(/#([^\s#]{1,40})/g)) {
    const tag = match[1].trim();
    if (tag !== '' && !hashtags.includes(tag)) hashtags.push(tag);
  }

  const publishedRaw = /data-e2e="detail-video-publish-time"[^>]*>([\s\S]*?)<\//.exec(html)?.[1] ?? '';
  const publishedText = stripTags(publishedRaw).replace(/^发布时间[:：]\s*/, '');

  // The avatar image carries the nickname in its alt text; the anchor text is
  // split across nested spans, so the alt attribute is the reliable one.
  const author =
    /data-e2e="live-avatar"[\s\S]{0,400}?<img[^>]*alt="([^"]+)"/.exec(html)?.[1]?.trim() ??
    stripTags(/data-e2e="user-info"[\s\S]{0,600}?<a[^>]*href="[^"]*\/user\/[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? '');

  return { id, description, hashtags, publishedText, author };
}
