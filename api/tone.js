// Função serverless (Vercel) — Assistente de Tom por IA.
// A chave da OpenAI fica SÓ aqui, como variável de ambiente secreta (OPENAI_API_KEY),
// nunca no frontend. O navegador chama POST /api/tone e recebe { preset, name, why }.
//
// Body aceito:
//   { prompt?: string,        // descrição em texto ("metal grave", "deixa mais brilhante")
//     ref?: string,           // link (YouTube ou qualquer) — o servidor lê SÓ o título, não baixa áudio
//     current?: object }      // preset atual (opcional) — quando presente, a IA AJUSTA em cima dele
//
// Configurar na Vercel: Project → Settings → Environment Variables → OPENAI_API_KEY = (sua chave)
// (use uma chave NOVA; a que foi colada no chat deve ser revogada.)

const SYS = `Você é um projetista de tom de guitarra para um simulador de rack web.
Escolha valores MUSICAIS e responda SOMENTE com um objeto JSON (sem markdown, sem texto extra) com:
- name: nome curto e criativo pro preset (PT-BR), ex "5150 Lead Apertado".
- why: UMA frase curta (PT-BR) explicando as escolhas.
- e as seções relevantes abaixo. Chaves e faixas válidas:

od:     { drive:1..100, tone:0..1, level:0..1, bypass:bool }        // overdrive/booster
fuzz:   { sustain:0..1, tone:0..1, level:0..1, bypass:bool }        // fuzz Big Muff-style (denso/sustentado; tone escava o médio). Use p/ stoner/doom/leads gordos; senão bypass:true
amp:    { model:"0"|"1"|"2"|"3", channel:0..2, gain:0..1, bass:0..1, mid:0..1, treble:0..1,
          presence:0..1, depth:0..1, master:0..1, bright:bool, power:true }
        // model "0" = Marshall-ish (JCM800), canal sempre 0.
        // model "1" = high-gain (5150): channel 0=Clean, 1=Crunch, 2=Lead.
        // model "2" = clean US-ish (Fender Twin), muito headroom/brilho, canal sempre 0. Bom p/ clean/funk/blues.
        // model "3" = Rectifier-ish moderno (grave/scooped/apertado): channel 0=Vintage, 1=Modern. Bom p/ metal moderno.
gate:   { threshold:-90..0, release:10..600, bypass:bool }          // noise gate (dB, ms)
comp:   { threshold:-60..0, ratio:1..20, attack:0.1..100, release:10..1000, makeup:0..24, bypass:bool }
eq:     { low:-18..18, mid:-18..18, midFreq:200..5000, midQ:0.2..8, high:-18..18, hp:20..400, lp:2000..20000, bypass:bool }
cab:    { cab:"4x12"|"2x12"|"1x12", speaker:"v30"|"green"|"cream", mic:"sm57"|"md421"|"r121",
          micB:"none"|"sm57"|"md421"|"r121", axis:0..1, distance:0..1, blend:0..1, spread:0..1, on:true }
chorus: { rate:0..1, depth:0..1, mix:0..1, bypass:bool }            // engrossa/espacializa (clean/pop)
phaser: { rate:0..1, depth:0..1, feedback:0..0.9, mix:0..1, bypass:bool } // varrido setentista (funk/psicodélico)
delay:  { time:0.02..1.2, feedback:0..0.95, tone:0..1, mix:0..1, bypass:bool }   // time em segundos
reverb: { size:0..1, damp:0..1, mix:0..1, bypass:bool }

Regras: metal/alto ganho → model "1" canal 2 (Lead), gate ligado, mid baixo. Clean/funk → model "1"
canal 0 (Clean) ou model "0" gain baixo, comp ligado. Ambient → delay+reverb ligados com mix alto.
Se um efeito não faz sentido, deixe bypass:true. Sempre inclua amp e cab.
Se vier uma REFERÊNCIA (música/artista), aproxime o timbre CARACTERÍSTICO daquele som com os recursos acima
(o motor só tem 2 amps, então é "no estilo de", não idêntico) e cite a referência no campo why.
Se vier um PRESET ATUAL, faça só o AJUSTE pedido e MANTENHA o resto igual (devolva o preset inteiro ajustado).`;

// Lê APENAS o título de um link (YouTube via oEmbed, ou <title>/og:title de páginas). Não baixa áudio.
async function resolveRef(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');
  // bloqueio simples de alvos internos (SSRF)
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || host.endsWith('.local')) return null;

  const signal = AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined;
  try {
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      const o = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), { signal });
      if (o.ok) { const d = await o.json(); if (d && d.title) return `música/vídeo "${d.title}"${d.author_name ? ' — canal ' + d.author_name : ''}`; }
    }
    const r = await fetch(url, { signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; guitar-rig-dsp/1.0)' } });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 20000);
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    const tt = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = (og && og[1]) || (tt && tt[1]);
    return title ? `página "${title.trim()}"` : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'use POST' }); return; }
  const key = process.env.OPENAI_API_KEY;
  if (!key) { res.status(500).json({ error: 'OPENAI_API_KEY não configurada na Vercel (Settings → Environment Variables).' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const desc = (body.prompt || '').toString().slice(0, 400).trim();
  const refUrl = (body.ref || '').toString().slice(0, 500).trim();
  const current = body.current && typeof body.current === 'object' ? body.current : null;

  let refInfo = null;
  if (refUrl) refInfo = await resolveRef(refUrl);
  if (!desc && !refInfo && !current) { res.status(400).json({ error: 'descreva o som ou cole um link válido' }); return; }

  // monta a mensagem do usuário
  const parts = [];
  if (refInfo) parts.push(`Reproduza o timbre de guitarra de: ${refInfo}.`);
  else if (refUrl) parts.push('(Não consegui ler o título do link — use só a descrição abaixo.)');
  if (desc) parts.push(refInfo ? `Ajuste pedido: ${desc}` : desc);
  if (current) parts.push('PRESET ATUAL (ajuste em cima dele, mantendo o resto):\n' + JSON.stringify(current));
  const userMsg = parts.join('\n') || 'monte um tom versátil e agradável';

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini', temperature: 0.7, max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYS }, { role: 'user', content: userMsg }],
      }),
    });
    if (!r.ok) { res.status(502).json({ error: 'OpenAI respondeu ' + r.status }); return; }
    const data = await r.json();
    let parsed = {};
    try { parsed = JSON.parse(data.choices[0].message.content); } catch { res.status(502).json({ error: 'IA não devolveu JSON válido' }); return; }
    const { name = '', why = '', ...preset } = parsed;
    res.status(200).json({ preset, name, why, ref: refInfo });
  } catch (e) {
    res.status(500).json({ error: e.message || 'falha na chamada' });
  }
}
