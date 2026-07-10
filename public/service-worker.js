/**
 * Service Worker — deixa o guitar-rig-dsp instalável (PWA) e utilizável offline.
 *
 * Estratégia NETWORK-FIRST: online sempre serve os arquivos frescos (importante porque
 * você ainda está iterando o rig) e atualiza o cache; offline (servidor desligado) cai
 * pro cache. O nome do cache carrega a VERSÃO — ao subir uma versão nova, o cache velho
 * é apagado no 'activate' e a UI é avisada da atualização.
 */
const VERSION = 'v0.6.1';
const CACHE = 'grd-' + VERSION;
const ASSETS = [
  './', './index.html', './app.js', './manifest.webmanifest', './icon.svg',
  './dsp/gate-processor.js', './dsp/compressor-processor.js', './dsp/overdrive-processor.js',
  './dsp/amp-processor.js', './dsp/eq-processor.js', './dsp/tuner-processor.js', './dsp/looper-processor.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
