# Assistente de Tom por IA (opcional)

`api/tone.js` é uma **função serverless** (Vercel) que gera um preset a partir de uma
descrição em texto. A chave da OpenAI fica **só no servidor**, como variável de ambiente
— nunca no frontend.

## Como ativar (só no deploy Vercel)
1. **Revogue** qualquer chave que já tenha vazado e crie uma nova em platform.openai.com.
2. Vercel → seu projeto → **Settings → Environment Variables**:
   - Nome: `OPENAI_API_KEY`
   - Valor: sua chave nova
3. Redeploy. Pronto — o botão **"IA"** no app chama `/api/tone`.

## Notas
- **Só funciona no deploy Vercel** (a função não roda no `node server.js` local). Sem a
  variável configurada, o botão avisa "IA indisponível" e o resto do app segue normal.
- Modelo usado: `gpt-4o-mini` (barato). Dá pra trocar em `api/tone.js`.
- A chave **nunca** aparece no código nem no navegador (é lida de `process.env`).
