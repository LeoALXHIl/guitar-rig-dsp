/**
 * PhaserProcessor — phaser estéreo (Rate/Depth/Feedback/Mix).
 *
 * FÍSICA: cascata de 6 filtros all-pass de 1ª ordem cujo coeficiente é varrido por um LFO.
 * Isso move uma série de notches pelo espectro → o "varrido" setentista. Feedback realimenta
 * a saída na entrada da cascata (notches mais profundos/ressonantes). L e R defasados p/ estéreo.
 */
class PhaserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.7, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.3, minValue: 0, maxValue: 0.9, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.N = 6;                                  // 6 estágios all-pass
    this.zm = [new Float32Array(this.N), new Float32Array(this.N)]; // estado por canal
    this.fb = [0, 0];
    this.phase = 0;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const inL = input[0], inR = input[1] || input[0];
    const outL = output[0], outR = output[1] || output[0];
    if (!inL) return true;
    const n = outL.length;
    if (params.bypass[0] >= 0.5) { outL.set(inL); if (output[1]) outR.set(inR); return true; }

    const rate = 0.05 + params.rate[0] * 3.95;    // 0.05..4 Hz
    const depth = params.depth[0], fbAmt = params.feedback[0], mix = params.mix[0];
    const inc = 2 * Math.PI * rate / sampleRate;
    // faixa de varredura dos notches: ~300 Hz .. ~2300 Hz
    const fMin = 300, fMax = 2300, N = this.N;

    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const x0 = c === 0 ? inL[i] : (inR ? inR[i] : inL[i]);
        const lfo = Math.sin(this.phase + (c ? Math.PI / 2 : 0));
        const f = fMin * Math.pow(fMax / fMin, 0.5 + 0.5 * lfo * depth);
        const tanw = Math.tan(Math.PI * Math.min(f, sampleRate * 0.45) / sampleRate);
        const g = (tanw - 1) / (tanw + 1);        // coef do all-pass de 1ª ordem
        let s = x0 + fbAmt * this.fb[c];
        const zm = this.zm[c];
        for (let k = 0; k < N; k++) {
          const y = g * s + zm[k];
          zm[k] = s - g * y;                       // all-pass: y = g*x + z; z = x - g*y
          s = y;
        }
        this.fb[c] = s;
        const o = x0 * (1 - mix) + s * mix;
        if (c === 0) outL[i] = o; else if (output[1]) outR[i] = o;
      }
      this.phase += inc; if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    }
    return true;
  }
}
registerProcessor('phaser-processor', PhaserProcessor);
