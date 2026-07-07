/**
 * GateProcessor — noise gate / downward expander (estilo ISP Decimator).
 *
 * Essencial em alto ganho: entre as notas, o ruído/hiss/hum fica exposto. O gate
 * fecha (atenua) quando o envelope do sinal cai abaixo do threshold e abre quando
 * sobe. Detalhes que o tornam musical (e não "chaveado"):
 *  • DETECTOR de envelope de pico (attack instantâneo, release curto).
 *  • HISTERESE: abre no threshold, só fecha 6 dB abaixo → não "treme" (chatter).
 *  • HOLD: segura aberto por alguns ms depois de cair → preserva o sustain/decay.
 *  • ATTACK/RELEASE do ganho: abre rápido (não corta o ataque da nota), fecha no
 *    tempo do knob Decay (fechar abrupto "engole" a cauda; lento deixa vazar ruído).
 *
 * É um multiplicador de ganho suave → não precisa de oversampling.
 */
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -55, minValue: -90, maxValue: 0, automationRate: 'k-rate' }, // dBFS
      { name: 'release', defaultValue: 120, minValue: 10, maxValue: 600, automationRate: 'k-rate' },   // ms
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.env = 0;        // envelope detectado
    this.gain = 1;       // ganho aplicado (0 fechado, 1 aberto)
    this.open = false;
    this.holdRemain = 0;
    this.envRel = Math.exp(-1 / (0.004 * sampleRate)); // release do detector ~4 ms
    this.attCoef = 1 - Math.exp(-1 / (0.001 * sampleRate)); // abre em ~1 ms
    this.holdSamples = Math.floor(0.012 * sampleRate);      // hold ~12 ms
    // envia o ganho de redução pro medidor (a ~30 Hz)
    this._frames = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const x = input[0], y = output[0];
    if (!x) return true;
    if (params.bypass[0] >= 0.5) { y.set(x); this._report(1); return true; }

    const openLin = Math.pow(10, params.threshold[0] / 20);
    const closeLin = openLin * 0.5; // histerese de ~6 dB
    const relCoef = 1 - Math.exp(-1 / ((params.release[0] / 1000) * sampleRate));

    for (let i = 0; i < x.length; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      this.env = a > this.env ? a : this.env * this.envRel; // pico com release

      if (!this.open && this.env > openLin) { this.open = true; this.holdRemain = this.holdSamples; }
      else if (this.open && this.env >= closeLin) { this.holdRemain = this.holdSamples; }
      else if (this.open && this.env < closeLin) {
        if (this.holdRemain > 0) this.holdRemain--; else this.open = false;
      }

      const target = this.open ? 1 : 0;
      const c = target > this.gain ? this.attCoef : relCoef;
      this.gain += c * (target - this.gain);
      y[i] = x[i] * this.gain;
    }
    this._report(this.gain);
    return true;
  }

  _report(g) {
    // redução de ganho pro meter (opcional; a UI pode ler)
    if ((this._frames++ & 15) === 0) this.port.postMessage({ gr: g });
  }
}

registerProcessor('gate-processor', GateProcessor);
