# Guitar Rig DSP — Roadmap de 100 Sprints (MVP → produto vendável)

Estado atual: **MVP JUCE compila e toca** (4 amps: preamp+power amp+tone stack+sag, 4× OS).
Falta: cabinet, pedais, UI própria, e toda a camada de produto/venda.

Marque `[x]` conforme concluir. Cada sprint é uma entrega pequena e testável.

---

## FASE 1 — Paridade de som (motor completo em C++)  [1–15]
- [ ] 1. Portar o **cabinet** (res. caixa + corpo do falante + quebra de cone + mic + rolloff + comb) pós power amp
- [ ] 2. Cabinet: seletor de **caixa** (4x12 / 2x12 / 1x12)
- [ ] 3. Cabinet: seletor de **falante** (V30 / Greenback / Creamback)
- [ ] 4. Cabinet: **mic A + mic B** (dual-mic) com seleção (SM57 / MD421 / R121)
- [ ] 5. Cabinet: **axis / distance / blend / spread** (imagem estéreo)
- [ ] 6. **Loader de IR real (.wav)** via `juce::dsp::Convolution` (alternativa ao sintético)
- [ ] 7. Portar **Overdrive** (tube screamer)
- [ ] 8. Portar **Fuzz** (Big Muff)
- [ ] 9. Portar **Noise Gate**
- [ ] 10. Portar **Compressor**
- [ ] 11. Portar **EQ paramétrico** (pós-cab)
- [ ] 12. Portar **Delay** (estéreo)
- [ ] 13. Portar **Reverb** (Freeverb)
- [ ] 14. Portar **Chorus + Phaser**
- [ ] 15. **Cadeia reordenável** (roteamento) + bypass por bloco

## FASE 2 — Calibração de tom ("soa real")  [16–25]
- [ ] 16. A/B de cada amp contra referência real (de ouvido, com o Leonardo)
- [ ] 17. Ajustar **gain staging** por amp
- [ ] 18. Ajustar **curvas do tone stack** por amp
- [ ] 19. Refinar **sag / dinâmica / resposta ao toque**
- [ ] 20. Ajustar **power amp** (bias, sag, classe AB)
- [ ] 21. Revisar **anti-aliasing** (ADAA onde valer a pena)
- [ ] 22. Calibrar cada **canal** (Clean/Crunch/Lead, Vintage/Modern…)
- [ ] 23. **Ruído/hum** de válvula opcional (realismo)
- [ ] 24. **Clean-up** pelo volume da guitarra (responde como amp real)
- [ ] 25. **Bright/Presence** interagindo com o ganho (comportamento real)

## FASE 3 — Mais gear (ampliar o leque)  [26–38]
- [ ] 26. Amp **Vox-style** (AC30, chime)
- [ ] 27. Amp **Fender tweed** (breakup precoce)
- [ ] 28. Amp **Plexi** (não-master-volume)
- [ ] 29. Amp **moderno alemão** (Diezel/Engl-style, alto ganho)
- [ ] 30. Amp de **baixo** (opcional, novo público)
- [ ] 31. Pedal **Distortion** (RAT-style)
- [ ] 32. Pedal **Boost** limpo
- [ ] 33. Pedal **Wah** (auto-wah + wah por MIDI expression)
- [ ] 34. Pedal **Tremolo**
- [ ] 35. Pedal **Flanger**
- [ ] 36. Pedal **Octaver / Pitch**
- [ ] 37. Pedal **Compressor** de pedaleira (separado do studio comp)
- [ ] 38. **Noise gate avançado** (multibanda / de-hiss)

## FASE 4 — UI própria (cara de produto)  [39–55]
- [ ] 39. `AudioProcessorEditor` **custom** (sair do editor genérico)
- [ ] 40. **Design system** / identidade visual da marca
- [ ] 41. **Knobs** vetoriais realistas (chicken-head, skirted, chrome)
- [ ] 42. **Faceplate por amp** (tolex, grade, metal) — como no web
- [ ] 43. Layout de **rack / pedaleira**
- [ ] 44. **Medidores** VU de entrada e saída
- [ ] 45. **Analisador de espectro** / osciloscópio
- [ ] 46. Indicadores de **clip / gate**
- [ ] 47. UI **redimensionável** (scaling) + tela cheia
- [ ] 48. **Tooltips** e ajuda in-app
- [ ] 49. **Temas** (claro/escuro + skins)
- [ ] 50. Animações/feedback (LEDs, tube-glow reativo)
- [ ] 51. Tela **Sobre** (versão, créditos, licença)
- [ ] 52. **Acessibilidade** (teclado, foco, ARIA-equivalente)
- [ ] 53. **Undo/redo** de parâmetros
- [ ] 54. **A/B** de configurações
- [ ] 55. Persistir **estado da UI** (tamanho, aba aberta)

## FASE 5 — Presets & conteúdo  [56–65]
- [ ] 56. Sistema de **presets** (salvar/carregar) — APVTS já serializa
- [ ] 57. **Browser** de presets (categorias, busca, favoritos)
- [ ] 58. **Banco de fábrica** por estilo (metal, blues, clean, ambient…)
- [ ] 59. **Import/export** (.vstpreset + formato próprio)
- [ ] 60. Slots **A/B/C/D** de troca rápida
- [ ] 61. **Tags** e metadados de preset
- [ ] 62. **Compartilhar** preset (arquivo/link)
- [ ] 63. **Migração** de presets entre versões
- [ ] 64. **Assistente de tom por IA** (como o web: descrição/link → preset)
- [ ] 65. **Signature packs** de artista (conteúdo pago à parte)

## FASE 6 — Recursos pro  [66–75]
- [ ] 66. **Afinador** embutido (YIN)
- [ ] 67. **Metrônomo / drums** (treino)
- [ ] 68. **Looper**
- [ ] 69. **MIDI learn** / automação de todos os params
- [ ] 70. **MIDI Program Change** → troca de preset
- [ ] 71. Opções de **oversampling** (2×/4×/8×, eco/hi-fi)
- [ ] 72. **Modo baixa latência**
- [ ] 73. **Dual amp / split** (dois amps em paralelo)
- [ ] 74. **IR duplo** + mixer de cab
- [ ] 75. Utilitários de **I/O** (gain, phase, hi-pass, mono)

## FASE 7 — Qualidade & multiplataforma  [76–85]
- [ ] 76. Rodar **pluginval** (validação oficial de plugin)
- [ ] 77. **Testes unitários** de DSP (JUCE UnitTest)
- [ ] 78. **CI** (GitHub Actions) build Windows + macOS
- [ ] 79. Build **macOS** (Intel + Apple Silicon, universal)
- [ ] 80. Formato **AU** (macOS / Logic)
- [ ] 81. Formato **AAX** (Pro Tools — requer conta/assinatura PACE)
- [ ] 82. Formato **LV2** (Linux) — opcional
- [ ] 83. **Standalone** robusto (seletor de device, ASIO, salvar config)
- [ ] 84. Otimização **CPU / SIMD** + denormals
- [ ] 85. **Estabilidade**: testar 44.1–192 kHz, vários buffers, automação pesada

## FASE 8 — Camada comercial (virar produto)  [86–93]
- [ ] 86. **Marca / logo / nome** definitivos (sem trademark de terceiros)
- [ ] 87. **Licenciamento / DRM** (serial + ativação online)
- [ ] 88. **Trial** (X dias, ou com ruído periódico)
- [ ] 89. **Instalador Windows** (Inno Setup) + **assinatura de código** (cert EV)
- [ ] 90. **Assinatura + notarização macOS** (conta Apple Developer)
- [ ] 91. **Auto-update** / verificação de versão
- [ ] 92. **Telemetria opt-in** + relatório de crash
- [ ] 93. **EULA**, política de privacidade e **licença JUCE comercial** (pra vender fechado)

## FASE 9 — Loja & distribuição  [94–98]
- [ ] 94. **Landing page** (features, áudios demo, preço, comprar)
- [ ] 95. **Checkout** + entrega de licença (Lemon Squeezy / Gumroad / Stripe)
- [ ] 96. **Área de conta** (downloads, licenças, reativação)
- [ ] 97. Submeter a **marketplaces** (Plugin Boutique, etc.)
- [ ] 98. **Suporte** (docs, FAQ, canal de contato)

## FASE 10 — Lançamento & marketing  [99–100]
- [ ] 99. **Conteúdo de lançamento**: vídeos, áudios A/B, presets de artista, review units
- [ ] 100. **Lançamento** + campanha (redes, parcerias com guitarristas, early-bird)

---

### Ordem sugerida de ataque
1. **Fase 1** primeiro (cabinet → pedais) = o plugin passa a soar como o web.
2. **Fase 2** (calibrar de ouvido) em paralelo — é o que faz soar profissional.
3. **Fase 4** (UI) quando o som estiver fechado — é o que vende visualmente.
4. **Fases 7–9** (qualidade + produto + loja) pra transformar em algo comprável.
5. **Fase 3 / 5 / 6** entram como diferencial/valor ao longo do caminho.

> Realidade: as fases 1–6 eu faço aqui (código + build). As fases 8–10 (marca, DRM,
> assinatura, loja, marketing) têm partes que dependem de contas/pagamentos/decisões suas.
