/**
 * ReverbProcessor — reverb algorítmico Freeverb (Schroeder/Moorer) estéreo.
 *
 * 8 comb filters em paralelo + 4 allpass em série por canal (o canal direito usa as
 * mesmas tunings deslocadas → imagem estéreo). size = tamanho da sala (decaimento),
 * damp = absorção dos agudos (sala mais "morta"), mix = dry/wet.
 * Tunings do Freeverb clássico, escaladas pela sample rate.
 */
const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLP = [556, 441, 341, 225];
const SPREAD = 23, FIXED = 0.015;

function mkComb(len) { return { b: new Float32Array(len), i: 0, f: 0 }; }
function mkAllp(len) { return { b: new Float32Array(len), i: 0 }; }

class ReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'size', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'damp', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    const sc = sampleRate / 44100;
    this.ch = [0, 1].map((c) => ({
      combs: COMB.map((t) => mkComb(Math.round((t + (c ? SPREAD : 0)) * sc))),
      allps: ALLP.map((t) => mkAllp(Math.round((t + (c ? SPREAD : 0)) * sc))),
    }));
  }
  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    if (params.bypass[0] >= 0.5) { for (let c = 0; c < out.length; c++) if (out[c]) out[c].set(inp && inp[c] ? inp[c] : out[c].fill(0)); return true; }
    const fb = params.size[0] * 0.28 + 0.7, d1 = params.damp[0] * 0.4, d2 = 1 - d1, mix = params.mix[0];
    for (let c = 0; c < out.length; c++) {
      const st = this.ch[c] || this.ch[0], x = inp && inp[c] ? inp[c] : null, y = out[c];
      const combs = st.combs, allps = st.allps;
      for (let i = 0; i < y.length; i++) {
        const dry = x ? x[i] : 0, inn = dry * FIXED;
        let w = 0;
        for (let k = 0; k < combs.length; k++) { const cm = combs[k]; const o = cm.b[cm.i]; cm.f = o * d2 + cm.f * d1; cm.b[cm.i] = inn + cm.f * fb; if (++cm.i >= cm.b.length) cm.i = 0; w += o; }
        for (let k = 0; k < allps.length; k++) { const ap = allps[k]; const bufd = ap.b[ap.i]; const o = -w + bufd; ap.b[ap.i] = w + bufd * 0.5; if (++ap.i >= ap.b.length) ap.i = 0; w = o; }
        y[i] = dry * (1 - mix) + w * mix;
      }
    }
    return true;
  }
}
registerProcessor('reverb-processor', ReverbProcessor);
