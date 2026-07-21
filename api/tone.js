// Função serverless (Vercel) — Assistente de Tom por IA.
// A chave da OpenAI fica SÓ aqui, como variável de ambiente secreta (OPENAI_API_KEY),
// nunca no frontend. O navegador chama POST /api/tone com { prompt } e recebe { preset }.
//
// Configurar na Vercel: Project → Settings → Environment Variables → OPENAI_API_KEY = (sua chave)
// (use uma chave NOVA; a que foi colada no chat deve ser revogada.)

const SYS = `Você é um projetista de tom de guitarra para um simulador de rack web.
Dada a descrição do usuário, escolha valores MUSICAIS e responda SOMENTE com um objeto JSON
(sem markdown, sem texto extra) contendo apenas as seções relevantes. Chaves e faixas válidas:

od:     { drive:1..100, tone:0..1, level:0..1, bypass:bool }        // overdrive/booster
amp:    { model:"0"|"1", channel:0..2, gain:0..1, bass:0..1, mid:0..1, treble:0..1,
          presence:0..1, depth:0..1, master:0..1, bright:bool, power:true }
        // model "0" = Marshall-ish (JCM800), canal sempre 0.
        // model "1" = high-gain (5150): channel 0=Clean, 1=Crunch, 2=Lead.
gate:   { threshold:-90..0, release:10..600, bypass:bool }          // noise gate (dB, ms)
comp:   { threshold:-60..0, ratio:1..20, attack:0.1..100, release:10..1000, makeup:0..24, bypass:bool }
eq:     { low:-18..18, mid:-18..18, midFreq:200..5000, midQ:0.2..8, high:-18..18, hp:20..400, lp:2000..20000, bypass:bool }
cab:    { cab:"4x12"|"2x12"|"1x12", speaker:"v30"|"green", mic:"sm57"|"md421"|"r121",
          micB:"none"|"sm57"|"md421"|"r121", axis:0..1, distance:0..1, blend:0..1, spread:0..1, on:true }
delay:  { time:0.02..1.2, feedback:0..0.95, tone:0..1, mix:0..1, bypass:bool }   // time em segundos
reverb: { size:0..1, damp:0..1, mix:0..1, bypass:bool }

Regras: metal/alto ganho → model "1" canal 2 (Lead), gate ligado, mid baixo. Clean/funk → model "1"
canal 0 (Clean) ou model "0" gain baixo, comp ligado. Ambient → delay+reverb ligados com mix alto.
Se um efeito não faz sentido, deixe bypass:true. Sempre inclua amp e cab.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'use POST' }); return; }
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY não configurada na Vercel (Settings → Environment Variables).' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  let prompt = (body && body.prompt || '').toString().slice(0, 400).trim();
  if (!prompt) { res.status(400).json({ error: 'descrição vazia' }); return; }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) { res.status(502).json({ error: 'OpenAI respondeu ' + r.status }); return; }
    const data = await r.json();
    let preset = {};
    try { preset = JSON.parse(data.choices[0].message.content); } catch { res.status(502).json({ error: 'IA não devolveu JSON válido' }); return; }
    res.status(200).json({ preset });
  } catch (e) {
    res.status(500).json({ error: e.message || 'falha na chamada' });
  }
}
