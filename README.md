# 🎸 guitar-rig-dsp

Simulador de rack de guitarra no navegador com **motor de modelagem de amps construído do zero**
(pré-amp valvulado → tone stack → power amp → cabinet), foco em tons EVH/Marshall de alto ganho.
DSP em **TypeScript/JS rodando em AudioWorklet** (migração pra Rust/WASM planejada só se o profiler pedir).

> Projeto novo, independente do RigTone NAM (que usa perfis neurais capturados).
> Aqui o objetivo é **modelar o circuito**, não reproduzir uma captura.

## Como rodar

Requisito: **Node.js 18+** (zero dependências).

```bash
node server.js
```

Abre **http://localhost:8124**, permite o acesso ao microfone/interface, usa **fone de ouvido**
e clica em **"Ligar o rig"**. (Porta 8124 pra conviver com o RigTone NAM na 8123.)

Sem interface? Marque **Tom de teste** pra ouvir a cadeia reagindo.

## Status — Fases 1–5 ✅ + Profissionalização Sprint 1 ✅

Cadeia funcionando (gate fixo no início; OD↔amp reordenável):

```
guitarra (getUserMedia) ─┐
tom de teste ────────────┴─▶ [meter in] ─▶ GATE ─▶ OVERDRIVE ─▶ CABEÇOTE ─▶ CABINET+MIC ─▶ master ─▶ [meter out] ─▶ fone
```

**Sprint 6 (redesign visual — Studio Dark / Neural DSP):**
- Layout reimaginado: **tira de cadeia clicável** (gate ▸ comp ▸ drive ▸ amp ▸ eq ▸ cab · looper/ritmo/áudio/sistema)
  com LEDs de estado, **palco central** que mostra **um módulo em foco por vez** (card grande, knobs
  ampliados), e **dock fixo** embaixo (in/out meters + clip + master + afinador + espectro sempre visíveis).
- Estética flat/near-black, tipografia grande, chrome mínimo. Reorder OD⇄Amp agora pela tira (arraste o chip
  ou botão). Zero mudança de wiring — só reorganização de containers + CSS.

**Sprint 5 (UI premium #13):**
- **Knobs rotativos** desenhados em canvas (arco de valor, corpo metálico, ponteiro) sobrepostos
  aos `<input type=range>` (que continuam no DOM, escondidos) — arraste vertical, shift=fino,
  duplo-clique=reset, scroll. Todo o wiring (MIDI/presets/undo/labels) segue intacto.
- **4 skins** (Onyx / Vintage / Blueface / Crimson) via CSS custom properties, persistidas.
- Painéis com **textura metálica, parafusos, sombras**, toggles estilo **LED**, header com placa.
- **#20 PWA completo** — `manifest.webmanifest` + `icon.svg` + `service-worker.js` (network-first,
  offline, cache versionado, aviso de atualização). App **instalável** e usável offline.

**Sprint 4 (robustez + prática):**
- **#15 Looper + metrônomo + drum machine** — looper de camadas (`dsp/looper-processor.js`:
  rec/overdub/play/clear, estéreo preservado, verificado no Node) pós-master; metrônomo e
  bateria (kick/snare/hat sintetizados) com scheduler lookahead, BPM e 3 padrões (rock/metal/funk).
- **#17 Painel de áudio/latência** — escolha de dispositivo de entrada, sample rate e latency hint
  (aplicados ao reiniciar), leitura de round-trip latency e SR ativo.
- **#19 Logging + erro + monitor de perf** — logger com ring buffer + export, captura de
  `error`/`unhandledrejection`, e HUD com FPS/frame-time/dropouts (drift áudio×relógio real).

**Sprint 3 (gestão + controle):**
- **#10 Gerenciador de presets em IndexedDB** — busca por nome/tag, favoritos ★, tags editáveis,
  painel "Gerenciar" (migra automaticamente os presets antigos do localStorage).
- **#11 MIDI (Web MIDI)** — MIDI Learn (arma um controle e mova um CC), Control Change mapeado
  a qualquer knob, Program Change → troca preset. Mapa persiste em localStorage.
- **#12 Undo/Redo (Ctrl+Z/Y), A/B e Snapshots** — histórico de estado (até 60), 2 slots A/B com
  toggle instantâneo, 4 snapshots de sessão. Verificado: scaling MIDI, filtro de busca, pilha undo.

**Sprint 2 (tom + estúdio + visibilidade):**
- **#16 Compressor + EQ paramétrico** (`dsp/compressor-processor.js`, `dsp/eq-processor.js`) —
  blocos com bypass; comp com meter de GR; EQ 3 bandas + HP/LP (verificado: +12 dB exato @1kHz).
- **#9 Cab estéreo dual-mic + IR determinístico** — 2 microfones (blend equal-power + spread
  estéreo via `StereoPanner`), IR gerado com **RNG seeded** (mesma config → mesmo IR).
- **#14 Afinador** (`dsp/tuner-processor.js`, YIN) — verificado 0.0 cents nas 6 cordas.
- **#7 Metering dBFS** + LED de clip (clique reseta) e **#8 espectro + osciloscópio** (canvas).
- **#20 (parcial)** versionamento de preset + migração automática v1→v2.

**Sprint 1 (DSP core):**
- **#1 Oversampling 4× + anti-aliasing** — overdrive e amp rodam toda a distorção a 4× a
  sample rate, reamostrada com FIR polifásico windowed-sinc. Verificado: **~19 dB menos
  aliasing** (medido por FFT no harness Node). É o maior salto de qualidade sonora.
- **#4 Noise Gate** — `dsp/gate-processor.js`, expander com histerese + hold + attack/release,
  medidor de redução de ganho. Threshold + Decay na UI. Fixo no início da cadeia.
- **#3 Suavização de parâmetros** — Gain/Master/Drive/Level suavizados por one-pole (~5 ms)
  por sample → sem zipper noise.

- **Overdrive** (`dsp/overdrive-processor.js`): soft clip assimétrico via `tanh` + tone
  (passa-baixa 1 polo) + level.
- **Cabeçote** (`dsp/amp-processor.js`), **2 modelos** selecionáveis:
  - **800-style (JCM800 2203, EL34)** — 3 estágios de triodo em cascata.
  - **5150-style Lead (EVH 5150III, 6L6)** — 4 estágios, mais ganho, mais escuro e apertado.
  - Cada estágio: `tanh` assimétrico + passa-baixa Miller + passa-alta de acoplamento (aperta
    o grave). Tone stack Bass/Mid/Treble (scoop de médio + interação treble×bass), Presence,
    Depth/Resonance, power amp push-pull com **sag** dinâmico, trafo de saída.
  - Verificado num harness Node: **estável, saída limitada (±1), sem NaN**, reage ao gain,
    Power-off = bypass. **Nota:** tone stack é modelo comportamental (não a transfer function
    SPICE exata — refinamento futuro); já é "crunchy" no gain mínimo, fiel aos amps reais.
- **Cabinet + Mic** (`app.js`, IR sintético parametrizado): caixa (4x12/2x12/1x12) × falante
  (V30/Greenback-style) × microfone (SM57/MD421/R121) × eixo (on/off-axis) × distância.
  **Carregue seu `.wav` de IR real** pra sobrescrever o sintético.
- **Presets**: 3 de fábrica + salvar/apagar (localStorage) + exportar/importar JSON.
- **Reordenar**: arraste a alça ⠿ ou botão "Trocar ordem" (OD antes/depois do amp).
- Meters de entrada/saída, tom de teste, master.

> ⚠️ **Validação de áudio é por escuta na sua interface** — o DSP foi verificado
> numericamente (estabilidade/limites), mas o *tom* você afina no ouvido.

## Roadmap

| Fase | Entregável |
|------|-----------|
| **1** ✅ | Pipeline Web Audio + overdrive + cabinet + meters |
| **2** ✅ | 1º amp: **JCM800 2203** (12AX7 em cascata + tone stack + EL34 + sag) |
| **3** ✅ | 2º amp: **EVH 5150III Lead** (6L6, 4 estágios, alto ganho) — seletor de modelo |
| **4** ✅ | Cabinet+Mic parametrizável (caixa/falante/mic/posição) + carregar `.wav` |
| **5** ✅ | Reordenar OD↔amp (drag/botão) + sistema de presets (save/export/import) |
| **6** (opc.) | Portar core DSP pra plugin VST/AU (JUCE) — ver abaixo |

## Fase 6 — caminho pra VST/AU (não implementado)

O motor DSP está isolado nos `*-processor.js` (funções puras de sample-a-sample). Pra virar
plugin: reescrever esses blocos em **C++** (ou Rust) preservando a mesma matemática, empacotar
com **JUCE** (que dá o wrapper VST3/AU e a UI), e substituir só a camada de I/O. A modelagem
(triodos, tone stack, power amp, sag) migra 1:1. Enquanto isso, o alvo é o navegador.

## Arquitetura

Cada bloco de DSP é um `AudioWorkletProcessor` isolado, registrado por nome. Adicionar um
amp/pedal novo = adicionar um processor + conectá-lo no grafo. O grafo é montado no main
thread e a ordem vem de um array (`chainOrder`), então **reordenar = reconectar nós**
(`rewireChain`) — foi assim que o drag-and-drop saiu de graça.

```
guitar-rig-dsp/
├── server.js              # servidor estático local (porta 8124)
├── package.json
└── public/
    ├── index.html         # UI do rack + barra de presets
    ├── app.js             # I/O, grafo, cab+mic (IR), presets, reordenação, meters
    ├── dsp/
    │   ├── overdrive-processor.js
    │   └── amp-processor.js       # cabeçote 800-style + 5150-style
    └── ir/                # (opcional) IRs .wav do usuário
```
