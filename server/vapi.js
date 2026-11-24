// Vapi integration: the same agent (prompt + tools + knowledge) hosted on Vapi.
// Tools are executed by this server via Vapi's server URL; Vapi's end-of-call report
// supplies its own per-turn latency breakdown for the dashboard.
import crypto from 'node:crypto';
import { vapi, PUBLIC_BASE_URL } from './config.js';
import { buildInstructions } from './brain.js';
import { toolDefs, runTool } from './tools.js';
import { recordMetric } from './metrics.js';
import { GREETING } from './pipelines/cascade.js';

export const vapiEnabled = () => !!vapi.publicKey;

export function assistantConfig() {
  const server = { url: `${PUBLIC_BASE_URL}/vapi/tools`, ...(vapi.serverSecret ? { secret: vapi.serverSecret } : {}) };
  return {
    name: 'Halvora Aria',
    firstMessage: GREETING,
    model: {
      provider: process.env.VAPI_MODEL_PROVIDER || 'google',
      model: process.env.VAPI_MODEL || 'gemini-2.5-flash',
      temperature: 0.4,
      maxTokens: 200,
      messages: [{ role: 'system', content: buildInstructions({ style: 'Answer in one or two short sentences. For details beyond the overview, call search_hotel_info.', includeDate: true }) }],
      tools: toolDefs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters }, server })),
    },
    transcriber: { provider: 'deepgram', model: process.env.VAPI_TRANSCRIBER_MODEL || 'nova-3', language: 'en' },
    voice: { provider: 'deepgram', voiceId: process.env.VAPI_VOICE || 'thalia' },
    startSpeakingPlan: { waitSeconds: 0.2 },
    server: { url: `${PUBLIC_BASE_URL}/vapi/events`, ...(vapi.serverSecret ? { secret: vapi.serverSecret } : {}) },
    serverMessages: ['end-of-call-report', 'tool-calls'],
    maxDurationSeconds: 600,
  };
}

function authorized(req) {
  if (!vapi.serverSecret) return true;
  const got = Buffer.from(String(req.get('x-vapi-secret') || ''));
  const want = Buffer.from(vapi.serverSecret);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export async function toolsWebhook(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const msg = req.body?.message || {};
  const list = msg.toolCallList || msg.toolCalls || [];
  const results = await Promise.all(list.map(async (tc) => {
    const fn = tc.function || tc;
    let args = fn.arguments ?? fn.parameters ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    const out = await runTool(fn.name, args, { ip: req.ip, topK: 3 });
    return { toolCallId: tc.id, result: JSON.stringify(out) };
  }));
  res.json({ results });
}

export function eventsWebhook(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const msg = req.body?.message || {};
  if (msg.type === 'tool-calls') return toolsWebhook(req, res);
  if (msg.type === 'end-of-call-report') {
    const pm = msg.artifact?.performanceMetrics || msg.performanceMetrics;
    const turns = pm?.turnLatencies || [];
    const sessionId = String(msg.call?.id || '').slice(0, 40);
    turns.forEach((t, i) => recordMetric({
      platform: 'vapi', source: 'vapi-report', sessionId, turnIndex: i + 1,
      responseMs: t.turnLatency, endOfTurnMs: t.endpointingLatency, llmTtftMs: t.modelLatency, ttsTtfbMs: t.voiceLatency, sttMs: t.transcriberLatency,
      llm: `vapi/${process.env.VAPI_MODEL || 'gemini-2.5-flash'}`,
    }));
    if (turns.length) console.log(`[vapi] stored ${turns.length} turn latencies from end-of-call report`);
  }
  res.json({ ok: true });
}
