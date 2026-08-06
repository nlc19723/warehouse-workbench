// ============================================
// Service Worker v6 — 只缓存库文件，HTML/JS/CSS 始终从网络获取
//     解决：用户端缓存导致更新不生效 + 加载慢
// ============================================
const CACHE_NAME = 'warehouse-workbench-v6';
const LIBS = [
  'lib/dexie.min.js', 'lib/chart.min.js', 'lib/xlsx.full.min.js', 'lib/supabase.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(LIBS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  if (url.includes('supabase.co') || url.includes('localhost:54321')) return;
  if (url.endsWith('.xlsx') || url.endsWith('.xls') || url.endsWith('.xlsm')) return;

  // 库文件：Cache-First（大文件不变，缓存加速）
  const isLib = LIBS.some(lib => url.includes(lib));
  if (isLib) {
    return caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => cached || fetch(e.request).then(res => { cache.put(e.request, res.clone()); return res; }))
    );
  }

  // HTML / CSS / JS：Network-First（始终拉最新，确保更新生效）
  return fetch(e.request).catch(() => caches.match(e.request));
});
