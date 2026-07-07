/**
 * OverdriveProcessor — primeiro pedal da cadeia.
 *
 * v2: OVERSAMPLING 4× (anti-aliasing no soft clip) + suavização de Drive/Level.
 *
 * FÍSICA: soft clip via tanh (satura suave → harmônicos de ordem baixa), com bias
 * assimétrico (harmônicos pares, "calor" de válvula), tone = passa-baixa 1 polo,
 * level = ganho de saída. O tanh gera harmônicos acima de Nyquist → rodamos a 4×
 * a taxa e reamostramos com FIR polifásico pra não dobrar (aliasing).
 */

// ─── Oversampler polifásico (idêntico ao do amp; verificado no harness Node) ───
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

const OS_FACTOR = 4;

class OverdriveProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive', defaultValue: 8, minValue: 1, maxValue: 100, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'level', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.fsOS = sampleRate * OS_FACTOR;
    this.os = new Oversampler(OS_FACTOR, 16);
    this.up = new Float32Array(OS_FACTOR);
    this._lp = 0;             // estado do tone (passa-baixa) à taxa 4×
    this._bias = 0.18; this._biasComp = Math.tanh(0.18);
    this.smA = 1 - Math.exp(-1 / (0.005 * sampleRate));
    this.sDrive = 8; this.sLevel = 0.5;
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const x = input[0], y = output[0];
    if (!x) return true;

    if (params.bypass[0] >= 0.5) { y.set(x); return true; }

    const driveT = params.drive[0], tone = params.tone[0], levelT = params.level[0];
    // tone → corte do passa-baixa (700 Hz .. 7 kHz), coef à taxa 4×
    const cutoff = 700 * Math.pow(10, tone);   // 700 * (7000/700)^tone ≈ 700..7000
    const dt = 1 / this.fsOS, rc = 1 / (2 * Math.PI * Math.min(cutoff, this.fsOS * 0.45));
    const a = dt / (rc + dt);
    const up = this.up, L = OS_FACTOR;

    for (let i = 0; i < x.length; i++) {
      this.sDrive += this.smA * (driveT - this.sDrive);
      this.sLevel += this.smA * (levelT - this.sLevel);
      this.os.up(x[i], up);
      for (let k = 0; k < L; k++) {
        let s = up[k] * this.sDrive;
        s = Math.tanh(s + this._bias) - this._biasComp;    // soft clip assimétrico
        this._lp += a * (s - this._lp); s = this._lp;      // tone
        up[k] = s * this.sLevel;
      }
      y[i] = this.os.down(up);
    }
    return true;
  }
}

registerProcessor('overdrive-processor', OverdriveProcessor);
