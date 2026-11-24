import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = root;
export const DATA_DIR = process.env.DATA_DIR || path.join(root, 'data');
export const PORT = Number(process.env.PORT || 3000);
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
export const ALLOW_CLIENT_KEYS = process.env.ALLOW_CLIENT_KEYS !== 'false';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
export const INTERNAL_SECRET = process.env.INTERNAL_SECRET || process.env.LIVEKIT_API_SECRET || 'dev-internal-secret';

export const env = {
  gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
  groq: process.env.GROQ_API_KEY || '',
  openai: process.env.OPENAI_API_KEY || '',
  deepgram: process.env.DEEPGRAM_API_KEY || '',
};

export const models = {
  gemini: process.env.GEMINI_MODEL || 'gemini-flash-latest',
  geminiLite: process.env.GEMINI_LITE_MODEL || 'gemini-flash-lite-latest',
  geminiLive: process.env.GEMINI_LIVE_MODEL || '', // auto-detected from the models list when empty
  groq: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
  openai: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  openaiFast: process.env.OPENAI_FAST_MODEL || 'gpt-4.1-nano',
  deepgramStt: process.env.DEEPGRAM_STT_MODEL || 'nova-3',
  deepgramTts: process.env.DEEPGRAM_TTS_VOICE || 'aura-2-thalia-en',
  liveVoice: process.env.GEMINI_LIVE_VOICE || 'Kore',
};

export const twilio = {
  accountSid: process.env.TWILIO_ACCOUNT_SID || '',
  authToken: process.env.TWILIO_AUTH_TOKEN || '',
  number: process.env.TWILIO_PHONE_NUMBER || '',
  profile: process.env.TWILIO_PROFILE || 'fast',
};
export const livekit = {
  url: process.env.LIVEKIT_URL || '',
  apiKey: process.env.LIVEKIT_API_KEY || '',
  apiSecret: process.env.LIVEKIT_API_SECRET || '',
};
export const vapi = {
  publicKey: process.env.VAPI_PUBLIC_KEY || '',
  assistantId: process.env.VAPI_ASSISTANT_ID || '',
  serverSecret: process.env.VAPI_SERVER_SECRET || '',
};

// Latency profiles for the cascaded pipeline.
export const profiles = {
  standard: {
    id: 'standard',
    label: 'Standard',
    endpointingMs: 500,        // Deepgram silence window before a final
    utteranceEndMs: 1000,      // fallback end-of-utterance
    topK: 4,                   // RAG chunks
    contextChars: 2400,
    maxTokens: 320,
    historyTurns: 12,
    maxToolRounds: 3,
    firstChunk: 'sentence',    // first TTS chunk boundary
    ttsSampleRate: 24000,
    preBufferMs: 150,          // client playback pre-buffer
    style: 'Answer in 2 to 3 short sentences.',
    fillerOnTool: true,
  },
  fast: {
    id: 'fast',
    label: 'Low Latency',
    endpointingMs: 200,
    utteranceEndMs: 1000,
    topK: 2,
    contextChars: 1100,
    maxTokens: 110,
    historyTurns: 6,
    maxToolRounds: 2,
    firstChunk: 'clause',      // start TTS at the first comma / clause
    ttsSampleRate: 16000,      // smaller audio payload
    preBufferMs: 40,
    style: 'Answer in one or two short sentences, under 35 words.',
    fillerOnTool: true,
  },
};

export function resolveKeys(clientKeys = {}) {
  const pick = (k) => (ALLOW_CLIENT_KEYS && typeof clientKeys[k] === 'string' && clientKeys[k].trim().length > 10 ? clientKeys[k].trim() : env[k]);
  return { gemini: pick('gemini'), groq: pick('groq'), openai: pick('openai'), deepgram: pick('deepgram') };
}

// Choose the LLM for a profile given available keys. `pref` may be 'gemini' | 'groq' | 'openai' | 'auto'.
export function chooseLLM(profileId, keys, pref = 'auto') {
  const fast = profileId === 'fast';
  const order = pref && pref !== 'auto' ? [pref] : fast ? ['groq', 'gemini', 'openai'] : ['gemini', 'openai', 'groq'];
  for (const p of order) {
    if (!keys[p]) continue;
    if (p === 'gemini') return { provider: 'gemini', model: fast ? models.geminiLite : models.gemini };
    if (p === 'groq') return { provider: 'groq', model: models.groq };
    if (p === 'openai') return { provider: 'openai', model: fast ? models.openaiFast : models.openai };
  }
  return null;
}
