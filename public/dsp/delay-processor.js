/**
 * DelayProcessor — delay estéreo com feedback e tone no laço (vibe analógico/BBD).
 *
 * Buffer circular por canal. A cada sample: lê o sample atrasado, filtra (passa-baixa
 * de 1 polo no caminho de realimentação → cada repetição fica mais escura, como um
 * delay analógico), realimenta e mistura dry/wet. tone=1 brilhante, tone=0 escuro.
 */
class DelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'time', defaultValue: 0.35, minValue: 0.02, maxValue: 1.2, automationRate: 'k-rate' },   // s
      { name: 'feedback', defaultValue: 0.35, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.max = Math.ceil(sampleRate * 1.3);
    this.buf = []; this.wp = []; this.lp = [];
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    if (params.bypass[0] >= 0.5) { for (let c = 0; c < out.length; c++) if (out[c]) out[c].set(inp && inp[c] ? inp[c] : out[c].fill(0)); return true; }
    const ds = Math.max(1, Math.min(this.max - 1, Math.floor(params.time[0] * sampleRate)));
    const fb = params.feedback[0], mix = params.mix[0];
    const cutoff = 800 * Math.pow(10, params.tone[0]);         // 800 Hz .. 8 kHz
    const dt = 1 / sampleRate, rc = 1 / (2 * Math.PI * Math.min(cutoff, sampleRate * 0.45)), a = dt / (rc + dt);
    for (let c = 0; c < out.length; c++) {
      if (!this.buf[c]) { this.buf[c] = new Float32Array(this.max); this.wp[c] = 0; this.lp[c] = 0; }
      const buf = this.buf[c], x = inp && inp[c] ? inp[c] : null, y = out[c];
      let wp = this.wp[c], lp = this.lp[c];
      for (let i = 0; i < y.length; i++) {
        const dry = x ? x[i] : 0;
        let rp = wp - ds; if (rp < 0) rp += this.max;
        let wet = buf[rp];
        lp += a * (wet - lp); wet = lp;                        // tone no feedback
        buf[wp] = dry + wet * fb;
        if (++wp >= this.max) wp = 0;
        y[i] = dry * (1 - mix) + wet * mix;
      }
      this.wp[c] = wp; this.lp[c] = lp;
    }
    return true;
  }
}
registerProcessor('delay-processor', DelayProcessor);
