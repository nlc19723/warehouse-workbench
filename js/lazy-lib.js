// ============================================
// 🟢 v228.08 性能优化 P0-1：大库按需加载器（LazyLib）
//   目的：把 xlsx / chart / jszip / jsqr / qrcode / zxing 等「非首屏必需」的大库
//   从 index.html 的 defer 预载中移除，改为首次使用时动态加载，
//   从而降低首屏 JS 下载 + 解析量，缩短 DOMContentLoaded（实测 3.7s → 目标 <2s）。
//
//   设计约束（务必遵守）：
//   1. 幂等：同一库并发调用只下载一次，返回同一个 Promise。
//   2. 兼容预载：若 window.XLSX 等已存在（如被别处预载或旧缓存），直接 resolve，不重复下载。
//   3. 失败可重试：加载失败清理缓存，下次调用可重新尝试。
//   4. 不改业务逻辑：本文件只负责「把库准备好」，不触碰任何数据处理流程。
// ============================================

const LazyLib = (function () {
  // 库名 -> { src: 路径, global: 挂载的全局变量名 }
  // ⚠️ 路径必须与 index.html 中原有 <script src> 完全一致（含 ?v= 版本戳），
  //    否则会命中旧缓存或 404。发版改版本号时需同步此处。
  const LIBS = {
    xlsx:   { src: 'lib/xlsx.full.min.js?v=55',  global: 'XLSX' },
    chart:  { src: 'lib/chart.min.js?v=55',      global: 'Chart' },
    jszip:  { src: 'lib/jszip.min.js?v=1',       global: 'JSZip' },
    jsqr:   { src: 'lib/jsqr.min.js?v=1',        global: 'jsQR' },
    qrcode: { src: 'lib/qrcode.min.js?v=1',      global: 'QRCode' },
    // zxing 路径必须与 js/qr-scan.js 的 loadZXing() 完全一致（?v=1），
    // 否则同一份库会因 URL 不同被下载两次、产生两份缓存。
    zxing:  { src: 'lib/zxing.min.js?v=1',       global: 'ZXing' }
  };

  const cache = Object.create(null);   // name -> Promise

  // 读取全局变量（UMD 可能挂在 window.X 或 window.X.default）
  function readGlobal(name) {
    const g = window[name];
    if (g && typeof g === 'object' && typeof g.default !== 'undefined') return g.default;
    return g;
  }

  function load(name) {
    if (cache[name]) return cache[name];

    const conf = LIBS[name];
    if (!conf) return Promise.reject(new Error('[LazyLib] 未知库: ' + name));

    // 已挂载（被预载 / 之前加载过）→ 直接返回，不重复下载
    if (window[conf.global]) return Promise.resolve(readGlobal(conf.global));

    const p = new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = conf.src;
      s.async = true;
      s.onload = function () {
        const g = readGlobal(conf.global);
        if (g) {
          resolve(g);
        } else {
          // 下载成功但未挂载（极少数 UMD 兼容问题）→ 清缓存并报错，允许下次重试
          delete cache[name];
          reject(new Error('[LazyLib] ' + name + ' 已下载但未正确挂载'));
        }
      };
      s.onerror = function () {
        delete cache[name];   // 失败清理，允许重试
        reject(new Error('[LazyLib] ' + name + ' 加载失败，请检查网络后重试'));
      };
      document.head.appendChild(s);
    });

    cache[name] = p;
    return p;
  }

  // 同步判断某库是否就绪（不改变行为，仅用于优化提示/分支）
  function has(name) {
    const conf = LIBS[name];
    return !!(conf && window[conf.global]);
  }

  return {
    load: load,
    has: has,
    xlsx:   function () { return load('xlsx'); },
    chart:  function () { return load('chart'); },
    jszip:  function () { return load('jszip'); },
    jsqr:   function () { return load('jsqr'); },
    qrcode: function () { return load('qrcode'); },
    zxing:  function () { return load('zxing'); }
  };
})();

// 挂载到 window，确保 index.html 内联脚本与其它作用域也能访问
if (typeof window !== 'undefined') window.LazyLib = LazyLib;
