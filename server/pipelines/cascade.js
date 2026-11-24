// Cascaded pipeline: streaming ASR -> streaming LLM -> streaming TTS, fully overlapped.
// Transport-agnostic: used by the browser WebSocket and by Twilio Media Streams.
//
// transport = { sendAudio(buf), clear(), event(obj), close() }
import { DeepgramSTT, DeepgramTTS, cachedPhrase } from '../deepgram.js';
import { Conversation, Chunker, AGENT_NAME } from '../brain.js';
import { recordMetric } from '../metrics.js';

export const GREETING = `Hi, I'm ${AGENT_NAME} from Halvora Hotels and Retreats. How can I help you today?`;
const FILLERS = ['One moment, let me check that.', 'Sure, let me look that up.', 'Just a second.'];

export class CascadeSession {
  constructor({ transport, profile, keys, llmPref, platform, channel = 'voice', ip, inEncoding = 'linear16', inRate = 16000, outEncoding = 'linear16', awaitClientMetrics = true }) {
    this.t = transport;
    this.profile = profile;
    this.keys = keys;
    this.platform = platform;
    this.ip = ip;
    this.inEncoding = inEncoding;
    this.inRate = inRate;
    this.outEncoding = outEncoding;
    this.outRate = outEncoding === 'mulaw' ? 8000 : profile.ttsSampleRate;
    this.outBytesPerSec = outEncoding === 'mulaw' ? 8000 : this.outRate * 2;
    this.inBytesPerSec = inEncoding === 'mulaw' ? inRate : inRate * 2;
    this.awaitClientMetrics = awaitClientMetrics;
    this.conv = new Conversation({ profile, keys, llmPref, channel, ip });
    this.segments = [];
    this.lastWordEnd = null;
    this.audioSec = 0;
    this.timeline = []; // [audioSecAtChunkEnd, wallMsWhenSent]
    this.turn = null;
    this.turnCount = 0;
    this.playbackEnd = 0;
    this.pendingMetrics = new Map();
    this.closed = false;
  }

  start() {
    if (!this.keys.deepgram) throw new Error('No Deepgram API key configured.');
    if (!this.conv.llm) throw new Error('No LLM API key configured (Gemini, Groq or OpenAI).');
    this.stt = new DeepgramSTT({
      key: this.keys.deepgram,
      encoding: this.inEncoding,
      sampleRate: this.inRate,
      endpointingMs: this.profile.endpointingMs,
      utteranceEndMs: this.profile.utteranceEndMs,
      onTranscript: (r) => this.onTranscript(r),
      onUtteranceEnd: () => { if (this.segments.length) this.commitUserTurn('utterance_end'); },
      onError: (e) => this.fail(e),
    });
    this.tts = new DeepgramTTS({
      key: this.keys.deepgram,
      encoding: this.outEncoding,
      sampleRate: this.outRate,
      onAudio: (buf) => this.onTtsAudio(buf),
      onFlushed: () => { if (this.turn) this.turn.ttsDone = true; this.maybeFinishTurn(); },
      onError: (e) => this.fail(e),
    });
    this.t.event({ type: 'ready', sampleRate: this.outRate, preBufferMs: this.profile.preBufferMs, profile: this.profile.id, llm: this.conv.llm, agent: AGENT_NAME });
    // Warm the phrase cache (greeting + fillers) in the background, then greet.
    const phrase = (text) => cachedPhrase({ key: this.keys.deepgram, text, encoding: this.outEncoding, sampleRate: this.outRate });
    FILLERS.forEach((f) => phrase(f).catch(() => {}));
    phrase(GREETING).then((buf) => {
      if (this.closed) return;
      this.t.event({ type: 'assistant', text: GREETING, turnId: 0, final: true });
      this.sendAudio(buf);
    }).catch((e) => this.fail(e));
    this.maxTimer = setTimeout(() => { this.t.event({ type: 'error', message: 'Session time limit reached (15 minutes).' }); this.close(); }, 15 * 60 * 1000);
  }

  // ---- input ----
  pushAudio(buf) {
    if (this.closed) return;
    this.audioSec += buf.length / this.inBytesPerSec;
    this.timeline.push([this.audioSec, Date.now()]);
    if (this.timeline.length > 3000) this.timeline.splice(0, 1000);
    this.stt?.send(buf);
  }
  wallForAudioSec(sec) {
    for (const [a, w] of this.timeline) if (a >= sec) return w - ((a - sec) * 1000);
    return Date.now();
  }
  agentBusy() { return !!this.turn || Date.now() < this.playbackEnd; }

  onTranscript(r) {
    const text = r.text.trim();
    if (text) {
      // Barge-in: the guest started talking while the agent is speaking or thinking.
      const words = text.split(/\s+/).length;
      if (this.agentBusy() && (words >= 2 || r.isFinal)) this.interrupt('barge_in');
      if (!r.isFinal) this.t.event({ type: 'partial', text: [...this.segments, text].join(' ') });
    }
    if (r.isFinal && text) {
      this.segments.push(text);
      if (r.lastWordEnd != null) this.lastWordEnd = r.lastWordEnd; // words[].end is seconds since stream start
    }
    if (r.speechFinal && this.segments.length) this.commitUserTurn('endpoint');
  }

  commitUserTurn(reason) {
    const text = this.segments.join(' ').trim();
    this.segments = [];
    if (!text) return;
    const now = Date.now();
    const speechEnd = this.lastWordEnd != null ? Math.min(now, this.wallForAudioSec(this.lastWordEnd)) : now - this.profile.endpointingMs;
    if (this.turn) this.interrupt('superseded');
    const turn = { id: ++this.turnCount, text, speechEnd, committedAt: now, reason, abort: new AbortController(), spoken: '', audioBytes: 0, llmDone: false, ttsDone: false };
    this.turn = turn;
    this.t.event({ type: 'user', text, turnId: turn.id });
    this.runTurn(turn).catch((e) => {
      if (turn.abort.signal.aborted) return;
      console.error('[cascade] turn error', e.status || '', e.message);
      this.t.event({ type: 'error', message: friendly(e) });
      if (this.turn === turn) this.turn = null;
    });
  }

  async runTurn(turn) {
    const chunker = new Chunker(this.profile.firstChunk);
    const speak = (chunk) => {
      if (turn.abort.signal.aborted) return;
      if (!turn.ttsFirstTextAt) turn.ttsFirstTextAt = Date.now();
      turn.spoken += (turn.spoken ? ' ' : '') + chunk;
      this.tts.speak(chunk + ' ');
    };
    const gen = this.conv.respond(turn.text, { signal: turn.abort.signal });
    let res;
    while (!(res = await gen.next()).done) {
      if (turn.abort.signal.aborted) return;
      const ev = res.value;
      if (ev.type === 'text') {
        if (!turn.firstTokenAt) turn.firstTokenAt = Date.now();
        this.t.event({ type: 'assistant_delta', text: ev.text, turnId: turn.id });
        for (const c of chunker.push(ev.text)) speak(c);
      } else if (ev.type === 'tool') {
        this.t.event({ type: 'tool', names: ev.names, turnId: turn.id });
        for (const c of chunker.flush()) speak(c);
        // Perceived-latency masking: play a pre-rendered filler while the tool round runs.
        if (this.profile.fillerOnTool && !turn.audioBytes && !turn.ttsFirstTextAt) {
          const f = FILLERS[turn.id % FILLERS.length];
          cachedPhrase({ key: this.keys.deepgram, text: f, encoding: this.outEncoding, sampleRate: this.outRate }).then((buf) => {
            if (turn.abort.signal.aborted || turn.audioBytes) return;
            turn.fillerAt = Date.now();
            this.sendAudio(buf);
            this.t.event({ type: 'filler', text: f, turnId: turn.id });
          }).catch(() => {});
        }
      }
    }
    if (turn.abort.signal.aborted) return;
    for (const c of chunker.flush()) speak(c);
    turn.metrics = res.value;
    turn.llmDone = true;
    this.t.event({ type: 'assistant', text: turn.spoken, turnId: turn.id, final: true });
    if (turn.ttsFirstTextAt) this.tts.flush();
    else { turn.ttsDone = true; }
    this.maybeFinishTurn();
  }

  onTtsAudio(buf) {
    const turn = this.turn;
    if (!turn || turn.abort.signal.aborted) return;
    if (!turn.audioBytes) turn.firstAudioAt = Date.now();
    turn.audioBytes += buf.length;
    this.sendAudio(buf);
  }

  sendAudio(buf) {
    const dur = (buf.length / this.outBytesPerSec) * 1000;
    this.playbackEnd = Math.max(this.playbackEnd, Date.now()) + dur;
    this.t.sendAudio(buf);
  }

  maybeFinishTurn() {
    const turn = this.turn;
    if (!turn || !turn.llmDone || !turn.ttsDone) return;
    this.turn = null;
    this.emitMetrics(turn, false);
  }

  interrupt(reason) {
    const turn = this.turn;
    const speaking = Date.now() < this.playbackEnd;
    if (!turn && !speaking) return;
    if (turn) {
      turn.abort.abort();
      this.turn = null;
      if (turn.firstAudioAt || turn.fillerAt) this.emitMetrics(turn, true);
      const playedMs = turn.firstAudioAt ? Date.now() - turn.firstAudioAt : 0;
      const totalMs = (turn.audioBytes / this.outBytesPerSec) * 1000 || 1;
      if (turn.llmDone) this.conv.markInterrupted(Math.round(turn.spoken.length * Math.min(1, playedMs / totalMs)));
    }
    this.tts?.clear();
    this.t.clear();
    this.playbackEnd = 0;
    this.t.event({ type: 'interrupted', reason });
  }

  emitMetrics(turn, interrupted) {
    const m = turn.metrics || {};
    const firstAny = Math.min(turn.firstAudioAt || Infinity, turn.fillerAt || Infinity);
    const rec = {
      platform: this.platform,
      profile: this.profile.id,
      turnIndex: turn.id,
      endOfTurnMs: turn.committedAt - turn.speechEnd,           // endpointing + final ASR
      llmTtftMs: turn.firstTokenAt ? turn.firstTokenAt - turn.committedAt : null,   // includes RAG + prompt
      ttsTtfbMs: turn.firstAudioAt && turn.ttsFirstTextAt ? turn.firstAudioAt - turn.ttsFirstTextAt : null,
      responseMs: turn.firstAudioAt ? turn.firstAudioAt - turn.speechEnd : null,     // speech end -> first answer audio (server)
      perceivedMs: Number.isFinite(firstAny) ? firstAny - turn.speechEnd : null,      // includes filler audio
      ragMs: m.ragMs, toolMs: m.toolMs, toolRounds: m.toolRounds, tools: m.tools,
      llm: m.llmProvider ? `${m.llmProvider}/${m.llmModel}` : null,
      inputTokens: m.inputTokens, cachedTokens: m.cachedTokens, outputTokens: m.outputTokens,
      interrupted,
      source: 'server',
    };
    this.t.event({ type: 'metrics', turnId: turn.id, metrics: rec });
    if (turn.reason === 'typed') return; // typed test turns have no real speech timing
    if (!this.awaitClientMetrics) { recordMetric(rec); return; }
    // Wait briefly for the browser's measured voice-to-voice latency, then store.
    const timer = setTimeout(() => { this.pendingMetrics.delete(turn.id); recordMetric(rec); }, 4000);
    this.pendingMetrics.set(turn.id, { rec, timer });
  }

  clientMetric({ turnId, v2vMs }) {
    const p = this.pendingMetrics.get(turnId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingMetrics.delete(turnId);
    if (Number.isFinite(v2vMs) && v2vMs > 0 && v2vMs < 30000) p.rec.clientV2vMs = Math.round(v2vMs);
    recordMetric(p.rec);
  }

  fail(e) {
    if (this.closed) return;
    console.error('[cascade]', e.message);
    this.t.event({ type: 'error', message: friendly(e) });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.maxTimer);
    this.turn?.abort.abort();
    for (const { rec, timer } of this.pendingMetrics.values()) { clearTimeout(timer); recordMetric(rec); }
    this.pendingMetrics.clear();
    this.stt?.close();
    this.tts?.close();
    this.t.close?.();
  }
}

export function friendly(e) {
  const s = `${e.status || ''} ${e.message || e}`;
  if (/^No .*(key|configured)|needs an? .*key/i.test(String(e.message))) return `${e.message} Add it to the server's .env file, or paste your own on the Settings page.`;
  if (/429|quota|rate/i.test(s)) return 'The AI provider rate limit was reached (free tier). Please wait a minute, or add your own keys on the Settings page.';
  if (/401|403|api key|invalid.*key|permission/i.test(s)) return 'An API key was rejected. Check the keys on the server or on the Settings page.';
  return `Something went wrong: ${String(e.message || e).slice(0, 160)}`;
}
