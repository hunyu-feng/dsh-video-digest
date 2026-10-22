/**
 * Model call. The plugin never asks for an API key: by default it reuses the
 * route the harness is already configured with (`agentDefaultModel`), so the
 * summary runs on whatever provider/model the user picked in the GUI.
 *
 * A local config file can pin a different route for this plugin only, without
 * touching the global default:
 *
 *   ~/.dsh-video-digest/config.json   (or $DSH_VIDEO_DIGEST_CONFIG)
 *   { "provider": "deepseek-account", "model": "deepseek-v4-pro", "reasoningEffort": "max" }
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { DigestError } from './http.js';

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} Route
 */

/**
 * @returns {string} config file path
 */
export function configPath() {
  return process.env.DSH_VIDEO_DIGEST_CONFIG?.trim() || join(homedir(), '.dsh-video-digest', 'config.json');
}

/**
 * Read the optional per-plugin route override. Invalid or missing files simply
 * mean "follow the harness default".
 * @returns {{ provider?: string, model?: string, reasoningEffort?: string } | null}
 */
export function readPluginConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider.trim() : '',
      model: typeof parsed.model === 'string' ? parsed.model.trim() : '',
      reasoningEffort: typeof parsed.reasoningEffort === 'string' ? parsed.reasoningEffort.trim() : '',
    };
  } catch {
    return null;
  }
}

/**
 * Work out which provider/model to call.
 * @param {{ get(service: string): any }} ctx host context
 * @param {{ provider?: string, model?: string }} [override]
 * @returns {Route}
 */
export function resolveRoute(ctx, override = {}) {
  if (override.provider && override.model) return { provider: override.provider, model: override.model };

  const envProvider = process.env.VIDEO_DIGEST_PROVIDER?.trim();
  const envModel = process.env.VIDEO_DIGEST_MODEL?.trim();
  if (envProvider && envModel) return { provider: envProvider, model: envModel };

  const pinned = readPluginConfig();
  if (pinned?.provider && pinned?.model) {
    return {
      provider: pinned.provider,
      model: pinned.model,
      ...(pinned.reasoningEffort ? { reasoningEffort: pinned.reasoningEffort } : {}),
    };
  }

  const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
  if (selection?.provider && selection?.model) {
    return { provider: String(selection.provider), model: String(selection.model) };
  }

  const providers = ctx.get('llm')?.listProviders?.() ?? [];
  const first = providers.find((provider) => provider?.id);
  if (first) {
    return {
      provider: String(first.id),
      model: envModel || 'deepseek-flash',
    };
  }
  throw new DigestError('E_NO_MODEL', '没有可用的模型路由：未配置 agentDefaultModel，也没有已注册的 llm provider', {
    hint: '在 DSH 设置里选择默认模型，或设置 VIDEO_DIGEST_PROVIDER / VIDEO_DIGEST_MODEL 环境变量。',
  });
}

/**
 * Stream one completion to completion and return the concatenated text.
 * @param {{
 *   ctx: { get(service: string): any },
 *   route: Route,
 *   system: string,
 *   prompt: string,
 *   maxTokens?: number,
 *   temperature?: number,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ text: string, usage: Record<string, number> | null, truncated: boolean }>}
 */
export async function complete(input) {
  const llm = input.ctx.get('llm');
  if (!llm?.stream) {
    throw new DigestError('E_NO_LLM', '当前 profile 没有 llm 服务，无法调用模型做总结', {
      hint: '启用任一 llm provider 插件后重试。',
    });
  }

  const stream = llm.stream({
    provider: input.route.provider,
    model: input.route.model,
    // Only pin an effort when the config asked for one; otherwise let the
    // provider apply the model's own default.
    ...(input.route.reasoningEffort ? { reasoningEffort: input.route.reasoningEffort } : {}),
    system: input.system,
    // Message content is a block array at this layer: the providers reject a
    // bare string (deepseek-account surfaces it as "Messages transport failed").
    messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
    temperature: input.temperature ?? 0.3,
    maxTokens: input.maxTokens ?? 1600,
    signal: input.signal,
  });

  let text = '';
  let usage = null;
  let failure = '';
  let truncated = false;
  for await (const chunk of stream) {
    if (input.signal?.aborted) throw new DigestError('E_ABORTED', '已取消');
    if (!chunk || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
    else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind;
      if (kind === 'max-tokens') truncated = true;
      if (kind === 'error' || kind === 'aborted') {
        failure = chunk.reason?.failure?.message ?? kind;
      }
    }
  }

  if (failure) {
    throw new DigestError('E_MODEL', `模型调用失败：${failure}`, {
      hint: '检查默认模型是否可用，或换一个 provider 后重试。',
    });
  }
  if (!text.trim()) {
    throw new DigestError('E_MODEL_EMPTY', '模型返回了空内容', {
      hint: '推理模型可能把 token 预算都花在思考上，用 detail=detailed 或换更大的 maxTokens 再试。',
    });
  }
  return { text, usage, truncated };
}
