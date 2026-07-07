/**
 * EqProcessor — EQ paramétrico de 3 bandas + HP/LP (pós-cab, o "segredo" de mix).
 *
 * Low shelf + Mid peaking (freq/Q/gain) + High shelf, com passa-alta e passa-baixa
 * opcionais. Biquads RBJ (Transposed DF-II). Coeficientes recalculados por bloco só
 * quando os parâmetros mudam. Estéreo (processa todos os canais de entrada).
 */
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _n(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
  peaking(fs, f0, Q, dB) { const A = Math.pow(10, dB / 40), w = 2 * Math.PI * f0 / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Q); this._n(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A); }
  lowShelf(fs, f0, dB) { const A = Math.pow(10, dB / 40), w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), b = Math.sqrt(A) / 0.9 * s; this._n(A * ((A + 1) - (A - 1) * c + b), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - b), (A + 1) + (A - 1) * c + b, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - b); }
  highShelf(fs, f0, dB) { const A = Math.pow(10, dB / 40), w = 2 * Math.PI * f0 / fs, c = Math.cos(w), s = Math.sin(w), b = Math.sqrt(A) / 0.9 * s; this._n(A * ((A + 1) + (A - 1) * c + b), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - b), (A + 1) - (A - 1) * c + b, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - b); }
  highpass(fs, f0, Q) { const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Q); this._n((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  lowpass(fs, f0, Q) { const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), al = Math.sin(w) / (2 * Q); this._n((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  process(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
}

class EqProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'lowGain', defaultValue: 0, minValue: -18, maxValue: 18, automationRate: 'k-rate' },
      { name: 'midGain', defaultValue: 0, minValue: -18, maxValue: 18, automationRate: 'k-rate' },
      { name: 'midFreq', defaultValue: 800, minValue: 200, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'midQ', defaultValue: 1, minValue: 0.2, maxValue: 8, automationRate: 'k-rate' },
      { name: 'highGain', defaultValue: 0, minValue: -18, maxValue: 18, automationRate: 'k-rate' },
      { name: 'hpFreq', defaultValue: 20, minValue: 20, maxValue: 400, automationRate: 'k-rate' },
      { name: 'lpFreq', defaultValue: 20000, minValue: 2000, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.ch = [];  // banco de biquads por canal
    this._key = '';
  }
  _bank() { return { hp: new Biquad(), low: new Biquad(), mid: new Biquad(), high: new Biquad(), lp: new Biquad() }; }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    if (params.bypass[0] >= 0.5) { for (let c = 0; c < input.length; c++) output[c] && output[c].set(input[c]); return true; }
    const fs = sampleRate;
    const key = ['lowGain', 'midGain', 'midFreq', 'midQ', 'highGain', 'hpFreq', 'lpFreq'].map(k => params[k][0]).join('|');
    const recompute = key !== this._key; this._key = key;
    for (let c = 0; c < input.length; c++) {
      if (!this.ch[c]) this.ch[c] = this._bank();
      const b = this.ch[c];
      if (recompute) {
        b.hp.highpass(fs, params.hpFreq[0], 0.707);
        b.low.lowShelf(fs, 120, params.lowGain[0]);
        b.mid.peaking(fs, params.midFreq[0], params.midQ[0], params.midGain[0]);
        b.high.highShelf(fs, 3500, params.highGain[0]);
        b.lp.lowpass(fs, params.lpFreq[0], 0.707);
      }
      const x = input[c], y = output[c];
      for (let i = 0; i < x.length; i++) {
        let s = x[i];
        s = b.hp.process(s); s = b.low.process(s); s = b.mid.process(s); s = b.high.process(s); s = b.lp.process(s);
        y[i] = s;
      }
    }
    return true;
  }
}
registerProcessor('eq-processor', EqProcessor);
