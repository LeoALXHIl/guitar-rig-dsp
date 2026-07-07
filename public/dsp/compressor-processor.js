/**
 * CompressorProcessor — compressor feed-forward (estilo pedal/estúdio).
 *
 * DSP: detector de envelope (peak com attack/release) → cálculo de ganho em dB com
 * threshold, ratio e soft-knee → makeup gain. Clássico pra sustain/lead e funk/country.
 * Feed-forward (detecta na entrada) com knee suave pra transição musical. Envia a
 * redução de ganho (GR, em dB) pro meter via port.
 */
class CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -24, minValue: -60, maxValue: 0, automationRate: 'k-rate' }, // dBFS
      { name: 'ratio', defaultValue: 4, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 8, minValue: 0.1, maxValue: 100, automationRate: 'k-rate' },     // ms
      { name: 'release', defaultValue: 120, minValue: 10, maxValue: 1000, automationRate: 'k-rate' },  // ms
      { name: 'makeup', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: 'k-rate' },        // dB
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.env = 1e-6;   // envelope linear
    this.gr = 0;       // redução atual (dB, ≤0)
    this._frames = 0;
    this.knee = 6;     // dB de soft-knee
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || input.length === 0) return true;
    const x = input[0], y = output[0];
    if (!x) return true;
    if (params.bypass[0] >= 0.5) { y.set(x); this._report(0); return true; }

    const thr = params.threshold[0], ratio = params.ratio[0];
    const makeup = Math.pow(10, params.makeup[0] / 20);
    const attCoef = 1 - Math.exp(-1 / ((params.attack[0] / 1000) * sampleRate));
    const relCoef = 1 - Math.exp(-1 / ((params.release[0] / 1000) * sampleRate));
    const knee = this.knee;
    let lastGrDb = 0;

    for (let i = 0; i < x.length; i++) {
      const a = x[i] < 0 ? -x[i] : x[i];
      // detector de envelope (peak, attack/release)
      const coef = a > this.env ? attCoef : relCoef;
      this.env += coef * (a - this.env);
      const level = 20 * Math.log10(this.env + 1e-9); // dBFS

      // curva estática com soft-knee
      let grDb = 0;
      const over = level - thr;
      if (over >= knee / 2) grDb = (thr + (level - thr) / ratio) - level;         // acima do joelho
      else if (over > -knee / 2) {                                                 // dentro do joelho
        const x2 = over + knee / 2;
        const comp = ((1 / ratio - 1) * x2 * x2) / (2 * knee);
        grDb = comp;
      }
      lastGrDb = grDb;
      y[i] = x[i] * Math.pow(10, grDb / 20) * makeup;
    }
    this._report(lastGrDb);
    return true;
  }
  _report(grDb) { if ((this._frames++ & 15) === 0) this.port.postMessage({ gr: grDb }); }
}
registerProcessor('compressor-processor', CompressorProcessor);
