// ============================================
// Service Worker v8 — PWA 离线安装版
//     预缓存应用外壳（支持离线打开/安装为桌面应用）
//     库文件 Cache-First / 应用文件 Network-First（带离线回退）
// ============================================
// 🟢 v206：CACHE_NAME 曾长期停留在 v24，导致旧缓存永不失效、用户看不到新版样式。
// 🟢 v207：P0 修复（XSS 转义 / DataStore 缓存失效 / 核对单事务）。每次发版必须同步 bump。
//   现改为跟随 CSS 版本号（index.html 里 style.css?v=NNN），发版 bump 时缓存自动整体换新。
const CACHE_NAME = 'warehouse-workbench-v227.97';

// 预缓存：应用外壳（离线可打开的最低文件集）
// 🟢 v227.72：把「登录链路必需」的 JS 也纳入预缓存。
//   旧版只缓存 index.html / style.css / manifest.json，一个 JS 都没有 ——
//   离线冷启动时 JS 只能走回退，结果被回退成了 HTML（见下方 fetch 分支说明）。
const PRECACHE = [
  '.',
  'index.html',
  'css/style.css',
  'manifest.json',
  // 登录链路核心：config(账号) / globals(转义等) / app(登录UI与校验) /
  // db(数据) / sync(isOnline) / modal(WBModal) / data-loader
  'js/config.js',
  'js/globals.js',
  'js/app.js',
  'js/db.js',
  'js/sync.js',
  'js/modal.js',
  'js/data-loader.js',
  'js/table-utils.js',
  'js/query.js'
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

  // ====== 应用文件（HTML/CSS/JS）：Network-First + 成功后写缓存 ======
  // 🟢 v206：加 { cache: 'no-store' } 强制绕过浏览器 HTTP 缓存。
  //   否则静态服务器返回的强缓存/304 会让用户一直拿到旧 CSS，样式更新不生效。
  //
  // 🟢 v227.72【重要修复】离线回退不再一律回退到 index.html。
  //   旧实现：caches.match('.') —— '.' 预缓存的就是 index.html，于是 **任意** 失败请求
  //   （JS / CSS / 图片…）都会被塞一份 HTML 回去。浏览器把 HTML 当脚本解析 →
  //   "Unexpected token '<'" → 脚本全废 → 白屏、登录点不动（正是「链接打不开」的物理原因）。
  //   现在按「导航请求 / 资源请求」分开处理：只有要打开页面才回退 HTML。
  const isNavigation = (e.request.mode === 'navigate')
    || ((e.request.headers.get('accept') || '').indexOf('text/html') !== -1);

  // 未缓存时的兜底 MIME：让浏览器明确收到「失败」，而不是拿到一份能解析的 HTML
  const offlineMime = (u) => /\.css(\?|$)/i.test(u) ? 'text/css; charset=utf-8'
    : /\.json(\?|$)/i.test(u) ? 'application/json; charset=utf-8'
    : /\.(png|jpe?g|gif|svg|ico|webp)(\?|$)/i.test(u) ? 'image/svg+xml'
    : 'application/javascript; charset=utf-8';

  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(res => {
        // 成功后写入缓存（运行时累积），让后续离线能命中
        if (res && res.ok) {
          try {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, copy)).catch(() => {});
          } catch (err) { /* clone 失败忽略，不影响正常响应 */ }
        }
        return res;
      })
      .catch(() => {
        // ① 导航请求（要打开页面）→ 回退 index.html，保证离线能进应用
        if (isNavigation) {
          return caches.match(e.request, { ignoreSearch: true })
            .then(cached => cached || caches.match('index.html') || caches.match('.'));
        }
        // ② 资源请求（JS/CSS/图片…）→ 只从缓存取；绝不拿 HTML 冒充
        return caches.match(e.request, { ignoreSearch: true }).then(cached => {
          if (cached) return cached;
          // 未缓存：明确 504，让浏览器报错而不是执行 HTML
          return new Response('/* offline: not cached */', {
            status: 504,
            statusText: 'Offline',
            headers: { 'Content-Type': offlineMime(url) }
          });
        });
      })
  );
});
