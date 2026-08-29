// ============================================
// 二维码公共组件（A1 档案页 / A2 现存量列表 共用）
// 依赖：lib/qrcode.min.js（全局 qrcode 函数，零依赖、可离线）
// 编码内容：存货编码纯文本（方式一）—— 扫到编码后由工作台内跳转档案
// ============================================
//
// 🟢 A2 关键设计：
//   1) 内存缓存 svgCache：编码 → SVG 字符串，避免分页来回/筛选时反复生成（1407 种物料性能保障）
//   2) 列表缩略码仅作展示索引，点击弹大图保证可扫（D1）
//   3) 列表二维码不提供跳转（D2），弹窗内无"打开档案"按钮
// ============================================

(function () {
  const svgCache = new Map(); // 编码 → 自适应 SVG 字符串

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 生成自适应 SVG（含 viewBox，实际大小由容器 CSS 控制）— 带内存缓存
  function svg(code) {
    const key = String(code == null ? '' : code).trim();
    if (!key) return '';
    if (svgCache.has(key)) return svgCache.get(key);
    try {
      if (typeof qrcode !== 'function') return '';
      const qr = qrcode(0, 'M');
      qr.addData(key);
      qr.make();
      const s = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      svgCache.set(key, s);
      return s;
    } catch (e) { console.warn('[QR] gen failed:', e); return ''; }
  }

  // 固定尺寸 SVG（用于 canvas 转 PNG / 打印，需固有宽高）
  function svgFixed(code, cellSize, margin) {
    const key = String(code == null ? '' : code).trim();
    if (!key || typeof qrcode !== 'function') return '';
    const qr = qrcode(0, 'M');
    qr.addData(key);
    qr.make();
    return qr.createSvgTag(cellSize || 8, margin == null ? 4 : margin);
  }

  // 列表缩略码 HTML（A2）：仅展示索引，不跳转；点击弹大图
  function thumb(code, name, spec) {
    const key = String(code == null ? '' : code).trim();
    if (!key) return '<span class="qr-thumb qr-thumb-empty">—</span>';
    const s = svg(key);
    if (!s) return '<span class="qr-thumb qr-thumb-empty">—</span>';
    return `<span class="qr-thumb" data-qr-code="${escapeHtml(key)}" data-qr-name="${escapeHtml(name || '')}" data-qr-spec="${escapeHtml(spec || '')}" title="点击查看/下载二维码">${s}</span>`;
  }

  // 弹大图（A2 列表用）：放大展示 + 编码/规格文字 + 下载 PNG；按 D2 不提供跳转
  function showModal(code, name, spec) {
    const key = String(code == null ? '' : code).trim();
    if (!key) return;
    const old = document.getElementById('qrModal');
    if (old) old.remove();
    const s = svg(key);
    if (!s) return;
    const overlay = document.createElement('div');
    overlay.id = 'qrModal';
    overlay.className = 'qr-modal';
    overlay.innerHTML =
      '<div class="qr-modal-box">' +
      '<div class="qr-modal-head">' + escapeHtml(name || '存货二维码') + '</div>' +
      '<div class="qr-modal-img">' + s + '</div>' +
      '<div class="qr-modal-meta">编码：' + escapeHtml(key) +
      (spec ? '　规格：' + escapeHtml(spec) : '') + '</div>' +
      '<div class="qr-modal-actions">' +
      '<button class="btn-secondary" type="button" data-qr-dl="' + escapeHtml(key) + '">⬇ 下载 PNG</button>' +
      '<button class="btn-secondary" type="button" data-qr-close>关闭</button>' +
      '</div></div>';
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', e => {
      const t = e.target;
      if (t === overlay || (t.hasAttribute && t.hasAttribute('data-qr-close'))) { close(); return; }
      if (t.hasAttribute && t.hasAttribute('data-qr-dl')) downloadPng(t.getAttribute('data-qr-dl'));
    });
    // Esc 关闭
    const onKey = ev => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }

  // 白底 PNG 下载（离线，便于仓库贴码）
  function downloadPng(code) {
    try {
      const key = String(code == null ? '' : code).trim();
      if (!key) return;
      const svgText = svgFixed(key, 8, 4);
      if (!svgText) return;
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const S = 4; // 放大 4 倍保证打印清晰
        const c = document.createElement('canvas');
        c.width = img.width * S; c.height = img.height * S;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // 白底，避免透明背景
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(b => {
          if (!b) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(b);
          a.download = key + '.png';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => { URL.revokeObjectURL(a.href); URL.revokeObjectURL(url); }, 1500);
        }, 'image/png');
      };
      img.onerror = () => { WBModal.alert('二维码生成失败，请重试'); URL.revokeObjectURL(url); };
      img.src = url;
    } catch (e) { console.error('[QR] download failed:', e); }
  }

  // 单张打印（v197 排版：仅大码 + 右侧「名称、规格」上下排列，无日期/标题/编号）
  function printWindow(code, name, spec) {
    try {
      const key = String(code == null ? '' : code).trim();
      if (!key) return;
      const s = svgFixed(key, 12, 6);
      if (!s) return;
      const w = window.open('', '_blank');
      if (!w) { WBModal.alert('请允许浏览器弹出窗口以打印二维码'); return; }
      w.document.open();
      w.document.write(
        '<!doctype html><html><head><meta charset="utf-8"><title>存货二维码</title>' +
        '<style>' +
        'html,body{margin:0;padding:0;background:#fff;}' +
        'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1a202c;}' +
        '.label{display:flex;flex-direction:row;align-items:center;justify-content:center;' +
        'gap:20px;padding:28px 20px;max-width:520px;margin:24px auto;}' +
        '.label .code{flex:0 0 240px;width:240px;height:240px;}' +
        '.label .code svg{width:100%;height:100%;display:block;}' +
        '.label .info{flex:1 1 auto;display:flex;flex-direction:column;gap:14px;' +
        'min-width:0;align-items:flex-start;}' +
        '.label .info .name{font-size:20px;font-weight:700;line-height:1.35;' +
        'word-break:break-word;text-align:left;}' +
        '.label .info .spec{font-size:14px;color:#555;line-height:1.5;text-align:left;}' +
        '@media print{.label{margin:0;padding:24px 16px;}}' +
        '</style></head><body>' +
        '<div class="label">' +
        '<div class="code">' + s + '</div>' +
        '<div class="info">' +
        '<div class="name">' + escapeHtml(name || '') + '</div>' +
        (spec ? '<div class="spec">规格：' + escapeHtml(spec) + '</div>' : '') +
        '</div></div>' +
        '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},250);};</scr' + 'ipt>' +
        '</body></html>');
      w.document.close();
    } catch (e) { console.error('[QR] print failed:', e); }
  }

  // 🟢 v197：A3 批量打印 — 多张标签组成网格（A4 友好，2 列 4 行默认；每张 = 大码 + 名称/规格）
  function printBulk(items) {
    try {
      if (!Array.isArray(items) || items.length === 0) return;
      const cards = items.map(it => {
        const key = String(it && it.code || '').trim();
        if (!key) return '';
        const s = svgFixed(key, 8, 4); // 批量用稍小一点的码更省空间
        if (!s) return '';
        return '<div class="card">' +
          '<div class="code">' + s + '</div>' +
          '<div class="info">' +
            '<div class="name">' + escapeHtml(it.name || '') + '</div>' +
            (it.spec ? '<div class="spec">规格：' + escapeHtml(it.spec) + '</div>' : '') +
          '</div></div>';
      }).join('');
      const w = window.open('', '_blank');
      if (!w) { WBModal.alert('请允许浏览器弹出窗口以打印二维码'); return; }
      w.document.open();
      w.document.write(
        '<!doctype html><html><head><meta charset="utf-8"><title>批量打印存货二维码 · 共 ' + items.length + ' 张</title>' +
        '<style>' +
        'html,body{margin:0;padding:0;background:#fff;}' +
        'body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1a202c;}' +
        'h1.title{font-size:13px;color:#888;text-align:center;margin:18px 0 6px;letter-spacing:1px;}' +
        '.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px 18px;padding:18px 22px;max-width:760px;margin:0 auto;}' +
        '.card{display:flex;flex-direction:row;align-items:center;gap:14px;padding:14px;' +
        'border:1px dashed #d1d5db;border-radius:10px;break-inside:avoid;page-break-inside:avoid;}' +
        '.card .code{flex:0 0 110px;width:110px;height:110px;}' +
        '.card .code svg{width:100%;height:100%;display:block;}' +
        '.card .info{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px;align-items:flex-start;}' +
        '.card .name{font-size:15px;font-weight:700;line-height:1.35;word-break:break-word;text-align:left;}' +
        '.card .spec{font-size:12px;color:#666;line-height:1.4;text-align:left;}' +
        '@media print{.title{display:none;}body{print-color-adjust:exact;-webkit-print-color-adjust:exact;}.grid{padding:10mm 12mm;}}' +
        '@page{margin:10mm 12mm;}' +
        '</style></head><body>' +
        '<h1 class="title">存货二维码 · 批量打印 · 共 ' + items.length + ' 张</h1>' +
        '<div class="grid">' + cards + '</div>' +
        '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},300);};</scr' + 'ipt>' +
        '</body></html>');
      w.document.close();
    } catch (e) { console.error('[QR] printBulk failed:', e); }
  }

  // 全局事件委托：列表缩略码点击 → 弹大图（表格翻页/排序重渲染后依然生效）
  document.addEventListener('click', e => {
    const t = e.target && e.target.closest ? e.target.closest('.qr-thumb') : null;
    if (!t || t.classList.contains('qr-thumb-empty')) return;
    showModal(t.getAttribute('data-qr-code'), t.getAttribute('data-qr-name'), t.getAttribute('data-qr-spec'));
  });

  window.QR = { svg, svgFixed, thumb, showModal, downloadPng, printWindow, printBulk, escapeHtml };
})();
