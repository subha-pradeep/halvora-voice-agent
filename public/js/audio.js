// Browser audio helpers shared by every mode: mic capture, streaming playback, VAD and the
// voice-to-voice latency meter (same measurement method across cascade, S2S, LiveKit and Vapi).

export class Mic {
  constructor({ onFrame, onLevel } = {}) { this.onFrame = onFrame; this.onLevel = onLevel; }
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/js/mic-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'mic-processor');
    this.node.port.onmessage = (e) => { this.onLevel?.(e.data.rms); this.onFrame?.(e.data.pcm, e.data.rms); };
    src.connect(this.node);
    // Worklet must be pulled by the graph; route through a muted gain so nothing is audible.
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
  }
  stop() {
    try { this.node?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
  }
}

// Plays streamed PCM16 chunks gaplessly with a small pre-buffer.
export class Player {
  constructor({ sampleRate = 24000, preBufferMs = 80 } = {}) {
    this.ctx = new AudioContext({ sampleRate });
    this.rate = sampleRate;
    this.preBuffer = preBufferMs / 1000;
    this.next = 0;
    this.sources = new Set();
    this.onStart = null; // (perfTime) => void, fired when a new burst of audio starts playing
  }
  async resume() { if (this.ctx.state !== 'running') await this.ctx.resume(); }
  isPlaying() { return this.ctx.currentTime < this.next - 0.01; }
  enqueue(arrayBuffer) {
    const i16 = new Int16Array(arrayBuffer);
    if (!i16.length) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f32.length, this.rate);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    const fresh = this.next <= now;
    const at = fresh ? now + this.preBuffer : this.next;
    src.start(at);
    this.next = at + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    if (fresh && this.onStart) this.onStart(performance.now() + (at - now) * 1000);
  }
  clear() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear();
    this.next = 0;
  }
  close() { this.clear(); this.ctx.close().catch(() => {}); }
}

// Energy VAD with an adaptive noise floor. Tracks when the user last made voiced sound.
export class SpeechDetector {
  constructor() { this.floor = 0.004; this.lastVoiceAt = 0; this.voicedFrames = 0; this.spokeSinceMark = false; }
  push(rms, { agentPlaying = false } = {}) {
    if (rms < this.floor * 2) this.floor = this.floor * 0.995 + rms * 0.005;
    const thr = Math.max(0.012, this.floor * 3.5);
    if (rms > thr * (agentPlaying ? 2.5 : 1)) {
      this.voicedFrames++;
      if (this.voicedFrames >= 3) { this.lastVoiceAt = performance.now(); this.spokeSinceMark = true; }
    } else this.voicedFrames = 0;
  }
  // Called when the agent's response audio starts: returns voice-to-voice ms or null.
  measure(agentStartPerf) {
    if (!this.spokeSinceMark || !this.lastVoiceAt) return null;
    this.spokeSinceMark = false;
    const v = agentStartPerf - this.lastVoiceAt;
    return v > 0 && v < 30000 ? Math.round(v) : null;
  }
}

// Detects onset of remote (agent) audio on a MediaStreamTrack, for LiveKit.
export class RemoteOnset {
  constructor(track, onOnset) {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.an = this.ctx.createAnalyser();
    this.an.fftSize = 512;
    src.connect(this.an);
    const data = new Float32Array(this.an.fftSize);
    let silentSince = performance.now();
    let speaking = false;
    this.timer = setInterval(() => {
      this.an.getFloatTimeDomainData(data);
      let s = 0; for (const v of data) s += v * v;
      const rms = Math.sqrt(s / data.length);
      const now = performance.now();
      if (rms > 0.01) {
        if (!speaking && now - silentSince > 350) onOnset(now);
        speaking = true;
      } else {
        if (speaking) silentSince = now;
        speaking = false;
      }
    }, 10);
  }
  stop() { clearInterval(this.timer); this.ctx.close().catch(() => {}); }
}
