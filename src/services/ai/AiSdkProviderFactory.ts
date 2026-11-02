/**
 * AiSdkProviderFactory.ts
 *
 * Maps a Deplao AI platform (openai/gemini/claude/deepseek/grok/mistral/
 * 9router/openrouter/ollama/lmstudio) to a Vercel AI SDK LanguageModel
 * via @ai-sdk/openai-compatible, so agent harnesses (WorkflowAgentService)
 * can use generateText with tools / generateObject with zod schemas.
 *
 * Main process ONLY (ESM-only packages loaded via dynamic import by callers).
 * Renderer must never import this file.
 */

import type { AIPlatform } from '../../models';

/** Default base URLs (without /chat/completions) per platform */
function getDefaultBaseUrl(platform: string): string {
  switch (platform) {
    case 'xkiro':     return 'https://api.xkiro.com/v1';
    case 'deepseek':   return 'https://api.deepseek.com/v1';
    case 'grok':       return 'https://api.x.ai/v1';
    case 'mistral':    return 'https://api.mistral.ai/v1';
    case '9router':    return 'http://localhost:20128/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'ollama':     return 'http://localhost:11434/v1';
    case 'lmstudio':   return 'http://localhost:1234/v1';
    case 'openai':
    default:           return 'https://api.openai.com/v1';
  }
}

/** Resolve base URL: strip trailing slashes, strip a /chat/completions tail,
 *  honor baseUrl override (may be with or without /v1). */
export function resolveBaseUrl(platform: string, baseUrl: string | null | undefined): string {
  if (baseUrl) {
    let base = baseUrl.trim().replace(/\/+$/, '');
    // Full endpoint passed → strip the tail to get the base
    base = base.replace(/\/chat\/completions$/, '');
    if (/\/v\d+$/.test(base)) return base;
    // baseUrl without version prefix (e.g. http://localhost:11434) → append /v1
    return `${base}/v1`;
  }
  return getDefaultBaseUrl(platform);
}

/** Local OpenAI-compatible servers — no API key required, slower inference */
export function isLocalSdkPlatform(platform: string): boolean {
  return platform === 'ollama' || platform === 'lmstudio';
}

export interface SdkModelHandle {
  model: any;              // LanguageModel from @ai-sdk/openai-compatible
  maxDuration: number;     // ms — caller should pass as abort deadline budget
  isLocal: boolean;
}

/**
 * Create an AI SDK LanguageModel for the given platform.
 * The `ai` + `@ai-sdk/openai-compatible` modules are ESM-only — this factory
 * MUST be called with the dynamically-imported `openaiCompatible` factory:
 *
 *   const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
 *   const handle = createSdkModel(createOpenAICompatible, 'ollama', 'qwen2.5:7b', key, null);
 *
 * Kept as a pure function (no top-level ESM imports) so the CJS main process
 * can require this file safely.
 */
export function createSdkModel(
  createOpenAICompatible: (opts: any) => any,
  platform: AIPlatform | string,
  model: string,
  apiKey: string,
  baseUrl: string | null | undefined,
): SdkModelHandle {
  const isLocal = isLocalSdkPlatform(String(platform));
  const resolvedBase = resolveBaseUrl(String(platform), baseUrl);
  const provider = createOpenAICompatible({
    name: String(platform),
    baseURL: resolvedBase,
    // Ollama/LM Studio accept any non-empty key; SDK requires a non-empty string
    apiKey: apiKey && apiKey.trim() ? apiKey : (isLocal ? 'local' : 'missing-key'),
  });
  return {
    model: provider.chatModel(model),
    maxDuration: isLocal ? 300_000 : 60_000,
    isLocal,
  };
}
