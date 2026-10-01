// オフラインでも開けるようにするための Service Worker。
// アプリ本体はネットワーク優先で、つながらないときだけキャッシュを使う
// （開発中に古いファイルが表示され続けるのを避けるため）。
// マップ・エージェントの画像は中身が変わらないので、キャッシュ優先にして 2 回目以降すぐ出す。

const CACHE = 'valo-lineups-v16';
const ASSETS = 'valo-lineups-assets-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/firebase.js',
  './js/auth.js',
  './js/store.js',
  './js/ui.js',
  './js/valo.js',
  './js/mapview.js',
  './js/images.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== ASSETS).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

function cacheFirst(request, cacheName) {
  return caches.match(request).then(
    (hit) =>
      hit ||
      fetch(request).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(cacheName).then((c) => c.put(request, copy));
        }
        return res;
      }),
  );
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Firebase SDK・QR ライブラリはバージョン付き URL で中身が変わらない
  const versionedLib =
    (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) ||
    (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/qrcode-generator@'));
  if (versionedLib) return e.respondWith(cacheFirst(e.request, CACHE));
  // マップ・エージェント・アビリティの画像
  if (url.hostname === 'media.valorant-api.com') return e.respondWith(cacheFirst(e.request, ASSETS));
  if (url.origin !== location.origin) return;
  // GitHub Pages はブラウザに 10 分キャッシュさせるので、毎回サーバーに更新を確かめる
  // （変わっていなければ中身は送られてこないので軽い）
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
  );
});
