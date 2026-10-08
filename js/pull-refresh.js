// ============================================
// 移动端下拉刷新 🟢 v229.70；v229.72 起刷新后落点由 App._bootTarget() 统一解析
// 作用：移动端（≤768px）触屏下，页面滚动到顶时向下拖拽 → 整页重载工作台并重新进入。
//
// 设计要点（全部来自实测核对，非通用模板）：
//  · 滚动容器是 #contentArea（.content-scroll），**不是 body** —— 判顶用 container.scrollTop<=0，
//    用 window.scrollY 判会导致手势永不触发。
//  · 与 mobile-gestures.js 的左侧边缘右滑（抽屉）起点重叠 → 必须在 touchstart 阶段
//    用方向判定（|dy| > |dx|）把两者分开，不能等 move 阶段再判（那时抽屉已开）。
//  · 表格是横向滚动容器（.table-wrapper 等）—— 触点落在其上时不启动下拉，
//    避免与横向拖表格/框选复制打架。
//  · touchmove 仅用 { passive: false } 挂在容器上，**且仅 armed 态才 preventDefault**；
//    常态下完全不劫持页面滚动（这是下拉刷新最常见的翻车点）。
//  · 刷新动作 = location.reload()，而非重调 App.init()：
//    App.init() 内绑了约 30 个全局监听（侧栏/时钟/版本巡检/拖拽守卫），
//    重复调用会事件叠加与内存泄漏。整页重载由浏览器保证干净重建。
//    登录态在 localStorage.wb_current_keeper，整页重载**不掉登录**。
//
// 🟢 v229.72 落点机制（本文件不再负责"刷新后回到原模块"）：
//   刷新**前**只写一条意图标记 sessionStorage.wb_boot_target（含时间戳），
//   由 App._bootTarget() 在启动时统一解析成首屏落点，启动链路**一次导航到位**。
//   v229.70/v229.71 曾在本文件内做"启动后补偿式改道"（等 _bootDone 再 go 目标模块），
//   那是「先渲染 dashboard 再切走 → 闪屏 + 同模块渲染两次」的根因，v229.72 已整段删除：
//   补偿式改道天然会多渲染一次，让启动链路直接落对位置才是唯一正解。
// ============================================
(function () {
  'use strict';

  if (typeof window === 'undefined' || !('ontouchstart' in window)) return;

  // ===== 参数 =====
  var TRIGGER = 64;          // 触发阈值(px)：下拉超过即"松手就刷新"
  var DAMP = 0.5;            // 阻尼：实拖 128px → 视觉 64px，避免原生 overscroll 打架
  var MAX = 110;             // 指示器最大下拉距离(px)，再多不再增加位移
  var REBUND_MS = 260;
  var MIN_FRESH = 12;        // 最小触发位移(px)，低于此视为误触直接回弹

  // 横向滚动容器守卫（与 mobile-gestures.js inHScroll 保持同一批选择器）
  var HSCROLL_SEL = '.table-wrapper,.ob-list-table-wrapper,.ob-entry-table-wrapper,.oc-entry-table-wrapper,.ss-panel';
  // 浮层/弹窗打开时不响应
  var MODAL_SEL = '.modal.show,.wb-modal.show,.panel-dialog.show,#excelFilterPopup.show';

  var container = null, indicator = null, arc = null;
  var st = 'idle';           // idle | armed | pulling | refreshing
  var startY = 0, startX = 0, dy = 0, dirLocked = false;
  var activePointer = false, refreshing = false;
  var lastAtTop = true;      // touchstart 时采样是否在顶部（防"已滚下去又滑回"误判）

  function mobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function booting() {
    // 启动屏未收尾时不响应（此时整页正在重建，拖拽无意义）
    return !!(window.__bootSplashStarted && !window.__bootSplashDone);
  }
  function modalOpen() {
    if (document.querySelector(MODAL_SEL)) return true;
    return !!document.querySelector('.modal-overlay.show,#modalOverlay.show');
  }
  function inHScroll(el) {
    return !!(el && el.closest && el.closest(HSCROLL_SEL));
  }
  function atTop() {
    return !container || container.scrollTop <= 0;
  }

  // ===== 指示器 DOM =====
  function ensureIndicator() {
    if (indicator) return indicator;
    indicator = document.createElement('div');
    indicator.id = 'wbPullRefresh';
    indicator.className = 'wb-ptr';
    indicator.setAttribute('aria-hidden', 'true');
    indicator.innerHTML =
      '<div class="wb-ptr-ring"></div>' +
      '<svg class="wb-ptr-arrow" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path d="M12 4v13M12 17l-5-5M12 17l5-5" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<div class="wb-ptr-text"></div>';
    document.body.appendChild(indicator);
    arc = indicator.querySelector('.wb-ptr-arrow');
    return indicator;
  }

  function setState(next) {
    st = next;
    if (!indicator) return;
    indicator.classList.toggle('is-armed', next === 'armed');
    indicator.classList.toggle('is-pulling', next === 'pulling');
    indicator.classList.toggle('is-refreshing', next === 'refreshing');
    indicator.classList.toggle('is-hidden', next === 'idle');
  }

  function setProgress(dist) {
    if (!indicator) return;
    // 箭头随进度旋转：到阈值时正好转 180°（视觉上"翻面"提示松手刷新）
    var p = clamp(dist / TRIGGER, 0, 1);
    if (arc) arc.style.transform = 'rotate(' + (p * 180).toFixed(1) + 'deg)';
    var txt = indicator.querySelector('.wb-ptr-text');
    if (txt) txt.textContent = p >= 1 ? '松手刷新' : '下拉刷新';
  }

  function springBack() {
    if (!indicator) return;
    indicator.style.transition = reducedMotion() ? 'none'
      : 'transform ' + REBUND_MS + 'ms cubic-bezier(.22,1,.36,1), opacity ' + REBUND_MS + 'ms ease';
    indicator.style.transform = 'translate3d(0,-100%,0)';
    indicator.style.opacity = '0';
    setState('idle');
    setTimeout(function () {
      if (indicator) { indicator.style.transition = 'none'; indicator.style.transform = ''; }
    }, reducedMotion() ? 0 : REBUND_MS + 20);
  }

  // ===== 刷新 =====
  function doRefresh() {
    if (refreshing) return;
    refreshing = true;
    setState('refreshing');
    if (indicator) {
      indicator.style.transition = 'transform ' + REBUND_MS + 'ms cubic-bezier(.22,1,.36,1)';
      indicator.style.transform = 'translate3d(0,0,0)';
      indicator.style.opacity = '1';
      var txt = indicator.querySelector('.wb-ptr-text');
      if (txt) txt.textContent = '正在重新进入…';
      if (arc) arc.style.transform = '';
    }
    // 🟢 v229.72：只写「意图标记」，不自己负责跳转。
    //   由 App._bootTarget() 读取并解析成首屏落点（含权限/存在性/新鲜度三重校验），
    //   启动链路一次导航到位 —— 消除「先渲染 dashboard 再切走」的闪屏与重复渲染。
    try {
      var A = window.App;
      var m = (A && A.currentModule) ? A.currentModule : '';
      if (m) {
        sessionStorage.setItem('wb_boot_target', m);
        sessionStorage.setItem('wb_ptr_at', String(Date.now()));
      }
    } catch (e) { /* 隐私模式等：失败则按默认落点启动，不阻断刷新 */ }

    // 整页重载 —— 干净重建，不重调 App.init()（避免全局监听叠加）
    // 留一帧让转圈动画渲染出来再跳，避免"点了没反应"的错觉
    setTimeout(function () { location.reload(); }, reducedMotion() ? 0 : 180);
  }

  // ===== 手势 =====
  function onTouchStart(e) {
    if (refreshing || !mobile() || booting() || modalOpen()) return;
    if (!e.touches || !e.touches.length) return;
    var t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    dy = 0;
    dirLocked = false;        // 方向在 start 阶段不锁，move 满阈值再锁
    activePointer = true;
    lastAtTop = atTop();
    if (!lastAtTop) return;    // 未在顶部：本次手势直接不参与
    ensureIndicator();
  }

  function onTouchMove(e) {
    if (!activePointer || refreshing) return;
    if (st === 'idle' && !lastAtTop) return;

    var t = e.touches && e.touches[0];
    if (!t) return;

    var mdy = t.clientY - startY, mdx = t.clientX - startX;

    // ① 方向锁定：纵向显著优先才归下拉，否则让位给抽屉/横滑（必须在 move 早期判定）
    if (!dirLocked) {
      var ady = Math.abs(mdy), adx = Math.abs(mdx);
      if (ady < 8 && adx < 8) return;                 // 还没到判定阈值，先不动
      dirLocked = true;
      if (mdy <= 0) { activePointer = false; return; } // 向上推 → 不是下拉
      if (mdx > 0 && adx > ady * 1.2) { activePointer = false; return; } // 明显横向（抽屉）→ 让位
      if (inHScroll(e.target)) { activePointer = false; return; }      // 表格横滚区 → 让位
    }

    if (st === 'idle' || st === 'armed') {
      // 只有"从顶部继续下拉"才接管；已滚下去时不劫持
      if (!atTop() && mdy > 0) { activePointer = false; return; }
      // 常态下阻止浏览器原生下拉刷新/overscroll 接管（仅 armed 后才拦滚动）
      if (e.cancelable) e.preventDefault();
      dy = mdy * DAMP;
      if (dy > MAX) dy = MAX;
      setState(dy >= TRIGGER ? 'pulling' : 'armed');
      if (indicator) {
        indicator.style.transition = 'none';
        indicator.style.transform = 'translate3d(0,' + (dy - 46).toFixed(1) + 'px,0)';
        indicator.style.opacity = dy > 8 ? '1' : '0';
      }
      setProgress(dy);
    }
  }

  function onTouchEnd() {
    if (!activePointer || refreshing) { activePointer = false; return; }
    activePointer = false;
    if (st === 'pulling' && dy >= TRIGGER && dy >= MIN_FRESH) {
      doRefresh();
      return;
    }
    springBack();
  }

  function bind() {
    container = document.getElementById('contentArea') || document.querySelector('.content-scroll') || document.body;
    if (!container) return;
    // passive:false 是必须的 —— 否则 preventDefault 无效（浏览器会警告且不阻止滚动）
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });
  }

  // 供 app.js 在启动完成后调用（也可自举，作为双保险）
  function install() {
    if (window.__wbPullRefreshInstalled) return;
    window.__wbPullRefreshInstalled = true;
    bind();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }

  window.PullRefresh = { install: install };
})();