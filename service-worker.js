// ============================================
// Service Worker v8 — PWA 离线安装版
//     预缓存应用外壳（支持离线打开/安装为桌面应用）
//     库文件 Cache-First / 应用文件 Network-First（带离线回退）
// ============================================
// 🟢 v206：CACHE_NAME 曾长期停留在 v24，导致旧缓存永不失效、用户看不到新版样式。
// 🟢 v207：P0 修复（XSS 转义 / DataStore 缓存失效 / 核对单事务）。每次发版必须同步 bump。
//   现改为跟随 CSS 版本号（index.html 里 style.css?v=NNN），发版 bump 时缓存自动整体换新。
const CACHE_NAME = 'warehouse-workbench-v214';

// 预缓存：应用外壳（离线可打开的最低文件集）
const PRECACHE = [
  '.',
  'index.html',
  'css/style.css',
  'manifest.json'
];

// 第三方库（大文件，Cache-First 加速）
const LIBS = [
  'lib/dexie.min.js',
  'lib/chart.min.js',
  'lib/xlsx.full.min.js',
  'lib/supabase.min.js'
];

// 安装：预缓存应用外壳 + 跳过等待
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(PRECACHE).catch(() => {}) // 预缓存失败不阻塞安装
    )
  );
  self.skipWaiting();
});

// 激活：清理旧版本缓存 + 立即接管所有页面
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// 请求拦截
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // 非 GET 请求直接放行
  if (e.request.method !== 'GET') return;

  // Supabase API 和本地开发服务器不缓存
  if (url.includes('supabase.co') || url.includes('localhost:54321')) return;

  // Excel 文件下载不缓存
  if (url.endsWith('.xlsx') || url.endsWith('.xls') || url.endsWith('.xlsm')) return;

  // ====== 库文件：Cache-First（大文件不变，优先用缓存加速）======
  const isLib = LIBS.some(lib => url.includes(lib));
  if (isLib) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached =>
          cached || fetch(e.request).then(res => {
            cache.put(e.request, res.clone());
            return res;
          })
        )
      )
    );
    return;
  }

  // ====== 应用文件（HTML/CSS/JS）：Network-First，离线回退到缓存 ======
  // 网络正常时始终拉最新；网络断开时返回缓存的版本（含预缓存的 . 作为 fallback）
  // 🟢 v206：加 { cache: 'no-store' } 强制绕过浏览器 HTTP 缓存。
  //   否则静态服务器返回的强缓存/304 会让用户一直拿到旧 CSS，样式更新不生效。
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() =>
      caches.match(e.request).then(cached => cached || caches.match('.'))
    )
  );
});
