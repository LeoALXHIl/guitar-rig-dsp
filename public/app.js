// guitar-rig-dsp — main thread. Monta o grafo Web Audio, I/O, UI, meters.
//
// Cadeia de sinal (Sprint 2):
//   entrada ─▶ [meter in] ─▶ GATE ─▶ COMP ─▶ (OD ⇄ AMP) ─▶ EQ ─▶ CAB (dual-mic estéreo)
//                                                                     ─▶ master ─▶ [meter/scope] ─▶ fone
//   entrada ─▶ TUNER (tap, saída mutada) — detecção de pitch
//
// Cada bloco é um AudioWorkletNode/nó independente. Reordenar = reconectar (rewireChain).

const $ = (id) => document.getElementById(id);

let ctx = null, running = false, micStream = null, inputSource = null;
let testNode = null, testGain = null;

// blocos
let gate = null, comp = null, overdrive = null, amp = null, eq = null, tuner = null, tunerMute = null;
let cabConvA = null, cabConvB = null, cabGainA = null, cabGainB = null, panA = null, panB = null, cabDry = null;
let master = null, looper = null, drumBus = null, inAnalyser = null, outAnalyser = null;

// config de áudio (aplicada ao (re)ligar o rig) — Sprint 4 #17
const audioCfg = { sampleRate: 0, latencyHint: 'interactive', inputDeviceId: '' };
let chainOrder = ['od', 'amp'];   // blocos reordenáveis (comp fica antes, eq depois)

// canvas do osciloscópio/espectro
let scopeCtx = null;
// peak-hold dos meters
const hold = { in: -100, out: -100 };

// ===========================================================================
// Cabinet + Microfone — IR sintético parametrizado, DETERMINÍSTICO (seeded) + dual-mic
// ===========================================================================
const CABS = {
  '4x12': { lenMs: 60, decayMs: 11, hp: 78, resHz: 85, resGain: 6 },
  '2x12': { lenMs: 50, decayMs: 9, hp: 85, resHz: 100, resGain: 5 },
  '1x12': { lenMs: 42, decayMs: 7, hp: 95, resHz: 120, resGain: 4 },
};
const SPEAKERS = {
  v30: { bodyHz: 480, bodyGain: -3, presHz: 2600, presGain: 6, topHz: 5200 },
  green: { bodyHz: 520, bodyGain: 4, presHz: 1800, presGain: 2, topHz: 4400 },
};
const MICS = {
  sm57: { pk: [[5500, 1.0, 5], [3000, 0.8, 2]], shelf: [120, -2], topHz: 6500 },
  md421: { pk: [[8000, 0.9, 3], [4500, 0.8, 2]], shelf: [90, 2], topHz: 9000 },
  r121: { pk: [[2000, 0.7, 2]], shelf: [100, 3], topHz: 3800 },
};

const cabSettings = { cab: '4x12', speaker: 'v30', mic: 'sm57', micB: 'none', axis: 0.25, distance: 0.3, blend: 0.5, spread: 0.4 };
let customIR = null, pendingA = null, pendingB = null, regenToken = 0;

// PRNG determinístico (mulberry32) — mesmo IR pra mesmas configs (não é ruído aleatório a cada regen)
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

async function makeCabMicIR(sr, micModel) {
  const C = CABS[cabSettings.cab], S = SPEAKERS[cabSettings.speaker], M = MICS[micModel];
  const seed = hashStr(`${cabSettings.cab}|${cabSettings.speaker}|${micModel}|${cabSettings.axis.toFixed(2)}|${cabSettings.distance.toFixed(2)}`);
  const rnd = mulberry32(seed);
  const extraLen = 1 + cabSettings.distance * 0.5;
  const len = Math.floor(sr * (C.lenMs / 1000) * extraLen);
  const off = new OfflineAudioContext(1, len, sr);
  const noiseBuf = off.createBuffer(1, len, sr);
  const d = noiseBuf.getChannelData(0);
  const decay = sr * (C.decayMs / 1000);
  for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.exp(-i / decay);  // ruído SEEDED
  const src = off.createBufferSource(); src.buffer = noiseBuf;
  const nodes = [];
  const bq = (type, f, q, g) => { const n = off.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q != null) n.Q.value = q; if (g != null) n.gain.value = g; nodes.push(n); return n; };
  bq('highpass', C.hp, 0.7);
  bq('peaking', C.resHz, 1.1, C.resGain + (1 - cabSettings.distance) * 2);
  bq('peaking', S.bodyHz, 1.0, S.bodyGain);
  bq('peaking', S.presHz, 1.2, S.presGain);
  for (const [f, q, g] of M.pk) bq('peaking', f, q, g);
  bq('lowshelf', M.shelf[0], null, M.shelf[1]);
  const axisTop = 8000 - cabSettings.axis * 5500;
  bq('lowpass', Math.min(S.topHz, M.topHz, axisTop), 0.8);
  let prev = src; for (const n of nodes) { prev.connect(n); prev = n; } prev.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  const ir = rendered.getChannelData(0);
  let sum = 0; for (let i = 0; i < ir.length; i++) sum += ir[i] * ir[i];
  const norm = 1 / Math.sqrt(sum || 1);
  for (let i = 0; i < ir.length; i++) ir[i] *= norm;
  return rendered;
}

async function regenCab() {
  const tok = ++regenToken;
  const sr = ctx ? ctx.sampleRate : 48000;
  if (customIR) { if (cabConvA) cabConvA.buffer = customIR; applyCabState(); return; }
  const irA = await makeCabMicIR(sr, cabSettings.mic);
  const irB = cabSettings.micB !== 'none' ? await makeCabMicIR(sr, cabSettings.micB) : null;
  if (tok !== regenToken) return; // render obsoleto (usuário mexeu de novo) → descarta
  if (cabConvA) { cabConvA.buffer = irA; if (cabConvB) cabConvB.buffer = irB || irA; applyCabState(); }
  else { pendingA = irA; pendingB = irB; }
}

// ===========================================================================
// Ligar / desligar
// ===========================================================================
async function start() {
  if (running) return;
  try {
    ctx = new AudioContext(Object.assign({ latencyHint: audioCfg.latencyHint }, audioCfg.sampleRate ? { sampleRate: audioCfg.sampleRate } : {}));
  } catch (e) { ctx = new AudioContext({ latencyHint: audioCfg.latencyHint }); Log.warn('sampleRate pedido rejeitado, usando padrão'); }
  for (const m of ['gate', 'compressor', 'overdrive', 'amp', 'eq', 'tuner', 'looper']) await ctx.audioWorklet.addModule(`dsp/${m}-processor.js`);

  const wn = (name) => new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  gate = wn('gate-processor');
  comp = wn('compressor-processor');
  overdrive = wn('overdrive-processor');
  amp = wn('amp-processor');
  eq = wn('eq-processor');
  tuner = wn('tuner-processor');
  gate.port.onmessage = (e) => { if (e.data && e.data.gr != null) $('gateGr').style.width = Math.round((1 - e.data.gr) * 100) + '%'; };
  comp.port.onmessage = (e) => { if (e.data && e.data.gr != null) $('compGr').style.width = Math.min(100, Math.round(-e.data.gr / 24 * 100)) + '%'; };
  tuner.port.onmessage = (e) => updateTuner(e.data);

  // cab dual-mic estéreo
  cabConvA = ctx.createConvolver(); cabConvA.normalize = false;
  cabConvB = ctx.createConvolver(); cabConvB.normalize = false;
  cabGainA = ctx.createGain(); cabGainB = ctx.createGain();
  panA = ctx.createStereoPanner(); panB = ctx.createStereoPanner();
  cabDry = ctx.createGain();
  master = ctx.createGain(); master.gain.value = 0.8;
  looper = new AudioWorkletNode(ctx, 'looper-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2 });
  looper.port.onmessage = (e) => updateLooper(e.data);
  drumBus = ctx.createGain(); drumBus.gain.value = 0.6;
  inAnalyser = ctx.createAnalyser(); inAnalyser.fftSize = 1024;
  outAnalyser = ctx.createAnalyser(); outAnalyser.fftSize = 2048;
  if (pendingA) { cabConvA.buffer = pendingA; cabConvB.buffer = pendingB || pendingA; }

  // final: cab(A/B/dry) → master → LOOPER → out ; metrônomo/drums → out (fora do loop)
  cabConvA.connect(cabGainA).connect(panA).connect(master);
  cabConvB.connect(cabGainB).connect(panB).connect(master);
  cabDry.connect(master);
  master.connect(looper).connect(outAnalyser).connect(ctx.destination);
  drumBus.connect(ctx.destination);

  // tuner: tap da entrada, saída mutada (só pra rodar o worklet)
  tunerMute = ctx.createGain(); tunerMute.gain.value = 0;
  tuner.connect(tunerMute).connect(ctx.destination);

  await regenCab();
  applyCabState();
  pushParams();

  await connectGuitar();
  buildTestTone();
  rewireChain();

  running = true;
  $('power').textContent = '⏻ Desligar o rig';
  $('power').classList.add('on');
  $('status').textContent = 'Rig ligado. Toque a guitarra ou ative o tom de teste.';
  scopeCtx = $('scope').getContext('2d');
  populateDevices();
  const latMs = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
  $('audioLatency').textContent = latMs ? latMs.toFixed(1) + ' ms' : 'n/d';
  $('audioSr').textContent = ctx.sampleRate + ' Hz';
  Log.info(`rig ligado @ ${ctx.sampleRate}Hz, latência ~${latMs.toFixed(1)}ms, hint=${audioCfg.latencyHint}`);
  perf.reset();
  // uiLoop já está rodando desde o load (anima knobs mesmo com rig desligado)
}

async function connectGuitar() {
  try {
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    if (audioCfg.inputDeviceId) audio.deviceId = { exact: audioCfg.inputDeviceId };
    micStream = await navigator.mediaDevices.getUserMedia({ audio });
    inputSource = ctx.createMediaStreamSource(micStream);
    $('audioNote').textContent = '';
    inputSource.connect(inAnalyser);
    $('inputInfo').textContent = 'Entrada: interface/guitarra conectada ✓';
  } catch (e) {
    $('inputInfo').textContent = 'Sem entrada de áudio (permissão negada). Use o tom de teste.';
  }
}

function buildTestTone() {
  testNode = ctx.createOscillator(); testNode.type = 'sawtooth'; testNode.frequency.value = 220;
  testGain = ctx.createGain(); testGain.gain.value = 0;
  testNode.connect(testGain); testGain.connect(inAnalyser); testNode.start();
}

function stop() {
  if (!running) return;
  transportStop();
  try { testNode && testNode.stop(); } catch {}
  micStream && micStream.getTracks().forEach((t) => t.stop());
  ctx && ctx.close();
  running = false;
  $('power').textContent = '⏻ Ligar o rig';
  $('power').classList.remove('on');
  $('status').textContent = 'Rig desligado.';
  ['inMeter', 'outMeter', 'gateGr', 'compGr'].forEach((id) => $(id).style.width = '0%');
  mb.in = mb.out = -100; drawVU(-60);
  if (bgCtx) bgCtx.clearRect(0, 0, bgW, bgH);
  Log.info('rig desligado');
}

// ===========================================================================
// Parâmetros
// ===========================================================================
function pushParams() {
  if (!overdrive) return;
  const t = ctx.currentTime;
  overdrive.parameters.get('drive').setTargetAtTime(+$('drive').value, t, 0.01);
  overdrive.parameters.get('tone').setTargetAtTime(+$('tone').value, t, 0.01);
  overdrive.parameters.get('level').setTargetAtTime(+$('level').value, t, 0.01);
  overdrive.parameters.get('bypass').setValueAtTime($('odBypass').checked ? 1 : 0, t);
  pushGateParams(); pushCompParams(); pushAmpParams(); pushEqParams();
}
function pushGateParams() {
  if (!gate) return; const t = ctx.currentTime;
  gate.parameters.get('threshold').setTargetAtTime(+$('gateThresh').value, t, 0.02);
  gate.parameters.get('release').setTargetAtTime(+$('gateRel').value, t, 0.02);
  gate.parameters.get('bypass').setValueAtTime($('gateBypass').checked ? 1 : 0, t);
}
function pushCompParams() {
  if (!comp) return; const t = ctx.currentTime;
  comp.parameters.get('threshold').setTargetAtTime(+$('compThresh').value, t, 0.02);
  comp.parameters.get('ratio').setTargetAtTime(+$('compRatio').value, t, 0.02);
  comp.parameters.get('attack').setTargetAtTime(+$('compAtt').value, t, 0.02);
  comp.parameters.get('release').setTargetAtTime(+$('compRel').value, t, 0.02);
  comp.parameters.get('makeup').setTargetAtTime(+$('compMakeup').value, t, 0.02);
  comp.parameters.get('bypass').setValueAtTime($('compBypass').checked ? 1 : 0, t);
}
function pushAmpParams() {
  if (!amp) return; const t = ctx.currentTime;
  const set = (n, v) => amp.parameters.get(n).setTargetAtTime(v, t, 0.02);
  set('gain', +$('ampGain').value); set('bass', +$('bass').value); set('mid', +$('mid').value);
  set('treble', +$('treble').value); set('presence', +$('presence').value); set('depth', +$('depth').value);
  set('master', +$('ampMaster').value);
  amp.parameters.get('model').setValueAtTime(+$('ampModel').value, t);
  amp.parameters.get('bright').setValueAtTime($('bright').checked ? 1 : 0, t);
  amp.parameters.get('power').setValueAtTime($('ampPower').checked ? 1 : 0, t);
}
function pushEqParams() {
  if (!eq) return; const t = ctx.currentTime;
  const set = (n, v) => eq.parameters.get(n).setTargetAtTime(v, t, 0.02);
  set('lowGain', +$('eqLow').value); set('midGain', +$('eqMid').value); set('midFreq', +$('eqMidFreq').value);
  set('midQ', +$('eqMidQ').value); set('highGain', +$('eqHigh').value); set('hpFreq', +$('eqHP').value); set('lpFreq', +$('eqLP').value);
  eq.parameters.get('bypass').setValueAtTime($('eqBypass').checked ? 1 : 0, t);
}

// entrada → gate → comp → (chainOrder: od/amp) → eq → cab
function rewireChain() {
  if (!running && !overdrive) return;
  const nodeOf = { od: overdrive, amp };
  [inAnalyser, gate, comp, overdrive, amp, eq].forEach((n) => n.disconnect());
  inAnalyser.connect(gate); inAnalyser.connect(tuner);
  gate.connect(comp);
  let prev = comp;
  for (const id of chainOrder) { prev.connect(nodeOf[id]); prev = nodeOf[id]; }
  prev.connect(eq);
  eq.connect(cabDry); eq.connect(cabConvA); eq.connect(cabConvB);
}

// cab on/off + blend dual-mic (equal-power) + spread estéreo
function applyCabState() {
  if (!cabGainA) return;
  const t = ctx.currentTime, on = $('cabOn').checked;
  const hasB = cabSettings.micB !== 'none' && !customIR;
  const th = cabSettings.blend * Math.PI / 2;
  const gA = hasB ? Math.cos(th) : 1, gB = hasB ? Math.sin(th) : 0;
  cabGainA.gain.setTargetAtTime(on ? gA : 0, t, 0.01);
  cabGainB.gain.setTargetAtTime(on ? gB : 0, t, 0.01);
  cabDry.gain.setTargetAtTime(on ? 0 : 1, t, 0.01);
  const sp = hasB ? cabSettings.spread : 0;
  panA.pan.setTargetAtTime(-sp, t, 0.01); panB.pan.setTargetAtTime(sp, t, 0.01);
}

// ===========================================================================
// Metering (dBFS peak + peak-hold + clip) + osciloscópio/espectro
// ===========================================================================
const dbToPct = (db) => Math.max(0, Math.min(100, (db + 60) / 60 * 100));
function meterStats(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let peak = 0; for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
  return 20 * Math.log10(peak + 1e-9);
}
// estado de balística dos meters (VU-like: sobe na hora, desce devagar; + peak-hold)
const mb = { in: -100, out: -100, inH: -100, outH: -100, inHT: 0, outHT: 0 };
function animateKnobs() { for (const k of allKnobs) k.step(); }

// loop de UI SEMPRE rodando (anima knobs mesmo com o rig desligado); o resto só quando ligado
function uiLoop() {
  animateKnobs();
  if (running) {
    const now = performance.now();
    for (const [an, mId, hId, key, clipId] of [[inAnalyser, 'inMeter', 'inHold', 'in', 'inClip'], [outAnalyser, 'outMeter', 'outHold', 'out', 'outClip']]) {
      const db = meterStats(an);
      mb[key] = db > mb[key] ? db : mb[key] - 0.9;              // balística: attack instantâneo, release ~54 dB/s
      $(mId).style.width = dbToPct(mb[key]) + '%';
      const hk = key + 'H', ht = key + 'HT';
      if (db > mb[hk]) { mb[hk] = db; mb[ht] = now; }           // peak-hold: sobe e segura
      else if (now - mb[ht] > 900) mb[hk] = Math.max(db, mb[hk] - 0.5);
      const he = $(hId); if (he) he.style.left = dbToPct(mb[hk]) + '%';
      if (db >= -0.2) $(clipId).classList.add('on');
    }
    // glow reativo: os chips acesos pulsam conforme o nível de saída
    const level = Math.max(0, Math.min(1, (mb.out + 60) / 60));
    document.documentElement.style.setProperty('--sig', level.toFixed(3));
    const freq = new Uint8Array(outAnalyser.frequencyBinCount); outAnalyser.getByteFrequencyData(freq);
    drawScope(freq);
    drawVU(mb.out);
    drawBg(level, freq);
    perf.tick();
  }
  requestAnimationFrame(uiLoop);
}
let barH = null, barCap = null;
function drawScope(freq) {
  if (!scopeCtx) return;
  const c = scopeCtx, W = c.canvas.width, H = c.canvas.height, nf = freq.length;
  c.clearRect(0, 0, W, H);
  const bars = 72;
  if (!barH || barH.length !== bars) { barH = new Float32Array(bars); barCap = new Float32Array(bars); }
  const grad = c.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, cssVar('--led')); grad.addColorStop(0.55, cssVar('--accent')); grad.addColorStop(1, '#e0503a');
  const w = W / bars - 1;
  for (let b = 0; b < bars; b++) {
    const idx = Math.floor(Math.pow(b / bars, 2) * nf), v = freq[idx] / 255, target = v * H;
    barH[b] = target > barH[b] ? target : barH[b] * 0.86;               // barra: sobe rápido, cai suave
    if (barH[b] > barCap[b]) barCap[b] = barH[b]; else barCap[b] -= H * 0.006; // peak cap descendo
    const x = b / bars * W;
    c.fillStyle = grad; c.fillRect(x, H - barH[b], w, barH[b]);
    c.fillStyle = cssVar('--txt'); c.fillRect(x, H - Math.max(barCap[b], 1.5), w, 1.5);
  }
  // osciloscópio com glow (aditivo)
  c.save(); c.globalCompositeOperation = 'lighter'; c.shadowColor = cssVar('--accent'); c.shadowBlur = 6;
  const wave = new Uint8Array(outAnalyser.fftSize); outAnalyser.getByteTimeDomainData(wave);
  c.strokeStyle = cssVar('--accent'); c.lineWidth = 1.6; c.beginPath();
  for (let i = 0; i < wave.length; i += 4) { const x = i / wave.length * W, y = (wave[i] / 255) * H; i === 0 ? c.moveTo(x, y) : c.lineTo(x, y); }
  c.stroke(); c.restore();
}

// ---- fundo reativo ao áudio (glow que respira + espectro silhueta) ----
let bgCtx = null, bgW = 0, bgH = 0;
function resizeBg() { const c = $('bg'); if (!c) return; bgW = c.width = window.innerWidth; bgH = c.height = window.innerHeight; }
function initBg() { const c = $('bg'); if (!c) return; resizeBg(); bgCtx = c.getContext('2d'); }
window.addEventListener('resize', resizeBg);
function drawBg(level, freq) {
  if (!bgCtx) return; const ctx = bgCtx, W = bgW, H = bgH;
  ctx.clearRect(0, 0, W, H);
  // glow radial que respira com o nível
  ctx.save(); ctx.globalAlpha = 0.06 + level * 0.18;
  const rg = ctx.createRadialGradient(W / 2, H * 0.34, 20, W / 2, H * 0.34, Math.max(W, H) * 0.55);
  rg.addColorStop(0, cssVar('--accent')); rg.addColorStop(1, 'transparent');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H); ctx.restore();
  // espectro gigante (silhueta na base)
  if (freq) {
    const bars = 64; ctx.save(); ctx.globalAlpha = 0.10; ctx.fillStyle = cssVar('--accent');
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let b = 0; b < bars; b++) { const idx = Math.floor(Math.pow(b / bars, 2) * freq.length), v = freq[idx] / 255; ctx.lineTo(b / (bars - 1) * W, H - v * H * 0.45); }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill(); ctx.restore();
  }
}

// ===========================================================================
// Afinador
// ===========================================================================
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function updateTuner(d) {
  if (!d || !d.hz || d.hz < 30 || d.hz > 1200) { $('tunerNote').textContent = '—'; $('tunerCents').textContent = ''; $('tunerNeedle').style.left = '50%'; $('tunerNeedle').style.background = 'var(--dim)'; return; }
  const n = 12 * Math.log2(d.hz / 440) + 69;
  const midi = Math.round(n);
  const cents = Math.round((n - midi) * 100);
  $('tunerNote').textContent = NOTE_NAMES[(midi % 12 + 12) % 12] + (Math.floor(midi / 12) - 1);
  $('tunerCents').textContent = (cents >= 0 ? '+' : '') + cents + ' cents';
  $('tunerNeedle').style.left = Math.max(2, Math.min(98, 50 + cents)) + '%';
  $('tunerNeedle').style.background = Math.abs(cents) <= 5 ? 'var(--led)' : 'var(--accent)';
}

// ===========================================================================
// Eventos da UI
// ===========================================================================
$('power').addEventListener('click', () => (running ? stop() : start()));
['inClip', 'outClip'].forEach((id) => $(id).addEventListener('click', () => $(id).classList.remove('on'))); // clicar reseta o clip

const bindKnobs = (ids, push, fmt) => ids.forEach((id) => $(id).addEventListener('input', () => { $(id + 'Val').textContent = fmt(id, +$(id).value); if (running) push(); }));
bindKnobs(['drive', 'tone', 'level'], pushParams, (id, v) => v.toFixed(id === 'drive' ? 0 : 2));
$('odBypass').addEventListener('change', () => running && pushParams());

bindKnobs(['gateThresh', 'gateRel'], pushGateParams, (id, v) => id === 'gateThresh' ? v.toFixed(0) + ' dB' : v.toFixed(0) + ' ms');
$('gateBypass').addEventListener('change', () => running && pushGateParams());

bindKnobs(['compThresh', 'compRatio', 'compAtt', 'compRel', 'compMakeup'], pushCompParams, (id, v) => {
  if (id === 'compThresh') return v.toFixed(0) + ' dB'; if (id === 'compRatio') return v.toFixed(1) + ':1';
  if (id === 'compMakeup') return '+' + v.toFixed(0) + ' dB'; return v.toFixed(0) + ' ms';
});
$('compBypass').addEventListener('change', () => running && pushCompParams());

bindKnobs(['ampGain', 'bass', 'mid', 'treble', 'presence', 'depth', 'ampMaster'], pushAmpParams, (id, v) => v.toFixed(2));
$('ampModel').addEventListener('change', () => { $('ampModelName').textContent = $('ampModel').selectedOptions[0].dataset.tag; if (running) pushAmpParams(); });
$('bright').addEventListener('change', () => running && pushAmpParams());
$('ampPower').addEventListener('change', () => running && pushAmpParams());

bindKnobs(['eqLow', 'eqMid', 'eqMidFreq', 'eqMidQ', 'eqHigh', 'eqHP', 'eqLP'], pushEqParams, (id, v) => {
  if (id === 'eqMidFreq' || id === 'eqHP' || id === 'eqLP') return v.toFixed(0) + ' Hz';
  if (id === 'eqMidQ') return 'Q ' + v.toFixed(1); return (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
});
$('eqBypass').addEventListener('change', () => running && pushEqParams());

$('cabOn').addEventListener('change', () => running && applyCabState());
$('cabType').addEventListener('change', () => { cabSettings.cab = $('cabType').value; regenCab(); });
$('speaker').addEventListener('change', () => { cabSettings.speaker = $('speaker').value; regenCab(); });
$('mic').addEventListener('change', () => { cabSettings.mic = $('mic').value; regenCab(); });
$('micB').addEventListener('change', () => { cabSettings.micB = $('micB').value; regenCab(); });
$('blend').addEventListener('input', () => { cabSettings.blend = +$('blend').value; $('blendVal').textContent = Math.round((1 - cabSettings.blend) * 100) + '/' + Math.round(cabSettings.blend * 100); applyCabState(); });
$('spread').addEventListener('input', () => { cabSettings.spread = +$('spread').value; $('spreadVal').textContent = Math.round(cabSettings.spread * 100) + '%'; applyCabState(); });
$('axis').addEventListener('input', () => { cabSettings.axis = +$('axis').value; $('axisVal').textContent = cabSettings.axis < 0.5 ? 'on-axis' : 'off-axis'; regenCab(); });
$('distance').addEventListener('input', () => { cabSettings.distance = +$('distance').value; $('distanceVal').textContent = cabSettings.distance < 0.5 ? 'perto' : 'longe'; regenCab(); });
$('irFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const tmp = ctx || new (window.AudioContext || window.webkitAudioContext)();
  try { customIR = await tmp.decodeAudioData(await file.arrayBuffer()); $('irName').textContent = 'IR: ' + file.name + ' ✓'; regenCab(); }
  catch { $('irName').textContent = 'falhou ao ler o .wav'; }
});
$('irClear').addEventListener('click', () => { customIR = null; $('irName').textContent = 'IR sintético'; $('irFile').value = ''; regenCab(); });

$('master').addEventListener('input', () => { $('masterVal').textContent = (+$('master').value).toFixed(2); if (running && master) master.gain.setTargetAtTime(+$('master').value, ctx.currentTime, 0.01); });
$('testOn').addEventListener('change', () => { if (running && testGain) testGain.gain.setTargetAtTime($('testOn').checked ? 0.25 : 0, ctx.currentTime, 0.02); });

// ===========================================================================
// Reordenar (OD ⇄ Amp) + presets
// ===========================================================================
// reordena OD⇄Amp: troca os chips na tira (mantendo as setas) + reconecta o áudio
function setOrder(order) {
  chainOrder = order.slice();
  const a = $('chipOD'), b = $('chipAMP');
  if (a && b) {
    const odFirst = (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    if (odFirst !== (chainOrder[0] === 'od')) { const t = document.createComment(''); a.replaceWith(t); b.replaceWith(a); t.replaceWith(b); }
  }
  if (running) rewireChain();
}
$('swapOrder').addEventListener('click', () => setOrder([chainOrder[1], chainOrder[0]]));
let dragId = null;
[$('chipOD'), $('chipAMP')].forEach((ch) => {
  if (!ch) return;
  ch.draggable = true;
  ch.addEventListener('dragstart', (e) => { dragId = ch.dataset.mod; e.dataTransfer.effectAllowed = 'move'; });
  ch.addEventListener('dragover', (e) => e.preventDefault());
  ch.addEventListener('drop', (e) => { e.preventDefault(); if (dragId && dragId !== ch.dataset.mod) setOrder([chainOrder[1], chainOrder[0]]); dragId = null; });
});

function collectState() {
  return {
    v: 2,
    gate: { threshold: +$('gateThresh').value, release: +$('gateRel').value, bypass: $('gateBypass').checked },
    comp: { threshold: +$('compThresh').value, ratio: +$('compRatio').value, attack: +$('compAtt').value, release: +$('compRel').value, makeup: +$('compMakeup').value, bypass: $('compBypass').checked },
    od: { drive: +$('drive').value, tone: +$('tone').value, level: +$('level').value, bypass: $('odBypass').checked },
    amp: { model: $('ampModel').value, gain: +$('ampGain').value, bass: +$('bass').value, mid: +$('mid').value, treble: +$('treble').value, presence: +$('presence').value, depth: +$('depth').value, master: +$('ampMaster').value, bright: $('bright').checked, power: $('ampPower').checked },
    eq: { low: +$('eqLow').value, mid: +$('eqMid').value, midFreq: +$('eqMidFreq').value, midQ: +$('eqMidQ').value, high: +$('eqHigh').value, hp: +$('eqHP').value, lp: +$('eqLP').value, bypass: $('eqBypass').checked },
    cab: { cab: $('cabType').value, speaker: $('speaker').value, mic: $('mic').value, micB: $('micB').value, axis: +$('axis').value, distance: +$('distance').value, blend: +$('blend').value, spread: +$('spread').value, on: $('cabOn').checked },
    master: +$('master').value, order: chainOrder.slice(),
  };
}

function applyState(s) {
  s = migratePreset(s);
  const setC = (id, v) => { if (v === undefined) return; const el = $(id); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
  const g = s.gate || {}, cp = s.comp || {}, e = s.eq || {};
  setC('gateThresh', g.threshold); setC('gateRel', g.release); setC('gateBypass', g.bypass);
  setC('compThresh', cp.threshold); setC('compRatio', cp.ratio); setC('compAtt', cp.attack); setC('compRel', cp.release); setC('compMakeup', cp.makeup); setC('compBypass', cp.bypass);
  setC('drive', s.od.drive); setC('tone', s.od.tone); setC('level', s.od.level); setC('odBypass', s.od.bypass);
  setC('ampModel', s.amp.model); setC('ampGain', s.amp.gain); setC('bass', s.amp.bass); setC('mid', s.amp.mid);
  setC('treble', s.amp.treble); setC('presence', s.amp.presence); setC('depth', s.amp.depth); setC('ampMaster', s.amp.master); setC('bright', s.amp.bright); setC('ampPower', s.amp.power);
  setC('eqLow', e.low); setC('eqMid', e.mid); setC('eqMidFreq', e.midFreq); setC('eqMidQ', e.midQ); setC('eqHigh', e.high); setC('eqHP', e.hp); setC('eqLP', e.lp); setC('eqBypass', e.bypass);
  setC('cabType', s.cab.cab); setC('speaker', s.cab.speaker); setC('mic', s.cab.mic); setC('micB', s.cab.micB); setC('axis', s.cab.axis); setC('distance', s.cab.distance); setC('blend', s.cab.blend); setC('spread', s.cab.spread); setC('cabOn', s.cab.on);
  setC('master', s.master);
  Object.assign(cabSettings, { cab: s.cab.cab, speaker: s.cab.speaker, mic: s.cab.mic, micB: s.cab.micB || 'none', axis: s.cab.axis, distance: s.cab.distance, blend: s.cab.blend ?? 0.5, spread: s.cab.spread ?? 0.4 });
  refreshLabels();
  setOrder(s.order || ['od', 'amp']);
  if (running) { pushParams(); regenCab(); }
}

// migração de formato de preset (versionamento) — v1 (sem comp/eq/dual-mic) → v2
function migratePreset(s) {
  if (!s.v || s.v < 2) {
    s.comp = s.comp || { threshold: -24, ratio: 4, attack: 8, release: 120, makeup: 0, bypass: true };
    s.eq = s.eq || { low: 0, mid: 0, midFreq: 800, midQ: 1, high: 0, hp: 20, lp: 20000, bypass: true };
    if (s.cab) { s.cab.micB = s.cab.micB || 'none'; s.cab.blend = s.cab.blend ?? 0.5; s.cab.spread = s.cab.spread ?? 0.4; }
    s.v = 2;
  }
  return s;
}

function refreshLabels() {
  const two = ['drive', 'tone', 'level', 'ampGain', 'bass', 'mid', 'treble', 'presence', 'depth', 'ampMaster', 'master'];
  two.forEach((id) => { const v = $(id + 'Val'); if (v) v.textContent = (+$(id).value).toFixed(id === 'drive' ? 0 : 2); });
  $('ampModelName').textContent = $('ampModel').selectedOptions[0].dataset.tag;
  $('axisVal').textContent = +$('axis').value < 0.5 ? 'on-axis' : 'off-axis';
  $('distanceVal').textContent = +$('distance').value < 0.5 ? 'perto' : 'longe';
  $('gateThreshVal').textContent = (+$('gateThresh').value).toFixed(0) + ' dB';
  $('gateRelVal').textContent = (+$('gateRel').value).toFixed(0) + ' ms';
  $('compThreshVal').textContent = (+$('compThresh').value).toFixed(0) + ' dB';
  $('compRatioVal').textContent = (+$('compRatio').value).toFixed(1) + ':1';
  $('compAttVal').textContent = (+$('compAtt').value).toFixed(0) + ' ms';
  $('compRelVal').textContent = (+$('compRel').value).toFixed(0) + ' ms';
  $('compMakeupVal').textContent = '+' + (+$('compMakeup').value).toFixed(0) + ' dB';
  $('eqLowVal').textContent = (+$('eqLow').value >= 0 ? '+' : '') + (+$('eqLow').value).toFixed(1) + ' dB';
  $('eqMidVal').textContent = (+$('eqMid').value >= 0 ? '+' : '') + (+$('eqMid').value).toFixed(1) + ' dB';
  $('eqHighVal').textContent = (+$('eqHigh').value >= 0 ? '+' : '') + (+$('eqHigh').value).toFixed(1) + ' dB';
  $('eqMidFreqVal').textContent = (+$('eqMidFreq').value).toFixed(0) + ' Hz';
  $('eqMidQVal').textContent = 'Q ' + (+$('eqMidQ').value).toFixed(1);
  $('eqHPVal').textContent = (+$('eqHP').value).toFixed(0) + ' Hz';
  $('eqLPVal').textContent = (+$('eqLP').value).toFixed(0) + ' Hz';
  $('blendVal').textContent = Math.round((1 - cabSettings.blend) * 100) + '/' + Math.round(cabSettings.blend * 100);
  $('spreadVal').textContent = Math.round(cabSettings.spread * 100) + '%';
  if (typeof syncChainDots === 'function') syncChainDots();
  if (typeof syncKnobs === 'function') syncKnobs();
}

// --- presets ---
const dOff = { threshold: -24, ratio: 4, attack: 8, release: 120, makeup: 0, bypass: true };
const dEq = { low: 0, mid: 0, midFreq: 800, midQ: 1, high: 0, hp: 20, lp: 20000, bypass: true };
const FACTORY = {
  '★ Metal moderno (5150)': { v: 2, gate: { threshold: -50, release: 90, bypass: false }, comp: dOff, od: { drive: 20, tone: 0.5, level: 0.8, bypass: false }, amp: { model: '1', gain: 0.85, bass: 0.6, mid: 0.15, treble: 0.7, presence: 0.6, depth: 0.75, master: 0.6, bright: true, power: true }, eq: { low: 0, mid: -2, midFreq: 500, midQ: 1.2, high: 2, hp: 80, lp: 12000, bypass: false }, cab: { cab: '4x12', speaker: 'v30', mic: 'sm57', micB: 'r121', axis: 0.3, distance: 0.25, blend: 0.35, spread: 0.5, on: true }, master: 0.8, order: ['od', 'amp'] },
  '★ Hard rock (JCM800)': { v: 2, gate: { threshold: -58, release: 150, bypass: false }, comp: dOff, od: { drive: 15, tone: 0.6, level: 0.85, bypass: false }, amp: { model: '0', gain: 0.75, bass: 0.5, mid: 0.55, treble: 0.65, presence: 0.5, depth: 0.4, master: 0.65, bright: true, power: true }, eq: dEq, cab: { cab: '4x12', speaker: 'v30', mic: 'sm57', micB: 'none', axis: 0.25, distance: 0.3, blend: 0.5, spread: 0.4, on: true }, master: 0.8, order: ['od', 'amp'] },
  '★ Crunch clássico (Plexi-ish)': { v: 2, gate: { threshold: -65, release: 200, bypass: true }, comp: dOff, od: { drive: 8, tone: 0.6, level: 0.5, bypass: true }, amp: { model: '0', gain: 0.45, bass: 0.55, mid: 0.6, treble: 0.6, presence: 0.45, depth: 0.35, master: 0.7, bright: true, power: true }, eq: dEq, cab: { cab: '2x12', speaker: 'green', mic: 'r121', micB: 'none', axis: 0.4, distance: 0.4, blend: 0.5, spread: 0.4, on: true }, master: 0.8, order: ['od', 'amp'] },
  '★ Funk/Clean comp (Fender-ish)': { v: 2, gate: { threshold: -70, release: 200, bypass: true }, comp: { threshold: -28, ratio: 4, attack: 5, release: 100, makeup: 6, bypass: false }, od: { drive: 4, tone: 0.7, level: 0.5, bypass: true }, amp: { model: '0', gain: 0.2, bass: 0.6, mid: 0.5, treble: 0.7, presence: 0.5, depth: 0.3, master: 0.5, bright: true, power: true }, eq: { low: 1, mid: 0, midFreq: 900, midQ: 1, high: 3, hp: 40, lp: 16000, bypass: false }, cab: { cab: '2x12', speaker: 'green', mic: 'sm57', micB: 'r121', axis: 0.35, distance: 0.35, blend: 0.5, spread: 0.6, on: true }, master: 0.8, order: ['od', 'amp'] },
};
// ===========================================================================
// Sprint 3 — Preset Manager (IndexedDB + busca/tags/favoritos), A/B, Undo/Redo,
//            Snapshots e MIDI (Web MIDI). Lógica pura testada no harness Node.
// ===========================================================================
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- IndexedDB (presets do usuário com metadados) ----
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('grd', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('presets', { keyPath: 'name' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbAll() { const db = await idbOpen(); return new Promise((res) => { const q = db.transaction('presets').objectStore('presets').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); }
async function idbPut(rec) { const db = await idbOpen(); return new Promise((res) => { const tx = db.transaction('presets', 'readwrite'); tx.objectStore('presets').put(rec); tx.oncomplete = () => res(); tx.onerror = () => res(); }); }
async function idbDel(name) { const db = await idbOpen(); return new Promise((res) => { const tx = db.transaction('presets', 'readwrite'); tx.objectStore('presets').delete(name); tx.oncomplete = () => res(); tx.onerror = () => res(); }); }

let userCache = {}; // name -> {name, state, tags:[], favorite}
async function loadUserPresets() {
  const arr = await idbAll(); userCache = {}; arr.forEach((r) => (userCache[r.name] = r));
  // migração única do localStorage antigo
  try {
    const old = JSON.parse(localStorage.getItem('grd-presets') || 'null');
    if (old) { for (const [n, st] of Object.entries(old)) if (!userCache[n]) { const rec = { name: n, state: st, tags: [], favorite: false }; userCache[n] = rec; await idbPut(rec); } localStorage.removeItem('grd-presets'); }
  } catch {}
  refreshPresetList(); renderManager();
}
const getPresetState = (name) => FACTORY[name] || (userCache[name] && userCache[name].state);

function refreshPresetList(sel) {
  const list = $('presetList');
  list.innerHTML = '<option value="">— presets —</option>'
    + '<optgroup label="Fábrica">' + Object.keys(FACTORY).map((n) => `<option>${n}</option>`).join('') + '</optgroup>'
    + '<optgroup label="Meus">' + Object.keys(userCache).map((n) => `<option>${n}</option>`).join('') + '</optgroup>';
  if (sel) list.value = sel;
}
$('presetList').addEventListener('change', () => { const n = $('presetList').value; if (!n) return; const s = getPresetState(n); if (s) applyAndMark(clone(s)); });
$('presetSave').addEventListener('click', async () => { const name = prompt('Nome do preset:'); if (!name) return; const rec = { name, state: collectState(), tags: [], favorite: false }; userCache[name] = rec; await idbPut(rec); refreshPresetList(name); renderManager(); });
$('presetDel').addEventListener('click', async () => { const n = $('presetList').value; if (!n || FACTORY[n]) return; delete userCache[n]; await idbDel(n); refreshPresetList(''); renderManager(); });
$('presetExport').addEventListener('click', () => { const blob = new Blob([JSON.stringify(collectState(), null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'rig-preset.json'; a.click(); URL.revokeObjectURL(a.href); });
$('presetImport').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; try { applyAndMark(JSON.parse(await f.text())); } catch { alert('preset inválido'); } e.target.value = ''; });

// ---- Preset Manager (busca/tags/favoritos) — lógica de filtro pura ----
function filterPresets(query, favOnly) {
  const q = (query || '').toLowerCase();
  const rows = [];
  for (const n of Object.keys(FACTORY)) rows.push({ name: n, factory: true, tags: [], favorite: false });
  for (const n of Object.keys(userCache)) { const r = userCache[n]; rows.push({ name: n, factory: false, tags: r.tags || [], favorite: !!r.favorite }); }
  return rows.filter((r) => {
    if (favOnly && !r.favorite) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || (r.tags || []).some((t) => t.toLowerCase().includes(q));
  });
}
function renderManager() {
  const box = $('mgrList'); if (!box) return;
  const rows = filterPresets($('mgrSearch').value, $('mgrFav').checked);
  box.innerHTML = rows.map((r) => `<div class="mgr-row" data-n="${encodeURIComponent(r.name)}">
      <button class="star ${r.favorite ? 'on' : ''}" data-act="fav" ${r.factory ? 'disabled' : ''}>${r.favorite ? '★' : '☆'}</button>
      <span class="mgr-name" data-act="load">${r.name}</span>
      <span class="mgr-tags">${(r.tags || []).map((t) => `<i>${t}</i>`).join('')}</span>
      ${r.factory ? '<span class="mgr-fx">fábrica</span>' : '<button class="mini" data-act="tag">tags</button><button class="mini" data-act="del">✕</button>'}
    </div>`).join('') || '<div style="color:var(--dim);font-size:13px">nenhum preset</div>';
}
$('mgrSearch').addEventListener('input', renderManager);
$('mgrFav').addEventListener('change', renderManager);
$('mgrList').addEventListener('click', async (e) => {
  const row = e.target.closest('.mgr-row'); if (!row) return; const name = decodeURIComponent(row.dataset.n); const act = e.target.dataset.act;
  if (act === 'load') { const s = getPresetState(name); if (s) { applyAndMark(clone(s)); refreshPresetList(name); } }
  else if (act === 'del') { delete userCache[name]; await idbDel(name); refreshPresetList(''); renderManager(); }
  else if (act === 'fav') { const r = userCache[name]; if (r) { r.favorite = !r.favorite; await idbPut(r); renderManager(); } }
  else if (act === 'tag') { const r = userCache[name]; if (r) { const t = prompt('Tags (vírgula):', (r.tags || []).join(', ')); if (t !== null) { r.tags = t.split(',').map((s) => s.trim()).filter(Boolean); await idbPut(r); renderManager(); } } }
});
$('mgrToggle').addEventListener('click', () => $('manager').classList.toggle('open'));

// ---- A/B ----
let abA = null, abB = null, abCur = 'A';
$('abSetA').addEventListener('click', () => { abA = collectState(); $('abSetA').classList.add('set'); });
$('abSetB').addEventListener('click', () => { abB = collectState(); $('abSetB').classList.add('set'); });
$('abToggle').addEventListener('click', () => { abCur = abCur === 'A' ? 'B' : 'A'; $('abToggle').textContent = 'A/B: ' + abCur; const s = abCur === 'A' ? abA : abB; if (s) applyAndMark(clone(s)); });

// ---- Undo/Redo ----
let history = [], hIdx = -1, restoring = false, dirtyT = null;
function snapshotForUndo() { if (restoring) return; history = history.slice(0, hIdx + 1); history.push(collectState()); if (history.length > 60) history.shift(); hIdx = history.length - 1; updateUndoUI(); }
function markDirty() { clearTimeout(dirtyT); dirtyT = setTimeout(snapshotForUndo, 350); }
function applyAndMark(s) { applyState(s); markDirty(); }
function undo() { if (hIdx > 0) { hIdx--; restoring = true; applyState(clone(history[hIdx])); restoring = false; updateUndoUI(); } }
function redo() { if (hIdx < history.length - 1) { hIdx++; restoring = true; applyState(clone(history[hIdx])); restoring = false; updateUndoUI(); } }
function updateUndoUI() { $('undoBtn').disabled = hIdx <= 0; $('redoBtn').disabled = hIdx >= history.length - 1; }
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);
document.addEventListener('input', markDirty);
document.addEventListener('change', () => { markDirty(); syncChainDots(); });
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
});

// ---- Snapshots (sessão, 4 slots) ----
const snaps = [null, null, null, null];
document.querySelectorAll('.snap').forEach((btn, i) => {
  btn.addEventListener('click', () => {
    if ($('snapEdit').checked) { snaps[i] = collectState(); btn.classList.add('set'); }
    else if (snaps[i]) applyAndMark(clone(snaps[i]));
  });
});

// ---- MIDI (Web MIDI) ----
let midiMap = {}, midiLearn = false, armedId = null;
try { midiMap = JSON.parse(localStorage.getItem('grd-midi') || '{}'); } catch {}
const saveMidiMap = () => localStorage.setItem('grd-midi', JSON.stringify(midiMap));
function ccToValue(v, min, max) { return min + (v / 127) * (max - min); }
function applyCC(cc, value) {
  const id = midiMap[cc]; if (!id) return; const el = $(id); if (!el) return;
  if (el.type === 'checkbox') { el.checked = value >= 64; el.dispatchEvent(new Event('change', { bubbles: true })); }
  else { el.value = ccToValue(value, +el.min, +el.max); el.dispatchEvent(new Event('input', { bubbles: true })); }
}
function onMidiMessage(e) {
  const [status, d1, d2] = e.data, type = status & 0xf0;
  if (type === 0xB0) {
    if (midiLearn && armedId != null) { midiMap[d1] = armedId; saveMidiMap(); armedId = null; renderMidiMap(); $('midiStatus').textContent = `CC${d1} → ${midiMap[d1]}`; return; }
    applyCC(d1, d2);
  } else if (type === 0xC0) { const names = [...Object.keys(FACTORY), ...Object.keys(userCache)]; const s = getPresetState(names[d1]); if (s) applyAndMark(clone(s)); }
}
async function initMidi() {
  if (!navigator.requestMIDIAccess) { $('midiStatus').textContent = 'Web MIDI não suportado'; return; }
  try { const access = await navigator.requestMIDIAccess(); const hook = () => { for (const inp of access.inputs.values()) inp.onmidimessage = onMidiMessage; }; hook(); access.onstatechange = hook; $('midiStatus').textContent = 'MIDI ativo ✓'; }
  catch { $('midiStatus').textContent = 'permissão MIDI negada'; }
}
function renderMidiMap() { $('midiMap').textContent = Object.entries(midiMap).map(([cc, id]) => `CC${cc}→${id}`).join(' · ') || '(sem mapeamentos)'; }
$('midiEnable').addEventListener('click', initMidi);
$('midiLearn').addEventListener('change', () => { midiLearn = $('midiLearn').checked; $('midiStatus').textContent = midiLearn ? 'Learn: clique num knob e mova um CC' : 'MIDI ativo ✓'; });
$('midiClear').addEventListener('click', () => { midiMap = {}; saveMidiMap(); renderMidiMap(); });
document.addEventListener('pointerdown', (e) => {
  if (!midiLearn) return;
  let id = null;
  if (e.target.classList && e.target.classList.contains('knob-canvas')) id = e.target.dataset.for;
  else { const el = e.target.closest('input,select'); if (el) id = el.id; }
  if (id) { armedId = id; $('midiStatus').textContent = `armado: ${id} — mova um CC`; }
});

// ===========================================================================
// Sprint 4 — Looper, Transport (metrônomo + drums), Áudio/latência, Logging/Perf
// ===========================================================================

// ---- Logging + tratamento de erro (#19) ----
const Log = {
  buf: [], max: 500,
  add(level, msg) {
    let ts = ''; try { ts = new Date().toISOString().slice(11, 19); } catch { ts = ''; }
    this.buf.push(`${ts} ${level} ${msg}`); if (this.buf.length > this.max) this.buf.shift();
    const el = $('logView'); if (el) { el.textContent = this.buf.slice(-14).join('\n'); el.scrollTop = el.scrollHeight; }
  },
  info(m) { this.add('INFO', m); }, warn(m) { this.add('WARN', m); }, error(m) { this.add('ERRO', m); },
};
window.addEventListener('error', (e) => { Log.error(`${e.message} @ ${e.filename}:${e.lineno}`); $('status').textContent = '⚠ erro: ' + e.message; });
window.addEventListener('unhandledrejection', (e) => Log.error('promise: ' + (e.reason && e.reason.message || e.reason)));
$('logExport').addEventListener('click', () => { const blob = new Blob([Log.buf.join('\n')], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'guitar-rig-dsp.log'; a.click(); URL.revokeObjectURL(a.href); });

// ---- Monitor de performance (#19) ----
// FPS/frame do main thread + latência do áudio + "drift" (relógio de áudio vs relógio real,
// proxy honesto de dropouts — o navegador não expõe CPU% do thread de áudio).
const perf = {
  lastWall: 0, lastAudio: 0, frames: 0, acc: 0, glitches: 0,
  reset() { this.lastWall = performance.now(); this.lastAudio = ctx ? ctx.currentTime : 0; this.frames = 0; this.acc = 0; this.glitches = 0; },
  tick() {
    const now = performance.now(); const dt = now - this.lastWall; this.lastWall = now;
    this.acc += dt; this.frames++;
    if (ctx) {
      const aud = ctx.currentTime; const wallSec = dt / 1000; const audAdv = aud - this.lastAudio; this.lastAudio = aud;
      if (wallSec > 0.05 && audAdv < wallSec - 0.02) this.glitches++; // áudio ficou pra trás → provável dropout
    }
    if (this.frames >= 20) {
      const fps = 1000 / (this.acc / this.frames);
      $('perfFps').textContent = fps.toFixed(0);
      $('perfMs').textContent = (this.acc / this.frames).toFixed(1) + ' ms';
      $('perfGlitch').textContent = this.glitches;
      this.frames = 0; this.acc = 0;
    }
  },
};

// ---- Looper (#15) ----
const looperCmd = (cmd, value) => looper && looper.port.postMessage({ cmd, value });
function updateLooper(d) {
  if (!d) return;
  const map = { idle: 'vazio', rec: '● gravando', play: d.overdub ? '● overdub' : '▶ tocando', stopped: '❚❚ parado' };
  $('loopState').textContent = map[d.state] || d.state;
  $('loopState').style.color = d.state === 'rec' || d.overdub ? '#ff4230' : d.state === 'play' ? 'var(--led)' : 'var(--dim)';
  if (d.secs != null) $('loopLen').textContent = d.secs > 0 ? d.secs.toFixed(1) + 's' : '';
  if (d.pos != null) $('loopBar').style.width = Math.round(d.pos * 100) + '%';
}
$('loopRec').addEventListener('click', () => { looperCmd('rec'); Log.info('looper: rec/loop/overdub'); });
$('loopStop').addEventListener('click', () => looperCmd('stop'));
$('loopClear').addEventListener('click', () => { looperCmd('clear'); $('loopBar').style.width = '0%'; });
$('loopLevel').addEventListener('input', () => { $('loopLevelVal').textContent = (+$('loopLevel').value).toFixed(2); looperCmd('level', +$('loopLevel').value); });

// ---- Transport: metrônomo + drums (#15) ----
const transport = { playing: false, bpm: 120, step: 0, nextTime: 0, timer: null, metroOn: false, drumsOn: false, pattern: 'rock' };
const PATTERNS = {
  rock: { k: [0, 8], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14] },
  metal: { k: [0, 3, 6, 8, 11, 14], s: [4, 12], h: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  funk: { k: [0, 10], s: [4, 12], h: [0, 2, 3, 6, 8, 10, 11, 14] },
};
let noiseBuf = null;
function getNoise() { if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; } return noiseBuf; }
function env(node, t, peak, dur) { const g = ctx.createGain(); node.connect(g).connect(drumBus); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); return g; }
function click(t, accent) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = accent ? 1600 : 1000; env(o, t, accent ? 0.6 : 0.35, 0.04); o.start(t); o.stop(t + 0.05); }
function kick(t) { const o = ctx.createOscillator(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.12); env(o, t, 0.9, 0.22); o.start(t); o.stop(t + 0.24); }
function snare(t) { const n = ctx.createBufferSource(); n.buffer = getNoise(); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400; n.connect(hp); env(hp, t, 0.6, 0.14); const o = ctx.createOscillator(); o.frequency.value = 190; env(o, t, 0.25, 0.1); n.start(t); n.stop(t + 0.16); o.start(t); o.stop(t + 0.12); }
function hat(t) { const n = ctx.createBufferSource(); n.buffer = getNoise(); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 8000; n.connect(hp); env(hp, t, 0.28, 0.04); n.start(t); n.stop(t + 0.05); }
function scheduleStep(step, t) {
  if (transport.metroOn && step % 4 === 0) click(t, step === 0);
  if (transport.drumsOn) { const p = PATTERNS[transport.pattern]; if (p.k.includes(step)) kick(t); if (p.s.includes(step)) snare(t); if (p.h.includes(step)) hat(t); }
}
function scheduler() {
  const sixteenth = (60 / transport.bpm) / 4;
  while (transport.nextTime < ctx.currentTime + 0.12) { scheduleStep(transport.step, transport.nextTime); transport.nextTime += sixteenth; transport.step = (transport.step + 1) % 16; }
}
function transportStart() { if (!ctx || transport.playing) return; transport.playing = true; transport.step = 0; transport.nextTime = ctx.currentTime + 0.08; transport.timer = setInterval(scheduler, 25); $('transportBtn').textContent = '❚❚ Parar'; $('transportBtn').classList.add('on'); }
function transportStop() { transport.playing = false; clearInterval(transport.timer); const b = $('transportBtn'); if (b) { b.textContent = '▶ Iniciar'; b.classList.remove('on'); } }
$('transportBtn').addEventListener('click', () => { if (!running) { $('status').textContent = 'Ligue o rig primeiro.'; return; } transport.playing ? transportStop() : transportStart(); });
$('bpm').addEventListener('input', () => { transport.bpm = +$('bpm').value; $('bpmVal').textContent = transport.bpm + ' BPM'; });
$('metroOn').addEventListener('change', () => transport.metroOn = $('metroOn').checked);
$('drumsOn').addEventListener('change', () => transport.drumsOn = $('drumsOn').checked);
$('drumPattern').addEventListener('change', () => transport.pattern = $('drumPattern').value);
$('drumVol').addEventListener('input', () => { $('drumVolVal').textContent = (+$('drumVol').value).toFixed(2); if (drumBus) drumBus.gain.setTargetAtTime(+$('drumVol').value, ctx.currentTime, 0.02); });

// ---- Áudio / latência (#17) ----
async function populateDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const ins = devs.filter((d) => d.kind === 'audioinput');
    $('inputDevice').innerHTML = '<option value="">Padrão do sistema</option>' + ins.map((d) => `<option value="${d.deviceId}">${d.label || 'Entrada ' + d.deviceId.slice(0, 6)}</option>`).join('');
    $('inputDevice').value = audioCfg.inputDeviceId;
  } catch (e) { Log.warn('não foi possível listar dispositivos'); }
}
$('inputDevice').addEventListener('change', () => { audioCfg.inputDeviceId = $('inputDevice').value; noteRestart(); });
$('srSel').addEventListener('change', () => { audioCfg.sampleRate = +$('srSel').value; noteRestart(); });
$('latSel').addEventListener('change', () => { audioCfg.latencyHint = $('latSel').value; noteRestart(); });
function noteRestart() { if (running) $('audioNote').textContent = '↻ reinicie o rig para aplicar'; }

// ===========================================================================
// Sprint 5 — UI Premium (#13): knobs rotativos em canvas + temas/skins
// ===========================================================================
// Os knobs SOBREPÕEM os <input type=range> (que continuam no DOM, escondidos).
// Arrastar o knob seta o input e dispara 'input' → todo o wiring (params, MIDI,
// presets, undo, labels) continua funcionando sem alteração.

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#e0a24a';
const allKnobs = [];

class Knob {
  constructor(input, label) {
    this.input = input; this.label = label;
    this.min = +input.min; this.max = +input.max; this.step = +input.step || 0.01;
    this.default = +input.value;
    this.target = this.default; this.disp = this.default; this._self = false; // p/ animação spring
    const size = 54, dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement('canvas');
    c.className = 'knob-canvas'; c.dataset.for = input.id;
    c.style.width = c.style.height = size + 'px'; c.width = c.height = size * dpr;
    this.ctx = c.getContext('2d'); this.ctx.scale(dpr, dpr); this.S = size; this.c = c;
    input.style.display = 'none';
    label.appendChild(c);
    label.classList.add('has-knob');

    // acessibilidade: knob vira um slider navegável por teclado
    const name = (label.querySelector('.row span') || {}).textContent || input.id;
    c.tabIndex = 0; c.setAttribute('role', 'slider'); c.setAttribute('aria-label', name);
    c.setAttribute('aria-valuemin', this.min); c.setAttribute('aria-valuemax', this.max);
    c.addEventListener('keydown', (e) => {
      const big = (this.max - this.min) / 10; let v = +input.value, hit = true;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': v += this.step; break;
        case 'ArrowDown': case 'ArrowLeft': v -= this.step; break;
        case 'PageUp': v += big; break; case 'PageDown': v -= big; break;
        case 'Home': v = this.min; break; case 'End': v = this.max; break;
        default: hit = false;
      }
      if (hit) { e.preventDefault(); this.set(v); }
    });

    let startY = 0, startVal = 0, drag = false, fine = false;
    c.addEventListener('pointerdown', (e) => { if (midiLearn) return; drag = true; fine = e.shiftKey; startY = e.clientY; startVal = +input.value; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => { if (!drag) return; const dy = startY - e.clientY; const rng = this.max - this.min; let v = startVal + (dy / 160) * rng * (fine ? 0.25 : 1); this.set(v); });
    c.addEventListener('pointerup', () => { drag = false; });
    c.addEventListener('dblclick', () => this.set(this.default));
    c.addEventListener('wheel', (e) => { e.preventDefault(); const d = (e.deltaY < 0 ? 1 : -1) * this.step * (e.shiftKey ? 1 : 5); this.set(+input.value + d); }, { passive: false });
    // mudança externa (preset/MIDI/undo) → anima em spring; mudança própria (drag) → instantânea
    input.addEventListener('input', () => { this.target = +this.input.value; this._aria(); if (this._self) { this.disp = this.target; this._self = false; this.draw(); } });
    this._aria();
    this.draw();
  }
  _aria() {
    this.c.setAttribute('aria-valuenow', this.input.value);
    const vb = this.label.querySelector('b');
    this.c.setAttribute('aria-valuetext', vb ? vb.textContent : this.input.value);
  }
  set(v) {
    v = Math.max(this.min, Math.min(this.max, v));
    if (this.step) v = Math.round(v / this.step) * this.step;
    this.input.value = v;
    this._self = true;
    this.input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  step() { // avança a animação; retorna true se ainda animando
    const d = this.target - this.disp;
    if (Math.abs(d) < (this.max - this.min) * 1e-4) { if (this.disp !== this.target) { this.disp = this.target; this.draw(); } return false; }
    this.disp += d * 0.3; this.draw(); return true;
  }
  draw() {
    const ctx = this.ctx, S = this.S, cx = S / 2, cy = S / 2, r = S * 0.26;
    const t = (this.disp - this.min) / (this.max - this.min);
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ang = a0 + (a1 - a0) * t;
    const acc = cssVar('--accent'), edge = cssVar('--edge');
    ctx.clearRect(0, 0, S, S);
    ctx.lineCap = 'round';
    // ticks ao redor (marcações)
    ctx.strokeStyle = edge; ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) { const aa = a0 + (a1 - a0) * (i / 10), c1 = Math.cos(aa), s1 = Math.sin(aa), r2 = r + (i % 5 === 0 ? 9 : 7);
      ctx.beginPath(); ctx.moveTo(cx + c1 * (r + 6), cy + s1 * (r + 6)); ctx.lineTo(cx + c1 * r2, cy + s1 * r2); ctx.stroke(); }
    // trilho
    ctx.lineWidth = 3.5; ctx.strokeStyle = edge; ctx.beginPath(); ctx.arc(cx, cy, r + 5, a0, a1); ctx.stroke();
    // arco de valor (com glow)
    ctx.save(); ctx.strokeStyle = acc; ctx.shadowColor = acc; ctx.shadowBlur = 7;
    ctx.beginPath(); ctx.arc(cx, cy, r + 5, a0, ang); ctx.stroke(); ctx.restore();
    // corpo metálico com sombra e bisel
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
    const g = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.5, 1, cx, cy, r * 1.2);
    g.addColorStop(0, 'rgba(255,255,255,.5)'); g.addColorStop(0.4, cssVar('--metal1')); g.addColorStop(1, cssVar('--metal2'));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.restore();
    // aro (escuro) + brilho superior
    ctx.lineWidth = 1.4; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(cx, cy - 0.5, r - 1.5, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    // textura de grip (ranhuras)
    ctx.strokeStyle = 'rgba(0,0,0,.32)'; ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) { const aa = (i / 12) * Math.PI * 2, c1 = Math.cos(aa), s1 = Math.sin(aa);
      ctx.beginPath(); ctx.moveTo(cx + c1 * r * 0.8, cy + s1 * r * 0.8); ctx.lineTo(cx + c1 * r * 0.97, cy + s1 * r * 0.97); ctx.stroke(); }
    // ponteiro com glow + ponta
    const px = cx + Math.cos(ang) * r * 0.9, py = cy + Math.sin(ang) * r * 0.9;
    ctx.save(); ctx.strokeStyle = acc; ctx.shadowColor = acc; ctx.shadowBlur = 6; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(ang) * r * 0.3, cy + Math.sin(ang) * r * 0.3); ctx.lineTo(px, py); ctx.stroke();
    ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(px, py, 1.8, 0, 7); ctx.fill(); ctx.restore();
  }
}

// ---- VU de agulha analógico (saída) ----
let vuCtx = null;
function initVU() {
  const c = $('vu'); if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = 240 * dpr; c.height = 150 * dpr;
  vuCtx = c.getContext('2d'); vuCtx.scale(dpr, dpr);
  drawVU(-60);
}
function drawVU(db) {
  if (!vuCtx) return;
  const ctx = vuCtx, W = 240, H = 150, px = W / 2, py = H - 16, R = H - 44;
  const lo = -40, hi = 3, span = 1.7, base = -Math.PI / 2;
  const toAng = (d) => { const t = Math.max(0, Math.min(1, (d - lo) / (hi - lo))); return base - span / 2 + t * span; };
  ctx.clearRect(0, 0, W, H);
  // arco de fundo
  ctx.lineWidth = 3; ctx.strokeStyle = cssVar('--edge');
  ctx.beginPath(); ctx.arc(px, py, R, base - span / 2, base + span / 2); ctx.stroke();
  // zona vermelha (0..+3 dB)
  ctx.strokeStyle = '#e0503a'; ctx.beginPath(); ctx.arc(px, py, R, toAng(0), toAng(hi)); ctx.stroke();
  // ticks + labels
  ctx.font = '9px system-ui'; ctx.textAlign = 'center';
  for (const m of [-40, -20, -10, -5, 0, 3]) { const a = toAng(m), c1 = Math.cos(a), s1 = Math.sin(a);
    ctx.strokeStyle = m >= 0 ? '#e0503a' : cssVar('--dim'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + c1 * (R - 5), py + s1 * (R - 5)); ctx.lineTo(px + c1 * R, py + s1 * R); ctx.stroke();
    ctx.fillStyle = m >= 0 ? '#e0503a' : cssVar('--dim'); ctx.fillText(m === 0 ? '0' : '' + m, px + c1 * (R - 15), py + s1 * (R - 15) + 3); }
  ctx.fillStyle = cssVar('--dim'); ctx.font = 'bold 11px system-ui'; ctx.fillText('VU', px, py - R + 20);
  // agulha (com glow)
  const a = toAng(db);
  ctx.save(); ctx.strokeStyle = cssVar('--accent'); ctx.shadowColor = cssVar('--accent'); ctx.shadowBlur = 7; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * (R - 3), py + Math.sin(a) * (R - 3)); ctx.stroke(); ctx.restore();
  // pivô
  ctx.fillStyle = cssVar('--txt'); ctx.beginPath(); ctx.arc(px, py, 4, 0, 7); ctx.fill();
}
function initKnobs() { document.querySelectorAll('label.knob').forEach((l) => { const inp = l.querySelector('input[type=range]'); if (inp && inp.id) allKnobs.push(new Knob(inp, l)); }); }
function syncKnobs() { allKnobs.forEach((k) => { k.target = +k.input.value; k._aria(); k.draw(); }); }

// ---- temas / skins ----
const THEMES = ['onyx', 'vintage', 'blue', 'crimson', 'emerald', 'violet', 'light'];
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('grd-theme', name); } catch {}
  syncKnobs();
}
$('themeSel').addEventListener('change', () => applyTheme($('themeSel').value));
(function initTheme() {
  let t = 'onyx'; try { t = localStorage.getItem('grd-theme') || 'onyx'; } catch {}
  if (!THEMES.includes(t)) t = 'onyx';
  $('themeSel').value = t; applyTheme(t);
})();

// ---- tira de cadeia: foco de módulo + LEDs de estado (Neural-DSP style) ----
function selectModule(id) {
  document.querySelectorAll('.mod').forEach((m) => m.classList.toggle('active', m.dataset.mod === id));
  document.querySelectorAll('.chip').forEach((c) => { const on = c.dataset.mod === id; c.classList.toggle('active', on); c.setAttribute('aria-selected', on ? 'true' : 'false'); });
}
function syncChainDots() {
  document.querySelectorAll('.chip[data-sw]').forEach((c) => {
    const sw = $(c.dataset.sw); if (!sw) return;
    const active = c.dataset.inv === '1' ? !sw.checked : sw.checked;
    c.classList.toggle('lit', active);
  });
}
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => selectModule(c.dataset.mod)));

// ===========================================================================
// Sprint 5 — PWA (#20): instalável + offline via service worker + auto-update
// ===========================================================================
const APP_VERSION = 'v0.7.0';
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('service-worker.js').then((reg) => {
    Log.info('service worker registrado (offline pronto)');
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          $('status').textContent = '↻ Atualização disponível — recarregue a página';
          Log.info('nova versão disponível no service worker');
        }
      });
    });
  }).catch((e) => Log.warn('service worker não registrou: ' + e.message));
}

// ---- init ----
refreshPresetList();
renderMidiMap();
loadUserPresets();
initKnobs();
initVU();
initBg();
selectModule('amp');   // amp em foco por padrão
syncChainDots();
snapshotForUndo(); // estado inicial no histórico
uiLoop();          // liga o loop de animação (knobs/meters/scope)

// ripple material nos botões e chips
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.btn, .ghost, .mini, .chip'); if (!b) return;
  const rect = b.getBoundingClientRect(), d = Math.max(rect.width, rect.height);
  const r = document.createElement('span'); r.className = 'ripple';
  r.style.width = r.style.height = d + 'px';
  r.style.left = (e.clientX - rect.left - d / 2) + 'px';
  r.style.top = (e.clientY - rect.top - d / 2) + 'px';
  b.appendChild(r); setTimeout(() => r.remove(), 520);
});

// ===========================================================================
// Sprint D — Onboarding & Ajuda: tooltips, atalhos de teclado, help, welcome
// ===========================================================================

// tooltips (data-tip) definidos por JS pra não poluir o HTML
const CHIP_TIPS = {
  gate: 'Noise Gate — corta o ruído/hiss entre as notas (essencial em alto ganho)',
  comp: 'Compressor — controla a dinâmica, mais sustain e uniformidade',
  od: 'Overdrive — empurra o amp e aperta o grave (tightener)',
  amp: 'Cabeçote — o coração do tom, 2 modelos (JCM800 / 5150)',
  eq: 'EQ paramétrico — molda o timbre depois do cabinet',
  cab: 'Cabinet + microfones — caixa, falante e micagem (dual-mic estéreo)',
  looper: 'Looper — grave camadas e toque por cima',
  rhythm: 'Ritmo — metrônomo + bateria pra praticar',
  audio: 'Áudio — dispositivo de entrada, sample rate e latência',
  system: 'Sistema — performance e log',
};
document.querySelectorAll('.chip').forEach((c) => { if (CHIP_TIPS[c.dataset.mod]) c.dataset.tip = CHIP_TIPS[c.dataset.mod]; });
const BTN_TIPS = {
  power: 'Ligar/desligar o rig (Espaço)', helpBtn: 'Ajuda e atalhos (?)',
  undoBtn: 'Desfazer (Ctrl+Z)', redoBtn: 'Refazer (Ctrl+Y)',
  abSetA: 'Guardar o estado atual em A', abSetB: 'Guardar o estado atual em B', abToggle: 'Alternar A/B pra comparar',
  midiEnable: 'Ativar controle por MIDI', midiClear: 'Limpar mapeamentos MIDI',
  presetSave: 'Salvar preset', presetExport: 'Exportar preset (.json)', presetDel: 'Apagar preset',
  mgrToggle: 'Gerenciar presets (busca / tags / favoritos)', swapOrder: 'Trocar a ordem OD ⇄ Amp',
  themeSel: 'Trocar a skin', presetList: 'Escolher um preset',
};
for (const [id, t] of Object.entries(BTN_TIPS)) { const el = $(id); if (el) { el.dataset.tip = t; el.setAttribute('aria-label', t); } }

// ARIA: cadeia = tablist, chips = tabs, módulos = tabpanels; status ao vivo; overlays = dialog
$('chain').setAttribute('role', 'tablist');
document.querySelectorAll('.chip').forEach((c) => { c.setAttribute('role', 'tab'); if (CHIP_TIPS[c.dataset.mod]) c.setAttribute('aria-label', c.textContent.trim() + ' — ' + CHIP_TIPS[c.dataset.mod]); });
document.querySelectorAll('.mod').forEach((m) => { m.setAttribute('role', 'tabpanel'); m.setAttribute('aria-label', m.dataset.mod); });
$('status').setAttribute('aria-live', 'polite');
['help', 'welcome'].forEach((id) => { const o = $(id); if (o) { o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); } });

// engine de tooltip
const tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl);
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]'); if (!el) return;
  tipEl.textContent = el.dataset.tip;
  const r = el.getBoundingClientRect();
  tipEl.style.left = (r.left + r.width / 2) + 'px'; tipEl.style.top = (r.top - 8) + 'px';
  tipEl.classList.add('show');
});
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-tip]')) tipEl.classList.remove('show'); });

// ajuda / atalhos
const toggleHelp = (force) => $('help').classList.toggle('open', force);
$('helpBtn').addEventListener('click', () => $('help').classList.toggle('open'));
$('helpClose').addEventListener('click', () => toggleHelp(false));
$('help').addEventListener('click', (e) => { if (e.target === $('help')) toggleHelp(false); });

// welcome de primeira vez
(function welcome() {
  let seen = false; try { seen = localStorage.getItem('grd-seen') === '1'; } catch {}
  if (!seen) $('welcome').classList.add('open');
})();
$('welcomeGo').addEventListener('click', () => { $('welcome').classList.remove('open'); try { localStorage.setItem('grd-seen', '1'); } catch {} });

// navegação por preset (setas [ ])
function presetStep(dir) {
  const list = $('presetList'), opts = [...list.options].filter((o) => o.value);
  if (!opts.length) return;
  let i = opts.findIndex((o) => o.value === list.value);
  i = (i + dir + opts.length) % opts.length;
  list.value = opts[i].value; list.dispatchEvent(new Event('change'));
}

// atalhos de teclado (ignora quando digitando em campo)
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+Z/Y tratados noutro handler
  const k = e.key;
  if (k === '?') { e.preventDefault(); $('help').classList.toggle('open'); }
  else if (k === 'Escape') { toggleHelp(false); $('welcome').classList.remove('open'); }
  else if (k === ' ' && !e.target.closest('button')) { e.preventDefault(); running ? stop() : start(); }
  else if (k >= '1' && k <= '6') selectModule(['gate', 'comp', 'od', 'amp', 'eq', 'cab'][+k - 1]);
  else if (k === 'a' || k === 'A') { if (abA) applyAndMark(clone(abA)); }
  else if (k === 'b' || k === 'B') { if (abB) applyAndMark(clone(abB)); }
  else if (k === '[') presetStep(-1);
  else if (k === ']') presetStep(1);
});

// ===========================================================================
// Sprint F — Marca & Skins 2.0: splash + seletor de cor de acento
// ===========================================================================
// splash: some depois que o app carrega
setTimeout(() => { const s = $('splash'); if (s) { s.classList.add('hide'); setTimeout(() => s.remove(), 600); } }, 900);

// cor de acento customizável (sobrepõe a da skin; persiste)
function applyAccent(hex) {
  if (hex) document.documentElement.style.setProperty('--accent', hex);
  else document.documentElement.style.removeProperty('--accent');
  if (typeof syncKnobs === 'function') syncKnobs();
}
$('accentPick').addEventListener('input', () => { applyAccent($('accentPick').value); try { localStorage.setItem('grd-accent', $('accentPick').value); } catch {} });
$('accentPick').addEventListener('dblclick', () => { applyAccent(''); try { localStorage.removeItem('grd-accent'); } catch {} }); // duplo-clique = volta pro acento da skin
(function initAccent() {
  let a = ''; try { a = localStorage.getItem('grd-accent') || ''; } catch {}
  if (a) { $('accentPick').value = a; applyAccent(a); }
})();

Log.info('app carregado ' + APP_VERSION);
