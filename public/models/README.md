# Modelo 3D real do amp (.glb) — plug-and-play

Coloque aqui um arquivo **`amp.glb`** e o app mostra um botão "Modelo real (.glb)"
que carrega o modelo interativo (girar/zoom) dentro da própria UI.

## Como conseguir o .glb
1. No Sketchfab, abra o modelo e veja se há **"Download 3D Model"** (precisa conta grátis;
   nem todo modelo é baixável).
2. Baixe no formato **glTF Binary (.glb)**.
3. Renomeie para **`amp.glb`** e coloque nesta pasta (`public/models/amp.glb`).
4. Recarregue o app → botão "Modelo real (.glb)" no bloco Amp.

## Observações honestas
- O viewer usa a lib **`<model-viewer>`** via **CDN** → essa visualização só funciona **online**
  (o resto do app segue offline). 
- **Knobs operáveis:** se o modelo tiver os knobs como peças separadas, dá pra girá-los;
  se for malha fundida, a gente usa **hotspots** (controles nossos ancorados nos knobs, que
  acompanham a rotação). Isso é um passo seguinte, feito depois que o `amp.glb` estiver aqui.
- **Marca:** modelos de marca (Fender/Marshall/EVH) — ok pra teste pessoal, evite no deploy público.
