import { Mic, Player, SpeechDetector, RemoteOnset } from './audio.js';

const $ = (s) => document.querySelector(s);
const state = { mode: 'web', arch: 'cascade', fast: true, active: null, config: null, userTurns: 0 };
const ui = {
  btn: $('#talk-btn'), status: $('#status'), level: $('#mic-level'), transcript: $('#transcript'), strip: $('#latency-strip'),
};

const storedKeys = () => { try { return JSON.parse(localStorage.getItem('halvora-keys') || '{}'); } catch { return {}; } };
const wsUrl = (p) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${p}`;
const fmt = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

// ---------- transcript ----------
let bubbles = {};
function clearIntro() { const intro = ui.transcript.querySelector('p.muted'); if (intro && !ui.transcript.querySelector('.msg')) intro.remove(); }
function bubble(role, key, text, { append = false, note = '' } = {}) {
  clearIntro();
  let el = key && bubbles[key];
  if (!el) {
    el = document.createElement('div');
    el.className = `msg ${role}`;
    el.innerHTML = `<span class="who">${role === 'user' ? 'You' : role === 'agent' ? 'Aria' : ''}</span><span class="text"></span><span class="note"></span>`;
    ui.transcript.appendChild(el);
    if (key) bubbles[key] = el;
  }
  const t = el.querySelector('.text');
  t.textContent = append ? t.textContent + text : text;
  if (note) el.querySelector('.note').textContent = note;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  return el;
}
function sys(text) { bubble('sys', null, text); }
$('#clear-transcript').onclick = () => { ui.transcript.innerHTML = ''; bubbles = {}; };

function chip(label, ms, detail) {
  const el = document.createElement('div');
  el.className = 'chip' + (ms != null && ms < 1200 ? ' good' : ms != null && ms < 2200 ? ' ok' : ' slow');
  el.innerHTML = `<strong>${fmt(ms)}</strong><span>${label}</span>${detail ? `<small>${detail}</small>` : ''}`;
  ui.strip.prepend(el);
  while (ui.strip.children.length > 8) ui.strip.lastChild.remove();
}

function setStatus(text, mode = '') { ui.status.textContent = text; ui.btn.dataset.state = mode; ui.btn.querySelector('.label').textContent = mode && mode !== 'error' ? 'Stop' : 'Start'; }

// ---------- config ----------
async function loadConfig() {
  const r = await fetch('/api/config');
  state.config = await r.json();
  const f = state.config.features;
  $('#phone-number').textContent = state.config.twilioNumber || 'Phone line not configured on this deployment';
  $('#lk-note').textContent = f.livekit ? 'Press Start to join a LiveKit room. The agent worker joins automatically.' : 'LiveKit is not configured on this deployment (set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).';
  $('#vapi-note').textContent = f.vapi ? 'Press Start to talk to the Vapi-hosted agent.' : 'Vapi is not configured on this deployment (set VAPI_PUBLIC_KEY).';
  updateArchNote();
}
function updateArchNote() {
  const c = state.config; if (!c) return;
  const p = c.profiles[state.fast ? 'fast' : 'standard'];
  const llm = c.llm[state.fast ? 'fast' : 'standard'];
  const keys = storedKeys();
  $('#arch-note').textContent = state.arch === 'cascade'
    ? `Deepgram Nova-3 streaming ASR → ${keys.llm && keys.llm !== 'auto' ? keys.llm : llm ? `${llm.provider} ${llm.model}` : 'no LLM key'} → Deepgram Aura-2 streaming TTS. Endpointing ${p.endpointingMs} ms, RAG top-${p.topK}, max ${p.maxTokens} tokens, history ${p.historyTurns} turns, first TTS chunk at ${p.firstChunk}, ${p.ttsSampleRate / 1000} kHz audio, ${p.preBufferMs} ms pre-buffer.`
    : 'Gemini Live native-audio model: audio in, audio out, with no separate ASR or TTS. Server-side VAD (300 ms silence), and the same tools and knowledge base.';
  $('#fast-wrap').style.display = state.arch === 'cascade' ? '' : 'none';
}

// ---------- tabs ----------
document.querySelectorAll('.mode-tabs button').forEach((b) => b.onclick = async () => {
  await stop();
  document.querySelectorAll('.mode-tabs button').forEach((x) => x.classList.toggle('active', x === b));
  state.mode = b.dataset.mode;
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== state.mode; });
  $('.stage').style.display = state.mode === 'phone' ? 'none' : '';
});
document.querySelectorAll('.seg button').forEach((b) => b.onclick = async () => {
  await stop();
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('active', x === b));
  state.arch = b.dataset.arch;
  updateArchNote();
});
$('#fast-toggle').onchange = async (e) => { await stop(); state.fast = e.target.checked; updateArchNote(); };

ui.btn.onclick = async () => {
  if (state.active) return stop();
  try {
    if (state.mode === 'web') await (state.arch === 'cascade' ? startStreamSession('/ws/cascade') : startStreamSession('/ws/s2s'));
    else if (state.mode === 'livekit') await startLiveKit();
    else if (state.mode === 'vapi') await startVapi();
  } catch (e) {
    console.error(e);
    sys(e.name === 'NotAllowedError' ? 'Microphone permission was denied.' : `Could not start: ${e.message}`);
    await stop();
    setStatus('Could not start', 'error');
  }
};

async function stop() {
  const a = state.active;
  state.active = null;
  if (a) { try { await a.stop(); } catch {} }
  ui.level.style.width = '0%';
  setStatus('Tap to start a conversation');
}

// ---------- Website: cascade + speech-to-speech (both stream over our WebSocket) ----------
async function startStreamSession(path) {
  const isS2S = path.includes('s2s');
  setStatus('Connecting…', 'connecting');
  const vad = new SpeechDetector();
  let player = null;
  let expecting = null; // turn id whose first audio we are waiting for
  let currentAgentKey = null;
  let userOpen = false;
  state.userTurns = 0;
  const ws = new WebSocket(wsUrl(path));
  ws.binaryType = 'arraybuffer';
  const mic = new Mic({
    onFrame: (pcm, rms) => { vad.push(rms, { agentPlaying: player?.isPlaying() }); if (ws.readyState === 1) ws.send(pcm); },
    onLevel: (rms) => { ui.level.style.width = `${Math.min(100, rms * 900)}%`; },
  });
  const session = { stop: async () => { try { ws.send(JSON.stringify({ type: 'stop' })); } catch {} ws.close(); mic.stop(); player?.close(); } };
  state.active = session;
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket connection failed')); });
  const keys = storedKeys();
  ws.send(JSON.stringify({ type: 'start', profile: state.fast ? 'fast' : 'standard', llm: keys.llm || 'auto', keys: { gemini: keys.gemini, groq: keys.groq, deepgram: keys.deepgram, openai: keys.openai } }));

  ws.onmessage = async (ev) => {
    if (typeof ev.data !== 'string') { player?.enqueue(ev.data); return; }
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'ready':
        player = new Player({ sampleRate: m.sampleRate, preBufferMs: m.preBufferMs });
        await player.resume();
        player.onStart = (t) => {
          if (expecting == null) return;
          const v2v = vad.measure(t);
          const turnId = expecting;
          expecting = null;
          if (isS2S) ws.send(JSON.stringify({ type: 'client_metric', turnId: state.userTurns, v2vMs: v2v, userSpoke: v2v != null }));
          else ws.send(JSON.stringify({ type: 'client_metric', turnId, v2vMs: v2v }));
          if (v2v != null) chip(isS2S ? 'voice-to-voice' : 'voice-to-voice', v2v, isS2S ? 'Gemini Live' : state.fast ? 'Low Latency' : 'Standard');
        };
        await mic.start();
        setStatus(isS2S ? `Listening · ${m.model}` : `Listening · ${m.llm?.provider} ${m.llm?.model}`, 'listening');
        break;
      case 'partial': bubble('user', 'partial', m.text).classList.add('interim'); break;
      case 'user':
        if (bubbles.partial) { bubbles.partial.remove(); delete bubbles.partial; }
        bubble('user', `u${m.turnId}`, m.text);
        expecting = m.turnId;
        state.userTurns++;
        setStatus('Thinking…', 'thinking');
        break;
      case 'user_delta': // S2S input transcription
        if (!userOpen) { userOpen = true; state.userTurns++; }
        bubble('user', `su${state.userTurns}`, m.text, { append: true });
        break;
      case 'response_start':
        userOpen = false;
        currentAgentKey = `sa${m.turnId}`;
        expecting = m.turnId;
        setStatus('Speaking…', 'speaking');
        break;
      case 'assistant_delta':
        bubble('agent', isS2S ? currentAgentKey || 'sa' : `a${m.turnId}`, m.text, { append: true });
        setStatus('Speaking…', 'speaking');
        break;
      case 'assistant':
        bubble('agent', `a${m.turnId}`, m.text);
        break;
      case 'turn_complete': currentAgentKey = null; setStatus('Listening', 'listening'); break;
      case 'tool': bubble('sys', null, `🔧 ${m.names.join(', ')}`); break;
      case 'filler': break;
      case 'metrics': {
        const x = m.metrics;
        const el = bubbles[`a${m.turnId}`];
        if (el) el.querySelector('.note').textContent = `end-of-turn ${fmt(x.endOfTurnMs)} · LLM TTFT ${fmt(x.llmTtftMs)} · TTS TTFB ${fmt(x.ttsTtfbMs)} · server response ${fmt(x.responseMs)}${x.tools ? ` · tools: ${x.tools.join(', ')}` : ''}${x.cachedTokens ? ` · ${x.cachedTokens} cached tokens` : ''}`;
        setStatus('Listening', 'listening');
        break;
      }
      case 'clear': player?.clear(); break;
      case 'interrupted': player?.clear(); sys('↩︎ interrupted'); expecting = null; break;
      case 'notice': sys(m.message); break;
      case 'error': sys(`⚠️ ${m.message}`); if (m.fatal) stop(); break;
    }
  };
  ws.onclose = () => { if (state.active === session) { sys('Session ended.'); stop(); } };

  // Typed input (cascade only) — useful for demos in noisy rooms.
  attachTypeBox(isS2S ? null : (text) => ws.send(JSON.stringify({ type: 'text', text })));
}

function attachTypeBox(send) {
  let box = $('#type-box');
  if (!send) { box?.remove(); return; }
  if (!box) {
    box = document.createElement('form');
    box.id = 'type-box';
    box.className = 'type-box';
    box.innerHTML = '<input placeholder="…or type a message" aria-label="Type a message"><button class="btn btn-sm">Send</button>';
    $('.transcript-wrap').appendChild(box);
  }
  box.onsubmit = (e) => { e.preventDefault(); const i = box.querySelector('input'); if (i.value.trim()) { send(i.value.trim()); i.value = ''; } };
}

// ---------- LiveKit ----------
async function startLiveKit() {
  if (!state.config.features.livekit) throw new Error('LiveKit is not configured on this deployment.');
  setStatus('Connecting to LiveKit…', 'connecting');
  const { Room, RoomEvent, Track } = await import('https://esm.sh/livekit-client@2');
  const tok = await (await fetch('/api/livekit/token')).json();
  if (tok.error) throw new Error(tok.error);
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const vad = new SpeechDetector();
  const mic = new Mic({ onFrame: (_p, rms) => vad.push(rms), onLevel: (rms) => { ui.level.style.width = `${Math.min(100, rms * 900)}%`; } });
  const els = [];
  let onset = null;
  let turn = 0;
  const session = { stop: async () => { onset?.stop(); mic.stop(); els.forEach((e) => e.remove()); await room.disconnect(); } };
  state.active = session;

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach(); el.style.display = 'none'; document.body.appendChild(el); els.push(el);
    onset = new RemoteOnset(track.mediaStreamTrack, (t) => {
      const v2v = vad.measure(t);
      if (v2v == null) return;
      turn++;
      chip('voice-to-voice', v2v, 'LiveKit');
      fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'livekit', clientV2vMs: v2v, turnIndex: turn, sessionId: tok.room }) });
    });
    setStatus('Connected · LiveKit agent', 'listening');
  });
  room.on(RoomEvent.DataReceived, (payload, _p, _k, topic) => {
    if (topic !== 'halvora-metrics') return;
    try { const m = JSON.parse(new TextDecoder().decode(payload)); sys(`LiveKit metrics · end-of-utterance ${fmt(m.eou)} · LLM TTFT ${fmt(m.ttft)} · TTS TTFB ${fmt(m.ttfb)} · total ${fmt(m.eou + m.ttft + m.ttfb)}`); } catch {}
  });
  // Agents 1.x publish transcripts as text streams on the lk.transcription topic.
  try {
    room.registerTextStreamHandler('lk.transcription', async (reader, info) => {
      const isAgent = info.identity !== room.localParticipant.identity;
      const id = reader.info.attributes?.['lk.segment_id'] || reader.info.id;
      for await (const chunk of reader) bubble(isAgent ? 'agent' : 'user', `lk-${id}`, chunk, { append: true });
    });
  } catch {}
  room.on(RoomEvent.Disconnected, () => { if (state.active === session) { sys('LiveKit session ended.'); stop(); } });
  await room.connect(tok.url, tok.token);
  await mic.start();
  await room.localParticipant.setMicrophoneEnabled(true, { echoCancellation: true, noiseSuppression: true });
  setStatus('Waiting for the agent to join…', 'connecting');
}

// ---------- Vapi ----------
async function startVapi() {
  const cfg = state.config.vapi;
  if (!cfg) throw new Error('Vapi is not configured on this deployment.');
  setStatus('Connecting to Vapi…', 'connecting');
  const mod = await import('https://esm.sh/@vapi-ai/web@2');
  const Vapi = mod.default?.default || mod.default;
  const vapi = new Vapi(cfg.publicKey);
  const vad = new SpeechDetector();
  const mic = new Mic({ onFrame: (_p, rms) => vad.push(rms), onLevel: (rms) => { ui.level.style.width = `${Math.min(100, rms * 900)}%`; } });
  let turn = 0;
  let callId = '';
  const session = { stop: async () => { mic.stop(); try { vapi.stop(); } catch {} } };
  state.active = session;
  vapi.on('call-start', () => setStatus('Connected · Vapi agent', 'listening'));
  vapi.on('speech-start', () => {
    const v2v = vad.measure(performance.now());
    setStatus('Speaking…', 'speaking');
    if (v2v == null) return;
    turn++;
    chip('voice-to-voice', v2v, 'Vapi');
    fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'vapi', clientV2vMs: v2v, turnIndex: turn, sessionId: callId }) });
  });
  vapi.on('speech-end', () => setStatus('Listening', 'listening'));
  let seg = 0;
  vapi.on('message', (m) => {
    if (m.type === 'transcript') {
      const who = m.role === 'user' ? 'user' : 'agent';
      const key = `v-${who}-${seg}`;
      bubble(who, key, m.transcript, {});
      if (m.transcriptType === 'final') seg++;
    } else if (m.type === 'tool-calls') sys(`🔧 ${(m.toolCallList || []).map((t) => t.function?.name).join(', ')}`);
  });
  vapi.on('error', (e) => sys(`⚠️ Vapi: ${e?.error?.message || e?.message || JSON.stringify(e).slice(0, 160)}`));
  vapi.on('call-end', () => { if (state.active === session) { sys('Vapi call ended. Vapi sends its own latency report to the dashboard.'); stop(); } });
  await mic.start();
  const assistant = cfg.assistantId || await (await fetch('/api/vapi/assistant')).json();
  const call = await vapi.start(assistant);
  callId = call?.id || '';
}

// ---------- Phone callback ----------
$('#callback-form').onsubmit = async (e) => {
  e.preventDefault();
  const phone = $('#cb-phone').value.replace(/[^\d+]/g, '');
  const st = $('#cb-status');
  st.textContent = 'Requesting a call…';
  const r = await fetch('/api/callback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
  const j = await r.json();
  st.textContent = j.error ? `⚠️ ${j.error}` : `📞 ${j.message}`;
};

loadConfig().catch((e) => sys(`Could not load configuration: ${e.message}`));
