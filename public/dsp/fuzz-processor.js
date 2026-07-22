/**
 * FuzzProcessor — pedal de fuzz estilo "Big Muff" (Sustain/Tone/Level).
 *
 * FÍSICA: dois estágios de ganho com clipping (transistor + diodos) em cascata → fuzz
 * denso e sustentado, MUITO mais comprimido/gordo que o overdrive. Entre os estágios,
 * um passa-baixa dá o "creme". O controle TONE é a rede passiva clássica do Muff:
 * crossfade entre uma versão grave (passa-baixa) e aguda (passa-alta) → escavado no meio.
 *
 * Anti-aliasing: como o clipping pesado gera muitos harmônicos acima de Nyquist, toda a
 * não-linearidade roda a 4× a sample rate e é reamostrada com FIR polifásico (igual OD/amp).
 */

// ─── Oversampler polifásico (idêntico ao do OD/amp; verificado no harness Node) ───
class Oversampler {
  constructor(factor, tapsPerPhase = 16) {
    this.L = factor; const N = tapsPerPhase * factor; this.N = N;
    this.hUp = this._design(N, 0.45 / factor, factor);
    this.hDown = this._design(N, 0.45 / factor, 1);
    this.tpp = Math.ceil(N / factor);
    this.sub = [];
    for (let p = 0; p < factor; p++) { const arr = []; for (let j = 0; p + j * factor < N; j++) arr.push(this.hUp[p + j * factor]); this.sub.push(Float32Array.from(arr)); }
    this.upBuf = new Float32Array(this.tpp); this.upPos = 0;
    this.downBuf = new Float32Array(N); this.downPos = 0;
  }
  _design(N, cutoff, dcGain) {
    const h = new Float32Array(N), M = N - 1; let sum = 0;
    for (let n = 0; n < N; n++) { const k = n - M / 2; const s = Math.abs(k) < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k); const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / M) + 0.08 * Math.cos(4 * Math.PI * n / M); h[n] = s * w; sum += h[n]; }
    const g = dcGain / sum; for (let n = 0; n < N; n++) h[n] *= g; return h;
  }
  up(x, out) {
    this.upBuf[this.upPos] = x; this.upPos = (this.upPos + 1) % this.tpp;
    for (let p = 0; p < this.L; p++) { const sf = this.sub[p]; let acc = 0, idx = this.upPos - 1; for (let j = 0; j < sf.length; j++) { if (idx < 0) idx += this.tpp; acc += sf[j] * this.upBuf[idx]; idx--; } out[p] = acc; }
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

class FuzzProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sustain', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'tone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'level', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.fsOS = sampleRate * OS_FACTOR;
    this.os = new Oversampler(OS_FACTOR, 16);
    this.up = new Float32Array(OS_FACTOR);
    this._dc = { x1: 0, y1: 0 };  // bloqueio de DC na entrada
    this._mid = 0;                 // passa-baixa entre estágios (à 4×)
    this._toneLp = 0;              // passa-baixa do controle de tone (à 4×)
    this.smA = 1 - Math.exp(-1 / (0.005 * sampleRate));
    this.sSus = 0.6; this.sLevel = 0.6;
  }

  _hpCoef(fc, fs) { return Math.exp(-2 * Math.PI * fc / fs); }
  _lpCoef(fc, fs) { const dt = 1 / fs, rc = 1 / (2 * Math.PI * fc); return dt / (rc + dt); }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const x = input[0], y = output[0];
    if (!x) return true;
    if (params.bypass[0] >= 0.5) { y.set(x); return true; }

    const susT = params.sustain[0], tone = params.tone[0], levelT = params.level[0];
    const fs = this.fsOS, up = this.up, L = OS_FACTOR;
    const Rdc = this._hpCoef(25, fs);
    const aMid = this._lpCoef(6500, fs);          // suaviza entre estágios
    const aTone = this._lpCoef(700 * Math.pow(10, tone * 0.8), fs); // 700..~4400 Hz
    const bias = 0.05;                            // leve assimetria → harmônicos pares

    for (let i = 0; i < x.length; i++) {
      this.sSus += this.smA * (susT - this.sSus);
      this.sLevel += this.smA * (levelT - this.sLevel);
      const preGain = 4 + this.sSus * 86;         // 4..90
      this.os.up(x[i], up);
      for (let k = 0; k < L; k++) {
        // bloqueio de DC
        let s = Rdc * (this._dc.y1 + up[k] - this._dc.x1); this._dc.x1 = up[k]; this._dc.y1 = s;
        // estágio 1 (ganho alto, clip)
        s = Math.tanh(preGain * s + bias) - Math.tanh(bias);
        // passa-baixa entre estágios (creme)
        this._mid += aMid * (s - this._mid); s = this._mid;
        // estágio 2 (mais suave, adiciona sustain/compressão)
        s = Math.tanh(1.8 * s);
        // controle de TONE: crossfade grave(LP) ↔ agudo(HP=sinal-LP) → escavado no meio
        this._toneLp += aTone * (s - this._toneLp);
        const lp = this._toneLp, hp = s - this._toneLp;
        s = lp * (1 - tone) + hp * tone;
        up[k] = s * (0.15 + this.sLevel * 0.85);
      }
      y[i] = this.os.down(up);
    }
    return true;
  }
}

registerProcessor('fuzz-processor', FuzzProcessor);
