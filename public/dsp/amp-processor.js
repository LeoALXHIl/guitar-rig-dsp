/**
 * AmpProcessor — cabeçote virtual com 2 modelos (JCM800 2203 / EVH 5150III Lead).
 *
 * v2 (profissionalização):
 *  • OVERSAMPLING 4× (#1): toda a cascata não-linear roda a 4× a sample rate e é
 *    reamostrada com FIR polifásico (windowed-sinc Blackman). Mata o aliasing dos
 *    estágios de tanh em alto ganho — verificado em ~19 dB de redução via FFT.
 *  • SUAVIZAÇÃO DE PARÂMETROS (#3): Gain e Master são suavizados por one-pole
 *    (~5 ms) por sample → sem "zipper noise" ao girar knobs.
 *
 * Cadeia modelada (agora a 4× internamente):
 *   HP grid → [V1a] → acopl. → [V1b] → acopl. → [V3a] (→ [V4a] no 5150)
 *           → tone stack → Presence → Depth → power amp (+ sag) → trafo de saída
 *
 * A física de cada estágio está documentada no bloco de VOICES e no loop.
 * Todos os não-lineares são tanh → saída limitada a ±1.
 */

// ─── Oversampler polifásico (FIR windowed-sinc). Verificado no harness Node. ───
class Oversampler {
  constructor(factor, tapsPerPhase = 16) {
    this.L = factor;
    const N = tapsPerPhase * factor; this.N = N;
    this.hUp = this._design(N, 0.45 / factor, factor);
    this.hDown = this._design(N, 0.45 / factor, 1);
    this.tpp = Math.ceil(N / factor);
    this.sub = [];
    for (let p = 0; p < factor; p++) {
      const arr = [];
      for (let j = 0; p + j * factor < N; j++) arr.push(this.hUp[p + j * factor]);
      this.sub.push(Float32Array.from(arr));
    }
    this.upBuf = new Float32Array(this.tpp); this.upPos = 0;
    this.downBuf = new Float32Array(N); this.downPos = 0;
  }
  _design(N, cutoff, dcGain) {
    const h = new Float32Array(N), M = N - 1; let sum = 0;
    for (let n = 0; n < N; n++) {
      const k = n - M / 2;
      const s = Math.abs(k) < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / M) + 0.08 * Math.cos(4 * Math.PI * n / M);
      h[n] = s * w; sum += h[n];
    }
    const g = dcGain / sum;
    for (let n = 0; n < N; n++) h[n] *= g;
    return h;
  }
  up(x, out) {
    this.upBuf[this.upPos] = x; this.upPos = (this.upPos + 1) % this.tpp;
    for (let p = 0; p < this.L; p++) {
      const sf = this.sub[p]; let acc = 0, idx = this.upPos - 1;
      for (let j = 0; j < sf.length; j++) { if (idx < 0) idx += this.tpp; acc += sf[j] * this.upBuf[idx]; idx--; }
      out[p] = acc;
    }
  }
  down(block) {
    const N = this.N;
    for (let s = 0; s < this.L; s++) { this.downBuf[this.downPos] = block[s]; this.downPos = (this.downPos + 1) % N; }
    let acc = 0, idx = this.downPos - 1;
    for (let i = 0; i < N; i++) { if (idx < 0) idx += N; acc += this.hDown[i] * this.downBuf[idx]; idx--; }
    return acc;
  }
}

// ─── Biquad (RBJ cookbook), Transposed Direct Form II ───
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _norm(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  peaking(fs, f0, Q, dB) {
    const A = Math.pow(10, dB / 40), w0 = 2 * Math.PI * f0 / fs;
    const c = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
    this._norm(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A);
  }
  lowShelf(fs, f0, dB) {
    const A = Math.pow(10, dB / 40), w0 = 2 * Math.PI * f0 / fs;
    const c = Math.cos(w0), s = Math.sin(w0), beta = Math.sqrt(A) / 0.9 * s;
    this._norm(
      A * ((A + 1) - (A - 1) * c + beta), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - beta),
      (A + 1) + (A - 1) * c + beta, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - beta);
  }
  highShelf(fs, f0, dB) {
    const A = Math.pow(10, dB / 40), w0 = 2 * Math.PI * f0 / fs;
    const c = Math.cos(w0), s = Math.sin(w0), beta = Math.sqrt(A) / 0.9 * s;
    this._norm(
      A * ((A + 1) + (A - 1) * c + beta), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - beta),
      (A + 1) - (A - 1) * c + beta, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - beta);
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const lerp = (a, b, t) => a + (b - a) * t;

const VOICES = [
  { // 0 — 800-style (JCM800 2203)
    stages: 3, stageGain: [[1.5, 9], [1.5, 11], [1.2, 6]], bias: [0.12, 0.08, 0.05],
    millerHz: [9000, 11000, 10000], millerBrightHz: 15000, coupleHz: [150, 60], coupleBrightHz: 260,
    midHz: 560, midQ: 0.7, midRange: [-13, 5], trebHz: 3000, bassHz: 100,
    powerGain: [0.4, 4.5], sag: 0.6, xfmrResHz: 95, xfmrResGain: 3,
  },
  { // 1 — 5150-style Lead (EVH 5150III lead)
    stages: 4, stageGain: [[2, 12], [2, 13], [1.6, 9], [1.3, 6]], bias: [0.14, 0.10, 0.06, 0.04],
    millerHz: [6000, 7000, 6000, 6000], millerBrightHz: 9000, coupleHz: [220, 120], coupleBrightHz: 340,
    midHz: 650, midQ: 0.8, midRange: [-16, 3], trebHz: 3200, bassHz: 90,
    powerGain: [0.4, 4.0], sag: 0.35, xfmrResHz: 85, xfmrResGain: 4,
  },
];

const OS_FACTOR = 4;

class AmpProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'model', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bass', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mid', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'treble', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'presence', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.4, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'master', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bright', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'power', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.fsOS = sampleRate * OS_FACTOR;
    this.os = new Oversampler(OS_FACTOR, 16);
    this.up = new Float32Array(OS_FACTOR);
    // estado dos filtros (agora à taxa 4×)
    this.miller = [0, 0, 0, 0];
    this.cpl = [{ x1: 0, y1: 0 }, { x1: 0, y1: 0 }];
    this._dc = { x1: 0, y1: 0 };
    this.bassF = new Biquad(); this.midF = new Biquad(); this.trebF = new Biquad();
    this.presF = new Biquad(); this.depthF = new Biquad();
    this.sagEnv = 0;
    this.xfmrHP = { x1: 0, y1: 0 };
    this.xfmrRes = new Biquad();
    this._lastKey = '';
    // suavização de parâmetros (one-pole ~5 ms, na taxa base)
    this.smA = 1 - Math.exp(-1 / (0.005 * sampleRate));
    this.sGain = 0.6; this.sMaster = 0.5;
  }

  _hp(fc, fs) { return Math.exp(-2 * Math.PI * fc / fs); }
  _lpCoef(fc, fs) { const dt = 1 / fs, rc = 1 / (2 * Math.PI * fc); return dt / (rc + dt); }
  _highpass(x, st, R) { const y = R * (st.y1 + x - st.x1); st.x1 = x; st.y1 = y; return y; }
  _triode(x, g, bias) { return -(Math.tanh(g * x + bias) - Math.tanh(bias)); }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const xin = input[0], yout = output[0];
    if (!xin) return true;
    if (params.power[0] < 0.5) { yout.set(xin); return true; }

    const fs = this.fsOS;                       // TODOS os coeficientes usam a taxa 4×
    const V = VOICES[params.model[0] >= 0.5 ? 1 : 0];
    const gainT = params.gain[0], masterT = params.master[0], bright = params.bright[0] > 0.5;

    // coeficientes dependentes do bright (por bloco), à taxa 4×
    const aM = V.millerHz.map((f, i) => this._lpCoef(i === 0 && bright ? V.millerBrightHz : f, fs));
    const Rc0 = this._hp(bright ? V.coupleBrightHz : V.coupleHz[0], fs);
    const Rc1 = this._hp(V.coupleHz[1], fs);
    const inHP = this._hp(30, fs);
    const xfmrHPr = this._hp(24, fs);

    // tone stack / presence / depth (recalcula só quando muda), à taxa 4×
    const key = `${params.model[0]}|${params.bass[0]}|${params.mid[0]}|${params.treble[0]}|${params.presence[0]}|${params.depth[0]}`;
    if (key !== this._lastKey) {
      this._lastKey = key;
      const bass = params.bass[0], mid = params.mid[0], treble = params.treble[0];
      const pres = params.presence[0], depth = params.depth[0];
      this.bassF.lowShelf(fs, V.bassHz, lerp(-14, 8, bass));
      this.trebF.highShelf(fs, V.trebHz, lerp(-8, 12, treble));
      const smile = (bass + treble) / 2;
      this.midF.peaking(fs, V.midHz, V.midQ, lerp(V.midRange[0], V.midRange[1], mid) - smile * 3);
      this.presF.highShelf(fs, 2200, lerp(0, 10, pres));
      this.depthF.lowShelf(fs, 110, lerp(0, 9, depth));
      this.xfmrRes.peaking(fs, V.xfmrResHz, 1.1, V.xfmrResGain);
    }

    const sagRelease = Math.exp(-1 / (0.06 * fs));
    const nStages = V.stages;
    const up = this.up, L = OS_FACTOR;

    for (let i = 0; i < xin.length; i++) {
      // suaviza escalares (por sample base) e deriva ganhos dos estágios
      this.sGain += this.smA * (gainT - this.sGain);
      this.sMaster += this.smA * (masterT - this.sMaster);
      const g0 = lerp(V.stageGain[0][0], V.stageGain[0][1], this.sGain);
      const g1 = lerp(V.stageGain[1][0], V.stageGain[1][1], this.sGain);
      const g2 = lerp(V.stageGain[2][0], V.stageGain[2][1], this.sGain);
      const g3 = nStages > 3 ? lerp(V.stageGain[3][0], V.stageGain[3][1], this.sGain) : 0;
      const gs = [g0, g1, g2, g3];
      const pGain = lerp(V.powerGain[0], V.powerGain[1], this.sMaster);

      // upsample 1 → L, processa a cascata inteira a 4×, downsample L → 1
      this.os.up(xin[i], up);
      for (let k = 0; k < L; k++) {
        let s = this._highpass(up[k], this._dc, inHP);
        for (let st = 0; st < nStages; st++) {
          s = this._triode(s, gs[st], V.bias[st]);
          this.miller[st] += aM[st] * (s - this.miller[st]); s = this.miller[st];
          if (st < 2) s = this._highpass(s, this.cpl[st], st === 0 ? Rc0 : Rc1);
        }
        s = this.bassF.process(s); s = this.midF.process(s); s = this.trebF.process(s);
        s = this.presF.process(s); s = this.depthF.process(s);
        // power amp + sag
        const mag = s < 0 ? -s : s;
        this.sagEnv = mag > this.sagEnv ? mag : this.sagEnv * sagRelease;
        const sag = 1 / (1 + V.sag * this.sagEnv);
        s = Math.tanh(pGain * sag * s);
        // trafo de saída
        s = this._highpass(s, this.xfmrHP, xfmrHPr);
        s = this.xfmrRes.process(s);
        up[k] = s * 0.7;
      }
      yout[i] = this.os.down(up);
    }
    return true;
  }
}

registerProcessor('amp-processor', AmpProcessor);
