// ============================================================
// 通用 Excel 式单元格框选 + 复制（v229.65 建立 / v229.66 自动接管）
// 替换各模块旧的 TableUtils.initSmartSelect（拖拽求和气泡），
// 让全表获得一致交互：
//   · 左键点格 = 选单格；按住拖动 = 矩形连续框选；Shift+点击 = 从锚点扩展
//     （v230.07：单击选中单格的基础交互已恢复；求和不离列——见下方 rangeSum）
//   · Ctrl+C = 复制选区为 TSV（仅数据行，不含表头；存货编码等图标前缀如 🔍 已清洗）
//   · Ctrl+A = 全选当前表；Esc = 清空
//   · 选择条（v230.06：固定在内容区左沿，不再遮挡居中翻页栏）：
//     已选 R 行 × C 列 · N 格 · 合计 ¥xxx（仅数量/金额类列，v230.06）+ 复制选区/全选/清空
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
  // 🟢 v230.06：同一容器同一表时保留 anchor（Shift+点击扩展跨 mousedown 事件依赖锚点，
  //   旧实现每次重建 state 会把锚点清掉，导致 Shift+扩展失效）；切换容器/表才整体重置。
  function ensureStateFor(container, td) {
    const table = (td && td.closest && td.closest('table')) || container.querySelector('table');
    if (!table) return false;
    if (state && state.container === container && state.table === table && document.body.contains(container)) {
      state.tbody = table.querySelector('tbody') || table;   // tbody 可能被模块重渲替换，取最新
      return true;
    }
    state = { container, table, tbody: table.querySelector('tbody') || table, sel: null, anchor: null, dragging: false };
    return true;
  }

  function clearHighlight(container) {
    if (!container) return;
    container.querySelectorAll('td.cell-picked').forEach(td => td.classList.remove('cell-picked'));
  }

  function applyHighlight() {
    if (!state) return;
    clearHighlight(state.container);
    if (!state.sel) return;
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

  // 🟢 v230.06：列类型判定——表头命中 NUMERIC_KEYWORDS 视为数量/金额类列，
  //   与 TableUtils._detectNumericCols（汇总行）同一口径，避免「存货编码/订单号被求和」。
  function isNumericColumn(th) {
    if (!th || !TU || !Array.isArray(TU.NUMERIC_KEYWORDS)) return false;
    const lbl = (th.querySelector && th.querySelector('.th-sort-label')) ? th.querySelector('.th-sort-label') : null;
    const text = ((lbl ? lbl.textContent : th.textContent) || '').trim();
    if (!text) return false;
    return TU.NUMERIC_KEYWORDS.some((k) => text.includes(k));
  }

  // 🟢 v230.06：合计只累计数量/金额类列——存货编码 Q03010100101、订单号 20240308 等
  //   纯编号列不再被解析成数字累加（用户反馈「非数量金额列也出合计，无意义」）。
  function rangeSum() {
    if (!state || !state.sel) return null;
    const { r1, c1, r2, c2 } = state.sel;
    const rows = bodyRows(state.tbody);
    const ths = state.table.querySelectorAll('thead th');
    let sum = 0, any = false;
    for (let r = r1; r <= r2 && r < rows.length; r++) {
      const tds = rows[r].children;
      for (let c = c1; c <= c2 && c < tds.length; c++) {
        if (!isNumericColumn(ths[c])) continue;
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

  // 🟢 v230.06：选择条定位——水平贴内容区左沿（+16px，天然避开侧边栏 240px/56px 两种态），
  //   解决旧实现 left:50% 底部居中与各模块居中翻页栏完全重叠的问题（用户反馈遮挡翻页键）。
  //   垂直方向：默认贴底；若与吸底可见的分页栏矩形重叠，则上移到分页栏上方 8px，
  //   做到「靠左且任何几何下都不遮挡翻页键」。
  function findVisiblePagination() {
    const bars = document.querySelectorAll('.pagination-bar');
    for (const b of bars) {
      if (!b.getClientRects || b.getClientRects().length === 0) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) continue;          // 空容器/未渲染
      if (r.bottom > 0 && r.top < window.innerHeight) return b;  // 视口内可见（吸底态）
    }
    return null;
  }

  function positionSelBar(barEl, container) {
    if (!barEl) return;
    const anchor = container || barEl._wbAnchor;
    try {
      let left = 16;   // CSS 兜底值；取不到容器几何时保持
      if (anchor && anchor.getBoundingClientRect) {
        const rect = anchor.getBoundingClientRect();
        left = rect.left + 16;
        const maxLeft = Math.max(8, window.innerWidth - 32);   // 右界兜底（超窄容器不越屏）
        if (left > maxLeft) left = maxLeft;
      }
      barEl.style.left = left + 'px';

      // 垂直避让：与吸底分页栏重叠时上移让位（浮条较宽，仅靠左移不足以保证不遮挡）
      const pager = findVisiblePagination();
      const bh = barEl.offsetHeight || 44;
      const bw = barEl.offsetWidth || 380;
      if (pager) {
        const pr = pager.getBoundingClientRect();
        const barBottom = 22, barTop = window.innerHeight - barBottom - bh;
        const hOverlap = left < pr.right && (left + bw) > pr.left;
        const vOverlap = barTop < pr.bottom && pr.top < (window.innerHeight - barBottom);
        if (hOverlap && vOverlap) {
          barEl.style.bottom = Math.max(8, window.innerHeight - pr.top + 8) + 'px';
          return;
        }
      }
      barEl.style.bottom = '22px';
    } catch (e) { /* 几何读取失败时退回 CSS 默认 left:16px / bottom:22px */ }
  }

  // 窗口缩放 / 侧边栏收起展开（body class 变化，不触发 resize）时重定位所有可见选择条
  function repositionAllSelBars() {
    try {
      if (bar) positionSelBar(bar, (state && state.container) || bar._wbAnchor);
      const ia = document.getElementById('iaSelBar');
      if (ia) positionSelBar(ia, ia._wbAnchor);
    } catch (e) { /* noop */ }
  }

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
    bar._wbAnchor = state.container;
    bar.innerHTML = `<div class="sel-bar-inner">` +
      `<span class="sel-bar-count">已选 <b>${rows}</b> 行 × <b>${cols}</b> 列 · ${cells} 格` +
      (sum !== null ? ` · 合计 <b>¥${fmtNum(sum)}</b>` : '') + `</span>` +
      `<button class="sel-btn" data-act="range">📋 复制选区</button>` +
      `<button class="sel-btn" data-act="all">全选</button>` +
      `<button class="sel-btn ghost" data-act="clear">清空</button>` +
      `</div>`;
    positionSelBar(bar, state.container);   // 内容就绪后再定位，几何实测才准
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
      // 🟢 v230.07：单击 = 选中该格（恢复基础交互：选中/复制单格）。
      //   v230.06 曾把单击改为只设锚点不出选区，用户反馈「点击无反应也没浮条」——
      //   选中单元格是表格基础能力。当初要杜绝的「乱求和」由列过滤兜底：
      //   合计只对数量/金额类列计算（见 rangeSum），编码/订单号列点击只有选区、不出合计。
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

  // 🟢 v230.06：选择条为 fixed 定位，容器左边变化（窗口缩放 / 侧边栏收起展开）时必须重定位，
  //   否则会停留在旧位置甚至遮挡翻页栏。侧边栏切换不触发 resize，故同时监听 body class。
  //   注意：这两个监听必须在脚本加载时注册，不能放进 ensureDocBound——
  //   inventory-alert 页只有 #alertTableArea（AUTO_SKIP），ensureDocBound 可能永不执行，
  //   但其 #iaSelBar 同样需要跟随重定位。
  window.addEventListener('resize', repositionAllSelBars);
  try {
    const bodyObs = new MutationObserver(repositionAllSelBars);
    bodyObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  } catch (e) { /* 无 MutationObserver 环境降级：仅 resize 兜底 */ }

  if (TU) {
    TU.initExcelSelection = initExcelSelection;
    TU.initExcelSelectionAll = initExcelSelectionAll;
    TU.positionSelBar = positionSelBar;      // 🟢 v230.06：供 inventory-alert 等自有选择条复用同一左沿定位
  }
  if (typeof window !== 'undefined') {
    window.initExcelSelection = initExcelSelection;
    window.initExcelSelectionAll = initExcelSelectionAll;
    window.positionSelBar = positionSelBar;
  }
})();
