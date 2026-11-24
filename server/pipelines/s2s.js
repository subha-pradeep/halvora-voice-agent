// Speech-to-speech pipeline: browser audio <-> server relay <-> Gemini Live (native audio model).
// The relay keeps the API key server-side; tools run on the server against the same booking backend.
import { Modality, EndSensitivity, StartSensitivity } from '@google/genai';
import { geminiClient } from '../llm.js';
import { buildInstructions } from '../brain.js';
import { toolDefs, runTool } from '../tools.js';
import { models } from '../config.js';
import { recordMetric } from '../metrics.js';
import { friendly } from './cascade.js';

const liveModelCache = new Map();
export async function resolveLiveModel(key) {
  if (models.geminiLive) return models.geminiLive;
  if (liveModelCache.has(key)) return liveModelCache.get(key);
  const p = (async () => {
    const ai = geminiClient(key);
    const found = [];
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    for await (const m of pager) if ((m.supportedActions || []).includes('bidiGenerateContent')) found.push(m.name.replace(/^models\//, ''));
    const score = (n) => (/native-audio/.test(n) ? 4 : 0) + (/flash/.test(n) ? 2 : 0) + (/latest/.test(n) ? 1 : 0) - (/thinking|image|tts/.test(n) ? 5 : 0);
    found.sort((a, b) => score(b) - score(a) || b.localeCompare(a));
    if (!found.length) throw new Error('No Gemini Live model is available for this API key.');
    console.log('[s2s] live models available:', found.join(', '), '-> using', found[0]);
    return found[0];
  })();
  liveModelCache.set(key, p);
  p.catch(() => liveModelCache.delete(key));
  return p;
}

const S2S_STYLE = 'Answer in one to three short sentences. For details not in the overview (amenities, dining, policies, packages, transfers, FAQs), call search_hotel_info before answering.';

export class S2SSession {
  constructor({ transport, keys, ip, sessionId }) {
    this.t = transport;
    this.keys = keys;
    this.ip = ip;
    this.sessionId = sessionId;
    this.turnIndex = 0;
    this.closed = false;
    this.toolsThisTurn = [];
  }

  async start() {
    if (!this.keys.gemini) throw new Error('Speech-to-speech needs a Gemini API key.');
    const model = await resolveLiveModel(this.keys.gemini);
    this.model = model;
    const ai = geminiClient(this.keys.gemini);
    this.session = await ai.live.connect({
      model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: buildInstructions({ style: S2S_STYLE, includeDate: true }),
        tools: [{ functionDeclarations: toolDefs.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: models.liveVoice } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
            silenceDurationMs: 300,
            prefixPaddingMs: 100,
          },
        },
      },
      callbacks: {
        onmessage: (msg) => this.onMessage(msg).catch((e) => console.error('[s2s] message error', e)),
        onerror: (e) => { console.error('[s2s] live error', e?.message || e); this.t.event({ type: 'error', message: friendly(e?.error || e) }); },
        onclose: (e) => { if (!this.closed) { this.t.event({ type: 'error', message: `Speech-to-speech session closed${e?.reason ? `: ${e.reason}` : ''}.` }); this.close(); } },
      },
    });
    this.t.event({ type: 'ready', sampleRate: 24000, preBufferMs: 60, model });
    // Ask the model to greet so the guest hears it speak first.
    this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'The guest has just connected. Greet them in one short sentence as Aria from Halvora Hotels and Retreats and ask how you can help.' }] }], turnComplete: true });
    this.maxTimer = setTimeout(() => { this.t.event({ type: 'error', message: 'Session time limit reached (15 minutes).' }); this.close(); }, 15 * 60 * 1000);
  }

  pushAudio(buf) {
    if (this.closed || !this.session) return;
    this.session.sendRealtimeInput({ audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  }

  async onMessage(msg) {
    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) { this.t.clear(); this.t.event({ type: 'interrupted' }); }
      if (sc.inputTranscription?.text) this.t.event({ type: 'user_delta', text: sc.inputTranscription.text });
      if (sc.outputTranscription?.text) this.t.event({ type: 'assistant_delta', text: sc.outputTranscription.text });
      for (const p of sc.modelTurn?.parts || []) {
        if (p.inlineData?.data) {
          if (!this.responding) { this.responding = true; this.turnIndex++; this.t.event({ type: 'response_start', turnId: this.turnIndex }); }
          this.t.sendAudio(Buffer.from(p.inlineData.data, 'base64'));
        }
      }
      if (sc.turnComplete || sc.generationComplete) {
        if (this.responding) this.t.event({ type: 'turn_complete', turnId: this.turnIndex, tools: this.toolsThisTurn });
        this.responding = false;
        if (sc.turnComplete) this.toolsThisTurn = [];
      }
    }
    if (msg.toolCall?.functionCalls?.length) {
      const calls = msg.toolCall.functionCalls;
      this.t.event({ type: 'tool', names: calls.map((c) => c.name) });
      const t0 = performance.now();
      const results = await Promise.all(calls.map((c) => runTool(c.name, c.args, { ip: this.ip, topK: 3 })));
      this.toolsThisTurn.push(...calls.map((c) => c.name));
      this.lastToolMs = Math.round(performance.now() - t0);
      if (!this.closed) this.session.sendToolResponse({ functionResponses: calls.map((c, i) => ({ id: c.id, name: c.name, response: { result: results[i] } })) });
    }
    if (msg.goAway) this.t.event({ type: 'notice', message: 'The speech-to-speech session will end soon (provider limit).' });
  }

  clientMetric({ turnId, v2vMs, userSpoke }) {
    if (!userSpoke || !Number.isFinite(v2vMs) || v2vMs <= 0 || v2vMs > 30000) return;
    recordMetric({ platform: 'web-s2s', source: 'client', turnIndex: turnId, clientV2vMs: v2vMs, llm: `gemini-live/${this.model}`, tools: this.toolsThisTurn, sessionId: this.sessionId });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.maxTimer);
    try { this.session?.close(); } catch {}
    this.t.close?.();
  }
}
