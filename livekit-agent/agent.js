// LiveKit Agents worker: the same Halvora agent (prompt, RAG, tools) on LiveKit.
// Pipeline: Silero VAD + Deepgram Nova-3 STT -> Gemini -> Deepgram Aura-2 TTS.
// Run:  npm run agent          (dev mode, connects to LIVEKIT_URL)
//       npm run agent:start    (production mode)
import { fileURLToPath } from 'node:url';
import { cli, defineAgent, llm, voice, WorkerOptions } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { env, models, profiles, PORT, INTERNAL_SECRET } from '../server/config.js';
import { buildInstructions } from '../server/brain.js';
import { toolDefs, todayISO } from '../server/tools.js';
import { retrieve, formatContext } from '../server/kb.js';
import { GREETING } from '../server/pipelines/cascade.js';

const PROFILE = profiles.fast;
// The worker may run on another machine, so tools and metrics go through the main server's API.
// That keeps one bookings store and one metrics store for every deployment mode.
const SERVER = (process.env.AGENT_SERVER_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const METRICS_URL = `${SERVER}/api/internal/metrics`;
async function runTool(name, args) {
  try {
    const r = await fetch(`${SERVER}/api/internal/tool`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET }, body: JSON.stringify({ name, args }) });
    return await r.json();
  } catch (e) { return { error: `Tool server unreachable: ${e.message}` }; }
}

class HalvoraAgent extends voice.Agent {
  constructor() {
    const tools = Object.fromEntries(toolDefs.map((t) => [t.name, llm.tool({
      description: t.description,
      parameters: t.parameters,
      execute: async (args) => runTool(t.name, args),
    })]));
    super({ instructions: buildInstructions({ style: PROFILE.style, includeDate: true }), tools });
  }
  // Same per-turn RAG as the website pipeline: inject retrieved context before the LLM runs.
  async onUserTurnCompleted(turnCtx, newMessage) {
    const text = newMessage.textContent || '';
    if (!text) return;
    const { results } = retrieve(text, PROFILE.topK);
    const ctx = formatContext(results, PROFILE.contextChars);
    if (ctx) turnCtx.addMessage({ role: 'system', content: `[Today: ${todayISO()}]\n[Retrieved Halvora information]\n${ctx}` });
  }
}

async function postMetrics(rows) {
  try {
    await fetch(METRICS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': INTERNAL_SECRET }, body: JSON.stringify(rows) });
  } catch (e) { console.warn('[livekit-agent] metrics post failed:', e.message); }
}

export default defineAgent({
  prewarm: async (proc) => { proc.userData.vad = await silero.VAD.load({ minSilenceDuration: 0.25 }); },
  entry: async (ctx) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad,
      stt: new deepgram.STT({ apiKey: env.deepgram, model: models.deepgramStt, endpointing: PROFILE.endpointingMs, interimResults: true }),
      llm: new google.LLM({ apiKey: env.gemini, model: process.env.LIVEKIT_LLM_MODEL || models.geminiLite, temperature: 0.4, maxOutputTokens: PROFILE.maxTokens, ...(/2\.5/.test(process.env.LIVEKIT_LLM_MODEL || models.geminiLite) ? { thinkingConfig: { thinkingBudget: 0 } } : { thinkingConfig: { thinkingLevel: 'MINIMAL' } }) }),
      tts: new deepgram.TTS({ apiKey: env.deepgram, model: models.deepgramTts, sampleRate: 24000 }),
      turnHandling: {
        turnDetection: 'vad',
        endpointing: { minDelay: 300, maxDelay: 2500 },
        preemptiveGeneration: { enabled: true },
      },
      maxToolSteps: PROFILE.maxToolRounds,
    });

    // Collect LiveKit's per-turn metrics (EOU delay, LLM TTFT, TTS TTFB) keyed by speech id.
    const turns = new Map();
    let turnIndex = 0;
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;
      const sid = m.speechId;
      if (!sid) return;
      const t = turns.get(sid) || {};
      if (m.type === 'eou_metrics') { t.eou = m.endOfUtteranceDelayMs; t.stt = m.transcriptionDelayMs; }
      else if (m.type === 'llm_metrics' && t.ttft === undefined) { t.ttft = m.ttftMs; t.cached = m.promptCachedTokens; t.input = m.promptTokens; }
      else if (m.type === 'tts_metrics' && t.ttfb === undefined) t.ttfb = m.ttfbMs;
      turns.set(sid, t);
      if (t.eou !== undefined && t.ttft !== undefined && t.ttfb !== undefined && !t.sent) {
        t.sent = true;
        turnIndex++;
        postMetrics([{
          platform: 'livekit', source: 'livekit-agent', sessionId: ctx.room.name, turnIndex,
          endOfTurnMs: t.eou, sttMs: t.stt, llmTtftMs: t.ttft, ttsTtfbMs: t.ttfb,
          responseMs: t.eou + t.ttft + t.ttfb, // LiveKit's documented total-latency formula
          inputTokens: t.input, cachedTokens: t.cached,
          llm: `gemini/${process.env.LIVEKIT_LLM_MODEL || models.geminiLite}`,
        }]);
        // Also tell the browser, which shows the breakdown live.
        const payload = new TextEncoder().encode(JSON.stringify({ type: 'metrics', turnIndex, eou: t.eou, ttft: t.ttft, ttfb: t.ttfb }));
        ctx.room.localParticipant?.publishData(payload, { reliable: true, topic: 'halvora-metrics' }).catch(() => {});
      }
      if (turns.size > 200) turns.clear();
    });

    await session.start({ agent: new HalvoraAgent(), room: ctx.room });
    await ctx.connect();
    session.say(GREETING);
  },
});

cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url) }));
