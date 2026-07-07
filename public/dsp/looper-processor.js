/**
 * LooperProcessor — looper de camadas (record → overdub → play), pós-master.
 *
 * Grava o sinal que passa por ele num buffer pré-alocado (60 s mono), toca em loop
 * e permite overdub (soma novas camadas por cima). Máquina de estados via mensagens:
 *   idle → [rec] grava a 1ª camada → [rec de novo] fecha o loop e toca →
 *          [rec de novo] liga/desliga overdub ; [stop] para ; [clear] zera.
 * Saída = sinal seco (passthrough) + playback do loop. Reporta estado/tamanho pra UI.
 */
class LooperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.max = Math.floor(sampleRate * 60);
    this.buf = new Float32Array(this.max);
    this.state = 'idle';   // idle | rec | play | stopped
    this.writePos = 0; this.playPos = 0; this.loopLen = 0;
    this.level = 1; this.overdub = false;
    this._frames = 0;
    this.port.onmessage = (e) => this._cmd(e.data);
  }
  _cmd(d) {
    const c = d.cmd;
    if (c === 'rec') {
      if (this.state === 'idle') { this.state = 'rec'; this.writePos = 0; this.loopLen = 0; }
      else if (this.state === 'rec') { this.loopLen = this.writePos; this.state = 'play'; this.playPos = 0; }
      else if (this.state === 'play') { this.overdub = !this.overdub; }
      else if (this.state === 'stopped' && this.loopLen > 0) { this.state = 'play'; this.playPos = 0; }
    } else if (c === 'stop') {
      if (this.state === 'rec') this.loopLen = this.writePos;
      this.state = this.loopLen > 0 ? 'stopped' : 'idle'; this.overdub = false;
    } else if (c === 'clear') {
      this.buf.fill(0); this.state = 'idle'; this.writePos = this.playPos = this.loopLen = 0; this.overdub = false;
    } else if (c === 'level') { this.level = d.value; }
    this._report();
  }
  _report() { this.port.postMessage({ state: this.state, secs: this.loopLen / sampleRate, overdub: this.overdub }); }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const nCh = out.length, n = out[0].length;
    // loop é mono (gravado do canal 0), mas o passthrough preserva todos os canais (estéreo do cab)
    for (let i = 0; i < n; i++) {
      const dry0 = inp && inp[0] ? inp[0][i] : 0;
      let wet = 0;
      if (this.state === 'rec') { if (this.writePos < this.max) this.buf[this.writePos++] = dry0; }
      else if (this.state === 'play' && this.loopLen > 0) {
        wet = this.buf[this.playPos] * this.level;
        if (this.overdub) this.buf[this.playPos] += dry0;
        if (++this.playPos >= this.loopLen) this.playPos = 0;
      }
      for (let c = 0; c < nCh; c++) { const d = inp && inp[c] ? inp[c][i] : 0; out[c][i] = d + wet; }
    }
    // reporta posição ~20×/s pra barra de progresso
    if ((this._frames++ & 7) === 0 && this.state === 'play') this.port.postMessage({ state: 'play', secs: this.loopLen / sampleRate, overdub: this.overdub, pos: this.playPos / (this.loopLen || 1) });
    return true;
  }
}
registerProcessor('looper-processor', LooperProcessor);
