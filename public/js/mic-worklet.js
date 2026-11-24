// AudioWorklet: downsample mic input to 16 kHz mono PCM16 and emit 20 ms frames with their RMS.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.frame = new Int16Array(320);
    this.n = 0;
    this.acc = 0;
    this.accN = 0;
    this.sumSq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // Box-filter decimation: average the samples that fall into each output sample.
      this.acc += ch[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.acc = 0; this.accN = 0;
        this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.sumSq += v * v;
        if (this.n === 320) {
          const rms = Math.sqrt(this.sumSq / 320);
          this.port.postMessage({ pcm: this.frame.buffer, rms }, [this.frame.buffer]);
          this.frame = new Int16Array(320);
          this.n = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
