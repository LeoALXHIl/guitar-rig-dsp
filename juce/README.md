# Guitar Rig DSP — plugin JUCE (Fase 6, MVP)

Plugin **VST3 + Standalone** que porta o preamp do amp **800-style (JCM800 2203)** do
guitar-rig-dsp web pra C++/JUCE. É o primeiro passo pra ter o rig rodando dentro de um DAW
(Reaper, Ableton, Logic…) com latência nativa — o formato que dá pra **vender**.

> **Escopo do MVP:** 1 amp (800-style), 4× oversampling, tone stack + presence/depth +
> power amp com sag. UI = editor genérico do JUCE (sliders automáticos). Os outros amps,
> pedais e a UI bonita entram nas próximas etapas — a matemática já está toda no projeto web.

## Pré-requisitos (Windows)
- **Visual Studio 2022** (com "Desenvolvimento para desktop com C++").
- **CMake 3.22+** — https://cmake.org/download (marque "Add to PATH").
- **Git** (o CMake baixa o JUCE sozinho via FetchContent na 1ª build; precisa de internet).

## Build (PowerShell, dentro da pasta `juce/`)
```powershell
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```
A 1ª vez demora (baixa e compila o JUCE). Saídas:
- **Standalone:** `build/GuitarRigDSP_artefacts/Release/Standalone/Guitar Rig DSP.exe`
- **VST3:** `build/GuitarRigDSP_artefacts/Release/VST3/Guitar Rig DSP.vst3`
  (com `COPY_PLUGIN_AFTER_BUILD`, já é copiado pra `C:\Program Files\Common Files\VST3`)

## Testar
- **Standalone:** abre o `.exe`, escolhe a interface de áudio (use ASIO se tiver → latência baixa) e toca.
- **No DAW:** re-escaneie os plugins e procure **Guitar Rig DSP** (fabricante NexTags).

## Como isso mapeia no web
`Source/PluginProcessor.cpp` → `processBlock` é o equivalente ao `process()` do
`public/dsp/amp-processor.js`. A struct `Biquad` e as fórmulas RBJ são **idênticas** às
verificadas no harness Node. O oversampling usa `juce::dsp::Oversampling` (4×).

## Próximos passos
1. Portar os outros 3 amps (5150 / Twin / Rectifier) — só copiar os `VOICES` do JS.
2. Portar os pedais (overdrive, fuzz, delay, reverb, chorus, phaser).
3. Cabinet: trocar o IR sintético por convolução (`juce::dsp::Convolution`) + carregar `.wav`.
4. UI própria (custom `AudioProcessorEditor`) no lugar do editor genérico.
5. Presets (o `APVTS` já serializa o estado).

## Licença JUCE
JUCE é **GPLv3** (grátis, código aberto) **ou** comercial (pra fechar/vender). Veja
https://juce.com/get-juce — se for vender fechado, precisa da licença comercial.
