/* ============================================================
 * BootSplash —— 工作台启动加载屏（设计预览：粒子汇聚 StockHub + 纸雕圆环）
 *  · 绑定真实启动进度：loadingProgress(0-100) 由 App._bootData 各里程碑驱动
 *  · 24 切片 SVG 圆环：activeSlices = round(progress/100*24)，index<active 即青色
 *  · 中心数字实时显示整数 + 百分号
 *  · CSS 变量 --progress 驱动底部进度线 + conic-gradient 连续进度环
 *  · 平滑：ease-out 缓动 + 最小展示 1.5s + 卡顿兜底（真值停滞时视觉爬行）
 *  · 100% 后圆盘全亮 → 等待 0.5s → 平滑淡出 → 回调揭示工作台
 * 暴露：window.BootSplash { start, setProgress, complete }
 * ============================================================ */
(function () {
  'use strict';
  var BootSplash = (function () {
    // ---------- 配置 ----------
    var N_RING = 24;                 // 切片总数
    var N_RING_CX = 134, N_RING_CY = 134, R_OUT = 126, R_IN = 92, GAP = 4.0;  // 与设计原型逐参数一致（viewBox 268）
    var WORD = 'StockHub';
    var WORD_FS = 38;
    var WORD_W = 0.50;               // 占屏宽比例（与粒子目标一致）
    var WORD_TRACK = '0.10em';
    var G0 = '#3B9B81', G1 = '#72D2B6';   // 词标渐变（与圆环同源）
    var C0 = [74, 166, 142], C1 = [114, 210, 182]; // 切片位置渐变（深→浅）
    var MIN_TIME = 1500;             // 最小展示时长
    var HOLD = 500;                  // 100% 后停留
    var FADE = 520;                  // 淡出时长
    var STALL_MS = 2500;             // 真值停滞阈值（兜底爬行）
    var STEP_MS = 620;               // 每次 setProgress 的缓动时长

    // ---------- 状态 ----------
    var root = null, ringSvg = null, ringProg = null, numEl = null, pctEl = null, cv = null, ctx = null, worker = null;
    var started = false, completed = false, fading = false, useWorker = false;
    var loadingProgress = 0;         // 真值目标（0-100），由外部里程碑驱动
    var displayed = 0;               // 缓动显示值（0-100）
    var fromVal = 0, toVal = 0, tStart = 0, tDur = STEP_MS;
    var startTime = 0, lastUpdate = 0, rafId = 0, onDone = null;
    var W = 0, H = 0, cx = 0, cy = 0, cyWord = 0, cyRing = 0, dpr = 1;
    var TARGETS = [], particles = [], ambient = [], ringCells = [], subIdx = 0;
    var time = 0, subTxt = null, subs = ['正在汇聚你的工作台', '正在整理你的货架', '正在唤醒你的数据', '正在校准你的库存'];
    // 🟢 v229.45：鼠标扰动（与原型一致 REPEL=58；事件绑在 root 上——canvas 为 pointer-events:none）
    var pointer = { x: -9999, y: -9999, active: false };
    var REPEL = 58;

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
    function easeOutCubic(x) { return 1 - Math.pow(1 - x, 3); }
    function easeInOutCubic(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
    function lerp(a, b, t) { return a + (b - a) * t; }
    function lerpC(t) {
      return 'rgb(' + Math.round(lerp(C0[0], C1[0], t)) + ',' + Math.round(lerp(C0[1], C1[1], t)) + ',' + Math.round(lerp(C0[2], C1[2], t)) + ')';
    }
    function FONT() { return "'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,system-ui,sans-serif"; }
    // 🟢 v229.45：词标渲染宽度——移动端沿用原型 W*0.50；PC 宽屏 clamp 到 430px（否则 0.50*1920=960px
    //   会把字母放大到与圆环接触、且 1000 粒子摊薄显空旷）。粒子目标与 flatWord 绘制共用同一宽度。
    var WORD_MAX_PX = 430;
    function wordPx() { return Math.min(W * WORD_W, WORD_MAX_PX); }

    // ---------- 几何：24 个纸雕切片（与设计原型逐参数一致：单点光源 + 边缘内阴影 + 位置渐变）----------
    function buildRing() {
      // 复用 index.html 内联的环骨架：仅收集点亮格，避免运行时重建造成首帧闪烁/重排
      var inlineOn = ringSvg.querySelector('.boot-ring-on');
      if (inlineOn) {
        ringCells = [];
        var sl = inlineOn.querySelectorAll('.boot-slice');
        for (var k = 0; k < sl.length; k++) ringCells.push(sl[k]);
        return;
      }
      var NS = 'http://www.w3.org/2000/svg';
      var CX = N_RING_CX, CY = N_RING_CY;
      var LX = 82, LY = -59, D_NEAR = 91, D_FAR = 309;   // 单点光源：环外 10~11 点钟方向的屏幕前方
      var defs = document.createElementNS(NS, 'defs');
      // 点光源辐射：距光源越近整体越白，远端微微回落（与原型 gLight 相同）
      var gLight = document.createElementNS(NS, 'radialGradient');
      gLight.setAttribute('id', 'bootGLight');
      gLight.setAttribute('gradientUnits', 'userSpaceOnUse');
      gLight.setAttribute('cx', '82'); gLight.setAttribute('cy', '-59'); gLight.setAttribute('r', '330');
      var stops = [[0, 0.95], [0.42, 0.55], [0.74, 0.14], [1, 0]];
      for (var s = 0; s < stops.length; s++) {
        var st = document.createElementNS(NS, 'stop');
        st.setAttribute('offset', stops[s][0]);
        st.setAttribute('stop-color', '#FFFFFF');
        st.setAttribute('stop-opacity', stops[s][1]);
        gLight.appendChild(st);
      }
      defs.appendChild(gLight);
      // 边缘阴影柔化
      var rim = document.createElementNS(NS, 'filter');
      rim.setAttribute('id', 'bootRimSoft');
      rim.setAttribute('x', '-60%'); rim.setAttribute('y', '-60%'); rim.setAttribute('width', '220%'); rim.setAttribute('height', '220%');
      var blur = document.createElementNS(NS, 'feGaussianBlur');
      blur.setAttribute('stdDeviation', '1.0');
      rim.appendChild(blur);
      defs.appendChild(rim);
      ringSvg.appendChild(defs);

      var polar = function (r, d) { var a = d * Math.PI / 180; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; };
      var seg = function (a0, a1) {
        var x0 = polar(R_OUT, a0), x1 = polar(R_OUT, a1), x2 = polar(R_IN, a1), x3 = polar(R_IN, a0);
        var lg1 = (a1 - a0) > 180 ? 1 : 0;
        return 'M' + x0[0] + ' ' + x0[1] + ' A' + R_OUT + ' ' + R_OUT + ' 0 ' + lg1 + ' 1 ' + x1[0] + ' ' + x1[1] +
               ' L' + x2[0] + ' ' + x2[1] + ' A' + R_IN + ' ' + R_IN + ' 0 ' + lg1 + ' 0 ' + x3[0] + ' ' + x3[1] + ' Z';
      };
      var mk = function (t, at) { var e = document.createElementNS(NS, t); for (var k in at) e.setAttribute(k, at[k]); return e; };
      var ringOff = mk('g', {}), ringOn = mk('g', {});
      var step = 360 / N_RING, span = step - GAP;
      for (var i = 0; i < N_RING; i++) {
        var a0 = -90 - (i + 1) * step + GAP / 2, a1 = a0 + span;
        // 每格独立 clip：内阴影只落在格子内部，不脏化格间缝隙
        var cp = mk('clipPath', { id: 'bootCellClip' + i });
        cp.appendChild(mk('path', { d: seg(a0, a1) }));
        defs.appendChild(cp);
        // 空格：单一全局光源铺满全环（顶面受白、底面背光）
        var og = mk('g', { 'clip-path': 'url(#bootCellClip' + i + ')' });
        og.appendChild(mk('path', { d: seg(a0, a1), fill: '#F4F7F6' }));
        og.appendChild(mk('path', { d: seg(a0, a1), fill: 'url(#bootGLight)' }));
        // 凹陷：阴影只沿"光源→格子"射线落在背光侧内壁上，不让格子内部发灰
        var mid = polar((R_OUT + R_IN) / 2, (a0 + a1) / 2);
        var vx = mid[0] - LX, vy = mid[1] - LY, vd = Math.hypot(vx, vy) || 1;
        var dn = Math.max(0, Math.min(1, (vd - D_NEAR) / (D_FAR - D_NEAR)));
        var op = (0.06 + 0.11 * dn).toFixed(3), sw = (1.8 + 0.8 * dn).toFixed(2), off = 2.4 + 1.6 * dn;
        og.appendChild(mk('path', { d: seg(a0, a1), fill: 'none', stroke: 'rgba(51,65,85,' + op + ')', 'stroke-width': sw, 'stroke-linejoin': 'round', transform: 'translate(' + (vx / vd * off).toFixed(2) + ',' + (vy / vd * off).toFixed(2) + ')', filter: 'url(#bootRimSoft)' }));
        ringOff.appendChild(og);
        // 点亮格：位置渐变纯平色块，同色 3px 描边让格子连续成环（零滤镜零高光零投影）
        var col = lerpC(i / (N_RING - 1));
        var g = mk('g', { 'class': 'boot-slice' });
        g.appendChild(mk('path', { d: seg(a0, a1), fill: col, stroke: col, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
        ringOn.appendChild(g);
        ringCells.push(g);
      }
      ringSvg.appendChild(ringOff);
      ringSvg.appendChild(ringOn);
    }

    function syncRing() {
      var active = Math.round(displayed / 100 * N_RING);
      for (var i = 0; i < N_RING; i++) {
        var on = i < active;
        if (ringCells[i].classList.contains('on') !== on) {
          if (on) ringCells[i].classList.add('on'); else ringCells[i].classList.remove('on');
        }
      }
      var pct = Math.round(displayed);
      if (numEl) numEl.textContent = pct;
      if (pctEl) pctEl.textContent = '%';
      if (root) root.style.setProperty('--progress', displayed.toFixed(2) + '%');
    }

    // ---------- 词标采样（粒子目标点）----------
    function buildWordmark(text, N) {
      var ow = 700, oh = 300;
      var tmp = document.createElement('canvas'); tmp.width = ow; tmp.height = oh;
      var o = tmp.getContext('2d');
      o.font = "500 160px " + FONT();
      o.textAlign = 'center'; o.textBaseline = 'middle';
      if ('letterSpacing' in o) o.letterSpacing = '8px';
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
      // 🟢 v229.45：PC 宽屏粒子加密（1000→1400），配合词宽 clamp 后不再空旷
      buildWordmark(WORD, W >= 768 ? 1400 : 1000);
      particles.length = 0;
      TARGETS.forEach(function (tr) {
        var ang = Math.random() * Math.PI * 2, rad = 200 + Math.random() * 240, white = Math.random() < 0.30, d = 0.45 + Math.random() * 0.55;
        particles.push({
          bx: cx + Math.cos(ang) * rad, by: cy + Math.sin(ang) * rad,
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

    // 词标：与圆环同源渐变 + 纸雕光影（左上内高光 / 右下柔影）
    function drawFlatWord(reveal, grow) {
      if (reveal <= 0.01) return;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(0.965 + 0.035 * grow, 0.965 + 0.035 * grow);
      ctx.globalAlpha = clamp(reveal, 0, 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = "400 " + WORD_FS + "px " + FONT();
      if ('letterSpacing' in ctx) ctx.letterSpacing = WORD_TRACK;
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

    // 中央光池（与原型一致：随呼吸微涨缩，收口时隆起）
    function drawLightPool(breathe) {
      var r = 150 * breathe;
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(0,168,150,0.035)');
      g.addColorStop(0.4, 'rgba(0,168,150,0.016)');
      g.addColorStop(0.75, 'rgba(0,168,150,0.008)');
      g.addColorStop(1, 'rgba(0,168,150,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    }

    function frame(now) {
      time = now / 1000;
      // 缓动推进 displayed → loadingProgress
      var tn = clamp((now - tStart) / tDur, 0, 1);
      displayed = lerp(fromVal, toVal, easeOutCubic(tn));
      // 卡顿兜底：真值长时间未推进且未到 100 → 视觉爬行到 95 封顶（等待真实收口）
      if (!completed && loadingProgress < 100 && now - lastUpdate > STALL_MS) {
        var creep = Math.min(95, lerp(loadingProgress, 95, 0.4));
        if (creep > loadingProgress + 0.5) setTarget(creep);
      }
      syncRing();

      var p = displayed / 100;
      var gA = p > 0.94 ? clamp(1 - (p - 0.94) / 0.06, 0, 1) : 1;
      var paMul = 1 - clamp((p - 0.62) / 0.38, 0, 1) * 0.85;        // 粒子就位后平滑淡为微光
      var convEnd = easeInOutCubic(clamp((p - 0.58) / 0.30, 0, 1)); // 0.58→0.88，字随粒子落位同步成形
      var breathe = 1 + 0.018 * Math.sin(time * 0.55);
      var breathA = 1 + 0.06 * Math.sin(time * 0.55);
      var poolSwell = 1;
      if (p > 0.88) { var bt = clamp((p - 0.88) / 0.12, 0, 1); poolSwell = 1 + 0.12 * Math.sin(bt * Math.PI); }

      ctx.clearRect(0, 0, W, H);
      drawLightPool(breathe * poolSwell);
      drawAmbient();
      drawFlatWord(convEnd, convEnd);

      for (var i = 0; i < particles.length; i++) {
        var pt = particles[i];
        var e = convFactor(p, pt);
        var wAmp = 1 - e;
        var wx = pt.bx + pt.ax * (0.6 + 0.8 * pt.d) * wAmp * Math.sin(time * pt.sx * (0.6 + 0.8 * pt.d) + pt.phx);
        var wy = pt.by + pt.ay * (0.6 + 0.8 * pt.d) * wAmp * Math.cos(time * pt.sy * (0.6 + 0.8 * pt.d) + pt.phy);
        var tx = cx + pt.trx * pt.shell, ty = cy + pt.try * pt.shell;
        var ang = Math.atan2(ty - wy, tx - wx);
        var sw = Math.sin(e * Math.PI) * 24;
        var sxv = Math.cos(ang + Math.PI / 2) * sw, syv = Math.sin(ang + Math.PI / 2) * sw;
        var x = wx + (tx - wx) * e + sxv, y = wy + (ty - wy) * e + syv;
        x = cx + (x - cx) * breathe; y = cy + (y - cy) * breathe;
        var pop = 0; if (e > 0.80) { var u = (e - 0.80) / 0.20; pop = Math.sin(u * Math.PI) * 0.08; }
        var ds = pt.size * (0.55 + 0.9 * pt.d) * (1 + pop);
        // 🟢 v229.45：鼠标扰动——REPEL 半径内径向推开（与原型 f=(REPEL-d)/REPEL*16 同手感）
        if (pointer.active) {
          var ddx = x - pointer.x, ddy = y - pointer.y, dd = Math.hypot(ddx, ddy);
          if (dd < REPEL && dd > 0.01) { var rf = (REPEL - dd) / REPEL * 16; x += ddx / dd * rf; y += ddy / dd * rf; }
        }
        var a = pt.aVar * (0.45 + 0.55 * pt.d) * breathA * paMul * gA;
        var aa = clamp(a * (pt.white ? 0.95 : 0.4), 0, 1);
        if (pt.white) { ctx.fillStyle = 'rgba(255,255,255,' + aa + ')'; ctx.beginPath(); ctx.arc(x, y, ds, 0, 7); ctx.fill(); }
        else {
          var s2 = ds; ctx.save(); ctx.translate(x, y); ctx.rotate(pt.rot + time * 0.2 * pt.spin);
          ctx.beginPath(); ctx.moveTo(0, -s2); ctx.lineTo(s2 * 0.72, 0); ctx.lineTo(0, s2); ctx.lineTo(-s2 * 0.72, 0); ctx.closePath();
          ctx.fillStyle = 'rgba(0,168,150,' + aa + ')'; ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,' + clamp(a * 0.5 * gA, 0, 1) + ')'; ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(0, -s2); ctx.lineTo(s2 * 0.72, 0); ctx.stroke();
          ctx.restore();
        }
      }
      rafId = requestAnimationFrame(frame);
    }

    function setTarget(v) {
      v = clamp(v, 0, 100);
      if (v === toVal) return;
      fromVal = displayed; toVal = v; tStart = performance.now(); tDur = STEP_MS;
      lastUpdate = performance.now();
    }

    // ---------- 对外接口 ----------
    function start(opts) {
      if (started) return;
      opts = opts || {};
      onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
      MIN_TIME = opts.minTime || MIN_TIME;
      root = document.getElementById('bootSplash');
      if (!root) return;
      cv = document.getElementById('bootSplashCanvas');
      ringSvg = document.getElementById('bootRingSvg');
      numEl = document.getElementById('bootNum');
      pctEl = document.getElementById('bootPct');
      subTxt = document.getElementById('bootSubTxt');
      if (!cv || !ringSvg) return;
      // 🟢 v229.51：优先把画布转交 Web Worker（OffscreenCanvas），粒子/环/数字在独立线程绘制，
      //   主线程被 DataLoader.init 同步重活阻塞时动画也不冻结；进度自驱动消除「跳-停-冲」。
      try {
        if (typeof Worker !== 'undefined' && cv.transferControlToOffscreen) {
          var off = cv.transferControlToOffscreen();
          worker = new Worker('js/boot-canvas-worker.js?v=229.56');
          worker.onmessage = onWorkerMsg;
          worker.onerror = function () {
            // worker 加载/运行失败（如离线且未缓存）：终止并强制收尾，避免启动屏永久卡住
            try { worker.terminate(); } catch (e) {}
            worker = null; useWorker = false; completed = true;
            fadeOut();
          };
          useWorker = true;
          root.classList.add('worker-mode');   // 标记走 worker 渲染（CSS 不再隐藏圆环/圆盘，均为原装 DOM/SVG）
          var geo0 = computeGeo();
          worker.postMessage({
            type: 'init', canvas: off,
            dpr: geo0.dpr, W: geo0.W, H: geo0.H, cx: geo0.cx, cyWord: geo0.cyWord, cyRing: geo0.cyRing,
            theme: currentTheme()
          }, [off]);
        } else {
          ctx = cv.getContext('2d');
        }
      } catch (e) {
        worker = null; useWorker = false;
        try { ctx = cv.getContext('2d'); } catch (e2) {}
      }
      resize();
      buildRing();   // 🟢 v229.51 圆盘恢复：始终构建/收集剪纸环切片（worker 模式也需按进度点亮 .boot-slice）
      if (!useWorker) {
        buildParticles();
        buildAmbient(W >= 768 ? 130 : 84);
      }
      started = true; completed = false; fading = false;
      loadingProgress = 0; displayed = 0; fromVal = 0; toVal = 0;
      startTime = performance.now(); lastUpdate = startTime;
      root.classList.add('is-active');
      window.__bootSplashStarted = true;   // 供 index.html 兜底脚本判断 JS 是否已接管
      var legacy = document.getElementById('loadingOverlay');
      if (legacy) legacy.style.display = 'none';
      if (subTxt) subTxt.textContent = subs[0];
      if (!useWorker) rafId = requestAnimationFrame(frame);
      // 兜底：若外部始终未调用 complete（异常链路），最长 14s 强制收尾，避免永久卡在启动屏
      if (BootSplash._failTimer) clearTimeout(BootSplash._failTimer);
      BootSplash._failTimer = setTimeout(function () {
        if (!completed) { try { console.warn('[BootSplash] 14s 未收口，强制完成'); } catch (e) {} forceComplete(); }
      }, 14000);
      // 视口变化（旋转 / 地址栏收展）时重排画布与装饰位置
      window.addEventListener('resize', function () {
        if (!started || fading) return;
        resize();
      });
      // 副文案轮换
      if (BootSplash._subTimer) clearInterval(BootSplash._subTimer);
      BootSplash._subTimer = setInterval(function () {
        subIdx = (subIdx + 1) % subs.length;
        if (subTxt) { subTxt.style.opacity = 0; setTimeout(function () { subTxt.textContent = subs[subIdx]; subTxt.style.opacity = 1; }, 400); }
      }, 3800);
      // 🟢 v229.45：鼠标扰动监听（绑 root——canvas pointer-events:none 收不到事件；坐标即画布坐标，canvas 全屏铺满）
      if (!BootSplash._pointerBound) {
        BootSplash._pointerBound = true;
        root.addEventListener('pointermove', function (e) {
          pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true;
          if (useWorker && worker) worker.postMessage({ type: 'pointer', x: e.clientX, y: e.clientY, active: true });
        });
        root.addEventListener('pointerleave', function () {
          pointer.active = false;
          if (useWorker && worker) worker.postMessage({ type: 'pointer', x: -9999, y: -9999, active: false });
        });
      }
    }

    // 🟢 v229.53：读取当前主题（深色模式数字配色不同），传给 Worker 绘制中心数字
    function currentTheme() {
      try {
        var t = (document.documentElement && document.documentElement.getAttribute('data-theme')) || '';
        return t === 'dark' ? 'dark' : 'light';
      } catch (e) { return 'light'; }
    }

    function computeGeo() {
      var W = window.innerWidth, H = window.innerHeight;
      var ringC = H * 0.4905;                                  // 圆环中心（与原型 414/844 一致）
      var wordGap = W >= 768 ? 158 : 123;
      return { W: W, H: H, dpr: Math.min(window.devicePixelRatio || 1, 2), cx: W / 2, cyWord: ringC - wordGap, cyRing: ringC };
    }
    function resize() {
      var g = computeGeo();
      W = g.W; H = g.H; dpr = g.dpr; cx = g.cx; cyWord = g.cyWord; cyRing = g.cyRing;
      cy = cyWord;   // 主线程 fallback 绘制基准（粒子/词标/光池中心），与 worker 路径一致
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      if (root) {
        root.style.setProperty('--cx', cx + 'px');
        root.style.setProperty('--cy', cyWord + 'px');
        root.style.setProperty('--cy-ring', cyRing + 'px');
        root.style.setProperty('--cy-sub', (cyRing + 142) + 'px');   // 副文案（原型 556-414=142）
        root.style.setProperty('--cy-bottom', (H - 82) + 'px');     // 底部装饰（原型 844-762=82）
      }
      if (useWorker) {
        if (worker) worker.postMessage({ type: 'resize', W: W, H: H, dpr: dpr, cx: cx, cyWord: cyWord, cyRing: cyRing, theme: currentTheme() });
      } else {
        cv.width = W * dpr; cv.height = H * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        buildAmbient(W >= 768 ? 130 : 84);
        if (!completed && displayed < 50) buildParticles();
      }
    }

    function setProgress(p) {
      if (!started || completed) return;
      loadingProgress = clamp(p, 0, 100);
      if (useWorker) { if (worker) worker.postMessage({ type: 'target', value: loadingProgress }); }
      else { setTarget(loadingProgress); }
    }

    function complete() {
      if (!started || completed) return;
      completed = true;
      loadingProgress = 100;
      if (useWorker) {
        if (worker) worker.postMessage({ type: 'complete' });
        // 🟢 v229.51：最小展示时长与收口由 worker 端处理（init 时记录 startTime）
      } else {
        var elapsed = performance.now() - startTime;
        var wait = Math.max(0, MIN_TIME - elapsed);
        setTimeout(function () {
          setTarget(100);
          setTimeout(function () { fadeOut(); }, HOLD + 120);
        }, wait);
      }
    }

    // 🟢 v229.51：异常兜底——不依赖 worker 回传，直接收尾淡出（worker 崩溃/离线未缓存时防卡死）
    function forceComplete() {
      if (completed) return;
      completed = true;
      loadingProgress = 100;
      fadeOut();
    }

    function fadeOut() {
      if (fading) return; fading = true;
      window.__bootSplashDone = true;
      if (BootSplash._failTimer) { clearTimeout(BootSplash._failTimer); BootSplash._failTimer = null; }
      if (worker) { try { worker.postMessage({ type: 'kill' }); worker.terminate(); worker = null; } catch (e) {} }
      if (root) root.classList.add('is-leaving');
      if (BootSplash._subTimer) { clearInterval(BootSplash._subTimer); BootSplash._subTimer = null; }
      setTimeout(function () {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (root) root.classList.remove('is-active', 'is-leaving');
        if (root) root.style.display = 'none';
        // 旧遮罩保持隐藏：LoadingHUD.show() 需要时会自行设 display='flex'，
        // 这里若恢复 '' 会让旧 spinner 页在启动屏淡出瞬间复活、盖住工作台
        var legacy = document.getElementById('loadingOverlay');
        if (legacy) legacy.style.display = 'none';
        if (typeof onDone === 'function') { try { onDone(); } catch (e) {} }
      }, FADE + 60);
    }

    // 🟢 v229.51：接收 Worker 回传（done / 实时进度）
    function onWorkerMsg(e) {
      var m = (e && e.data) || {};
      if (m.type === 'done') { fadeOut(); return; }
      if (m.type === 'disp') {
        displayed = m.value;
        if (root) root.style.setProperty('--progress', m.value.toFixed(2) + '%');
        syncRing();   // 🟢 v229.53：点亮 SVG 剪纸切片 + 更新原装 DOM 圆盘数字
      }
    }

    // 兜底：若外部始终未调用 complete（异常链路），最长 14s 强制收尾
    return { start: start, setProgress: setProgress, complete: complete };
  })();

  window.BootSplash = BootSplash;

  // 自动启动（DOM 就绪即可，defer 保证早于 App.init）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { BootSplash.start(); });
  } else {
    BootSplash.start();
  }
})();
