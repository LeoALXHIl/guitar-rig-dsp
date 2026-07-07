/**
 * TunerProcessor — afinador por detecção de pitch (autocorrelação normalizada / NSDF,
 * estilo MPM/McLeod). Acumula um buffer de análise, estima o período fundamental e
 * envia a frequência (Hz) e clareza pro main thread, que converte em nota/cents.
 *
 * Passa o áudio adiante inalterado (é só um "tap"); o mute do afinador é feito na UI.
 */
class TunerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;           // ~43 ms @ 48k — cobre até ~E2 (82 Hz)
    this.buf = new Float32Array(this.size);
    this.pos = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (input && input.length && output && output.length) {
      for (let c = 0; c < output.length; c++) if (output[c] && input[c]) output[c].set(input[c]);
    }
    if (!input || !input[0]) return true;
    const x = input[0];
    for (let i = 0; i < x.length; i++) {
      this.buf[this.pos++] = x[i];
      if (this.pos >= this.size) { this.pos = 0; this._analyze(); }
    }
    return true;
  }
  _analyze() {
    const buf = this.buf, n = this.size;
    // energia — não tenta detectar em silêncio
    let rms = 0; for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / n);
    if (rms < 0.005) { this.port.postMessage({ hz: 0, clarity: 0 }); return; }

    // YIN: função de diferença + normalização cumulativa (robusto p/ pitch de guitarra)
    const maxLag = Math.floor(n / 2);
    const d = new Float32Array(maxLag);
    for (let lag = 1; lag < maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < maxLag; i++) { const diff = buf[i] - buf[i + lag]; sum += diff * diff; }
      d[lag] = sum;
    }
    // diferença média cumulativa normalizada (cmnd)
    const cmnd = new Float32Array(maxLag); cmnd[0] = 1;
    let running = 0;
    for (let lag = 1; lag < maxLag; lag++) { running += d[lag]; cmnd[lag] = d[lag] * lag / (running || 1); }

    // 1º lag abaixo do threshold que seja mínimo local; senão, mínimo global
    const THRESH = 0.12;
    let bestLag = -1;
    for (let lag = 2; lag < maxLag - 1; lag++) {
      if (cmnd[lag] < THRESH && cmnd[lag] <= cmnd[lag - 1] && cmnd[lag] <= cmnd[lag + 1]) { bestLag = lag; break; }
    }
    if (bestLag < 0) {
      let min = Infinity;
      for (let lag = 2; lag < maxLag; lag++) if (cmnd[lag] < min) { min = cmnd[lag]; bestLag = lag; }
      if (min > 0.3) { this.port.postMessage({ hz: 0, clarity: 1 - min }); return; } // sem pitch confiável
    }
    // refino parabólico em torno do mínimo
    let lag = bestLag;
    if (lag > 1 && lag < maxLag - 1) {
      const a = cmnd[lag - 1], b = cmnd[lag], c = cmnd[lag + 1];
      const denom = a + c - 2 * b;
      if (Math.abs(denom) > 1e-9) lag += (a - c) / (2 * denom);
    }
    const hz = sampleRate / lag;
    this.port.postMessage({ hz, clarity: 1 - cmnd[bestLag] });
  }
}
registerProcessor('tuner-processor', TunerProcessor);
