// ============================================
// 智能单元格选择 + 浮动汇总提示工具 + Excel式表头排序筛选
// ============================================

// 🟢 v113：表格偏好持久化（列宽、对齐、录入草稿）
// 🟢 v145：新增 filters（表头筛选条件记忆），切模块再切回不丢失
// 🟢 v172：折叠态列宽上限 160px；所有可见 td/th 加 ellipsis + nowrap + overflow（解决 3 截图溢出 / "两列放大" 问题）
// 命名空间：wb_table_prefs  → { widths: { tableKey: { colField: px } }, aligns: { tableKey: { colField: 'left'|'center'|'right' } }, filters: { tableKey: { colField: {kw, checked, unchecked} } }, drafts: { tableKey: { ... } } }
const TablePrefs = {
  KEY: 'wb_table_prefs',

  _read() {
    try { return JSON.parse(localStorage.getItem(this.KEY)) || {}; }
    catch (e) { return {}; }
  },
  _write(obj) {
    try { localStorage.setItem(this.KEY, JSON.stringify(obj)); }
    catch (e) { console.warn('[TablePrefs] write failed:', e); }
  },

  // 列宽
  getColWidth(tableKey, colField) {
    if (!tableKey || !colField) return null;
    const all = this._read();
    return (all.widths && all.widths[tableKey] && all.widths[tableKey][colField]) || null;
  },
  setColWidth(tableKey, colField, px) {
    if (!tableKey || !colField) return;
    const all = this._read();
    all.widths = all.widths || {};
    all.widths[tableKey] = all.widths[tableKey] || {};
    all.widths[tableKey][colField] = Math.round(px);
    this._write(all);
  },
  // 🟢 v146：判断某 tableKey 下是否已有任何列宽记忆（用于首次进入时是否需要"锁定首屏为默认基线"）
  hasAnyColWidth(tableKey) {
    if (!tableKey) return false;
    const all = this._read();
    return !!(all.widths && all.widths[tableKey] && Object.keys(all.widths[tableKey]).length > 0);
  },

  // 对齐偏好
  getAlign(tableKey, colField) {
    if (!tableKey || !colField) return null;
    const all = this._read();
    return (all.aligns && all.aligns[tableKey] && all.aligns[tableKey][colField]) || null;
  },
  setAlign(tableKey, colField, align) {
    if (!tableKey || !colField || !['left', 'center', 'right'].includes(align)) return;
    const all = this._read();
    all.aligns = all.aligns || {};
    all.aligns[tableKey] = all.aligns[tableKey] || {};
    all.aligns[tableKey][colField] = align;
    this._write(all);
  },

  // 🟢 v145：表头筛选条件记忆（切模块再切回不丢失）
  // 🟢 v148：统一为「排除语义」——仅记录用户取消勾选的值（excluded）；默认勾选=显示。
  //   归一化返回 { kw, excluded }，自动兼容旧格式 { checked, unchecked }（旧 unchecked 即 excluded）。
  getFilter(tableKey, colField) {
    if (!tableKey || !colField) return null;
    const all = this._read();
    const raw = (all.filters && all.filters[tableKey] && all.filters[tableKey][colField]) || null;
    if (!raw) return null;
    if (typeof raw === 'string') return { kw: raw, excluded: [] }; // 旧纯关键词格式
    const kw = raw.kw || '';
    // 旧格式用 unchecked 当 excluded；新格式直接用 excluded
    const excluded = Array.isArray(raw.excluded) ? raw.excluded
                    : (Array.isArray(raw.unchecked) ? raw.unchecked : []);
    return { kw, excluded };
  },
  setFilter(tableKey, colField, state) {
    if (!tableKey || !colField || !state) return;
    const all = this._read();
    all.filters = all.filters || {};
    all.filters[tableKey] = all.filters[tableKey] || {};
    // 🟢 v148：只持久化 kw + excluded（被取消勾选的值）；不再写 checked/totalCount
    const kw = state.kw || '';
    const excluded = Array.isArray(state.excluded) ? state.excluded : [];
    if (kw || excluded.length > 0) {
      all.filters[tableKey][colField] = { kw, excluded };
    } else {
      delete all.filters[tableKey][colField]; // 无有效筛选则清掉，避免恢复空筛选
    }
    this._write(all);
  },

  // 录入草稿（订单核对等表单型表格切换模块回来时恢复）
  getDraft(tableKey) {
    if (!tableKey) return null;
    const all = this._read();
    return (all.drafts && all.drafts[tableKey]) || null;
  },
  // 🟢 v149：仅清空全部表头筛选记忆（进入/刷新工作台时调用）。
  //   不影响列宽、对齐、录入草稿等其他偏好。
  clearFilters() {
    const all = this._read();
    if (all.filters) {
      delete all.filters;
      this._write(all);
    }
  },
  setDraft(tableKey, data) {
    if (!tableKey) return;
    const all = this._read();
    all.drafts = all.drafts || {};
    if (data === null || data === undefined) {
      delete all.drafts[tableKey];
    } else {
      all.drafts[tableKey] = data;
    }
    this._write(all);
  },

  // 清空某一类偏好（用于调试/重置）
  clear(tableKey) {
    const all = this._read();
    if (all.widths) delete all.widths[tableKey];
    if (all.aligns) delete all.aligns[tableKey];
    if (all.drafts) delete all.drafts[tableKey];
    this._write(all);
  }
};
window.TablePrefs = TablePrefs;

// ============================================================
// 🟢 v133：移动端 JS 浮动表头/首列（绕开 iOS Safari thead sticky bug）
// ============================================================
// 解决问题：iOS Safari 在 <thead> 内 <th> 的 position:sticky 不可靠，
//   导致纵向滚动时首列单元格"穿过"表头标题。
// 方案：在 .table-wrapper 内部创建 absolute 定位的浮层
//   - 顶部 thead 浮层（横向跟随 scrollLeft、纵向>0 时显示）
//   - 左侧首列浮层（纵向跟随 scrollTop、横向>0 时显示）
//   - 左上角由两层叠加形成，背景充分不透明，视觉上完全分层

// 🟢 v134：长按下滑手势（iOS Safari 触发 selection swipe / WebKit drag preview）监听
// 全局注册表：TableStickyOverlay 装到 document/window 上的监听由这里统一管理，uninstallAll 时一次性解绑
window._overlayGlobalListeners = window._overlayGlobalListeners || [];
window._installedWraps = window._installedWraps || new WeakSet();

const TableStickyOverlay = {
  isNarrow() { return window.innerWidth <= 768; },

  /**
   * 给 .table-wrapper 安装移动端浮动表头/首列
   * 关键点：浮层 append 到 document.body（而不是 wrap 内），用 position:fixed 真正贴在屏幕视口；
   *   left / top / width 从 wrap.getBoundingClientRect() 实时取，滚动时更新。
   */

  // 🟢 v139：移动端列折叠——表宽超出视口时从右往左隐藏列，留「展开剩余 N 列」按钮，点击还原。
  //   替代旧的移动端固定首列浮层（mobile-float-firstcol）：用户不需要固定首列，正常显示即可。
  installColumnCollapse(wrap, table) {
    if (!this.isNarrow()) { this._resetCollapse(wrap, table); return; }
    let btn = wrap._colCollapseBtn;
    if (btn && btn.parentNode) {
      // 🟢 v143：已初始化过（按钮存在且在 DOM 内）——直接复用已有按钮与闭包状态，
      //   仅重新计算折叠/展开（响应容器尺寸变化）。不重新创建按钮、不覆盖 _colCollapsed，
      //   避免同一表格被多条路径（initSortableHeaders→install 与 initColumnResizers 补挂）
      //   用不同 wrap 重复处理导致按钮状态/折叠态不同步、点击无法展开。
      this._applyCollapse(wrap, table);
      return;
    }
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-col-toggle';
    if (wrap.parentNode) wrap.parentNode.insertBefore(btn, wrap);
    wrap._colCollapseBtn = btn;
    btn.addEventListener('click', () => {
      wrap._colCollapsed = !wrap._colCollapsed;
      this._applyCollapse(wrap, table);
    });
    if (wrap._colCollapsed === undefined) wrap._colCollapsed = true; // 默认折叠
    this._applyCollapse(wrap, table);
  },

  _applyCollapse(wrap, table) {
    const ths = table.querySelectorAll('thead th');
    const colCount = ths.length;
    const btn = wrap._colCollapseBtn;
    // 🟢 v144：移动端一律保留前 2 列（序号 + 主数据列）
    // 🟢 v198：首列若是复选框列（现存量「批量打印二维码」多选模式），保留列数 +1，
    //   否则折叠后只剩「勾选框 + 二维码」，用户看不出自己勾的是哪个存货。
    const hasCheckCol = !!table.querySelector('thead th.col-checkbox');
    const keepMin = Math.min(2 + (hasCheckCol ? 1 : 0), Math.max(1, colCount - 1));

    // 重置：所有列显示；表格恢复原始 table-layout（多数模块在 inline style 写 fixed，宽列拖拽需要它）
    table.querySelectorAll('thead th, tbody td, tfoot td').forEach(c => c.classList.remove('col-collapsed'));
    if (table.dataset.origTableLayout) table.style.tableLayout = table.dataset.origTableLayout;
    delete table.dataset.origTableLayout;
    // 清除折叠态设的表格总宽 + min-width（min-width:0 是 flex 容器下让 table 能缩到 inline width 的关键）
    table.style.width = '';
    table.style.minWidth = '';
    // 恢复 th 的 inline width / minWidth + 清掉 td max-width/overflow
    if (table.dataset.origThWidths) {
      try {
        const arr = JSON.parse(table.dataset.origThWidths);
        ths.forEach((th, i) => { th.style.width = arr[i] || ''; th.style.minWidth = ''; });
      } catch (_) {}
      delete table.dataset.origThWidths;
    }
    const firstTr = table.querySelector('tbody tr');
    if (firstTr) Array.from(firstTr.children).forEach(td => { td.style.maxWidth = ''; td.style.overflow = ''; });
    // 🟢 v172：清掉折叠态在 th/td 设的 maxWidth/textOverflow/whiteSpace + 父容器 col-collapse-mode 标记
    ths.forEach(th => { th.style.maxWidth = ''; th.style.overflow = ''; th.style.textOverflow = ''; th.style.whiteSpace = ''; });
    table.querySelectorAll('tbody tr').forEach(tr => {
      Array.from(tr.children).forEach(td => {
        if (!td.classList.contains('col-collapsed')) {
          td.style.maxWidth = ''; td.style.minWidth = ''; td.style.overflow = '';
          td.style.textOverflow = ''; td.style.whiteSpace = '';
        }
      });
    });
    if (wrap.parentElement) wrap.parentElement.classList.remove('col-collapse-mode');

    // 🟢 v144：桌面端或非数据表（列数 ≤1）一律不折叠、隐藏按钮
    if (!this.isNarrow() || colCount <= 1) {
      if (btn) btn.style.display = 'none';
      return;
    }

    // 🟢 v144：列数 ≤ keepMin（≤2 列）无需折叠，隐藏按钮
    if (colCount <= keepMin) {
      if (btn) btn.style.display = 'none';
      return;
    }

    // —— 移动端：无论是否「超宽」，一律默认折叠到前 2 列（用户需求：收齐展示 2 列）——
    if (!wrap._colCollapsed) {
      // 展开态：还原所有列，恢复自然列宽，允许横向滑动看剩余列（每列正常宽度，不挤）
      // 表格改为内容自适应宽度（width:auto + 各列自然/原始 inline 宽），由外层 .table-wrapper 的
      // overflow-x:auto 提供横向滚动条；不再等分/压扁列宽。
      table.style.tableLayout = 'fixed';
      table.style.width = 'auto';
      table.style.minWidth = '0';
      if (btn) { btn.style.display = ''; btn.textContent = '收起 ▴'; btn.dataset.state = 'expanded'; }
      return;
    }

    // 折叠态：隐藏第 3 列起到末尾，前 keepMin 列等分容器宽（展示 2 列、不挤）
    let hidden = 0;
    if (!table.dataset.origTableLayout) table.dataset.origTableLayout = table.style.tableLayout || '';
    if (!table.dataset.origThWidths) {
      table.dataset.origThWidths = JSON.stringify(Array.from(ths).map(th => th.style.width || ''));
    }
    table.style.tableLayout = 'fixed';
    for (let i = colCount - 1; i >= keepMin; i--) {
      this._hideColInTable(table, i, true);
      ths[i].style.width = '';
      hidden++;
    }
    // 等分剩余可见列宽（统一以「小号」为准：列宽上限 160px，避免「两列放大」视觉与溢出）
    const visThs = Array.from(table.querySelectorAll('thead th')).filter(th => !th.classList.contains('col-collapsed'));
    const N = visThs.length;
    if (N > 0) {
      const wrapW = wrap.clientWidth || 360;
      const MAX_COL = 160; // 🟢 v172：折叠后列宽上限（"统一以小号为准"）
      // 容器够宽则均分；不够宽则每列固定 160，总表宽 = N*160，靠 .table-wrapper 横向滚动
      const each = Math.min(MAX_COL, Math.floor((wrapW - 2) / N));
      // 🟢 v172：标记父容器进入折叠模式（CSS 兜底用）
      if (wrap.parentElement) wrap.parentElement.classList.add('col-collapse-mode');
      visThs.forEach(th => {
        th.style.width = each + 'px';
        th.style.minWidth = each + 'px';
        th.style.maxWidth = each + 'px';
        th.style.overflow = 'hidden';
        th.style.textOverflow = 'ellipsis';
        th.style.whiteSpace = 'nowrap';
      });
      // 🟢 v172：所有可见行 td 都设 ellipsis + nowrap + overflow（不再仅首行；防止长文本溢出到右列）
      table.querySelectorAll('tbody tr').forEach(tr => {
        Array.from(tr.children).forEach(td => {
          if (!td.classList.contains('col-collapsed')) {
            td.style.width = each + 'px';
            td.style.maxWidth = each + 'px';
            td.style.minWidth = each + 'px';
            td.style.overflow = 'hidden';
            td.style.textOverflow = 'ellipsis';
            td.style.whiteSpace = 'nowrap';
          }
        });
      });
      // 表格总宽 = N * each；可能略 > wrap.clientWidth，触发 .table-wrapper 的 overflow-x:auto 横向滚动
      table.style.width = (each * N) + 'px';
      table.style.minWidth = (each * N) + 'px';
    } else {
      table.style.width = '';
      table.style.minWidth = '0';
    }

    if (hidden === 0) {
      if (btn) btn.style.display = 'none';
    } else {
      if (btn) { btn.style.display = ''; btn.textContent = `展开剩余 ${hidden} 列 ▾`; btn.dataset.state = 'collapsed'; }
    }
  },

  _hideColInTable(tableEl, idx, hide) {
    if (!tableEl) return;
    const thead = tableEl.querySelector('thead');
    if (thead && thead.children[0] && thead.children[0].children[idx]) {
      thead.children[0].children[idx].classList.toggle('col-collapsed', hide);
    }
    tableEl.querySelectorAll('tbody tr').forEach(tr => {
      if (tr.children[idx]) tr.children[idx].classList.toggle('col-collapsed', hide);
    });
    tableEl.querySelectorAll('tfoot tr').forEach(tr => {
      if (tr.children[idx]) tr.children[idx].classList.toggle('col-collapsed', hide);
    });
  },

  _resetCollapse(wrap, table) {
    table.querySelectorAll('thead th, tbody td, tfoot td').forEach(c => c.classList.remove('col-collapsed'));
    if (wrap._colCollapseBtn) wrap._colCollapseBtn.style.display = 'none';
  },

  install(container) {
    const wrap = typeof container === 'string'
      ? (document.getElementById(container) || document.querySelector(container))
      : container;
    if (!wrap) return;
    // 🟢 v134：脱离文档的 wrap 不装（模块切换时旧 DOM 已被移除，MutationObserver/重渲染可能再次传入旧节点，装了就是孤儿浮层）
    if (!document.body.contains(wrap)) return;
    // 🟢 v134：防嵌套——如果这个 wrap 是某个已 install 的 wrap 的子节点，跳过（让外层 wrap 独占浮层）
    // 场景：#contentArea 内 #ocDetailTable（id）包着 #ocTableContainer（id 也带 id），initSortableHeadersAuto 会把两层都当容器，
    //       结果同一个 .data-table 被装两套浮层，浮层在 body 累积
    let ancestor = wrap.parentElement;
    while (ancestor && ancestor !== document.body) {
      if (ancestor._stickyOverlayHandle || ancestor._mobileStickyInstalled) {
        return;
      }
      ancestor = ancestor.parentElement;
    }
    // 🟢 v134：防重复 install，先卸载旧的（避免累积浮层/监听器）
    if (wrap._mobileStickyInstalled || wrap._stickyOverlayHandle) {
      this.uninstall(wrap);
    }
    if (!this.isNarrow()) return;

    const table = wrap.querySelector('.data-table');
    if (!table) return;
    const thead = table.querySelector('thead');
    const tds = table.querySelectorAll('tbody td:first-child');
    if (!thead || tds.length === 0) return;

    // 🟢 v140：表头用原生 sticky（收起/展开都固定标题），不再用纵滚才出现的 JS 浮层。
    //   JS 浮层在隐藏列后剩余列会被拉伸撑变形，且只在 sT>0 才显示——不符合需求。
    this.keepSticky(wrap, table);

    const update = () => {
      const r = wrap.getBoundingClientRect();
      // 表完全滚出视口：复位 sticky（避免错位），否则保持原生 sticky 表头
      if (r.bottom <= 0 || r.top >= window.innerHeight) {
        this._syncStickyHeader(wrap, table, true);
      } else {
        this._syncStickyHeader(wrap, table, false);
      }
    };

    // 🟢 v134：监听器统一管理，便于 uninstall 解绑
    const touchEndUpdate = () => setTimeout(update, 50);
    const fns = [
      [wrap, 'scroll', update, { passive: true }],
      [window, 'scroll', update, { passive: true }],
      [window, 'resize', update, undefined],
      // 🟢 v134：长按下滑手势——iOS Safari 可能不派发 scroll/click，要靠 touchmove 强制刷新位置
      [wrap, 'touchmove', update, { passive: true }],
      [wrap, 'touchend', touchEndUpdate, { passive: true }],
      [document, 'selectionchange', update, { passive: true }]
    ];
    fns.forEach(([el, ev, fn, opts]) => {
      el.addEventListener(ev, fn, opts);
      window._overlayGlobalListeners.push({ el, ev, fn, opts, wrap });
    });

    // 表格尺寸变化（排序/筛选后重排、列宽 resize）时重建
    const rebuild = () => {
      // 已脱离文档的 wrap 直接清理走人，不再重装（避免孤儿浮层累积）
      if (!document.body.contains(wrap)) {
        TableStickyOverlay.uninstall(wrap);
        return;
      }
      wrap._mobileStickyInstalled = false;
      wrap._stickyOverlayHandle = null;
      window._overlayGlobalListeners = window._overlayGlobalListeners.filter(l => l.wrap !== wrap);
      TableStickyOverlay.install(wrap);
    };

    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => {
        clearTimeout(wrap._mobileStickyResizeT);
        wrap._mobileStickyResizeT = setTimeout(rebuild, 180);
      });
      ro.observe(wrap);
      ro.observe(table);
    }

    wrap._stickyOverlayHandle = { update, ro, fns };
    wrap._mobileStickyInstalled = true;
    window._installedWraps.add(wrap);
    update();
    // 🟢 v139：移动端列折叠（替代固定首列浮层）
    this.installColumnCollapse(wrap, table);
  },

  /**
   * 🟢 v140：原生 sticky 表头（移动端）
   * 让 .data-table thead 用 position:sticky;top:0 固定标题（收起/展开都固定），
   * 数据行在 .table-wrapper 内纵向滑动。iOS Safari 在 .table-wrapper 设 overflow:auto 时
   * sticky 表头表现可靠（优于原生 thead sticky，故 v134 曾改用 JS 浮层；v140 在 overflow:auto 容器下恢复原生 sticky）。
   * 横向滚动时同步 sticky 表头的 left 偏移，使其随数据列横向移动而保持对齐。
   * 🟢 v172：折叠态列宽上限 160，所有可见 td 加 ellipsis + nowrap + overflow（不再仅首行；解决 3 截图溢出 / 放大问题）
   */
  keepSticky(wrap, table) {
    const thead = table.querySelector('thead');
    if (thead) {
      thead.style.position = 'sticky';
      thead.style.top = '0';
      thead.style.zIndex = '5';
    }
    this._syncStickyHeader(wrap, table, false);
  },

  _syncStickyHeader(wrap, table, reset) {
    const thead = table.querySelector('thead');
    if (!thead) return;
    if (reset) {
      thead.style.position = '';
      thead.style.top = '';
      thead.style.left = '';
      thead.style.zIndex = '';
      return;
    }
    // 横向滚动时让 sticky 表头跟随 left 偏移，保持与数据列对齐
    thead.style.left = `${-wrap.scrollLeft}px`;
  },

  /**
   * 🟢 v134：卸载某个 wrap 上的浮层 + 所有监听
   * - 移除挂在 document.body 的两个浮层 DOM
   * - 解绑 wrap/window/document 监听
   * - ResizeObserver.disconnect
   * - 复位 _mobileStickyInstalled / _stickyOverlayHandle
   *   模块切换时调用，避免旧浮层残留在 body 上影响下次渲染或被错误激活
   */
  uninstall(wrap) {
    if (!wrap) return;
    const h = wrap._stickyOverlayHandle;
    if (h) {
      h.fns.forEach(([el, ev, fn, opts]) => el.removeEventListener(ev, fn, opts));
      if (h.ro && typeof h.ro.disconnect === 'function') h.ro.disconnect();
    }
    // 🟢 v140：复位 sticky 表头（避免遗留 style 影响后续渲染）
    const table = wrap.querySelector && wrap.querySelector('.data-table');
    if (table) {
      const thead = table.querySelector('thead');
      if (thead) { thead.style.position = ''; thead.style.top = ''; thead.style.left = ''; thead.style.zIndex = ''; }
    }
    // 🟢 v139：清理列折叠按钮（挂在 wrap 的父节点上）
    if (wrap._colCollapseBtn && wrap._colCollapseBtn.parentNode) {
      wrap._colCollapseBtn.parentNode.removeChild(wrap._colCollapseBtn);
    }
    wrap._colCollapseBtn = null;
    wrap._colCollapsed = undefined;
    // 防御性：清掉属于这个 wrap 的全局监听记录
    window._overlayGlobalListeners = window._overlayGlobalListeners.filter(l => l.wrap !== wrap);
    if (window._installedWraps && typeof window._installedWraps.delete === 'function') {
      window._installedWraps.delete(wrap);
    }
    wrap._stickyOverlayHandle = null;
    wrap._mobileStickyInstalled = false;
  },

  /**
   * 🟢 v134：模块级统一卸载——清掉所有 wrap 上的浮层 + 监听
   * App.go 切换模块前调用，避免多模块累计
   */
  uninstallAll() {
    // 拷贝已注册的 wraps
    const installed = window._overlayGlobalListeners.map(l => l.wrap);
    const uniqWraps = Array.from(new Set(installed));
    uniqWraps.forEach(w => {
      try { this.uninstall(w); } catch (e) { /* wrap 可能已 detach */ }
    });
    // 兜底：清掉 body 上任何残留浮层（即便 uninstall 失败）
    document.querySelectorAll('.mobile-float-thead, .mobile-float-firstcol').forEach(n => {
      try { n.remove(); } catch (e) { /* noop */ }
    });
  }
};
window.TableStickyOverlay = TableStickyOverlay;

const TableUtils = {
  // 数值列检测关键词（中文列名）
  NUMERIC_KEYWORDS: ['数量', '金额', '单价', '价格', '占比', '天数', '次数', '存量', '入库量', '订货量', '订单量', '周转', '总量', '库存', '可用量', '无法使用量', '在途', '比例', '合计', '总价', '月均', '扣款', '延迟'],

  /**
   * 初始化 Excel 式表头：点击排序(升/降/无) + 筛选图标弹出关键词搜索
   * 直接基于当前页渲染的 DOM 表格操作，稳健适配所有模块（不依赖 JS 数据数组）
   * 🟢 v113：扩展支持 opts.tableKey（用于对齐/列宽偏好按数据表名记忆） + opts.getColField 自定义列字段名
   * 🟢 v192：扩展 opts.initialSort（{col, dir}）首次渲染高亮+应用排序；opts.onSortChange(field, dir) 排序变化回调
   *     —— 给详情页"数据层排序 + 跨页保留"用，主模块不传参时走老路径不破坏现有行为
   * @param {string} containerId - 表格容器ID（内含 .data-table）
   * @param {object} [opts] - { tableKey: string, getColField?: (th, colIdx)=>string,
   *                            initialSort?: {col:number, dir:1|2|0},
   *                            onSortChange?: (field:string, dir:1|2|0)=>void }
   */
  initSortableHeaders(containerId, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const table = container.querySelector('.data-table');
    if (!table) return;
    const thead = table.querySelector('thead');
    if (!thead) return;

    const tableKey = opts.tableKey || TableUtils._deriveTableKey(table) || containerId;
    const getColField = opts.getColField || ((th) => {
      const lbl = th.querySelector('.th-sort-label');
      return (lbl ? lbl.textContent : th.textContent).trim();
    });

    const ths = thead.querySelectorAll('th');
    const colFields = Array.from(ths).map(th => getColField(th));
    const columnFilters = {};
    const sortState = { col: -1, dir: 0 };
    if (opts.initialSort && typeof opts.initialSort.col === 'number'
        && [0, 1, 2].includes(opts.initialSort.dir)) {
      sortState.col = opts.initialSort.dir === 0 ? -1 : opts.initialSort.col;
      sortState.dir = opts.initialSort.dir;
    }

    if (tableKey) this._applyAlignPreferences(table, ths, colFields, tableKey);

    let hasRestoredFilter = false;
    if (tableKey) {
      const restored = this._restoreColumnFilters(ths, colFields, tableKey);
      Object.assign(columnFilters, restored.columnFilters);
      hasRestoredFilter = restored.hasRestoredFilter;
    }

    ths.forEach((th, colIdx) => {
      this._bindHeaderInteractions(th, colIdx, { ths, table, tableKey, colFields, columnFilters, sortState, opts });
    });

    if (sortState.dir !== 0 && sortState.col >= 0) {
      this._refreshArrowState(ths, sortState.col, sortState.dir);
      this._applyTableSortAndFilter(table, sortState.col, sortState.dir, columnFilters);
    }
    if (hasRestoredFilter) {
      this._applyTableSortAndFilter(table, sortState.col, sortState.dir, columnFilters);
    }

    if (!TableUtils._outsideBound) {
      document.addEventListener('mousedown', (e) => {
        if (TableUtils._filterPopup && !TableUtils._filterPopup.contains(e.target)) {
          TableUtils._hideFilterPopup();
        }
      });
      TableUtils._outsideBound = true;
    }

    if (window.TableStickyOverlay) TableStickyOverlay.install(container);
  },

  _applyAlignPreferences(table, ths, colFields, tableKey) {
    Array.from(ths).forEach((th, colIdx) => {
      const field = colFields[colIdx];
      if (!field) return;
      const a = TablePrefs.getAlign(tableKey, field) || 'center';
      table.querySelectorAll('tbody tr').forEach(tr => {
        const td = tr.children[colIdx];
        if (td) td.style.textAlign = a;
      });
    });
  },

  _restoreColumnFilters(ths, colFields, tableKey) {
    const columnFilters = {};
    let hasRestoredFilter = false;
    Array.from(ths).forEach((th, colIdx) => {
      const field = colFields[colIdx];
      if (!field || th.getAttribute('data-nofilter') === '1') return;
      const saved = TablePrefs.getFilter(tableKey, field);
      if (saved && (saved.kw || (saved.excluded && saved.excluded.length))) {
        columnFilters[colIdx] = saved;
        hasRestoredFilter = true;
      }
    });
    return { columnFilters, hasRestoredFilter };
  },

  _bindHeaderInteractions(th, colIdx, ctx) {
    const { ths, table, tableKey, colFields, columnFilters, sortState, opts } = ctx;
    if (th.getAttribute('data-nofilter') === '1') {
      th.style.cursor = '';
      return;
    }
    const originalText = th.textContent.trim();
    th.innerHTML = `
      <span class="th-sort-label">${originalText}</span>
      <span class="th-filter-icon" data-col="${colIdx}" title="筛选 / 排序 / 对齐">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2 4 L6 8 L10 4 Z"/></svg>
      </span>
    `;
    th.style.cursor = 'pointer';

    const filterIcon = th.querySelector('.th-filter-icon');
    filterIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      this._showFilterPopup(th, colIdx, columnFilters, (filterState) => {
        columnFilters[colIdx] = filterState;
        const hasActive = !!filterState && (
          !!filterState.kw || (filterState.excluded && filterState.excluded.length > 0)
        );
        filterIcon.classList.toggle('active', hasActive);
        if (tableKey && colFields[colIdx]) TablePrefs.setFilter(tableKey, colFields[colIdx], filterState);
        this._applyTableSortAndFilter(table, sortState.col, sortState.dir, columnFilters);
      }, {
        tableKey,
        colField: colFields[colIdx],
        applyAlign: (align) => {
          table.querySelectorAll('tbody tr').forEach(tr => {
            const td = tr.children[colIdx];
            if (td) td.style.textAlign = align;
          });
        }
      });
    });

    const labelEl = th.querySelector('.th-sort-label');
    if (labelEl) {
      labelEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (sortState.col === colIdx) {
          sortState.dir = sortState.dir === 1 ? 2 : sortState.dir === 2 ? 0 : 1;
        } else {
          sortState.dir = 1;
        }
        sortState.col = sortState.dir === 0 ? -1 : colIdx;
        this._refreshArrowState(ths, sortState.col, sortState.dir);
        this._applyTableSortAndFilter(table, sortState.col, sortState.dir, columnFilters);
        if (typeof opts.onSortChange === 'function') {
          const field = colFields[sortState.col] || '';
          opts.onSortChange(field, sortState.dir);
        }
      });
    }

    if (columnFilters[colIdx]) filterIcon.classList.add('active');
  },


  _refreshArrowState(ths, col, dir) {
    ths.forEach((th, i) => {
      const label = th.querySelector('.th-sort-label');
      if (!label) return;
      // 重置所有表头样式
      label.classList.remove('sort-asc', 'sort-desc');
      // 🟢 v195：排序激活时不再改 label 颜色（v185 表头底色已是冰川蓝渐变，白字改蓝后反差变小、看起来像列颜色变了）。
      //   排序状态由 sort-asc/sort-desc 类的箭头(↑/↓)指示；label 文字色始终跟随 th 的 #ffffff。
      label.style.color = '';
      // 当前排序列高亮
      if (i === col) {
        if (dir === 1) { label.classList.add('sort-asc'); }
        else if (dir === 2) { label.classList.add('sort-desc'); }
      }
    });
  },

  _applyTableSortAndFilter(table, sortCol, sortDir, filters) {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));

    // 1) 重置可见性
    rows.forEach(tr => { tr.style.display = ''; });

    // 2) 值集合筛选 + 关键词筛选（多列叠加生效）
    Object.entries(filters).forEach(([ci, fs]) => {
      if (!fs) return;
      const col = parseInt(ci, 10);

      // 🟢 v148：「排除」语义 — 仅隐藏 excluded 列表里的值；默认（不在 excluded 中）一律显示。
      const excluded = (fs && Array.isArray(fs.excluded)) ? fs.excluded
                      : (Array.isArray(fs?.unchecked) ? fs.unchecked : []); // 旧格式兼容
      if (excluded.length > 0) {
        const excludedSet = new Set(excluded.map(v => v.toLowerCase()));
        rows.forEach(tr => {
          const td = tr.children[col];
          const val = td ? td.textContent.trim().toLowerCase() : '';
          if (excludedSet.has(val)) tr.style.display = 'none';
        });
      }

      // 关键词二次过滤（新旧格式共用）
      const kw = typeof fs === 'string' ? fs : (fs && fs.kw) || '';
      if (kw) {
        const k = kw.toLowerCase();
        rows.forEach(tr => {
          if (tr.style.display === 'none') return;
          const td = tr.children[col];
          const val = td ? td.textContent.toLowerCase() : '';
          if (!val.includes(k)) tr.style.display = 'none';
        });
      }
    });

    // 3) 排序（仅对可见行原地重排）
    if (sortDir !== 0 && sortCol >= 0) {
      const visible = rows.filter(tr => tr.style.display !== 'none');
      visible.sort((a, b) => {
        const va = this._cellToComparable(a.children[sortCol]);
        const vb = this._cellToComparable(b.children[sortCol]);
        if (typeof va === 'number' && typeof vb === 'number') {
          return sortDir === 1 ? va - vb : vb - va;
        }
        const sa = String(va), sb = String(vb);
        return sortDir === 1 ? sa.localeCompare(sb, 'zh') : sb.localeCompare(sa, 'zh');
      });
      visible.forEach(tr => tbody.appendChild(tr));
    }
  },

  _cellToComparable(td) {
    if (!td) return '';
    const raw = (td.textContent || '').trim();
    if (raw === '' || raw === '-' || raw === '—' || raw === '/') return raw;
    // 去掉货币符号/千分位/百分号后尝试数值比较
    const cleaned = raw.replace(/[¥$￥,\s，%]/g, '');
    if (cleaned === '') return raw;
    const n = parseFloat(cleaned);
    if (!isNaN(n)) return n;
    return raw;
  },

  _showFilterPopup(th, colIdx, currentFilters, onConfirm, alignOpts = {}) {
    this._hideFilterPopup();
    const table = th.closest('.data-table');
    const tbody = table ? table.querySelector('tbody') : null;
    const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];

    const { sortedValues } = this._collectColumnValues(rows, colIdx);
    const { currentKw, excludedSet } = this._parseFilterState(currentFilters, colIdx);
    const tableKey = alignOpts.tableKey;
    const colField = alignOpts.colField;
    const applyAlign = alignOpts.applyAlign || (() => {});
    const curAlign = this._resolveCurrentAlign(alignOpts, tbody, colIdx);

    const popupId = 'th-filter-popup-' + Date.now();
    const popup = document.createElement('div');
    popup.className = 'excel-filter-popup';
    popup.id = popupId;
    popup.innerHTML = this._buildFilterPopupHtml({ currentKw, sortedValues, excludedSet, tableKey, colField, curAlign });
    popup.style.position = 'fixed';
    popup.style.zIndex = '9999';
    popup.addEventListener('mousedown', (e) => e.stopPropagation());

    this._attachFilterPopupPositioning(popup, th);
    this._bindFilterPopupEvents(popup, {
      tableKey, colField, applyAlign, curAlign, excludedSet, onConfirm,
    });
    popup.querySelector('.efp-search').focus();
    TableUtils._filterPopup = popup;
  },

  _collectColumnValues(rows, colIdx) {
    const valueMap = new Map();
    rows.forEach(tr => {
      const td = tr.children[colIdx];
      const rawVal = td ? (td.textContent || '').trim() : '';
      const displayVal = rawVal === '' ? '(空)' : rawVal;
      valueMap.set(displayVal, (valueMap.get(displayVal) || 0) + 1);
    });
    const sortedValues = Array.from(valueMap.entries()).sort((a, b) => {
      const na = parseFloat(a[0]), nb = parseFloat(b[0]);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      if (!isNaN(na)) return -1;
      if (!isNaN(nb)) return 1;
      return a[0].localeCompare(b[0], 'zh');
    });
    return { valueMap, sortedValues };
  },

  _parseFilterState(currentFilters, colIdx) {
    const currentFs = currentFilters[colIdx] || null;
    const currentKw = (currentFs && typeof currentFs === 'object') ? (currentFs.kw || '') : (typeof currentFs === 'string' ? currentFs : '');
    let excludedSet = new Set();
    if (currentFs && typeof currentFs === 'object') {
      if (Array.isArray(currentFs.excluded)) {
        excludedSet = new Set(currentFs.excluded);
      } else if (Array.isArray(currentFs.unchecked)) {
        excludedSet = new Set(currentFs.unchecked);
      }
    }
    return { currentKw, excludedSet };
  },

  _resolveCurrentAlign(alignOpts, tbody, colIdx) {
    const tableKey = alignOpts.tableKey;
    const colField = alignOpts.colField;
    const savedAlign = (tableKey && colField) ? TablePrefs.getAlign(tableKey, colField) : null;
    const firstTd = tbody ? tbody.querySelector('tr')?.children[colIdx] : null;
    const tdAlign = firstTd ? (firstTd.style.textAlign || '').replace(/['"\s]/g, '') : '';
    return savedAlign || tdAlign || 'center';
  },

  _buildFilterPopupHtml({ currentKw, sortedValues, excludedSet, tableKey, colField, curAlign }) {
    return `
      <div class="efp-search-row">
        <input type="text" class="efp-search" placeholder="🔍 搜索筛选..." value="${escAttr(currentKw)}" />
      </div>
      ${tableKey && colField ? `
      <div class="efp-align-row" title="设置该列对齐方式（会按数据表+列名记忆）">
        <span class="efp-align-label">对齐：</span>
        <button class="efp-align-btn ${curAlign === 'left' ? 'active' : ''}" data-align="left" title="左对齐">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <g fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="3"  y1="4"  x2="17" y2="4"/>
              <line x1="3"  y1="10" x2="12" y2=" 10"/>
              <line x1="3"  y1="16" x2="15" y2="16"/>
            </g>
          </svg>
        </button>
        <button class="efp-align-btn ${curAlign === 'center' ? 'active' : ''}" data-align="center" title="居中对齐">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <g fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="3"  y1="4"  x2="17" y2="4"/>
              <line x1="5"  y1="10" x2="15" y2="10"/>
              <line x1="4"  y1="16" x2="16" y2="16"/>
            </g>
          </svg>
        </button>
        <button class="efp-align-btn ${curAlign === 'right' ? 'active' : ''}" data-align="right" title="右对齐">
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <g fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="3"  y1="4"  x2="17" y2="4"/>
              <line x1="8"  y1=" 10" x2="17" y2="10"/>
              <line x1="5"  y1="16" x2="17" y2="16"/>
            </g>
          </svg>
        </button>
      </div>
      ` : ''}
      <div class="efp-values" style="max-height:280px;overflow-y:auto;">
        ${sortedValues.length > 0 ? sortedValues.map(([val, count]) => {
          const isChecked = !excludedSet.has(val);
          return `
          <label class="efp-item">
            <input type="checkbox" class="efp-cb" data-val="${this._escapeAttr(val)}" ${isChecked ? 'checked' : ''} />
            <span class="efp-text">${this._escapeHtml(val)}</span>
            <span class="efp-count">(${count})</span>
          </label>`;
        }).join('') : '<div class="efp-empty">无数据</div>'}
      </div>
      <div class="efp-actions">
        <button class="efp-action-btn efp-select-all">全选</button>
        <button class="efp-action-btn efp-invert">反选</button>
        <button class="efp-action-btn efp-ok primary">确定</button>
        <button class="efp-action-btn efp-cancel">取消</button>
      </div>
    `;
  },

  _attachFilterPopupPositioning(popup, th) {
    const popupWidth = 280;
    const updatePopupPos = () => {
      const r = th.getBoundingClientRect();
      popup.style.left = Math.min(r.right, window.innerWidth - popupWidth - 8) + 'px';
      popup.style.top = (r.bottom + 6) + 'px';
    };
    updatePopupPos();
    document.body.appendChild(popup);
    const contentScroll = document.querySelector('.content-scroll');
    const onScroll = () => {
      if (!popup.isConnected) return;
      updatePopupPos();
    };
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    if (contentScroll) contentScroll.addEventListener('scroll', onScroll, { passive: true });
    popup._wbLockHandlers = { onScroll, contentScroll };
    const tableWrapper = th.closest('.table-wrapper');
    if (tableWrapper) tableWrapper.addEventListener('scroll', onScroll, { passive: true });
    popup._wbLockHandlers.tableWrapper = tableWrapper;
  },

  _bindFilterPopupEvents(popup, ctx) {
    const { onConfirm, tableKey, colField, applyAlign, curAlign, excludedSet } = ctx;
    const searchInput = popup.querySelector('.efp-search');
    const allCbs = popup.querySelectorAll('.efp-cb');

    searchInput.addEventListener('input', () => {
      const kw = searchInput.value.toLowerCase().trim();
      allCbs.forEach(cb => {
        const item = cb.closest('.efp-item');
        const text = cb.dataset.val.toLowerCase();
        item.style.display = (!kw || text.includes(kw)) ? '' : 'none';
      });
    });

    popup.querySelector('.efp-select-all').addEventListener('click', () => {
      allCbs.forEach(cb => { cb.checked = true; cb.closest('.efp-item').style.display = ''; });
    });

    popup.querySelector('.efp-invert').addEventListener('click', () => {
      allCbs.forEach(cb => {
        if (cb.closest('.efp-item').style.display !== 'none') {
          cb.checked = !cb.checked;
        }
      });
    });

    let pendingAlign = curAlign;
    popup.querySelectorAll('.efp-align-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const a = btn.dataset.align;
        pendingAlign = a;
        popup.querySelectorAll('.efp-align-btn').forEach(b => b.classList.toggle('active', b.dataset.align === a));
        applyAlign(a);
        if (tableKey && colField) TablePrefs.setAlign(tableKey, colField, a);
      });
    });

    popup.querySelector('.efp-ok').addEventListener('click', () => {
      const allVals = Array.from(popup.querySelectorAll('.efp-cb')).map(cb => cb.dataset.val);
      const checkedVals = Array.from(popup.querySelectorAll('.efp-cb:checked')).map(cb => cb.dataset.val);
      const pageUnchecked = allVals.filter(v => !checkedVals.includes(v));
      const finalExcluded = new Set(excludedSet);
      pageUnchecked.forEach(v => finalExcluded.add(v));
      excludedSet.forEach(v => { if (allVals.includes(v) && checkedVals.includes(v)) finalExcluded.delete(v); });
      const kw = searchInput.value.trim();
      const filterState = (kw || finalExcluded.size > 0) ? { kw, excluded: Array.from(finalExcluded) } : { kw: '', excluded: [] };
      onConfirm(filterState);
      this._hideFilterPopup();
    });

    popup.querySelector('.efp-cancel').addEventListener('click', () => {
      if (pendingAlign !== curAlign) {
        applyAlign(curAlign);
        if (tableKey && colField) TablePrefs.setAlign(tableKey, colField, curAlign);
      }
      this._hideFilterPopup();
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { popup.querySelector('.efp-ok').click(); }
      if (e.key === 'Escape') { popup.querySelector('.efp-cancel').click(); }
    });
  },


  _escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  },

  _escapeAttr(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  _hideFilterPopup() {
    const p = TableUtils._filterPopup;
    if (p) {
      // 🟢 v146：解绑位置锁监听
      if (p._wbLockHandlers) {
        const h = p._wbLockHandlers;
        window.removeEventListener('scroll', h.onScroll, { capture: true });
        if (h.contentScroll) h.contentScroll.removeEventListener('scroll', h.onScroll);
        if (h.tableWrapper) h.tableWrapper.removeEventListener('scroll', h.onScroll);
        p._wbLockHandlers = null;
      }
      p.remove();
    }
    TableUtils._filterPopup = null;
  },

  /**
   * 初始化表格的智能选择功能
   * @param {string} containerId - 表格容器ID（内含 data-table）
   */
  initSmartSelect(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const table = container.querySelector('.data-table');
    if (!table) return;

    // 检测哪些列是数值列
    const numericCols = this.detectNumericColumns(table);

    let isSelecting = false;
    let selectedCells = []; // [{td, rowIdx, colIdx, value}]
    let floatTooltip = null;

    const getCellIndex = (td) => {
      const row = td.parentElement;
      const tbody = row.parentElement;
      return {
        rowIdx: Array.from(tbody.children).indexOf(row),
        colIdx: Array.from(row.children).indexOf(td)
      };
    };

    const clearSelection = () => {
      selectedCells.forEach(c => c.td.classList.remove('cell-selected'));
      selectedCells = [];
      this.hideFloatTooltip();
    };

    const updateSelection = (startCell, endCell) => {
      clearSelection();
      const start = getCellIndex(startCell);
      const end = getCellIndex(endCell);

      const minRow = Math.min(start.rowIdx, end.rowIdx);
      const maxRow = Math.max(start.rowIdx, end.rowIdx);
      const minCol = Math.min(start.colIdx, end.colIdx);
      const maxCol = Math.max(start.colIdx, end.colIdx);

      // 只选择数值列
      const selectedNumericCols = [];
      for (let c = minCol; c <= maxCol; c++) {
        if (numericCols.includes(c)) selectedNumericCols.push(c);
      }
      if (selectedNumericCols.length === 0) return;

      const tbody = startCell.parentElement.parentElement;
      const rows = tbody.children;
      let totalSum = 0;
      const cells = [];

      for (let r = minRow; r <= maxRow; r++) {
        const row = rows[r];
        if (!row) continue;
        selectedNumericCols.forEach(c => {
          const td = row.children[c];
          if (!td) return;
          td.classList.add('cell-selected');
          const val = parseFloat(td.textContent.replace(/[¥,，%]/g, '').trim());
          if (!isNaN(val)) {
            totalSum += val;
            cells.push({ td, rowIdx: r, colIdx: c, value: val });
          }
        });
      }
      selectedCells = cells;

      if (cells.length > 0) {
        this.showFloatTooltip(endCell, totalSum, cells.length);
      }
    };

    // 鼠标事件
    table.addEventListener('mousedown', (e) => {
      const td = e.target.closest('td');
      if (!td || td.closest('thead')) return;
      isSelecting = true;
      clearSelection();
      updateSelection(td, td);
    });

    table.addEventListener('mousemove', (e) => {
      if (!isSelecting) return;
      const td = e.target.closest('td');
      if (!td || td.closest('thead')) return;
      const firstCell = selectedCells.length > 0 ? selectedCells[0].td : td;
      updateSelection(firstCell, td);
    });

    // 点击表格外清除选择（F5 修复：每次渲染先移除上一次绑定的全局监听，
    // 只保留最新一组且引用当前 container/isSelecting，避免重复绑定累积闭包导致内存泄漏）
    if (TableUtils._ssMouseUp) document.removeEventListener('mouseup', TableUtils._ssMouseUp);
    if (TableUtils._ssMouseDown) document.removeEventListener('mousedown', TableUtils._ssMouseDown);
    TableUtils._ssMouseUp = () => {
      if (isSelecting) {
        isSelecting = false;
        // 保持 tooltip 显示，点击其他地方清除
      }
    };
    TableUtils._ssMouseDown = (e) => {
      if (!container.contains(e.target)) {
        clearSelection();
      }
    };
    document.addEventListener('mouseup', TableUtils._ssMouseUp);
    document.addEventListener('mousedown', TableUtils._ssMouseDown);
  },

  /**
   * 检测表格中哪些列是数值列
   */
  detectNumericColumns(table) {
    const thead = table.querySelector('thead');
    if (!thead) return [];
    const headers = thead.querySelectorAll('th');
    const numericCols = [];

    headers.forEach((th, idx) => {
      const text = th.textContent.trim();
      // 明确排除「税率」列，避免税率被误统计
      if (text.includes('税率')) return;
      if (this.NUMERIC_KEYWORDS.some(kw => text.includes(kw))) {
        numericCols.push(idx);
      }
    });

    return numericCols;
  },

  /**
   * 显示浮动汇总 tooltip
   */
  showFloatTooltip(anchorCell, sum, count) {
    this.hideFloatTooltip();
    const tooltip = document.createElement('div');
    tooltip.className = 'cell-summary-tooltip';
    tooltip.innerHTML = `
      <div class="cst-label">已选 ${count} 个数值</div>
      <div class="cst-value">${this.formatSum(sum)}</div>
    `;
    document.body.appendChild(tooltip);

    const rect = anchorCell.getBoundingClientRect();
    tooltip.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
    tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
    tooltip.style.opacity = '1';
    tooltip.style.transform = 'translateY(0)';

    // 延迟更新位置（等渲染完成）
    requestAnimationFrame(() => {
      const tr = tooltip.getBoundingClientRect();
      tooltip.style.left = Math.min(rect.left, window.innerWidth - tr.width - 10) + 'px';
      tooltip.style.top = (rect.top - tr.height - 8) + 'px';
    });

    this._floatTooltip = tooltip;
  },

  hideFloatTooltip() {
    if (this._floatTooltip) {
      this._floatTooltip.remove();
      this._floatTooltip = null;
    }
  },

  // ============================================================
  // 🟢 列宽拖拽调整（通用：所有模块的 .data-table 均可手动拖拽表头右边框改列宽）
  // 通过 MutationObserver（app.js 启动时挂载）对各模块表格自动初始化，无需逐个模块改代码
  // ============================================================

  /**
   * 为单个表格初始化列宽拖拽：
   *  - 锁定当前各列渲染宽度，避免拖动时互相挤压
   *  - 处于横向滚动容器内时，表格宽度按列宽总和扩展，可横向滚动
   *  - 切换为 table-layout:fixed，使拖拽精确可控
   *  - 每个表头右侧注入 .col-resize-handle 拖拽手柄（幂等，可重复调用）
   *  - 🟢 v113：从 TablePrefs 读取已记忆的列宽；拖拽结束写回
   * @param {HTMLTableElement} table
   * @param {object} [opts] - { tableKey?: string, getColField?: (th, colIdx)=>string }
   */
  initColumnResize(table, opts = {}) {
    if (!table) return;
    const thead = table.querySelector('thead');
    if (!thead) return;
    const ths = thead.querySelectorAll('th');
    if (!ths.length) return;

    const tableKey = opts.tableKey || table.dataset.tableKey || null;
    const getColField = opts.getColField || ((th) => {
      const lbl = th.querySelector('.th-sort-label');
      return (lbl ? lbl.textContent : th.textContent).trim();
    });

    const firstTime = table.dataset.colResize !== '1';
    if (firstTime) {
      const hasPreset = this._detectPresetColumns(table, ths);
      const remembered = this._readRememberedWidths(ths, tableKey, getColField);
      this._lockWidthsAndBaseline(table, ths, tableKey, getColField, hasPreset, remembered);
    }

    this._applyPcConstraints(table, tableKey);
    this._bindResizeHandles(table, ths, tableKey, getColField);
  },

  _detectPresetColumns(table, ths) {
    const _scrollP = this._findScrollParent(table) || table.parentElement;
    const _containerW0 = (_scrollP ? _scrollP.clientWidth
      : (table.parentElement ? table.parentElement.clientWidth : table.offsetWidth)) - 2;
    const _presetThs = Array.from(ths).filter(th => parseFloat(th.style.width) > 0);
    return ths.length >= 3
      && _presetThs.length >= Math.ceil(ths.length * 0.8)
      && _presetThs.reduce((a, th) => a + parseFloat(th.style.width), 0) > _containerW0;
  },

  _readRememberedWidths(ths, tableKey, getColField) {
    const remembered = {};
    if (tableKey) {
      ths.forEach((th, idx) => {
        const field = getColField(th);
        if (!field) return;
        const w = TablePrefs.getColWidth(tableKey, field);
        if (w) remembered[idx] = w;
      });
    }
    return remembered;
  },

  _lockWidthsAndBaseline(table, ths, tableKey, getColField, hasPreset, remembered) {
    let colSum = 0;
    ths.forEach((th, idx) => {
      const rememberedW = remembered[idx];
      let w;
      if (rememberedW) {
        w = rememberedW;
      } else if (!th.style.width && th.offsetWidth > 0) {
        w = th.offsetWidth;
      } else {
        w = parseFloat(th.style.width) || th.offsetWidth || 80;
      }
      th.style.width = w + 'px';
      th.style.minWidth = w + 'px';
      colSum += w;
    });

    if (tableKey && !TablePrefs.hasAnyColWidth(tableKey)) {
      if (!hasPreset) {
        const scrollParent = this._findScrollParent(table) || table.parentElement;
        const containerW = (scrollParent ? scrollParent.clientWidth
          : (table.parentElement ? table.parentElement.clientWidth : table.offsetWidth)) - 2;
        if (colSum > containerW && containerW > 0 && colSum > 0) {
          const scale = containerW / colSum;
          ths.forEach((th) => {
            const w = Math.max(36, Math.round(parseFloat(th.style.width) * scale));
            th.style.width = w + 'px';
            th.style.minWidth = w + 'px';
          });
          colSum = containerW;
        }
        ths.forEach((th) => {
          const field = getColField(th);
          if (!field) return;
          const w = parseFloat(th.style.width);
          if (!isNaN(w) && w > 0) TablePrefs.setColWidth(tableKey, field, w);
        });
      }
    }
    if (colSum > 0) {
      table.style.width = colSum + 'px';
      table.style.minWidth = colSum + 'px';
    }

    if (getComputedStyle(table).tableLayout !== 'fixed') {
      table.style.tableLayout = 'fixed';
    }
    table.dataset.colResize = '1';
  },

  _applyPcConstraints(table, tableKey) {
    if (window.innerWidth > 768) {
      const useScrollMode = this._shouldUseScrollMode(table, tableKey);
      if (useScrollMode) {
        this._applyScrollWidths(table, tableKey);
      } else {
        this._fitColumnsToContainer(table);
      }
    }
  },

  _bindResizeHandles(table, ths, tableKey, getColField) {
    ths.forEach(th => {
      if (th.dataset.noresize === '1') return;
      if (th.querySelector(':scope > .col-resize-handle')) return;

      const handle = document.createElement('span');
      handle.className = 'col-resize-handle';
      handle.title = '拖动调整列宽';
      th.appendChild(handle);

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = th.offsetWidth;
        const isDesktop = window.innerWidth > 768;
        const scrollParent = this._findScrollParent(table) || table.parentElement;
        const containerW = scrollParent ? scrollParent.clientWidth : (table.parentElement ? table.parentElement.clientWidth : table.offsetWidth);
        const onMove = (ev) => {
          let newWidth = Math.max(30, startWidth + (ev.clientX - startX));
          if (isDesktop) {
            const otherSum = Array.from(table.querySelectorAll('thead th')).reduce((sum, t) => {
              if (t === th) return sum;
              const w = parseFloat(t.style.minWidth || t.style.width);
              return sum + (isNaN(w) ? t.offsetWidth : w);
            }, 0);
            const maxForThis = Math.max(30, containerW - 2 - otherSum);
            newWidth = Math.min(newWidth, maxForThis);
            th.style.width = newWidth + 'px';
            th.style.minWidth = newWidth + 'px';
            const total = otherSum + newWidth;
            table.style.width = total + 'px';
            table.style.minWidth = total + 'px';
          } else {
            th.style.width = newWidth + 'px';
            th.style.minWidth = newWidth + 'px';
          }
        };
        const onUp = () => {
          document.body.classList.remove('col-resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (isDesktop) this._fitColumnsToContainer(table);
          if (tableKey) {
            const field = getColField(th);
            const finalW = parseFloat(th.style.width || th.style.minWidth || th.offsetWidth);
            if (field && !isNaN(finalW)) TablePrefs.setColWidth(tableKey, field, finalW);
          }
        };
        document.body.classList.add('col-resizing');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  },


  /**
   * 查找 table 的横向可滚动祖先（overflow-x: auto/scroll）
   * @param {HTMLElement} el
   * @returns {HTMLElement|null}
   */
  _findScrollParent(el) {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      const ox = cs.overflowX;
      if (ox === 'auto' || ox === 'scroll' || cs.overflow === 'auto' || cs.overflow === 'scroll') {
        return p;
      }
      p = p.parentElement;
    }
    return null;
  },

  /**
   * 🟢 v142：桌面端让表格总宽 = 各列宽之和（且 ≤ 容器宽），最后一列始终可见、无横向滚动条。
   *  - 若列宽总和 > 容器宽：等比压缩各列到总和 = 容器宽（消除初始溢出/横滚）。
   *  - 若列宽总和 ≤ 容器宽：表格宽 = 列宽之和（尊重用户记忆宽度，可留白）。
   *  - 每次初始化（含补手柄）都重算，确保列宽变化后表格宽度跟随、不超过容器。
   * @param {HTMLTableElement} table
   */
  _fitColumnsToContainer(table) {
    const ths = Array.from(table.querySelectorAll('thead th'));
    if (!ths.length) return;
    const scrollParent = this._findScrollParent(table) || table.parentElement;
    const containerW = (scrollParent ? scrollParent.clientWidth
      : (table.parentElement ? table.parentElement.clientWidth : table.offsetWidth)) - 2;
    const widths = ths.map(th => {
      const w = parseFloat(th.style.width);
      return isNaN(w) ? th.offsetWidth : w;
    });
    const sum = widths.reduce((a, b) => a + b, 0);
    if (sum > containerW && sum > 0) {
      // 超出容器：等比压缩各列宽，使总和恰好 = 容器宽（最后一列贴右边界、无横滚）
      const scale = containerW / sum;
      ths.forEach((th, i) => {
        const w = Math.max(36, Math.round(widths[i] * scale));
        th.style.width = w + 'px';
        th.style.minWidth = w + 'px';
      });
      table.style.width = containerW + 'px';
      table.style.minWidth = containerW + 'px';
    } else {
      // 未超出：表格宽 = 列宽之和，不强制充满（保留用户记忆的留白）
      table.style.width = sum + 'px';
      table.style.minWidth = sum + 'px';
    }
  },

  /**
   * 🟢 v145：判断某表格是否应走「横滚模式」（尊重已有列宽、不压缩）：
   *   满足任一条件即走横滚模式——
   *   1) 该 tableKey 在 TablePrefs 中已有记忆列宽（用户拖过/对齐过）；
   *   2) 表格 th 普遍带模板预设 inline width，且列宽总和 > 容器宽（如订货核对明细表）。
   *   横滚模式下表格宽 = 列宽之和，由可横滚祖先提供横向滚动，标题正常展开不挤。
   * @param {HTMLTableElement} table
   * @param {string|null} tableKey
   * @returns {boolean}
   */
  _shouldUseScrollMode(table, tableKey) {
    // 条件1：有记忆列宽 → 尊重记忆，不压缩（修复 v142 记忆被覆盖的问题）
    if (tableKey && typeof TablePrefs !== 'undefined' && TablePrefs.getColWidth) {
      const ths = table.querySelectorAll('thead th');
      for (const th of ths) {
        const lbl = th.querySelector('.th-sort-label');
        const field = (lbl ? lbl.textContent : th.textContent).trim();
        if (field && TablePrefs.getColWidth(tableKey, field)) return true;
      }
    }
    // 条件2：模板预设列宽且总和 > 容器 → 保留设计列宽，横滚展示
    const ths = Array.from(table.querySelectorAll('thead th'));
    if (ths.length >= 3) {
      const presetCnt = ths.filter(th => parseFloat(th.style.width) > 0).length;
      if (presetCnt >= Math.ceil(ths.length * 0.8)) {
        const scrollParent = this._findScrollParent(table) || table.parentElement;
        const containerW = (scrollParent ? scrollParent.clientWidth
          : (table.parentElement ? table.parentElement.clientWidth : table.offsetWidth)) - 2;
        const sum = ths.reduce((a, th) => a + (parseFloat(th.style.width) || th.offsetWidth), 0);
        if (sum > containerW) return true;
      }
    }
    return false;
  },

  /**
   * 🟢 v145：横滚模式——尊重各列已有宽度（记忆 or 模板预设），表格宽 = 列宽之和，
   *   由可横滚祖先提供横向滚动。不压缩任何列，标题保持正常宽度。
   * @param {HTMLTableElement} table
   * @param {string|null} tableKey
   */
  _applyScrollWidths(table, tableKey) {
    const ths = Array.from(table.querySelectorAll('thead th'));
    if (!ths.length) return;
    // 确保每列有确定宽度（记忆优先，否则用当前 inline/渲染宽），并锁定 min-width
    ths.forEach(th => {
      const lbl = th.querySelector('.th-sort-label');
      const field = (lbl ? lbl.textContent : th.textContent).trim();
      let w = null;
      if (tableKey && typeof TablePrefs !== 'undefined' && TablePrefs.getColWidth) {
        const m = TablePrefs.getColWidth(tableKey, field);
        if (m) w = m;
      }
      if (w == null) {
        const inline = parseFloat(th.style.width);
        w = !isNaN(inline) && inline > 0 ? inline : (th.offsetWidth > 0 ? th.offsetWidth : 80);
      }
      th.style.width = w + 'px';
      th.style.minWidth = w + 'px';
    });
    const sum = ths.reduce((a, th) => a + (parseFloat(th.style.width) || 0), 0);
    table.style.width = sum + 'px';
    table.style.minWidth = sum + 'px';
  },

  /**
   * 初始化某个根节点下所有未初始化的 .data-table 列宽拖拽
   * 🟢 v113：支持传入 opts.tableKey / opts.getColField（用于按数据表名记忆列宽）
   * @param {HTMLElement|object} [rootOrOpts]
   */
  initColumnResizers(rootOrOpts) {
    const isOpts = rootOrOpts && typeof rootOrOpts === 'object' && !(rootOrOpts instanceof HTMLElement);
    const opts = isOpts ? rootOrOpts : {};
    const root = isOpts ? document : (rootOrOpts || document);
    const baseTableKey = opts.tableKey || null;
    root.querySelectorAll('.data-table').forEach(t => {
      const keyForTable = baseTableKey
        || TableUtils._deriveTableKey(t)
        || null;
      this.initColumnResize(t, { ...opts, tableKey: keyForTable });
      // 🟢 v143：补挂移动端列折叠。v139 列折叠原本只通过 initSortableHeaders→TableStickyOverlay.install
      //   链路挂到部分模块；像 reconciliation 的 recSummary 内嵌表格、库存预警等未显式调 initSortableHeaders 的
      //   表格移动端就没有"展开剩余N列"按钮、超宽列被挤成竖条。这里统一补挂。
      //   wrap 优先取最近带 id 的祖先容器（与 initSortableHeaders 的 containerId 语义一致，避免同一个表格被
      //   不同 wrap 重复挂导致按钮状态不同步），其次 .table-wrapper，兜底 parentElement。
      //   桌面端 isNarrow()=false → installColumnCollapse 内部走 _resetCollapse，仅清折叠态、不动 th.style.width，不影响 PC 列宽。
      const wrap = t.closest('[id]') || t.closest('.table-wrapper') || t.parentElement;
      if (wrap) {
        // 避免重复挂：如果该表格已被 initSortableHeaders→install（keepSticky 链路）处理过
        // （祖先容器带 _mobileStickyInstalled / _colCollapseBtn 标记），则跳过，避免同一表格
        // 被不同 wrap 重复处理导致按钮状态不同步、点击无法展开。
        let already = false;
        let p = t;
        while (p && p !== document.body) {
          if (p._colCollapseBtn || p._mobileStickyInstalled || p._stickyOverlayHandle) { already = true; break; }
          p = p.parentElement;
        }
        if (!already) {
          try { TableStickyOverlay.installColumnCollapse(wrap, t); } catch (e) { /* 表格无 thead 等异常时静默跳过 */ }
        }
      }
    });
  },

  /**
   * 🟢 v113：推导表格的 tableKey（用于列宽/对齐记忆）
   * 优先级：表格自身 data-table-key → 最近的 [data-table-key] 祖先 → 最近带 id 容器（去后缀）
   * @param {HTMLElement} table
   * @returns {string|null}
   */
  _deriveTableKey(table) {
    if (!table) return null;
    if (table.dataset.tableKey) return table.dataset.tableKey;
    const ancestor = table.closest('[data-table-key]');
    if (ancestor) return ancestor.dataset.tableKey;
    // 最近的「带 id 容器」整体作为 tableKey（各模块容器 id 天然唯一，如 orderTableArea / stockTableArea）
    let p = table.parentElement;
    while (p && p !== document.body) {
      if (p.id) return p.id.replace(/^#/, '') || null;
      p = p.parentElement;
    }
    return null;
  },

  /**
   * 🟢 v113：自动为根节点下所有「未挂过 ▼筛选键」的 .data-table 挂筛选+对齐按钮组
   *  - 通过 .data-table 最近的 [data-table-key] 祖先识别 tableKey（用于偏好记忆）
   *  - 通过 .data-table 的 data-sortable-initialized 标记避免重复初始化
   *  - 模块自己显式调 initSortableHeaders(containerId, opts) 的优先（更快、更精确）
   * @param {HTMLElement} [root]
   */
  initSortableHeadersAuto(root) {
    const base = root || document;
    base.querySelectorAll('.data-table').forEach(table => {
      if (table.dataset.sortableInitialized === '1') return;
      const thead = table.querySelector('thead');
      if (!thead) return;
      const ths = thead.querySelectorAll('th');
      if (!ths.length) return;
      const tableKey = TableUtils._deriveTableKey(table) || null;
      // 找到最近的容器 id（往上查带 id 的祖先）作为 initSortableHeaders 的第一个参数
      let p = table.parentElement;
      while (p && p !== document.body && !p.id) p = p.parentElement;
      const containerId = (p && p.id) ? p.id : null;
      if (!containerId) return; // 没容器 id 就跳过（避免误初始化 body 内任何 .data-table）
      try {
        this.initSortableHeaders(containerId, { tableKey });
        table.dataset.sortableInitialized = '1';
      } catch (e) { /* 容器内可能没有 .data-table */ }
    });
  },

  formatSum(num) {
    if (Math.abs(num) >= 100000000) return '¥' + (num / 100000000).toFixed(2) + ' 亿';
    if (Math.abs(num) >= 10000) return '¥' + (num / 10000).toFixed(2) + ' 万';
    return '¥' + new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  },

  // ============================================================
  // 🟢 共享工具（O1/O2/O3/O5 去重）：导出 / 格式化 / 日期 / 编码键
  // ============================================================

  // 金额格式化（M3 统一入口：默认 2 位小数、千分位、空值返回 ''；不带 ¥ 前缀，前缀由模板拼接）
  formatMoney(num, fractionDigits = 2) {
    if (num == null || num === '') return '';
    const n = Number(num);
    if (isNaN(n)) return '';
    return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(n);
  },

  // 数量格式化（M3 统一入口：最多 4 位小数、去尾随 0、千分位、空值返回 ''；不再 Math.round 丢精度）
  formatNum(num, maxFractionDigits = 4) {
    if (num == null || num === '') return '';
    const n = Number(num);
    if (isNaN(n)) return '';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: maxFractionDigits }).format(n);
  },

  // 🟢 O4：图表主题色集中管理（原散落各模块的硬编码三元/数组，便于统一换肤）
  // 坐标轴/图例文字色（明/暗）
  chartTextColor(isDark) { return isDark ? '#94A3B8' : '#64748B'; },
  // 多序列图表通用调色板（与 dashboard.js 原 palette 数组一致）
  CHART_PALETTE: ['#3B82C4','#6DBF9F','#A78BFA','#D49595','#D4A870','#38BDF8','#34D399','#FB7185','#FBBF24','#8B5CF6'],

  // 🟢 O3：统一分页栏渲染（各列表模块分页 HTML 完全一致，抽此处消除重复）
  // opts: { module, section, total, totalPages, page, pageSize, pageSizes }
  //   module   —— 模块全局名（如 'StockModule'），用于生成 onclick="Module.goPage(...)"
  //   section  —— 可选；多 section 详情页传此值，回调签名变为 Module.goPage(section, N)
  //   page     —— 当前页（1-based）；totalPages —— 总页数；pageSize —— 每页条数
  //   没有 section 时退回旧形式（Module.goPage(N)），保持 14 个主模块零改动
  renderPagination(containerId, opts) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const { module, section = '', total = 0, totalPages = 1, page = 1, pageSize = 20, pageSizes = [20, 50, 100, 'all'] } = opts;
    const isAll = pageSize === 'all';
    const p = isAll ? 1 : Math.max(1, Math.min(page, totalPages || 1));
    const tp = isAll ? 1 : Math.max(1, totalPages || 1);
    const start = Math.max(1, p - 2);
    const end = Math.min(tp, start + 4);
    const nums = [];
    for (let i = start; i <= end; i++) nums.push(i);
    const optsHtml = pageSizes.map(s => {
      const selected = pageSize === s ? 'selected' : '';
      const label = s === 'all' ? '全部' : s;
      return `<option value="${s}" ${selected}>${label}</option>`;
    }).join('');
    const jumperId = containerId + 'Jumper';
    // 翻页器点击回调：多 section 模式下携带 section 标识（Module.goPage('sd-orders', 5)），
    // 单 section 模式退回旧形式 Module.goPage(5) 保持主模块兼容。
    const secArg = section ? `'${section.replace(/'/g, "\\'")}', ` : '';
    el.innerHTML = `
      <span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>
      <span class="page-btns">
        <button onclick="${module}.goPage(${secArg}1)" ${p === 1 ? 'disabled' : ''}>«</button>
        <button onclick="${module}.goPage(${secArg}${p - 1})" ${p === 1 ? 'disabled' : ''}>‹</button>
        ${nums.map(i => `<button class="${i === p ? 'active' : ''}" onclick="${module}.goPage(${secArg}${i})">${i}</button>`).join('')}
        <button onclick="${module}.goPage(${secArg}${p + 1})" ${p === tp ? 'disabled' : ''}>›</button>
        <button onclick="${module}.goPage(${secArg}${tp})" ${p === tp ? 'disabled' : ''}>»</button>
      </span>
      <span style="font-size:12px;color:var(--text-secondary);">
        每页 <select onchange="${module}.changePageSize(${secArg}this.value === 'all' ? 'all' : parseInt(this.value, 10))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
          ${optsHtml}
        </select> 条
      </span>
      <span style="font-size:12px;color:var(--text-secondary);">
        跳至 <input type="number" id="${jumperId}" min="1" max="${tp}" value="${p}"
          onkeydown="if(event.key==='Enter')${module}.goPage(${secArg}parseInt(this.value))"
          style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
        / ${tp} 页
      </span>
    `;
  },

  /**
   * 🟢 v192：近 N 个月过滤（按日期字符串前缀 YYYY-MM-DD 比较）
   *  - 从 supplier-detail 的内联闭包抽出，便于 stock-detail 复用
   *  - 空数据 / 缺日期字段一律排除；months 默认 3
   *  - 时间锚点为「今天 - N 个月」（月对齐），符合 v190 的"近 3 个月"语义
   */
  filterRecent3M(rows, dateField, months = 3) {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return (rows || []).filter(r => {
      const v = r && r[dateField];
      if (!v) return false;
      return String(v).slice(0, 10) >= cutoff;
    });
  },

  // 距离今天的天数（向上取整；负数=已过期；无日期=null）
  daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
  },

  // 月份标签 YYYY-MM（兼容 Date 或日期字符串）
  monthLabel(dateOrStr) {
    const d = (dateOrStr instanceof Date) ? dateOrStr : new Date(dateOrStr);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  // 存货编码查找键：名称|规格，去空白（O5 去重，逻辑与原内联完全一致）
  buildStockKey(name, spec) {
    return ((name || '') + '|' + (spec || '')).replace(/\s+/g, '');
  },

  // 最近 N 个月标签（YYYY-MM，含本月），档案趋势图复用
  lastNMonths(n) {
    const out = [];
    const now = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  },


  // 实体可点击链接（打通模块关联）：点击跳转 App.openEntity(type, key)
  // 文字原样显示，仅 hover 出现下划线；onmousedown 阻止冒泡，避免触发智能选区
  link(type, label, key) {
    const t = escAttr(type ?? '');
    const k = escAttr(key ?? '');
    const text = esc(label ?? '');
    const typeName = ({ order: '订单', supplier: '供应商', stock: '存货' })[type] || '存货';
    return `<a class="entity-link" href="javascript:void(0)" title="查看${typeName}档案" onclick="App.openEntity('${t}','${k}')" onmousedown="event.stopPropagation()">${text}</a>`;
  },

  // 统一 Excel 导出（O1 去重）：rows 为空时提示并返回，行为与原各模块一致
  exportToExcel(rows, filename, sheetName) {
    if (!rows || !rows.length) { WBModal.alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || '数据');
    XLSX.writeFile(wb, filename);
  }
};

// 🟢 O4：三个详情模块的 fmt/backBar/section 逐字一致，抽到此处共享（行为等价）
const DetailCommon = {
  fmt(v) {
    if (v == null || v === '') return '-';
    if (typeof v === 'number') return TableUtils.formatNum(v);
    return v;
  },

  backBar() {
    let crumbs = '';
    if (App.recentEntities && App.recentEntities.length) {
      crumbs = '<div class="detail-recent">' + App.recentEntities.map(e => {
        const isCur = (App.pendingEntity && e.type === App.pendingEntity.type && e.key === App.pendingEntity.key);
        const lbl = esc(e.label || e.key);
        if (isCur) return `<span class="crumb current">${lbl}</span>`;
        return `<span class="crumb" onclick="App.openEntity('${escAttr(e.type)}','${escAttr(e.key)}')">${lbl}</span>`;
      }).join('') + '</div>';
    }
    return `<div class="detail-back" onclick="App.back()">← 返回</div>${crumbs}`;
  },

  section(title, rows, columns, limit = 8, note = '', containerId = '') {
    if (!columns || !columns.length) return '';
    const head = columns.map(c => `<th>${esc(c.label)}</th>`).join('');
    // 移动端默认折叠、桌面默认展开（原生 <details> 手风琴，零额外脚本）
    const isMobile = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
    const openAttr = isMobile ? '' : 'open';
    const idAttr = containerId ? ` id="${containerId}"` : '';
    const wrap = (inner) => `<details class="detail-section" ${openAttr}><summary><h3>${esc(title)} <span class="count">(${rows ? rows.length : 0})</span></h3></summary>${inner}</details>`;
    if (!rows || !rows.length) {
      return wrap(`<div class="empty-state" style="padding:14px;"><div class="empty-icon">📭</div><div class="empty-text">暂无数据</div></div>`);
    }
    const shown = rows.slice(0, limit);
    const body = shown.map(r => `<tr>${columns.map(c => `<td>${c.render ? c.render(r) : esc(DetailCommon.fmt(r[c.field]))}</td>`).join('')}</tr>`).join('');
    const noteHtml = note ? `<div style="font-size:12px;color:var(--status-warning,#b7791f);margin-top:6px;">⚠️ ${esc(note)}</div>` : '';
    return wrap(`<div${idAttr} class="table-wrapper"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${noteHtml}`);
  }
};
window.DetailCommon = DetailCommon;
