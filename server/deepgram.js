// Deepgram streaming STT + streaming TTS over persistent WebSockets.
import WebSocket from 'ws';
import { models } from './config.js';

// ---------------- Streaming STT ----------------
export class DeepgramSTT {
  constructor({ key, encoding = 'linear16', sampleRate = 16000, endpointingMs = 300, utteranceEndMs = 1000, onTranscript, onUtteranceEnd, onSpeechStarted, onError, onOpen }) {
    const q = new URLSearchParams({
      model: models.deepgramStt,
      language: 'en',
      encoding,
      sample_rate: String(sampleRate),
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: String(endpointingMs),
      utterance_end_ms: String(utteranceEndMs),
      vad_events: 'true',
    });
    // Bias recognition towards domain words.
    for (const kw of ['Halvora', 'Udaipur', 'Munnar', 'Candolim', 'Pichola', 'haveli', 'jharokha']) q.append('keyterm', kw);
    this.cb = { onTranscript, onUtteranceEnd, onSpeechStarted, onError };
    this.queue = [];
    this.open = false;
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${q}`, { headers: { Authorization: `Token ${key}` } });
    this.ws.on('open', () => {
      this.open = true;
      for (const b of this.queue) this.ws.send(b);
      this.queue = [];
      onOpen?.();
      this.keepAlive = setInterval(() => this.ws.readyState === 1 && this.ws.send(JSON.stringify({ type: 'KeepAlive' })), 5000);
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'Results') {
        const alt = msg.channel?.alternatives?.[0];
        if (!alt) return;
        const words = alt.words || [];
        this.cb.onTranscript?.({ text: alt.transcript || '', isFinal: !!msg.is_final, speechFinal: !!msg.speech_final, start: msg.start, duration: msg.duration, lastWordEnd: words.length ? words[words.length - 1].end : null });
      } else if (msg.type === 'UtteranceEnd') this.cb.onUtteranceEnd?.(msg);
      else if (msg.type === 'SpeechStarted') this.cb.onSpeechStarted?.(msg);
    });
    this.ws.on('unexpected-response', (_req, res) => this.cb.onError?.(new Error(`Deepgram STT HTTP ${res.statusCode}${res.statusCode === 401 ? ' (check DEEPGRAM_API_KEY)' : ''}`)));
    this.ws.on('error', (e) => this.cb.onError?.(e));
    this.ws.on('close', () => { this.open = false; clearInterval(this.keepAlive); });
  }
  send(buf) {
    if (this.open && this.ws.readyState === 1) this.ws.send(buf);
    else if (this.ws.readyState === 0 && this.queue.length < 200) this.queue.push(buf);
  }
  finalize() { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'Finalize' })); }
  close() {
    clearInterval(this.keepAlive);
    try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'CloseStream' })); this.ws.close(); } catch {}
  }
}

// ---------------- Streaming TTS ----------------
// One persistent socket per session (pre-warmed at session start, so the first sentence
// doesn't pay TLS + handshake). Text is pushed sentence by sentence and audio streams back.
export class DeepgramTTS {
  constructor({ key, encoding = 'linear16', sampleRate = 24000, voice = models.deepgramTts, onAudio, onFlushed, onError }) {
    this.opts = { key, encoding, sampleRate, voice };
    this.cb = { onAudio, onFlushed, onError };
    this.dropping = false; // true between Clear and Cleared: discard stale audio
    this.pending = [];
    this.connect();
  }
  connect() {
    const { key, encoding, sampleRate, voice } = this.opts;
    const q = new URLSearchParams({ model: voice, encoding, sample_rate: String(sampleRate) });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${q}`, { headers: { Authorization: `Token ${key}` } });
    this.ws.on('open', () => { for (const m of this.pending) this.ws.send(m); this.pending = []; });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) { if (!this.dropping) this.cb.onAudio?.(data); return; }
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'Flushed') this.cb.onFlushed?.(msg);
      else if (msg.type === 'Cleared') this.dropping = false;
      else if (msg.type === 'Warning' || msg.type === 'Error') console.warn('[deepgram tts]', msg.description || msg.err_msg || msg);
    });
    this.ws.on('unexpected-response', (_req, res) => this.cb.onError?.(new Error(`Deepgram TTS HTTP ${res.statusCode}`)));
    this.ws.on('error', (e) => this.cb.onError?.(e));
    this.ws.on('close', () => { this.closedAt = Date.now(); });
  }
  #send(obj) {
    const m = JSON.stringify(obj);
    if (this.ws.readyState === 1) this.ws.send(m);
    else {
      if (this.ws.readyState >= 2 && !this.closed) this.connect();
      this.pending.push(m);
    }
  }
  speak(text) { this.#send({ type: 'Speak', text }); }
  flush() { this.#send({ type: 'Flush' }); }
  clear() { this.dropping = true; this.pending = []; this.#send({ type: 'Clear' }); setTimeout(() => { this.dropping = false; }, 1500); }
  close() { this.closed = true; try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'Close' })); this.ws.close(); } catch {} }
}

// ---------------- Pre-rendered phrase cache ----------------
// Greeting and filler phrases are synthesised once per (voice, encoding, rate) and replayed
// instantly, so they cost zero TTS latency on later turns.
const phraseCache = new Map();
export async function cachedPhrase({ key, text, encoding = 'linear16', sampleRate = 24000, voice = models.deepgramTts }) {
  const id = `${voice}|${encoding}|${sampleRate}|${text}`;
  if (phraseCache.has(id)) return phraseCache.get(id);
  const p = (async () => {
    const q = new URLSearchParams({ model: voice, encoding, sample_rate: String(sampleRate), container: 'none' });
    const r = await fetch(`https://api.deepgram.com/v1/speak?${q}`, { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error(`Deepgram speak ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  })();
  phraseCache.set(id, p);
  p.catch(() => phraseCache.delete(id));
  return p;
}
