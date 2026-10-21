// Configuration: hearth.config.json + .env (no dependencies).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export async function loadEnv(file = `${ROOT}.env`) {
  try {
    for (const line of (await readFile(file, 'utf8')).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env */ }
}

export const DEFAULT_CONFIG = {
  assistant: { name: 'Alexa', wakeWord: 'alexa', speakScreenResults: true },
  model: { provider: 'gemini', modelId: 'auto', temperature: 0.4 },
  servers: [{ name: 'mend', url: 'http://127.0.0.1:8787/mcp', headers: { 'x-mend-household': 'demo' } }],
};

export async function loadConfig(file = process.env.HEARTH_CONFIG || `${ROOT}hearth.config.json`) {
  try {
    const user = JSON.parse(await readFile(file, 'utf8'));
    return {
      assistant: { ...DEFAULT_CONFIG.assistant, ...user.assistant },
      model: { ...DEFAULT_CONFIG.model, ...user.model },
      servers: user.servers?.length ? user.servers : DEFAULT_CONFIG.servers,
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** Lists the Gemini models this key can call. */
export async function listGeminiModels(apiKey, fetchImpl = fetch) {
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`);
  if (!res.ok) throw new Error(`Gemini API key check failed (HTTP ${res.status}). Is GEMINI_API_KEY correct?`);
  const { models = [] } = await res.json();
  return models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
}

/**
 * Free-tier models are often briefly overloaded (HTTP 503) or rate limited (429), so Hearth
 * routes between several: the newest stable Flash models first, then one Flash-Lite as a last resort.
 */
export function geminiCandidates(names, max = 4) {
  const version = (n) => Number(n.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
  const stable = (re) => names.filter((n) => re.test(n) && !/preview|image|tts|live|audio|thinking/.test(n)).sort((a, b) => version(b) - version(a));
  const flash = stable(/^gemini-\d+(\.\d+)?-flash$/).slice(0, max);
  const lite = stable(/^gemini-\d+(\.\d+)?-flash-lite$/).slice(0, 1);
  const out = [...flash, ...lite];
  return out.length ? out : [chooseGemini(names)];
}

export function chooseGemini(names) {
  const flash = names.filter((n) => /^gemini-\d+(\.\d+)?-flash(-\d{3})?(-preview(-\d{2}-\d{4})?)?$/.test(n) && !/lite|image|tts|live|audio|thinking/.test(n));
  const version = (n) => Number(n.match(/^gemini-(\d+(?:\.\d+)?)/)[1]);
  flash.sort((a, b) => version(b) - version(a) || Number(/preview/.test(a)) - Number(/preview/.test(b)));
  const stable = flash.filter((n) => !/preview/.test(n));
  // Prefer the newest stable model; use a preview only if it's a newer generation.
  if (stable.length && (!flash.length || version(stable[0]) >= version(flash[0]))) return stable[0];
  return flash[0] || 'gemini-2.5-flash';
}

/** Sends each candidate a one-token request and moves the ones answering right now to the front. */
export async function healthiestFirst(apiKey, ids, fetchImpl = fetch) {
  const probe = async (id) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply OK' }] }], generationConfig: { maxOutputTokens: 4 } }),
      });
      return res.ok;
    } catch { return false; } finally { clearTimeout(timer); }
  };
  const ok = await Promise.all(ids.map(probe));
  return [...ids.filter((_, i) => ok[i]), ...ids.filter((_, i) => !ok[i])];
}

export async function createModel(cfg) {
  const provider = cfg.provider || 'gemini';
  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Add GEMINI_API_KEY to hearth/.env (free key: https://aistudio.google.com/apikey).');
    let ids = !cfg.modelId || cfg.modelId === 'auto' ? geminiCandidates(await listGeminiModels(apiKey)) : [].concat(cfg.modelId);
    if (ids.length > 1) ids = await healthiestFirst(apiKey, ids);
    const { GoogleModel } = await import('@strands-agents/sdk/models/google');
    // Fail fast so the router can switch models: 2 attempts per model instead of the SDK's 5 with long backoff.
    const clientConfig = { httpOptions: { timeout: 30000, retryOptions: { attempts: 2, initialDelay: 0.5, maxDelay: 2 } } };
    const make = (modelId) => new GoogleModel({ apiKey, modelId, clientConfig, params: { temperature: cfg.temperature ?? 0.4 } });
    if (ids.length === 1) return { model: make(ids[0]), label: `Gemini · ${ids[0]}` };
    // Strands' ModelRouter (FallbackStrategy) moves to the next model when one fails.
    const { ModelRouter, RoutingCandidate } = await import('@strands-agents/sdk/models/routing');
    const router = new ModelRouter(ids.map((id) => new RoutingCandidate({ model: make(id), name: id })));
    return { model: router, label: `Gemini · ${ids[0]} (+${ids.length - 1} fallbacks: ${ids.slice(1).join(', ')})` };
  }
  if (provider === 'openai') {
    // Any OpenAI-compatible endpoint: Groq, OpenRouter, Ollama, LM Studio… (npm i openai)
    const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
    const clientConfig = process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : undefined;
    return { model: new OpenAIModel({ api: 'chat', apiKey: process.env.OPENAI_API_KEY || 'none', modelId: cfg.modelId, clientConfig }), label: `OpenAI-compatible · ${cfg.modelId}` };
  }
  if (provider === 'bedrock') {
    const { BedrockModel } = await import('@strands-agents/sdk');
    return { model: new BedrockModel({ region: cfg.region || process.env.AWS_REGION || 'us-east-1', modelId: cfg.modelId }), label: `Amazon Bedrock · ${cfg.modelId}` };
  }
  throw new Error(`Unknown model provider "${provider}"`);
}
