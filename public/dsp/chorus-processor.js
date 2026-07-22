/**
 * ChorusProcessor — chorus estéreo (Rate/Depth/Mix).
 *
 * FÍSICA: duas linhas de delay curtas (~8 ms) moduladas por um LFO senoidal. A variação
 * de tempo desafina levemente a cópia → engrossa/espacializa o som. Os LFOs de L e R ficam
 * 90° defasados pra abrir a imagem estéreo. Leitura com interpolação linear (sem "zipper").
 */
class ChorusProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.len = Math.ceil(sampleRate * 0.05);          // buffer de 50 ms
    this.buf = [new Float32Array(this.len), new Float32Array(this.len)];
    this.wp = 0;
    this.phase = 0;
    this.base = 0.008 * sampleRate;                    // 8 ms
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) { return true; }
    const inL = input[0], inR = input[1] || input[0];
    const outL = output[0], outR = output[1] || output[0];
    if (!inL) return true;
    const n = outL.length;
    if (params.bypass[0] >= 0.5) { outL.set(inL); if (output[1]) outR.set(inR); return true; }

    const rate = 0.1 + params.rate[0] * 5.9;           // 0.1..6 Hz
    const depth = params.depth[0] * 0.005 * sampleRate; // até 5 ms de modulação
    const mix = params.mix[0];
    const inc = 2 * Math.PI * rate / sampleRate;
    const L = this.len;

    for (let i = 0; i < n; i++) {
      const dry = [inL[i], inR ? inR[i] : inL[i]];
      this.buf[0][this.wp] = dry[0]; this.buf[1][this.wp] = dry[1];
      for (let c = 0; c < 2; c++) {
        const lfo = Math.sin(this.phase + (c ? Math.PI / 2 : 0)); // R defasado 90°
        const d = this.base + depth * (0.5 + 0.5 * lfo);
        let rp = this.wp - d;
        while (rp < 0) rp += L;
        const i0 = Math.floor(rp), frac = rp - i0;
        const a = this.buf[c][i0 % L], b = this.buf[c][(i0 + 1) % L];
        const wet = a + (b - a) * frac;
        const o = dry[c] * (1 - mix * 0.5) + wet * mix;
        if (c === 0) outL[i] = o; else if (output[1]) outR[i] = o;
      }
      this.phase += inc; if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      this.wp = (this.wp + 1) % L;
    }
    return true;
  }
}
registerProcessor('chorus-processor', ChorusProcessor);
