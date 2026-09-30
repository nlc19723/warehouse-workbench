/* ============================================================
 * boot-canvas-worker.js —— 启动屏动画 Web Worker（OffscreenCanvas）
 * 主线程把 #bootSplashCanvas 的 OffscreenCanvas 转交本 worker，
 * 背景粒子 / 词标 / 光池 / 环境尘的绘制都在独立线程完成，
 * 即使主线程被 DataLoader.init 的同步重活（18MB JSON parse / IndexedDB 批量写入）阻塞，
 * 背景动画也绝不冻结。
 * 圆环（SVG 剪纸切片）与中心圆盘+数字（DOM .boot-center）保持原装渲染，
 * 由本 worker 回传的 disp 消息驱动主线程 syncRing() 按进度点亮/更新。
 *
 * 进度自驱动（T1）：向外部 target 缓动；target 长时间不前进则缓慢爬向 90% 封顶，
 * 消除「跳-停-冲」的体感。complete 后缓动到 100% → 停留 HOLD → 回传 done。
 *
 * 消息协议（主线程 → worker）：
 *   init   {canvas, dpr, W, H, cx, cyWord, cyRing}
 *   resize {W, H, dpr, cx, cyWord, cyRing}
 *   target {value}       真实目标进度 0-100
 *   complete             收口到 100%
 *   pointer {x, y, active}
 *   kill                 停止循环
 * 回传（worker → 主线程）：
 *   {type:'done'}        已达 100% 且停留结束，主线程可淡出
 *   {type:'disp', value} 当前显示进度（主线程用于 CSS 变量 / fallback 同步）
 * ============================================================ */
'use strict';
(function () {
  var cv, ctx;
  var W = 0, H = 0, dpr = 1, cx = 0, cyWord = 0, cyRing = 0, cyCenter = 0;
  var running = false, killed = false;
  var theme = 'light';
  var dbgChan = null;            // 🟢 调试通道（仅 init 带 dbg:true 时启用，生产不触发）

  // ---- 配置（与原 boot-splash.js 同源）----
  var WORD = 'StockHub';
  var WORD_FS = 38;
  var WORD_W = 0.50;
  var WORD_TRACK = '0.10em';
  var WORD_MAX_PX = 430;
  var G0 = '#3B9B81', G1 = '#72D2B6';
  var MIN_TIME = 1500, HOLD = 500;
  var FONT_STACK = "'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,system-ui,sans-serif";
  var STALL_MS = 2500;             // 真值停滞阈值（自驱动爬行）
  var STEP_MS = 620;               // 每次 setProgress 的缓动时长
  var CREEP_SPEED = 14;            // 自驱动爬行速度（%/秒）

  // ---- 进度状态 ----
  var target = 0, displayed = 0, completed = false;
  var fromVal = 0, toVal = 0, tStart = 0, tDur = STEP_MS, lastTargetTime = 0;
  var startTime = 0, completeAt = 0, donePosted = false;

  // ---- 粒子 / 装饰 ----
  var TARGETS = [], particles = [], ambient = [];
  var time = 0, lastTick = 0;
  var pointer = { x: -9999, y: -9999, active: false };
  var REPEL = 58;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
  function easeInOutCubic(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function FONT() { return "'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,system-ui,sans-serif"; }
  function wordPx() { return Math.min(W * WORD_W, WORD_MAX_PX); }

  // ---------- 词标采样（粒子目标点，用 OffscreenCanvas 离屏绘制）----------
  function buildWordmark(text, N) {
    var ow = 700, oh = 300;
    var tmp = new OffscreenCanvas(ow, oh);
    var o = tmp.getContext('2d');
    o.font = "500 160px " + FONT();
    o.textAlign = 'center'; o.textBaseline = 'middle';
    if ('letterSpacing' in o) { try { o.letterSpacing = '8px'; } catch (e) {} }
    o.fillStyle = '#fff'; o.fillText(text, ow / 2, oh / 2);
    var data = o.getImageData(0, 0, ow, oh).data;
    var minX = ow, minY = oh, maxX = 0, maxY = 0; var pts = []; var step2 = 2;
    for (var y = 0; y < oh; y += step2) for (var x = 0; x < ow; x += step2) {
      if (data[(y * ow + x) * 4 + 3] > 128) {
        pts.push([x, y]);
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    var bw = maxX - minX, sc = (wordPx() / bw);
    var cxw = (minX + maxX) / 2, cyw = (minY + maxY) / 2;
    var rel = pts.map(function (p) { return [(p[0] - cxw) * sc, (p[1] - cyw) * sc]; });
    for (var k = rel.length - 1; k > 0; k--) { var j = (Math.random() * (k + 1)) | 0; var t = rel[k]; rel[k] = rel[j]; rel[j] = t; }
    TARGETS = rel.slice(0, N).map(function (p) { return [p[0] + (Math.random() - 0.5) * 2.2, p[1] + (Math.random() - 0.5) * 2.2]; });
  }

  function buildParticles() {
    buildWordmark(WORD, W >= 768 ? 1400 : 1000);
    particles.length = 0;
    TARGETS.forEach(function (tr) {
      var ang = Math.random() * Math.PI * 2, rad = 200 + Math.random() * 240, white = Math.random() < 0.30, d = 0.45 + Math.random() * 0.55;
      particles.push({
        bx: cx + Math.cos(ang) * rad, by: cyWord + Math.sin(ang) * rad,
        trx: tr[0], try: tr[1], shell: 0.9 + 0.30 * d, white: white, d: d,
        size: white ? (0.9 + Math.random() * 0.9) : (2.2 + Math.random() * 2.6),
        aVar: 0.7 + Math.random() * 0.45, rot: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 0.5,
        ax: 5 + Math.random() * 14, ay: 5 + Math.random() * 14, sx: 0.3 + Math.random() * 0.7, sy: 0.3 + Math.random() * 0.7,
        phx: Math.random() * 7, phy: Math.random() * 7, pOff: (Math.random() - 0.5) * 0.16, pScale: 0.85 + Math.random() * 0.3
      });
    });
  }

  function buildAmbient(n) {
    ambient.length = 0;
    for (var i = 0; i < n; i++) {
      ambient.push({
        x: Math.random() * W, y: 30 + Math.random() * (H - 60),
        vx: (Math.random() - 0.5) * 0.10, vy: (Math.random() - 0.5) * 0.08,
        r: 0.5 + Math.random() * 1.6, white: Math.random() < 0.4,
        ph: Math.random() * 7, tw: 0.4 + Math.random() * 1.2, a: 0.12 + Math.random() * 0.22
      });
    }
  }

  function drawAmbient() {
    for (var i = 0; i < ambient.length; i++) {
      var m = ambient[i]; m.x += m.vx; m.y += m.vy;
      if (m.x < -10) m.x = W + 10; else if (m.x > W + 10) m.x = -10;
      if (m.y < 20) m.y = H - 30; else if (m.y > H - 20) m.y = 30;
      var tw = 0.65 + 0.35 * Math.sin(time * m.tw + m.ph);
      var a = clamp(m.a * tw, 0, 0.6);
      ctx.fillStyle = m.white ? 'rgba(255,255,255,' + a + ')' : 'rgba(0,168,150,' + (a * 0.85) + ')';
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 7); ctx.fill();
    }
  }

  function convFactor(p, pt) {
    var raw = (p - 0.30 + pt.pOff) / (0.50 * pt.pScale);
    return easeInOutCubic(clamp(raw, 0, 1));
  }

  // 词标：与圆环同源渐变 + 纸雕光影
  function drawFlatWord(reveal, grow) {
    if (reveal <= 0.01) return;
    ctx.save();
    ctx.translate(cx, cyWord);
    ctx.scale(0.965 + 0.035 * grow, 0.965 + 0.035 * grow);
    ctx.globalAlpha = clamp(reveal, 0, 1);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = "400 " + WORD_FS + "px " + FONT();
    if ('letterSpacing' in ctx) { try { ctx.letterSpacing = WORD_TRACK; } catch (e) {} }
    var trackPx = WORD_FS * 0.10;
    var mw = ctx.measureText(WORD).width - trackPx;
    var k = wordPx() / mw;
    ctx.translate(trackPx * k / 2, 0);
    ctx.scale(k, k);
    var LW = mw * k, LH = WORD_FS * k;
    var g = ctx.createLinearGradient(-LW / 2, -LH / 2, LW / 2, LH / 2);
    g.addColorStop(0, G0); g.addColorStop(1, G1);
    ctx.save();
    ctx.shadowColor = 'rgba(92,118,110,0.26)'; ctx.shadowBlur = 4; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 3;
    ctx.fillStyle = g; ctx.fillText(WORD, 0, 0);
    ctx.restore();
    ctx.shadowColor = 'transparent'; ctx.fillStyle = g; ctx.fillText(WORD, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    var hg = ctx.createLinearGradient(-LW / 2, -LH / 2, LW * 0.1, LH * 0.1);
    hg.addColorStop(0, 'rgba(255,255,255,0.42)'); hg.addColorStop(0.4, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg; ctx.fillRect(-LW / 2 - 4, -LH / 2 - 4, LW + 8, LH + 8);
    ctx.restore();
    ctx.restore();
  }

  function drawLightPool(breathe) {
    var r = 150 * breathe;
    var g = ctx.createRadialGradient(cx, cyWord, 0, cx, cyWord, r);
    g.addColorStop(0, 'rgba(0,168,150,0.035)');
    g.addColorStop(0.4, 'rgba(0,168,150,0.016)');
    g.addColorStop(0.75, 'rgba(0,168,150,0.008)');
    g.addColorStop(1, 'rgba(0,168,150,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cyWord, r, 0, 7); ctx.fill();
  }

  // 🟢 v229.55：删除 v229.54 引入的 Canvas 连续进度弧（drawArc）。
  // 原因：弧从 12 点顺时针扫，而 SVG 切片从 12 点逆时针点亮——两者方向相反、永不重叠，
  // 弧永远悬在切片暗区，视觉上像「多出一根线」。进度指示以原装切片环为准，
  // 主线程冻结期间由 Canvas 数字（drawNumber）继续爬升，不再需要第二根进度线。

  // 中心数字（在 worker 线程绘制，主线程被 DataLoader 冻结时数字照常爬升，杜绝「卡在40%」）
  // 圆盘底/阴浮雕/「加载中」纸雕质感仍由 DOM .boot-center 原样渲染（worker 模式下隐藏其 DOM 数字避免重影）
  function drawNumber(p) {
    var x = cx, y = cyCenter;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // 文案「加载中」
    ctx.fillStyle = theme === 'dark' ? 'rgba(143,176,170,0.92)' : 'rgba(90,111,107,0.92)';
    ctx.font = '400 12px ' + FONT_STACK;
    ctx.fillText('加载中', x, y - 22);
    // 中心数字
    var pct = Math.round(p);
    ctx.fillStyle = theme === 'dark' ? '#7fd8c4' : '#0E4D47';
    ctx.font = '700 28px ' + FONT_STACK;
    var numW = ctx.measureText(String(pct)).width;
    var pctW = ctx.measureText('%').width;
    var totalW = numW + pctW;
    var nx = x - totalW / 2;
    ctx.fillText(String(pct), nx + numW / 2, y + 4);
    ctx.font = '400 19px ' + FONT_STACK;
    ctx.fillText('%', nx + numW + pctW / 2, y + 4);
  }

  function tick(nowArg) {
    if (killed) return;
    try {
    var now = (typeof nowArg === 'number' && isFinite(nowArg)) ? nowArg : performance.now();
    if (!lastTick) lastTick = now;
    var dt = Math.min(0.05, (now - lastTick) / 1000);
    lastTick = now;
    time = now / 1000;

    // 缓动 displayed → target
    var tn = clamp((now - tStart) / tDur, 0, 1);
    var eased = lerp(fromVal, toVal, easeOutCubic(tn));
    // 自驱动爬行：target 久未前进且未完成 → 缓慢爬向 90% 封顶（不低于 eased 避免回退）
    var stalled = (!completed && target > 0 && target < 100 && now - lastTargetTime > STALL_MS);
    if (stalled) {
      displayed = Math.max(eased, Math.min(92, displayed + CREEP_SPEED * dt));
    } else {
      displayed = eased;
    }

    // complete 收口：到 100% 后停留 HOLD → 回传 done
    if (completed && displayed >= 99.5 && !donePosted) {
      if (now - completeAt >= HOLD) { donePosted = true; self.postMessage({ type: 'done' }); }
    }

    // ---- 绘制 ----
    ctx.clearRect(0, 0, W, H);
    var p = displayed / 100;
    var gA = p > 0.94 ? clamp(1 - (p - 0.94) / 0.06, 0, 1) : 1;
    var paMul = 1 - clamp((p - 0.62) / 0.38, 0, 1) * 0.85;
    var convEnd = easeInOutCubic(clamp((p - 0.58) / 0.30, 0, 1));
    var breathe = 1 + 0.035 * Math.sin(time * 0.7);
    var breathA = 1 + 0.10 * Math.sin(time * 0.7);
    var poolSwell = 1;
    if (p > 0.88) { var bt = clamp((p - 0.88) / 0.12, 0, 1); poolSwell = 1 + 0.12 * Math.sin(bt * Math.PI); }

    drawLightPool(breathe * poolSwell);
    drawAmbient();
    drawFlatWord(convEnd, convEnd);

    for (var i = 0; i < particles.length; i++) {
      var pt = particles[i];
      var e = convFactor(p, pt);
      var wAmp = 1 - e;
      var wx = pt.bx + pt.ax * (0.6 + 0.8 * pt.d) * wAmp * Math.sin(time * pt.sx * (0.6 + 0.8 * pt.d) + pt.phx);
      var wy = pt.by + pt.ay * (0.6 + 0.8 * pt.d) * wAmp * Math.cos(time * pt.sy * (0.6 + 0.8 * pt.d) + pt.phy);
      var tx = cx + pt.trx * pt.shell, ty = cyWord + pt.try * pt.shell;
      var ang = Math.atan2(ty - wy, tx - wx);
      var sw = Math.sin(e * Math.PI) * 24;
      var sxv = Math.cos(ang + Math.PI / 2) * sw, syv = Math.sin(ang + Math.PI / 2) * sw;
      var x = wx + (tx - wx) * e + sxv, y = wy + (ty - wy) * e + syv;
      x = cx + (x - cx) * breathe; y = cyWord + (y - cyWord) * breathe;
      var pop = 0; if (e > 0.80) { var u = (e - 0.80) / 0.20; pop = Math.sin(u * Math.PI) * 0.08; }
      var ds = pt.size * (0.55 + 0.9 * pt.d) * (1 + pop);
      if (pointer.active) {
        var ddx = x - pointer.x, ddy = y - pointer.y, dd = Math.hypot(ddx, ddy);
        if (dd < REPEL && dd > 0.01) { var rf = (REPEL - dd) / REPEL * 16; x += ddx / dd * rf; y += ddy / dd * rf; }
      }
      var a = pt.aVar * (0.45 + 0.55 * pt.d) * breathA * paMul * gA;
      var aa = clamp(a * (pt.white ? 0.95 : 0.4), 0, 1);
      if (pt.white) {
        ctx.fillStyle = 'rgba(255,255,255,' + aa + ')';
        ctx.beginPath(); ctx.arc(x, y, ds, 0, 7); ctx.fill();
      } else {
        var s2 = ds; ctx.save(); ctx.translate(x, y); ctx.rotate(pt.rot + time * 0.35 * pt.spin);
        ctx.beginPath(); ctx.moveTo(0, -s2); ctx.lineTo(s2 * 0.72, 0); ctx.lineTo(0, s2); ctx.lineTo(-s2 * 0.72, 0); ctx.closePath();
        ctx.fillStyle = 'rgba(0,168,150,' + aa + ')'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,' + clamp(a * 0.5 * gA, 0, 1) + ')'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(0, -s2); ctx.lineTo(s2 * 0.72, 0); ctx.stroke();
        ctx.restore();
      }
    }

    drawNumber(displayed);

    self.postMessage({ type: 'disp', value: displayed });
    if (dbgChan) { try { dbgChan.postMessage({ t: now, disp: displayed }); } catch (e) {} }

    } catch (e) {
      // 单帧绘制异常（偶发几何/字体问题）不中断动画循环，下一帧继续
    }
    if (running) setTimeout(tick, 16);
  }

  function setTarget(v) {
    v = clamp(v, 0, 100);
    if (v === toVal) return;
    fromVal = displayed; toVal = v; tStart = performance.now(); tDur = STEP_MS;
    lastTargetTime = performance.now();
  }

  function resize(msg) {
    // 🟢 v229.51：几何尽量用传入值，缺失时回退 self（WorkerGlobalScope 有 innerWidth/Height），避免 NaN 致绘制抛错
    var w = (msg && msg.W) || self.innerWidth || 1280;
    var h = (msg && msg.H) || self.innerHeight || 800;
    if (!isFinite(w) || w < 1) w = 1280;
    if (!isFinite(h) || h < 1) h = 800;
    var ringC = h * 0.4905;
    var wordGap = w >= 768 ? 158 : 123;
    W = w; H = h; cx = w / 2; cyWord = ringC - wordGap; cyRing = ringC;
    cyCenter = h * 0.5;            // 内凹盘中心（与原 .boot-center top:50% 对齐）
    if (msg && msg.theme) theme = msg.theme === 'dark' ? 'dark' : 'light';
    dpr = (msg && msg.dpr) || Math.min(self.devicePixelRatio || 1, 2);
    if (cv) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function init(msg) {
    cv = msg.canvas;
    ctx = cv.getContext('2d');
    if (msg.dbg) { try { dbgChan = new BroadcastChannel('boot-dbg'); } catch (e) { dbgChan = null; } }
    resize(msg);
    buildParticles();
    buildAmbient(W >= 768 ? 130 : 84);
    startTime = performance.now();
    lastTargetTime = startTime;
    lastTick = 0;
    running = true; killed = false;
    tick(performance.now());
  }

  self.onmessage = function (ev) {
    var m = ev.data || {};
    switch (m.type) {
      case 'init': init(m); break;
      case 'resize': resize(m); if (!running) { running = true; tick(performance.now()); } break;
      case 'target': setTarget(m.value); break;
      case 'complete':
        if (completed) break;
        completed = true;
        var el = performance.now() - startTime;
        var wait = Math.max(0, MIN_TIME - el);   // 最小展示时长（worker 端处理）
        setTimeout(function () {
          completeAt = performance.now();
          setTarget(100);
        }, wait);
        break;
      case 'pointer': pointer.x = m.x; pointer.y = m.y; pointer.active = !!m.active; break;
      case 'kill': killed = true; running = false; break;
    }
  };
})();
