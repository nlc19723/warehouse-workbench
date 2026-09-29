// ============================================
// 🟢 v229.37 移动端手势：
//    · 左缘右滑 → 拉出侧边栏抽屉（v229.29）
//    · 右缘左滑 → 返回（v229.30 新增）
// 🟢 v229.34 重构「右缘左滑返回」跟手视觉：Q弹果冻玻璃态
//    · 材质（多层渲染，参考悬浮乳白玻璃面板）：
//        ① 外投影：波形剪影 + 13px 大半径模糊 + 下移 18px（悬浮感）
//        ② 玻璃体：乳白微蓝填充 + backdrop blur(20px) saturate(1.8) brightness(1.15)
//        ③ 厚度层：沿波形内侧暗色内阴影（果冻物理厚度）
//        ④ 边缘高光：2px 白色核心(0.95) + 9px 白光外晕（环境光反射，微微晕开）
//        ⑤ 峰值镜面高光 + 右缘张力亮带 + 2.5% 噪点
//    · 波形：单峰高斯 x(y)=W-base-H·exp(-((y-y0)^2)/(2σ^2))
//        低谷→峰顶(触点)→低谷；σ 42→82（总跨度 ~330-400px）；H 10→100；
//        Catmull-Rom→贝塞尔保证切线连续无折角；右边界恒贴合屏幕右缘（液体拉出不断离）
//    · 物理：拖拽期 1:1 跟手 + 速度→拉伸张力；
//        松手 spring(stiffness 200, damping 20, mass 0.8) 回弹 + 果冻余震；
//        达阈值 → 波形如液体收缩回右缘，同时页面完成返回转场
// 🟢 v229.35 弹窗与返回：模态框(.modal-overlay)打开时，右缘左滑 = 关闭最上层弹窗
//    （安卓返回键惯例，等同 ESC / 点遮罩的取消语义），本次手势即消费、不做页面返回；
//    波形层级 z-index 55 → 1200，确保盖在弹窗(200)之上，用户右滑能看到跟手反馈
// 🟢 v229.37 弹窗关闭修正：工作台有两套弹窗体系（WBModal 动态 #wbModalRoot z=5000 /
//    遗留静态 #modalOverlay z=200）。旧版一律调 WBModal.close() 关不掉遗留弹窗，
//    导致「仪表盘待办明细等数据弹窗无法左滑返回」。现按 z-index 取最上层分别关闭。
// ============================================
// 体验决策（实施前盘点）：
//   1) 仅 ≤768px 生效，每次 touchstart 现场判断（旋转/分屏安全）
//   2) 左缘热区 26px：拉出抽屉；10px 方向锁定；纵向为主立即放手
//   3) 返回语义层级（从右缘左滑触发，按优先级）：
//        a. 先关最上层瞬时浮层（搜索下拉 .ss-panel.open / 列筛选 excel-filter-popup）
//        b. 再走 App 实体详情栈 App._navStack（openEntity→back）
//        c. 再走自建模块历史栈 BackHistory（包装 App.go 记录"来源模块"）
//        d. 已在最初始界面 → 橡皮筋回弹，无任何动作（绝不调 history.back() 以免退出 PWA）
//   4) 与表格横向滚动共存（右缘镜像左缘）：起手落在还能向右滚的容器
//      (scrollLeft < 最大) 内 → 完全让位原生横滚；已滚到最右才接管返回
//   5) 跳过场景：抽屉已开、收起态图标栏、加载遮罩未退、多点触控
//      （v229.35 起：模态框打开中不再跳过右缘返回 → 改为「右滑即关闭最上层弹窗」；
//        但左缘拉抽屉仍跳过，弹窗打开时不拉抽屉）
//   6) iOS Safari 标签页内系统右缘后退手势优先，网页侧不抢占；主屏 PWA 下完整可用；
//      overscroll-behavior-x:contain（body 上）压制 Android/Chrome 边缘系统返回手势
// ============================================
(function () {
  'use strict';
  if (typeof window === 'undefined' || !('ontouchstart' in window)) return;

  var EDGE = 26;          // 边缘热区(px)
  var LOCK = 10;          // 方向锁定阈值(px)
  var OPEN_RATIO = 0.4;   // 松手判定开抽屉的进度阈值
  var CLOSE_RATIO = 0.55; // 松手判定关抽屉的已拖出比例阈值
  var FLICK_V = 0.45;     // 轻扫速度(px/ms)
  var BACK_RATIO = 0.3;   // 松手判定"返回"的进度阈值（沿用既有产品手感，未改动）

  var panel = null, overlay = null, state = null;
  var BackHistory = [];   // 自建：模块切换"来源"历史（App 仅有实体详情栈）

  function mobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function railMode() { return !!(panel && panel.classList.contains('collapsed')); }
  // 与 topVisibleModal() 同一判定口径（v229.37）：只看计算样式会被"关闭后 0.25s 过渡"
  // 误判成弹窗常开，进而把左缘拉抽屉也一起拦掉。改为统一以 show 态为准。
  function modalOpen() { return !!topVisibleModal(); }
  function booting() {
    var o = document.getElementById('loadingOverlay');
    return !!(o && o.offsetParent !== null && getComputedStyle(o).display !== 'none');
  }
  function drawerOpen() { return !!(panel && panel.classList.contains('show')); }
  // 起手点是否在「还能向右滚回去」的横向容器里（是则让位原生滚动）
  function inHScroll(el) {
    var SEL = '.table-wrapper,.ob-list-table-wrapper,.oc-entry-table-wrapper,.ob-entry-table-wrapper,.ss-panel';
    var n = el && el.closest ? el.closest(SEL) : null;
    if (!n) return false;
    return n.scrollWidth > n.clientWidth + 1 && n.scrollLeft > 0;
  }
  // 右缘镜像：起手点落在「还能向左滚（即右侧还有内容）」的横向容器 → 让位原生滚动
  function inHScrollRight(el) {
    var SEL = '.table-wrapper,.ob-list-table-wrapper,.oc-entry-table-wrapper,.ob-entry-table-wrapper';
    var n = el && el.closest ? el.closest(SEL) : null;
    if (!n) return false;
    var max = n.scrollWidth - n.clientWidth;
    return max > 1 && n.scrollLeft < max - 1;
  }

  // ---------- 返回目标解析 ----------
  function pushBackHistory(from) {
    if (!from) return;
    if (BackHistory.length && BackHistory[BackHistory.length - 1] === from) return;
    BackHistory.push(from);
    if (BackHistory.length > 30) BackHistory.shift();
  }
  function installGoHistory() {
    if (!window.App || typeof App.go !== 'function' || App.__goWrapped) return;
    var orig = App.go.bind(App);
    App.__goWrapped = true;
    App.go = function (name, params) {
      try {
        var from = App.currentModule || 'dashboard';
        if (!App.go.__suppress && from !== name) pushBackHistory(from);
      } catch (e) { /* 历史记录失败不影响导航 */ }
      return orig(name, params);
    };
  }
  function suppressGo(on) { if (window.App && App.go) App.go.__suppress = on; }
  function doAppBack() {
    if (window.App && App._navStack && App._navStack.length) {
      suppressGo(true);
      try { App.back(); } finally { suppressGo(false); }   // back 内部再 go，需抑制以免污染历史
    } else if (BackHistory.length) {
      suppressGo(true);
      try { App.go(BackHistory.pop()); } finally { suppressGo(false); }
    }
    // 否则：已在最初始界面 → 橡皮筋回弹，无动作（绝不 history.back() 以免退出应用）
  }
  function closeTopmostTransient() {
    try {
      if (typeof TableUtils !== 'undefined' && TableUtils._filterPopup) {   // 列筛选弹窗
        TableUtils._hideFilterPopup();
        return true;
      }
      if (document.querySelector('.ss-panel.open')) {                        // 搜索下拉
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }
    } catch (e) { /* 关闭失败不影响返回 */ }
    return false;
  }

  // ---------- 弹窗关闭（v229.35：右缘左滑 = 关闭最上层弹窗）----------
  // 复用 modalOpen() 同款可见性判定：非 show 态是 display:flex + visibility:hidden，
  // 只判 display 会误判"弹窗常开"。
  function topVisibleModal() {
    var ms = document.querySelectorAll('.modal-overlay');
    var best = null, bestZ = -1;
    for (var i = 0; i < ms.length; i++) {
      // 必须真的在 show 态：非 show 的容器常驻 DOM（display:flex + visibility:hidden），
      // 且关闭后有 0.25s 的 visibility/opacity 过渡，只看计算样式会误判"弹窗还开着"，
      // 导致刚关完弹窗的那 250ms 内返回手势被白白吞掉。
      if (!ms[i].classList.contains('show')) continue;
      var cs = getComputedStyle(ms[i]);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var z = parseInt(cs.zIndex, 10);
      if (isNaN(z)) z = 0;
      if (z >= bestZ) { best = ms[i]; bestZ = z; }   // 同级取后出现者（后开的压在上面）
    }
    return best;
  }
  function closeTopmostModal() {
    var el = topVisibleModal();
    if (!el) return false;
    // ① WBModal 单实例 + 队列：close() = closeDialog(null)，等同 ESC / 点遮罩的取消语义
    if (el.id === 'wbModalRoot' && window.WBModal && typeof WBModal.close === 'function') {
      try { WBModal.close(); return true; } catch (e) { /* 落到兜底 */ }
    }
    // ② 遗留静态弹窗：优先点它自己的关闭/取消按钮（走业务原本的收尾逻辑），再兜底摘 show
    try {
      var btn = el.querySelector('.modal-close,.wb-modal-close,[data-modal-close],.modal-footer .btn-cancel,.modal-footer .btn-secondary');
      if (btn) btn.click();
    } catch (e) { /* 点按钮失败不影响兜底 */ }
    try {
      // 部分弹窗的关闭按钮只清 body 不清 show → 摘一次；已关则无副作用
      if (el.classList.contains('show')) el.classList.remove('show');
      return true;
    } catch (e) { /* 关闭失败不影响后续 */ }
    return false;
  }

  // ============================================================
  // 返回跟手视觉（v229.34：Q弹果冻玻璃态 + 单峰高斯波形）
  // ============================================================
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp2(a, b, t) { return a + (b - a) * t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function smoothstep(lo, hi, x) { var t = clamp01((x - lo) / (hi - lo)); return t * t * (3 - 2 * t); }

  var currentWaveFx = null;   // 当前波形前缘 x（兼容旧引用）

  // —— 波形数学：单峰高斯，低谷→峰顶→低谷，C∞ 切线连续 ——
  var H_PEAK_MIN = 10, H_PEAK_MAX = 100;   // 波峰高度（水平外凸）10 → 100
  var SIGMA_MIN = 42, SIGMA_MAX = 82;      // σ 42 → 82（跨度翻倍，总跨度 ~330-400px）
  var BASE_MIN = 2, BASE_MAX = 12;         // 谷底贴边余量
  var SPAN = 380;                          // 影响半径：±190 全权重，380 外平滑归零

  function peakExtent(p) { return lerp2(H_PEAK_MIN, H_PEAK_MAX, easeOutCubic(clamp01(p))); }
  function sigmaOf(p) { return lerp2(SIGMA_MIN, SIGMA_MAX, easeOutCubic(clamp01(p))); }
  function baseWidthOf(p) { return lerp2(BASE_MIN, BASE_MAX, easeOutCubic(clamp01(p))); }

  /** 左边界 x（y 处玻璃向左伸出多少）
   *  stretch：拖拽速度 → 拉伸张力（峰高 ×(1+0.38st)、σ ×(1-0.26st)，如拉扯糖体）
   *  wobble：松手果冻余震（峰高 ×(1+0.30wb)、σ ×(1-0.15wb)）
   */
  function leftEdgeX(y, prm) {
    var st = clamp01(prm.stretch || 0), wb = prm.wobble || 0, dis = prm.dissolve || 0;
    var peak = peakExtent(prm.progress) * (1 + 0.38 * st) * (1 + 0.30 * wb) * (1 - dis);
    var s = Math.max(12, sigmaOf(prm.progress) * (1 - 0.26 * st) * (1 - 0.15 * wb));
    var base = baseWidthOf(prm.progress) * (1 - dis * 0.9);
    var dd = y - prm.y0, dist = Math.abs(dd);
    if (dist >= SPAN) return prm.W;                            // 贴边，无玻璃
    var g = Math.exp(-(dd * dd) / (2 * s * s));                // 纯高斯：低谷→峰顶→低谷
    var win = 1 - smoothstep(SPAN * 0.55, SPAN, dist);         // 平滑流动融合到右缘
    return prm.W - (base + peak * g) * win;
  }

  /** 采样左边界，输出平滑三次贝塞尔路径（Catmull-Rom → Bézier，保证切线连续无折角） */
  function buildPath(prm, samples) {
    samples = samples || 88;
    var xs = [], ys = [], i;
    for (i = 0; i <= samples; i++) { var y = prm.H * i / samples; xs.push(leftEdgeX(y, prm)); ys.push(y); }
    var d = 'M ' + prm.W.toFixed(2) + ' 0 L ' + xs[0].toFixed(2) + ' ' + ys[0].toFixed(2);
    for (i = 0; i < xs.length - 1; i++) {
      var p0x = xs[i - 1] != null ? xs[i - 1] : xs[i], p0y = ys[i - 1] != null ? ys[i - 1] : ys[i];
      var p1x = xs[i], p1y = ys[i], p2x = xs[i + 1], p2y = ys[i + 1];
      var p3x = xs[i + 2] != null ? xs[i + 2] : p2x, p3y = ys[i + 2] != null ? ys[i + 2] : p2y;
      var c1x = p1x + (p2x - p0x) / 6, c1y = p1y + (p2y - p0y) / 6;
      var c2x = p2x - (p3x - p1x) / 6, c2y = p2y - (p3y - p1y) / 6;
      d += ' C ' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ', ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) + ', ' + p2x.toFixed(2) + ' ' + p2y.toFixed(2);
    }
    d += ' L ' + prm.W.toFixed(2) + ' ' + prm.H.toFixed(2) + ' Z';
    return d;
  }

  var NOISE_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

  /** 建一次多层玻璃 DOM，后续每帧只改 d / clip-path / opacity */
  function getGlassWave() {
    var root = document.getElementById('mg-glass-wave');
    if (root) return root;
    var html =
      // z-index 1200：盖在弹窗(200)/Toast(1000)之上，保证弹窗打开时右滑也有跟手反馈
      '<div id="mg-glass-wave" style="position:fixed;inset:0;z-index:1200;pointer-events:none;display:none">' +
        // ① 外投影：波形剪影 + 13px 模糊 + 下移（悬浮感）；不裁剪，模糊自然外溢
        '<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">' +
          '<defs><filter id="mg-shadowblur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="13"/></filter></defs>' +
          '<path id="mg-shadow-path" fill="rgba(38,46,72,0.34)" filter="url(#mg-shadowblur)" transform="translate(2 18)"/>' +
        '</svg>' +
        // ② 玻璃体：乳白微蓝（非纯透明）+ 高强度内部模糊（clip-path 收内）
        '<div id="mg-glass" style="position:absolute;inset:0;backdrop-filter:blur(20px) saturate(1.8) brightness(1.15);-webkit-backdrop-filter:blur(20px) saturate(1.8) brightness(1.15);background:linear-gradient(112deg,rgba(255,255,255,0.52) 0%,rgba(233,240,253,0.34) 46%,rgba(255,255,255,0.46) 100%);will-change:clip-path,opacity"></div>' +
        // ③ 厚度层：沿波形内侧的暗色内阴影（果冻厚度），整体裁进形状
        '<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">' +
          '<defs>' +
            '<clipPath id="mg-innerclip"><path id="mg-inner-clip-path"/></clipPath>' +
            '<filter id="mg-inshade" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter>' +
          '</defs>' +
          '<g clip-path="url(#mg-innerclip)"><path id="mg-inner-path" fill="none" stroke="rgba(92,106,148,0.38)" stroke-width="12" filter="url(#mg-inshade)"/></g>' +
        '</svg>' +
        // ⑤ 峰值镜面高光
        '<div id="mg-hl" style="position:absolute;inset:0"></div>' +
        // ⑥ 右缘液体张力亮带
        '<div id="mg-menis" style="position:absolute;inset:0;background:linear-gradient(to left,rgba(255,255,255,0.55) 0%,rgba(255,255,255,0) 18px);mix-blend-mode:screen"></div>' +
        // ⑦ 噪点（消除塑料感）
        '<div id="mg-noise" style="position:absolute;inset:0;opacity:0.025;mix-blend-mode:overlay"></div>' +
        // ④ 边缘高光（顶层）：9px 白光外晕 + 2px 白色核心，不裁剪 → 向外微微晕开
        '<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">' +
          '<defs>' +
            '<filter id="mg-bloom" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>' +
            '<filter id="mg-coreblur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="0.6"/></filter>' +
          '</defs>' +
          '<path id="mg-bloom-path" fill="none" stroke="#ffffff" stroke-width="9" stroke-opacity="0.5" filter="url(#mg-bloom)"/>' +
          '<path id="mg-core-path" fill="none" stroke="rgba(255,255,255,0.95)" stroke-width="2" filter="url(#mg-coreblur)"/>' +
        '</svg>' +
      '</div>';
    document.body.insertAdjacentHTML('beforeend', html);
    var nz = document.getElementById('mg-noise');
    if (nz) nz.style.backgroundImage = 'url("' + NOISE_URL + '")';
    return document.getElementById('mg-glass-wave');
  }

  var PATH_IDS = ['mg-shadow-path', 'mg-inner-clip-path', 'mg-inner-path', 'mg-bloom-path', 'mg-core-path'];
  var CLIP_IDS = ['mg-glass', 'mg-hl', 'mg-menis', 'mg-noise'];

  /** 每帧渲染：波形路径 + 各层裁剪与不透明度 */
  function renderWave(prm) {
    var root = getGlassWave();
    if (!root) return;
    var d = buildPath(prm), i, el;
    for (i = 0; i < PATH_IDS.length; i++) {
      el = document.getElementById(PATH_IDS[i]);
      if (el) el.setAttribute('d', d);
    }
    var clip = 'path("' + d + '")';
    for (i = 0; i < CLIP_IDS.length; i++) {
      el = document.getElementById(CLIP_IDS[i]);
      if (el) { el.style.clipPath = clip; if (el.style.webkitClipPath !== undefined) el.style.webkitClipPath = clip; }
    }
    var dis = 1 - (prm.dissolve || 0);
    var show = (prm.progress > 0.002 || Math.abs(prm.wobble || 0) > 0.02) && dis > 0.002;
    root.style.display = show ? 'block' : 'none';

    var bodyOp = Math.min(1, prm.progress * 4) * dis;    // 乳白体快速进场
    var shadowOp = Math.min(1, prm.progress * 3) * dis;  // 外投影早期出现（悬浮感）
    var edgeOp = Math.min(1, prm.progress * 2) * dis;    // 边缘光稍慢（Q弹发酵感）

    el = document.getElementById('mg-shadow-path'); if (el && el.ownerSVGElement) el.ownerSVGElement.style.opacity = String(0.9 * shadowOp);
    el = document.getElementById('mg-glass'); if (el) el.style.opacity = String(bodyOp);
    el = document.getElementById('mg-inner-path'); if (el && el.ownerSVGElement) el.ownerSVGElement.style.opacity = String(bodyOp);
    el = document.getElementById('mg-core-path'); if (el && el.ownerSVGElement) el.ownerSVGElement.style.opacity = String(edgeOp);

    el = document.getElementById('mg-hl');
    if (el) {
      var px = leftEdgeX(prm.y0, prm).toFixed(0);
      var hi = Math.min(1, prm.progress * 1.5);
      el.style.opacity = String(hi * dis);
      el.style.background = 'radial-gradient(170px 200px at ' + px + 'px ' + prm.y0 + 'px, ' +
        'rgba(255,255,255,' + (0.9 * hi).toFixed(3) + ') 0%, ' +
        'rgba(240,246,255,' + (0.35 * hi).toFixed(3) + ') 38%, ' +
        'rgba(255,255,255,0) 68%)';
    }
    el = document.getElementById('mg-menis');
    if (el) {
      el.style.opacity = String(Math.min(1, prm.progress * 1.8) * dis);
      var mask = 'radial-gradient(80px 260px at calc(100% - 8px) ' + prm.y0 + 'px, #000 55%, transparent 100%)';
      el.style.maskImage = mask;
      if (el.style.webkitMaskImage !== undefined) el.style.webkitMaskImage = mask;
    }
    el = document.getElementById('mg-noise'); if (el) el.style.opacity = String(0.025 * bodyOp);
    currentWaveFx = leftEdgeX(prm.y0, prm);
  }

  function wavePrms(progress, y0, extra) {
    var prm = { progress: clamp01(progress), y0: y0, W: window.innerWidth, H: window.innerHeight, stretch: 0, wobble: 0, dissolve: 0 };
    if (extra) { for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) prm[k] = extra[k]; }
    return prm;
  }

  // 跟手：拖拽期 1:1 跟手指（波峰 y0 = 手指 Y，幅度 = 视觉进度，速度 → 拉伸张力）
  function applyBackDrag(vp) {
    document.body.style.userSelect = 'none';
    if (document.body.style.webkitUserSelect !== undefined) document.body.style.webkitUserSelect = 'none';
    var y0 = (state && state.fy != null) ? state.fy : window.innerHeight / 2;
    var st = clamp01((state && state.stretch) || 0);
    renderWave(wavePrms(vp, y0, { stretch: st }));
  }

  /** 松手：spring(stiffness 200, damping 20, mass 0.8) 回弹 + 果冻余震（阻尼振荡） */
  function settleBack(vp0, y0, amp, done) {
    var x = vp0, v = 0, k = 200, c = 20, m = 0.8, target = 0;
    var t0 = nowMs(), last = t0, raf = 0;
    function frame(t) {
      var dt = Math.min(0.032, (t - last) / 1000); last = t;
      var el = (t - t0) / 1000;
      var a = (-k * (x - target) - c * v) / m;
      v += a * dt; x += v * dt;
      var wob = Math.sin(el * Math.PI * 2 * 3.2) * Math.exp(-4.5 * el) * amp;
      renderWave(wavePrms(x, y0, { wobble: wob }));
      if (el > 1.15 || (el > 0.15 && Math.abs(x - target) < 0.002 && Math.abs(v) < 0.002)) {
        if (raf) cancelAnimationFrame(raf);
        if (done) done();
        return;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  /** 达阈值：波形像液体一样收缩回右缘（同时页面完成返回转场） */
  function liquidRetract(vp0, y0, done) {
    var dur = 320, t0 = nowMs(), raf = 0;
    function frame(t) {
      var e = Math.min(1, (t - t0) / dur);
      var dis = 1 - Math.pow(1 - e, 3);   // easeOut：先快后缓，像液体回吸
      renderWave(wavePrms(vp0, y0, { dissolve: dis }));
      if (e < 1) raf = requestAnimationFrame(frame);
      else if (done) done();
    }
    raf = requestAnimationFrame(frame);
  }

  function fadeWave(dur) {
    var s = document.getElementById('mg-glass-wave');
    if (s) { s.style.transition = 'opacity ' + dur + 'ms'; s.style.opacity = '0'; }
    setTimeout(cleanupWave, dur + 40);
  }
  function cleanupWave() {
    var s = document.getElementById('mg-glass-wave');
    if (s && s.parentNode) s.parentNode.removeChild(s);
    document.body.style.userSelect = '';
    if (document.body.style.webkitUserSelect !== undefined) document.body.style.webkitUserSelect = '';
    currentWaveFx = null;
  }

  // ---------- 抽屉开/合视觉（沿用 v229.29） ----------
  function setDragStyles(p) {
    var w = panel.getBoundingClientRect().width || 1;
    panel.style.transform = 'translateX(' + Math.round(p * w - w) + 'px)';
    overlay.style.display = 'block';
    overlay.style.visibility = 'visible';
    overlay.style.opacity = String(p);
  }
  function clearDragStyles() {
    panel.style.transform = '';
    overlay.style.opacity = '';
    overlay.style.visibility = '';
    overlay.style.display = '';
  }
  function setDragging(on) {
    panel.classList.toggle('wb-dragging', on);
    overlay.classList.toggle('wb-dragging', on);
  }

  function commitOpen(p, v) {
    var open = p > OPEN_RATIO || v > FLICK_V;
    setDragging(false);
    setDragStyles(p);
    void panel.offsetWidth;   // 强制重排，让过渡从当前位置起步
    if (open) {
      panel.classList.add('show');
      overlay.classList.add('show');
      clearDragStyles();
      if (window.App) {
        App.sidebarOpen = true;
        if (App.sidebarCollapsed) {   // 与汉堡按钮行为一致：开抽屉即清图标栏态
          App.sidebarCollapsed = false;
          panel.classList.remove('collapsed');
          document.body.classList.remove('sidebar-rail');
        }
      }
    } else {
      clearDragStyles();              // 未达阈值 → 滑回原位
    }
  }
  function commitClose(p, v) {
    var close = p < CLOSE_RATIO || v < -FLICK_V;
    setDragging(false);
    setDragStyles(p);
    void panel.offsetWidth;
    if (close) {
      if (window.App && typeof App.closeMobileSidebar === 'function') {
        App.sidebarOpen = false;
        document.getElementById('sidebarOverlay').classList.remove('show');
        document.getElementById('sidebarPanel').classList.remove('show');
      } else {
        panel.classList.remove('show');
        overlay.classList.remove('show');
      }
      clearDragStyles();
    } else {
      clearDragStyles();              // 回弹到开位（.show 仍在，过渡回 translateX(0)）
    }
  }
  /** 返回提交：willBack → 液体收缩回右缘 + 返回转场；否则 → Q弹回弹 + 果冻余震 */
  function commitBack(p, v, fy, vp) {
    setDragging(false);
    var willBack = p > BACK_RATIO || v < -FLICK_V;   // v 负 = 向左快扫
    var H = window.innerHeight;
    if (fy == null) fy = H / 2;
    if (vp == null) vp = p;
    // 🟢 弹窗打开时：右滑即关闭最上层弹窗（安卓返回键惯例），本次手势消费，不做页面返回
    if (closeTopmostModal()) { cleanupWave(); return; }
    if (reducedMotion()) {                            // 减动效：只淡出，不做果冻位移
      fadeWave(150);
      if (willBack) { if (closeTopmostTransient()) return; doAppBack(); }
      return;
    }
    if (willBack) {
      if (closeTopmostTransient()) { cleanupWave(); return; }   // 先关瞬时浮层，本次手势即消费
      doAppBack();                                              // 页面完成返回转场
      liquidRetract(vp, fy, cleanupWave);                       // 波形如液体收缩回右缘
    } else {
      if (closeTopmostTransient()) { cleanupWave(); return; }   // 瞬时浮层优先被先关
      var energy = clamp01(Math.abs(v) * 1000 / 3500 + vp * 0.5);
      settleBack(vp, fy, 0.45 + energy * 0.55, cleanupWave);    // Q弹回弹 + 果冻余震
    }
  }

  function onStart(e) {
    if (state || e.touches.length !== 1 || !mobile()) return;
    installGoHistory();
    if (!panel || !overlay) {
      panel = document.getElementById('sidebarPanel');
      overlay = document.getElementById('sidebarOverlay');
      if (!panel || !overlay) return;
    }
    var t = e.touches[0];
    var W = window.innerWidth;
    var open = panel.classList.contains('show');
    if (!open) {
      if (railMode() || booting()) return;
      if (t.clientX <= EDGE) {                         // 左缘 → 开抽屉
        if (modalOpen()) return;                       // 弹窗打开时不拉抽屉
        if (inHScroll(e.target)) return;
        state = { mode: 'open' };
      } else if (t.clientX >= W - EDGE) {              // 右缘 → 返回（弹窗打开时也可触发：用于关弹窗）
        if (inHScrollRight(e.target)) return;
        state = { mode: 'back' };
      }                                                // 中间起手 → 不接管
    } else {
      // 抽屉已开：仅在面板内左拖才走关闭，右缘返回在此不接管（避免与"右滑关抽屉"混淆）
      if (!e.target.closest || !e.target.closest('#sidebarPanel')) return;
      state = { mode: 'close' };
    }
    if (!state) return;
    state.x0 = t.clientX; state.y0 = t.clientY;
    state.lastX = t.clientX; state.lastT = nowMs();
    state.p = 0; state.v = 0; state.claimed = false;
    state.fx = null; state.fy = null;                 // 波形锚点（y0）跟随手指
    state.vp = 0; state.stretch = 0;                  // 视觉进度 / 拉伸张力
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: false });
    document.addEventListener('touchcancel', onEnd, { passive: false });
  }

  function onMove(e) {
    if (!state || e.touches.length !== 1) { cleanup(false); return; }
    var t = e.touches[0];
    var dx = t.clientX - state.x0, dy = t.clientY - state.y0;
    if (!state.claimed) {
      if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
      if (Math.abs(dy) >= Math.abs(dx)) { cleanup(false); return; }   // 纵向为主 → 放手
      if (state.mode === 'open' && dx <= 0) { cleanup(false); return; }
      if (state.mode === 'close' && dx >= 0) { cleanup(false); return; }
      if (state.mode === 'back' && dx >= 0) { cleanup(false); return; } // 向右滑不触发返回
      state.claimed = true;
      setDragging(true);
    }
    e.preventDefault();   // 接管后阻止原生滚动/橡皮筋
    var nt = nowMs();
    state.v = (t.clientX - state.lastX) / Math.max(1, nt - state.lastT);   // px/ms，向左为负
    state.lastX = t.clientX; state.lastT = nt;
    if (state.mode === 'open') {
      var Wo = panel.getBoundingClientRect().width || 1;
      state.p = Math.min(1, Math.max(0, dx / Wo));
      setDragStyles(state.p);
    } else if (state.mode === 'close') {
      var Wc = panel.getBoundingClientRect().width || 1;
      state.p = Math.min(1, Math.max(0, 1 - (-dx / Wc)));
      setDragStyles(state.p);
    } else {   // back
      var Wb = window.innerWidth;
      state.p = Math.min(1, Math.max(0, -dx / (Wb * BACK_RATIO)));    // 返回判定进度（沿用）
      state.vp = Math.min(1, Math.max(0, -dx / (Wb * 0.5)));          // 波形视觉进度（跟手成长）
      state.fx = t.clientX; state.fy = t.clientY;                     // 波峰锚点实时跟手指 Y
      // 速度 → 拉伸张力（px/ms → px/s；系数 0.5 贴近跟手）
      var tgt = clamp01(Math.abs(state.v) * 1000 / 2600);
      state.stretch += (tgt - state.stretch) * 0.5;
      applyBackDrag(state.vp);
    }
  }

  function onEnd() {
    if (!state) return;
    var mode = state.mode, claimed = state.claimed, p = state.p, v = state.v;
    var fy = (state.fy != null) ? state.fy : (window.innerHeight / 2);
    var vp = (state.vp != null) ? state.vp : p;
    if (!claimed) {
      cleanup(false);
      if (mode === 'back') cleanupWave();   // 未达方向锁即松手：本无波形，确保清理
      return;
    }
    cleanup(false);
    if (mode === 'open') commitOpen(p, v);
    else if (mode === 'close') commitClose(p, v);
    else commitBack(p, v, fy, vp);
  }

  function cleanup(keepStyles) {
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onEnd);
    if (panel) panel.classList.remove('wb-dragging');
    if (overlay) overlay.classList.remove('wb-dragging');
    state = null;
  }

  installGoHistory();   // App 已就绪则立即装好历史钩子（否则 onStart 内惰性补装）
  document.addEventListener('touchstart', onStart, { passive: true });
  if (typeof window !== 'undefined') window.MobileGestures = { reopen: function () { panel = null; } };
})();
