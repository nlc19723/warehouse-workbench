// ============================================
// 模块 C：工作台内「扫一扫」（WebRTC + jsQR / BarcodeDetector / ZXing）
// 流程：点顶部扫一扫图标 → 摄像头取流 → 逐帧解码 → 得到存货编码
//      → 校验本地是否存在该编码 → App.openEntity('stock', code) 直达档案页
// 前提：getUserMedia 需 HTTPS（移动版已具备）；非 HTTPS/localhost 会给出明确提示
// ============================================
//
// 🟢 设计要点：
//   1) 后置摄像头优先（facingMode: environment），适合仓库现场扫码
//   2) 二维码：jsQR 逐帧解码（2D 码开销可控）
//   3) 条形码（1D）：节流解码（约 4~5 fps），1D 解码 CPU 重，逐帧跑会烫手
//      - 首选浏览器原生 BarcodeDetector（Android Chrome，硬件加速、零下载）
//      - 无原生支持（iOS Safari 等）时按需懒加载 lib/zxing.min.js（不打开扫一扫就不下载）
//   4) 同一编码 2 秒内防抖，避免重复触发跳转
//   5) 扫到编码先查本地库存：命中才跳档案，未命中给兜底提示（不跳空页）
// ============================================

(function () {
  let active = false;
  let stream = null;
  let rafId = null;
  let overlayEl = null;
  let offCanvas = null;      // 二维码解码：原尺寸
  let barCanvas = null;      // 条形码解码：裁中部横带 + 缩放
  let lastHit = { code: '', t: 0 };
  let lastBarTry = 0;
  let barBusy = false;

  // —— 条形码解码器（懒加载，避免不开扫码也下载 300KB）——
  let nativeDetector;        // undefined = 未探测；null = 不支持
  let zxingPromise = null;
  let zxingReader = null;
  let zxingHints = null;

  const BAR_TRY_MS = 220;    // 条形码解码节流间隔（≈4.5 fps）
  const BAR_MAX_W = 960;     // 条形码解码帧最大宽度（保横向分辨率，1D 码靠横向细节）
  const BAR_BAND = 0.56;     // 只取画面中部 56% 高度的水平带（覆盖取景框、减少像素量）

  const BAR_FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'codabar', 'itf'];

  // jsQR 的 UMD 可能挂 window.jsQR（对象，含 default）或直接就是函数
  function getQRDecoder() {
    if (typeof window.jsQR === 'function') return window.jsQR;
    if (window.jsQR && typeof window.jsQR.default === 'function') return window.jsQR.default;
    return null;
  }

  // 原生 BarcodeDetector：不支持的格式列表会让构造抛错，逐级降级
  function getNativeDetector() {
    if (nativeDetector !== undefined) return nativeDetector;
    const Ctor = window.BarcodeDetector;
    if (!Ctor) { nativeDetector = null; return null; }
    const candidates = [BAR_FORMATS, ['code_128', 'code_39', 'ean_13'], null];
    for (const fmts of candidates) {
      try {
        nativeDetector = fmts ? new Ctor({ formats: fmts }) : new Ctor();
        return nativeDetector;
      } catch (_) { nativeDetector = null; }
    }
    return null;
  }

  function loadZXing() {
    if (zxingPromise) return zxingPromise;
    zxingPromise = new Promise((resolve, reject) => {
      if (window.ZXing) { resolve(window.ZXing); return; }
      const s = document.createElement('script');
      s.src = 'lib/zxing.min.js?v=1';
      s.async = true;
      s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error('条形码解码库已下载但未挂载')));
      s.onerror = () => reject(new Error('条形码解码库加载失败'));
      document.head.appendChild(s);
    }).then((Z) => {
      try {
        const reader = new Z.MultiFormatReader();
        const F = Z.BarcodeFormat;
        const hints = new Map();
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
          F.CODE_128, F.CODE_39, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODABAR, F.ITF
        ]);
        zxingReader = reader;
        zxingHints = hints;
      } catch (e) {
        console.warn('[QRScan] ZXing 初始化失败：', e);
      }
      return Z;
    });
    return zxingPromise;
  }

  function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'qrScanOverlay';
    el.className = 'qr-scan-overlay';
    el.innerHTML =
      '<video class="qr-scan-video" id="qrScanVideo" playsinline muted autoplay></video>' +
      '<div class="qr-scan-mask">' +
      '<div class="qr-scan-frame">' +
      '<i class="qr-corner tl"></i><i class="qr-corner tr"></i>' +
      '<i class="qr-corner bl"></i><i class="qr-corner br"></i>' +
      '<div class="qr-scan-line"></div>' +
      '</div>' +
      '</div>' +
      '<div class="qr-scan-tip" id="qrScanTip">对准存货二维码或条形码</div>' +
      '<div class="qr-scan-bottom"><button class="qr-scan-cancel" type="button" id="qrScanCancel">取消</button></div>';
    document.body.appendChild(el);
    return el;
  }

  function setTip(text) {
    const tip = overlayEl && overlayEl.querySelector('#qrScanTip');
    if (tip) tip.textContent = text;
  }

  async function startCamera() {
    const video = overlayEl.querySelector('#qrScanVideo');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      setTip('对准存货二维码或条形码');
      tick();
    } catch (e) {
      const name = (e && e.name) || '';
      const notSecure = window.location.protocol !== 'https:' &&
        window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setTip('摄像头权限被拒绝，请在浏览器设置中允许后重试');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        setTip('未检测到可用摄像头设备');
      } else if (notSecure) {
        setTip('当前为 HTTP 访问，浏览器禁止调用摄像头，请改用 HTTPS 打开');
      } else {
        setTip('无法打开摄像头：' + (e && e.message ? e.message : '未知错误'));
      }
      console.warn('[QRScan] getUserMedia failed:', e);
    }
  }

  // 🟢 关键坑：@zxing/library 0.21 的 RGBLuminanceSource 传 Uint8ClampedArray 时
  //   内部取的是「每字节一个亮度」，getRow() 会整行返回 255（全白）→ 永远解码不出。
  //   必须传 Int32Array（每像素一个 32 位 ARGB 打包值）才走正确的分支。
  //   用 (buffer, byteOffset, length) 零拷贝构造，避免每帧复制 4 倍内存。
  function toInt32(rgba) {
    return new Int32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  }

  // 条形码专用取帧：裁中部横带（1D 码是细长条）+ 限制宽度，返回 canvas 与 ImageData
  function grabBarcodeFrame(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const bandH = Math.max(80, Math.round(vh * BAR_BAND));
    const sy = Math.round((vh - bandH) / 2);
    const scale = Math.min(1, BAR_MAX_W / vw);
    const dw = Math.max(1, Math.round(vw * scale));
    const dh = Math.max(1, Math.round(bandH * scale));
    if (!barCanvas) barCanvas = document.createElement('canvas');
    barCanvas.width = dw;
    barCanvas.height = dh;
    const ctx = barCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, sy, vw, bandH, 0, 0, dw, dh);
    return { canvas: barCanvas, imageData: ctx.getImageData(0, 0, dw, dh), w: dw, h: dh };
  }

  async function tryBarcode(video) {
    if (barBusy || !active) return;
    barBusy = true;
    try {
      const frame = grabBarcodeFrame(video);
      if (!frame) return;

      // ① 原生 BarcodeDetector（Android Chrome 等）
      const det = getNativeDetector();
      if (det) {
        try {
          const list = await det.detect(frame.canvas);
          if (list && list.length) {
            const txt = String(list[0].rawValue || '').trim();
            if (txt) { onDetected(txt); return; }
          }
        } catch (_) { /* 单帧解码异常忽略 */ }
      }

      // ② ZXing 兜底（iOS Safari 等无原生支持的浏览器，按需加载）
      if (!zxingReader) {
        setTip('正在加载条形码解码组件...');
        await loadZXing().catch(() => null);
        if (active) setTip('对准存货二维码或条形码');
      }
      const txt = decodeWithZXing(frame.imageData, frame.w, frame.h);
      if (txt) onDetected(txt);
    } finally {
      barBusy = false;
    }
  }

  // 用 ZXing 解 1D 条码；未命中返回 null（NotFoundException 属于正常情况，不打日志）
  function decodeWithZXing(imageData, w, h) {
    if (!zxingReader || !window.ZXing) return null;
    try {
      const Z = window.ZXing;
      const src = new Z.RGBLuminanceSource(toInt32(imageData.data), w, h);
      const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
      const res = zxingReader.decode(bitmap, zxingHints);
      const txt = res ? String(res.getText ? res.getText() : (res.text || '')).trim() : '';
      return txt || null;
    } catch (_) { return null; }
  }

  function tick() {
    if (!active || !overlayEl) return;
    const video = overlayEl.querySelector('#qrScanVideo');
    if (video && video.readyState >= video.HAVE_ENOUGH_DATA) {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        if (!offCanvas) offCanvas = document.createElement('canvas');
        offCanvas.width = w; offCanvas.height = h;
        const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);

          // ① 二维码：jsQR 逐帧
          const dec = getQRDecoder();
          if (dec) {
            let res = null;
            try {
              res = dec(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            } catch (_) { /* 单帧解码异常忽略，继续下一帧 */ }
            if (res && res.data) { onDetected(String(res.data).trim()); return; }
          }

          // ② 条形码：节流
          const now = Date.now();
          if (now - lastBarTry >= BAR_TRY_MS) {
            lastBarTry = now;
            tryBarcode(video);
          }
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  async function onDetected(code) {
    const now = Date.now();
    if (code && code === lastHit.code && now - lastHit.t < 2000) {
      rafId = requestAnimationFrame(tick); // 防抖：同一编码 2s 内不重复处理
      return;
    }
    lastHit = { code, t: now };
    if (!code) { rafId = requestAnimationFrame(tick); return; }

    setTip('识别成功，正在校验...');
    try {
      const stocks = await DataStore.getStock();
      const hit = (stocks || []).some(s => String((s && s.存货编码) || '').trim() === code);
      close();
      if (hit) {
        App.openEntity('stock', code); // 与点击列表存货编码链接完全同一条跳转管线
      } else {
        WBModal.alert('未找到存货编码：' + code + '\n请确认该二维码/条形码对应本工作台的存货编码。');
      }
    } catch (e) {
      close();
      WBModal.alert('校验存货编码失败：' + ((e && e.message) || e));
    }
  }

  function close() {
    active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (stream) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      stream = null;
    }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    barBusy = false;
    lastBarTry = 0;
  }

  async function open() {
    if (active) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      WBModal.alert('当前环境不支持摄像头扫码。\n请使用 HTTPS 访问工作台，或在手机浏览器中打开。');
      return;
    }
    // 二维码走 jsQR；条形码走原生 BarcodeDetector 或 ZXing（两者都没有才提示刷新）
    if (!getQRDecoder() && !getNativeDetector() && !window.ZXing) {
      WBModal.alert('扫码组件尚未加载完成，请刷新页面后重试');
      return;
    }
    active = true;
    lastHit = { code: '', t: 0 };
    lastBarTry = 0;
    barBusy = false;
    overlayEl = buildOverlay();
    const cancelBtn = overlayEl.querySelector('#qrScanCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', close);
    // 无原生条形码能力时，提前把 ZXing 拉下来，避免用户第一次扫条码时干等
    if (!getNativeDetector()) loadZXing().catch(() => {});
    await startCamera();
  }

  // _loadZXing / _decodeBarcode 为自检钩子（供自动化验证直接跑生产解码代码）
  window.QRScan = { open, close, _loadZXing: loadZXing, _decodeBarcode: decodeWithZXing };
})();
