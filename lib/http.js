/**
 * Tiny HTTP layer for the video digest pipeline.
 *
 * Everything here is dependency-free on purpose: the plugin runs inside the DSH
 * host process, so adding an HTTP client would add a supply-chain surface for
 * what `fetch` already does. The helpers only add the three things the pipeline
 * actually needs: a desktop user agent, a hard deadline, and a body-size cap.
 */

/** A browser-like UA. Several content APIs reject obviously non-browser clients. */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Failure with a stable code so tools can report something actionable. */
export class DigestError extends Error {
  /**
   * @param {string} code stable machine-readable code (`E_URL`, `E_HTTP`, ...)
   * @param {string} message human readable, already user-facing
   * @param {{ hint?: string, status?: number, cause?: unknown }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'DigestError';
    this.code = code;
    if (extra.hint !== undefined) this.hint = extra.hint;
    if (extra.status !== undefined) this.status = extra.status;
  }
}

/**
 * Merge an optional caller signal with a hard timeout.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
export function deadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * Read a response body while enforcing a byte cap and, optionally, a text cap.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DigestError('E_TOO_LARGE', `响应过大（${Math.round(declared / 1024)} KB），超过 ${Math.round(maxBytes / 1024)} KB 上限`);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new DigestError('E_TOO_LARGE', `响应超过 ${Math.round(maxBytes / 1024)} KB 上限`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Perform a GET and return the raw pieces the caller may need.
 * @param {string} url
 * @param {{
 *   headers?: Record<string, string>,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   method?: string,
 * }} [options]
 * @returns {Promise<{ url: string, status: number, headers: Headers, buffer: Buffer }>}
 */
export async function request(url, options = {}) {
  const { headers, signal, timeoutMs = 15_000, maxBytes = 6 * 1024 * 1024, method = 'GET' } = options;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new DigestError('E_URL', `不是合法的链接：${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DigestError('E_URL', `只支持 http(s) 链接，收到 ${parsed.protocol}`);
  }

  const gate = deadline(signal, timeoutMs);
  try {
    const response = await fetch(parsed.href, {
      method,
      redirect: 'follow',
      headers: {
        'User-Agent': DESKTOP_UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
      signal: gate.signal,
    });
    const buffer = await readCapped(response, maxBytes);
    return { url: response.url || parsed.href, status: response.status, headers: response.headers, buffer };
  } catch (cause) {
    if (cause instanceof DigestError) throw cause;
    const reason = gate.signal.aborted ? gate.signal.reason : cause;
    throw new DigestError(
      'E_HTTP',
      `请求失败：${reason instanceof Error ? reason.message : String(reason)}`,
      { hint: '检查网络或该站点是否需要代理；国内网络通常无法直连 YouTube。', cause },
    );
  } finally {
    gate.cleanup();
  }
}

/**
 * GET JSON, tolerating the HTML/error pages that content APIs sometimes return.
 * @param {string} url
 * @param {Parameters<typeof request>[1]} [options]
 * @returns {Promise<any>}
 */
export async function getJson(url, options = {}) {
  const { buffer, status } = await request(url, options);
  const text = buffer.toString('utf8').trim();
  if (text === '') {
    throw new DigestError('E_EMPTY', `接口返回空响应（HTTP ${status}）：${url}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    if (text.startsWith('<')) {
      throw new DigestError('E_NOT_JSON', `接口返回了网页而不是数据（HTTP ${status}），可能需要登录或被风控拦截`);
    }
    throw new DigestError('E_NOT_JSON', `接口返回的不是合法 JSON（HTTP ${status}）`);
  }
}

/**
 * GET text with a character cap, used for HTML pages.
 * @param {string} url
 * @param {Parameters<typeof request>[1]} [options]
 * @returns {Promise<{ url: string, status: number, text: string }>}
 */
export async function getText(url, options = {}) {
  const { url: finalUrl, status, buffer } = await request(url, options);
  return { url: finalUrl, status, text: buffer.toString('utf8') };
}
