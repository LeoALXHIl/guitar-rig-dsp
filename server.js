// Servidor estático mínimo, zero dependências (Node 18+).
// getUserMedia e AudioWorklet exigem um "secure context" — http://localhost já conta,
// então não precisamos de HTTPS nem dos headers COOP/COEP aqui (não há SharedArrayBuffer
// na Fase 1). Se um dia entrar WASM com threads, é aqui que os headers voltam.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8124; // 8123 é o RigTone NAM; usamos 8124 pra rodar os dois lado a lado
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    // normaliza e impede path traversal (../)
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    if (rel === '/' || rel === '\\' || rel === '') rel = '/index.html';
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 — arquivo não encontrado');
  }
});

server.listen(PORT, () => {
  console.log(`\n🎸 guitar-rig-dsp  →  http://localhost:${PORT}\n`);
  console.log('Pluga a guitarra, usa FONE DE OUVIDO (pra não realimentar) e clica em "Ligar o rig".\n');
});
