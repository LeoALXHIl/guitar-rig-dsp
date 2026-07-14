# Arte dos pedais (plug-and-play)

Solte aqui um PNG por pedal e o app usa automaticamente como chassis.
Se o arquivo não existir, o app mantém o chassis desenhado em CSS.

## Arquivos aceitos (nome = id do bloco)
- `gate.png`  — Noise Gate
- `comp.png`  — Compressor
- `od.png`    — Overdrive
- `eq.png`    — EQ
- `cab.png`   — Cabinet + Mic

## Specs recomendadas
- **PNG** com **fundo transparente** (ideal), ~**600×760 px**, pedal de frente ou leve perspectiva.
- Deixe os **furos dos knobs vazios** — o app desenha os knobs por cima (não precisa alinhar perfeito; eles ficam na área de controles do card).
- **Design original** — sem logos/nome de marca registrada (Boss, Marshall, Ibanez, etc.).

## Como usar
1. Coloque o arquivo aqui (ex.: `public/pedals/od.png`).
2. Recarregue o app (Ctrl+Shift+R). O pedal passa a usar a imagem.
3. Para voltar ao chassis CSS, é só remover o arquivo.

> Dica: pra converter um modelo 3D em PNG, gire no Sketchfab/visualizador glTF e tire um
> screenshot com fundo transparente, ou renderize no Blender (File → Render).
