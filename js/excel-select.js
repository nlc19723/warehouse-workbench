// ============================================================
// 通用 Excel 式单元格框选 + 复制（v229.65 建立 / v229.66 自动接管）
// 替换各模块旧的 TableUtils.initSmartSelect（拖拽求和气泡），
// 让全表获得一致交互：
//   · 左键点格 = 选单格；按住拖动 = 矩形连续框选；Shift+点击 = 从锚点扩展
//   · Ctrl+C = 复制选区为 TSV（仅数据行，不含表头；存货编码等图标前缀如 🔍 已清洗）
//   · Ctrl+A = 全选当前表；Esc = 清空
//   · 底部选择条：已选 R 行 × C 列 · N 格 · 合计 ¥xxx + 复制选区/全选/清空
//   · 表内禁止原生文字选区（不再出现蓝色选块）
//   · v229.66：监听 DOM 自动接管——页面任何时候出现的 .data-table 都会自动具备上述交互，
//     不再依赖「容器渲染那一刻必须已有表格」（盘点/盘点记录/下钻浮层等延迟出表此前会漏接）
// 不干扰：表头排序、单元格内链接/按钮、各模块自带右键菜单
// ============================================================
(function () {
  'use strict';
  const TU = (typeof TableUtils !== 'undefined') ? TableUtils : null;
  const CU = (typeof ClipboardUtils !== 'undefined') ? ClipboardUtils : null;

  // 同一时刻只在一个容器内框选（全局唯一状态）
  let state = null; // { container, table, tbody, sel:{r1,c1,r2,c2}, anchor:{r,c}, dragging }
  let docBound = false;
  let docObserveBound = false;
  let bar = null;

  function el(idOrNode) {
    return (typeof idOrNode === 'string') ? document.getElementById(idOrNode) : idOrNode;
  }

  function bodyRows(tbody) {
    return Array.from(tbody.children).filter(tr => tr.tagName === 'TR');
  }

  function cellRC(td) {
    if (!td || td.tagName !== 'TD') return null;
    const tr = td.parentElement;
    if (!tr || tr.tagName !== 'TR') return null;
    const tbody = tr.parentElement;
    if (!tbody) return null;
    const rows = bodyRows(tbody);
    const r = rows.indexOf(tr);
    if (r < 0) return null;
    return { r, c: td.cellIndex, td, tr, tbody };
  }

  // 🟢 v229.66：一个容器可能含多张表（详情页/盘点），按点击的 td 反查所属表，避免永远取第一张
  function ensureStateFor(container, td) {
    const table = (td && td.closest && td.closest('table')) || container.querySelector('table');
    if (!table) return false;
    const tbody = table.querySelector('tbody') || table;
    state = { container, table, tbody, sel: null, anchor: null, dragging: false };
    return true;
  }

  function clearHighlight(container) {
    if (!container) return;
    container.querySelectorAll('td.cell-picked').forEach(td => td.classList.remove('cell-picked'));
  }

  function applyHighlight() {
    if (!state || !state.sel) return;
    clearHighlight(state.container);
    const { r1, c1, r2, c2 } = state.sel;
    const rows = bodyRows(state.tbody);
    for (let r = r1; r <= r2 && r < rows.length; r++) {
      const tds = rows[r].children;
      for (let c = c1; c <= c2 && c < tds.length; c++) {
        const td = tds[c];
        if (td && td.tagName === 'TD') td.classList.add('cell-picked');
      }
    }
  }

  function rangeSum() {
    if (!state || !state.sel) return null;
    const { r1, c1, r2, c2 } = state.sel;
    const rows = bodyRows(state.tbody);
    let sum = 0, any = false;
    for (let r = r1; r <= r2 && r < rows.length; r++) {
      const tds = rows[r].children;
      for (let c = c1; c <= c2 && c < tds.length; c++) {
        const td = tds[c];
        if (!td) continue;
        const v = parseFloat(cellText(td).replace(/[^\d.\-]/g, ''));
        if (!isNaN(v)) { sum += v; any = true; }
      }
    }
    return any ? sum : null;
  }

  // 单元格纯文本：用于复制/求和。
  // 🟢 v229.67：去掉装饰性图标（如存货编码前的 🔍，渲染在 <span class="de-icon"> 里），
  //   否则粘贴出来变成「🔍0101020010」。只剥离 class 含 icon/de-icon/ico 的节点，数据本身原样保留。
  function cellText(td) {
    if (!td) return '';
    const clone = td.cloneNode(true);
    clone.querySelectorAll('[class]').forEach(n => {
      if (/(^|\s)(de-icon|icon|ico)(\s|$)/i.test(n.className)) n.remove();
    });
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function buildTSV() {
    const { r1, c1, r2, c2 } = state.sel;
    const rows = bodyRows(state.tbody);
    const matrix = [];
    // 复制只含选中的数据行，不拼接表头（thead）行——用户要求粘贴结果不带标题行。
    for (let r = r1; r <= r2 && r < rows.length; r++) {
      const tds = rows[r].children;
      const row = [];
      for (let c = c1; c <= c2 && c < tds.length; c++) {
        const td = tds[c];
        row.push(td ? cellText(td) : '');
      }
      matrix.push(row);
    }
    if (CU && CU.toTSV) return CU.toTSV(matrix);
    return matrix.map(row => row.join('\t')).join('\r\n');
  }

  function fmtNum(n) {
    try {
      if (TU && TU.formatNum) return TU.formatNum(n);
      return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    } catch (e) { return String(n); }
  }

  function removeBar() { if (bar) { bar.remove(); bar = null; } }

  function updateBar() {
    if (!state || !state.sel) { removeBar(); return; }
    const { r1, c1, r2, c2 } = state.sel;
    const rows = r2 - r1 + 1, cols = c2 - c1 + 1, cells = rows * cols;
    const sum = rangeSum();
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'sel-bar excel-sel-bar';
      bar.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').getAttribute('data-act');
        if (act === 'range') copySelection();
        else if (act === 'all') selectAll();
        else if (act === 'clear') clearSelection();
      });
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<div class="sel-bar-inner">` +
      `<span class="sel-bar-count">已选 <b>${rows}</b> 行 × <b>${cols}</b> 列 · ${cells} 格` +
      (sum !== null ? ` · 合计 <b>¥${fmtNum(sum)}</b>` : '') + `</span>` +
      `<button class="sel-btn" data-act="range">📋 复制选区</button>` +
      `<button class="sel-btn" data-act="all">全选</button>` +
      `<button class="sel-btn ghost" data-act="clear">清空</button>` +
      `</div>`;
    requestAnimationFrame(() => bar.classList.add('show'));
  }

  function copySelection() {
    if (!state || !state.sel) { if (typeof showToast === 'function') showToast('未选择单元格', 'warn'); return; }
    const { r1, c1, r2, c2 } = state.sel;
    const rows = r2 - r1 + 1, cols = c2 - c1 + 1;
    const tsv = buildTSV();
    const finish = (ok) => {
      if (typeof showToast !== 'function') return;
      const okk = (ok === true || ok === undefined);
      showToast(okk ? `已复制 ${rows} 行 × ${cols} 列到剪贴板` : '复制失败，请重试', okk ? 'success' : 'error');
    };
    if (CU && CU.copy) {
      Promise.resolve(CU.copy(tsv)).then(finish).catch(() => finish(false));
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tsv).then(() => finish(true)).catch(() => finish(false));
    } else {
      finish(false);
    }
  }

  function selectAll() {
    if (!state) return;
    const rows = bodyRows(state.tbody);
    const thCount = state.table.querySelectorAll('thead th').length;
    const c2 = Math.max(0, thCount - 1);
    const r2 = Math.max(0, rows.length - 1);
    state.anchor = { r: 0, c: 0 };
    state.sel = { r1: 0, c1: 0, r2, c2 };
    applyHighlight();
    updateBar();
  }

  function clearSelection() {
    if (state) { state.sel = null; state.anchor = null; clearHighlight(state.container); }
    removeBar();
  }

  function setSel(a, b) {
    state.sel = {
      r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c),
      r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c)
    };
  }

  // ---------- 事件 ----------
  function onContainerMouseDown(e) {
    if (e.button !== 0) return;
    if (e.excelSelHandled) return;                     // 🟢 v229.66：内外层容器都绑了时只处理一次
    if (e.target.closest('a, button, input, select, textarea, .col-resize-handle, .entity-link, .no-sel')) return;
    const td = e.target.closest('td');
    if (!td) return;
    const rc = cellRC(td);
    if (!rc) return;                       // 表头/非单元格，放行（排序等）
    if (!ensureStateFor(e.currentTarget, td)) return;
    e.excelSelHandled = true;
    if (e.shiftKey && state.anchor) {
      setSel(state.anchor, rc);
    } else {
      state.anchor = { r: rc.r, c: rc.c };
      state.sel = { r1: rc.r, c1: rc.c, r2: rc.r, c2: rc.c };
    }
    state.dragging = true;
    e.preventDefault();                     // 阻止原生文字选区（蓝色选块）
    applyHighlight();
    updateBar();
  }

  function onDocMouseMove(e) {
    if (!state || !state.dragging) return;
    const td = e.target.closest && e.target.closest('td');
    if (!td) return;
    const rc = cellRC(td);
    if (!rc || rc.tbody !== state.tbody) return;
    setSel(state.anchor, rc);
    applyHighlight();
    updateBar();
  }

  function onDocMouseUp() {
    if (state) state.dragging = false;
  }

  function onDocMouseDown(e) {
    if (!state) return;
    if (e.target.closest('.sel-bar')) return;          // 点选择条按钮不清除
    if (state.container.contains(e.target)) return;    // 在表内操作
    clearSelection();
  }

  function onDocKeyDown(e) {
    if (!state) return;
    if (state.container && !document.body.contains(state.container)) { state = null; removeBar(); return; }
    const t = e.target;
    const isField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    // 🟢 v229.66：盘点等模块渲完表会自动聚焦第一个输入框，此时用户 Ctrl+C 想复制的是「单元格选区」，
    //   旧守卫一律放行给原生 → 什么都复制不到。改为：仅当输入框内部自己选中了文字时才让原生接管。
    const innerTextSel = !!t && t.value != null && typeof t.selectionStart === 'number' && t.selectionStart !== t.selectionEnd;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      if (isField) return;                           // 不抢输入框的全选
      const ae = document.activeElement;
      if (state.sel || (ae && state.container.contains(ae))) {
        e.preventDefault();
        selectAll();
      }
    } else if (mod && (e.key === 'c' || e.key === 'C')) {
      if (isField && innerTextSel) return;           // 复制框内自己选的字
      if (t && t.tagName === 'SELECT') return;
      if (state.sel) { e.preventDefault(); copySelection(); }
    } else if (e.key === 'Escape') {
      if (isField) return;
      if (state.sel) clearSelection();
    }
  }

  // ---------- 对外接口 ----------
  function ensureDocBound() {
    if (docBound) return;
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    document.addEventListener('keydown', onDocKeyDown);
    document.addEventListener('mousedown', onDocMouseDown);
    // 模块切换时旧容器会从 DOM 移除 → 清理残留选区/选择条
    const ca = document.getElementById('contentArea');
    if (ca && !docObserveBound) {
      const obs = new MutationObserver((muts) => {
        if (!state || !state.container) return;
        for (const m of muts) {
          for (const n of m.removedNodes) {
            if (n === state.container || (n.contains && n.contains(state.container))) {
              state = null; removeBar(); return;
            }
          }
        }
      });
      obs.observe(ca, { childList: true, subtree: true });
      docObserveBound = true;
    }
    docBound = true;
  }

  // 🟢 v229.80：移动端禁用 Excel 式框选 —— 手机上手指滑动本意是滚页，极易误出选区；
  //   底部浮条还会遮住分页栏（用户实测反馈）。判定为移动端时 bindContainer 直接不绑定，
  //   交互整段关闭（不会产生选区 → 浮条永不出现）；CSS 再对 .sel-bar 做媒体查询隐藏兜底。
  //   判定口径：
  //     · 纯触摸设备（pointer:coarse 且 hover:none）→ 一律移动端。iPad Pro 横屏宽达 1366px，
  //       单看宽度会漏判，故以「能不能悬停」为准；Windows 触屏笔记本有鼠标 → hover:hover，不受影响。
  //     · 窄屏窗口（≤820px）→ 移动端（桌面把窗口拉窄时同样不该糊出浮条）。
  function isMobileLike() {
    try {
      const mm = window.matchMedia ? window.matchMedia.bind(window) : null;
      if (mm) {
        const coarse = mm('(pointer: coarse)').matches;
        const noHover = mm('(hover: none)').matches;
        if (coarse && noHover) return true;
      }
      return window.innerWidth <= 820;
    } catch (e) { return window.innerWidth <= 820; }
  }
  // 🟢 暴露给其它模块复用同一口径，避免各写一份、判定漂移
  if (TU) TU.isTouchLayout = isMobileLike;
  if (typeof window !== 'undefined') window.isTouchLayout = isMobileLike;

  function bindContainer(container) {
    if (!container || container._excelSelBound) return false;
    if (!container.querySelector('table')) return false;
    if (isMobileLike()) return false;                    // ← 移动端：不启用框选（v229.80）
    container._excelSelBound = true;
    container.classList.add('excel-sel');
    container.addEventListener('mousedown', onContainerMouseDown);
    ensureDocBound();
    return true;
  }

  function initExcelSelection(containerId) {
    return bindContainer(el(containerId));
  }

  // 批量绑定根节点下的所有 .data-table（用于详情页 / 仪表盘等多表场景）
  function initExcelSelectionAll(rootId) {
    const root = el(rootId) || document;
    root.querySelectorAll('.data-table').forEach(t => {
      const c = t.closest('.table-wrapper') || t.parentElement;
      bindContainer(c);
    });
  }

  // ------------------------------------------------------------
  // 🟢 v229.66 自动接管
  // 旧实现只在「模块显式调用」的那一刻绑定，若容器当时还没有 <table>
  // （盘点要先进日常盘点、盘点记录要有记录、驾驶舱浮层要先下钻），
  // bindContainer 便因 querySelector('table') 为空直接放弃，之后再出表也永远绑不上。
  // 改为监听 DOM：任何时刻新出现的 .data-table 都会自动获得框选 + 复制能力，
  // 做到「只要有表就有 Excel 交互」，不依赖各模块记得打调用。
  // ------------------------------------------------------------
  const AUTO_SKIP = '#alertTableArea, [data-no-excel]';   // 库存预警保留自己的右键菜单/行选择实现
  let autoBound = false;

  function tryBindIn(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.closest && root.closest(AUTO_SKIP)) return;
    const list = [];
    if (root.classList && root.classList.contains('data-table')) list.push(root);
    const inner = root.querySelectorAll ? root.querySelectorAll('.data-table') : [];
    for (let i = 0; i < inner.length; i++) list.push(inner[i]);
    for (const t of list) {
      if (t.closest(AUTO_SKIP)) continue;
      let c = t.closest('.table-wrapper');
      if (c && !c.contains(t)) c = null;
      try { bindContainer(c || t.parentElement); } catch (err) { /* 忽略单表异常 */ }
    }
  }

  function ensureAutoBind() {
    if (autoBound) return;
    autoBound = true;
    const pending = new Set();
    let timer = null;
    const flush = () => {
      timer = null;
      const roots = Array.from(pending);
      pending.clear();
      roots.forEach(r => tryBindIn(r));
      const ca = document.getElementById('contentArea'); if (ca) tryBindIn(ca);
      const mb = document.getElementById('modalBody'); if (mb) tryBindIn(mb);
    };
    try {
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) if (n && n.nodeType === 1) pending.add(n);
        }
        if (timer) return;
        timer = setTimeout(flush, 40);
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* 无 MutationObserver 环境降级为手动绑定 */ }
    setTimeout(flush, 80);
  }

  ensureAutoBind();

  if (TU) {
    TU.initExcelSelection = initExcelSelection;
    TU.initExcelSelectionAll = initExcelSelectionAll;
  }
  if (typeof window !== 'undefined') {
    window.initExcelSelection = initExcelSelection;
    window.initExcelSelectionAll = initExcelSelectionAll;
  }
})();
