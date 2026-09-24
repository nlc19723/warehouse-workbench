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

  // ────────────────────────────────────────────────────────────
  // 🟢 v228.26 弹性权重列宽（Flex Column Model）
  //   背景：旧体系把列宽存成绝对像素（widths[tableKey][field] = 168），
  //   导致 ① 宽屏表格不撑开、右侧大片留白 ② 窄屏被压到 36px 下限、列头截断
  //   ③ 换台机器/换个分辨率拖过的列宽就不对了。
  //   改为存「相对权重 + 最小可读宽度」，渲染时按可用宽度动态分配。
  //   存储结构（v2，与旧 widths 并存，旧值自动迁移一次）：
  //     colFlex: { tableKey: { field: 2.2 } }   // 相对权重，非像素
  //     colMin:  { tableKey: { field: 110 } }   // 可读下限像素
  // ────────────────────────────────────────────────────────────
  getColFlex(tableKey, colField) {
    if (!tableKey || !colField) return null;
    const all = this._read();
    const v = all.colFlex && all.colFlex[tableKey] && all.colFlex[tableKey][colField];
    return (typeof v === 'number' && v > 0) ? v : null;
  },
  setColFlex(tableKey, colField, flex) {
    if (!tableKey || !colField || !(flex > 0)) return;
    const all = this._read();
    all.colFlex = all.colFlex || {};
    all.colFlex[tableKey] = all.colFlex[tableKey] || {};
    all.colFlex[tableKey][colField] = Math.round(flex * 1000) / 1000;
    this._write(all);
  },
  getColMin(tableKey, colField) {
    if (!tableKey || !colField) return null;
    const all = this._read();
    const v = all.colMin && all.colMin[tableKey] && all.colMin[tableKey][colField];
    return (typeof v === 'number' && v > 0) ? v : null;
  },
  setColMin(tableKey, colField, px) {
    if (!tableKey || !colField || !(px > 0)) return;
    const all = this._read();
    all.colMin = all.colMin || {};
    all.colMin[tableKey] = all.colMin[tableKey] || {};
    all.colMin[tableKey][colField] = Math.round(px);
    this._write(all);
  },
  hasAnyColFlex(tableKey) {
    if (!tableKey) return false;
    const all = this._read();
    return !!(all.colFlex && all.colFlex[tableKey] && Object.keys(all.colFlex[tableKey]).length > 0);
  },
  /**
   * 一次性迁移：把旧的 px 列宽换算成 flex 权重。
   * 换算基准 = 该表当前所有列 px 之和（保持原有比例关系不变），
   * 归一化到「列数」为基准，使 flex 值直观（1.0 = 平均宽度）。
   */
  migrateWidthsToFlex(tableKey, fields) {
    if (!tableKey || !Array.isArray(fields) || !fields.length) return false;
    const all = this._read();
    const oldMap = (all.widths && all.widths[tableKey]) || null;
    if (!oldMap) return false;
    const pxs = fields.map(f => (typeof oldMap[f] === 'number' && oldMap[f] > 0) ? oldMap[f] : null);
    const valid = pxs.filter(p => p != null);
    if (valid.length < fields.length * 0.6) return false;   // 覆盖不足，不迁移
    const total = valid.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return false;
    all.colFlex = all.colFlex || {};
    all.colFlex[tableKey] = all.colFlex[tableKey] || {};
    fields.forEach((f, i) => {
      const p = pxs[i];
      if (p == null) return;
      // 归一化：让 Σflex = 列数，则 flex=1 表示该列等于平均宽度
      all.colFlex[tableKey][f] = Math.round(p / total * fields.length * 1000) / 1000;
    });
    // 标记已迁移，避免重复执行
    all.colFlexMigrated = all.colFlexMigrated || {};
    all.colFlexMigrated[tableKey] = 1;
    this._write(all);
    return true;
  },
  isFlexMigrated(tableKey) {
    if (!tableKey) return false;
    const all = this._read();
    return !!(all.colFlexMigrated && all.colFlexMigrated[tableKey]);
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

// 🟢 v227.50：移动端收起态按模块指定保留列（列头文字匹配，抗索引漂移：stock 批量模式首列插复选框、stocktake showInOut 动态列）
const COLLAPSE_KEEP = {
  inbound:           ['存货编码','存货名称','规格型号','入库量'],
  oblTableArea:      ['存货编码','存货名称','规格型号','出库数量'],   // 出库列表（表头叫“出库数量”）
  orders:            ['存货编码','存货名称','规格型号','订单量'],
  trackTableArea:    ['存货编码','存货名称','规格型号','未入库订单量'], // 订单跟踪（表头叫“未入库订单量”）
  stockTableArea:    ['存货编码','存货名称','规格型号','现存数量'],   // 现存量（表头叫“现存数量”）
  inventoryAlert:    ['存货编码','存货名称','规格型号','补货值'],
  stArea:            ['存货编码','存货名称','规格型号','现存量','盘点数量'],
  stRecArea:         ['存货编码','存货名称','规格型号','现存量','盘点数量'],   // 盘点记录列表：v228.43 同步补「现存量」
  pricingTableArea:  ['存货编码','存货名称','规格型号','含税单价'],
  recTableArea:      ['存货编码','存货名称','规格型号','含税金额'],
  supplierTableArea: ['供应商','合同到期日','已入库金额'], // 供应商管理（特殊3列：表头“供应商/合同到期日/已入库金额(元)”）
  'stk-alert':       ['分类','现存量','补货值'],           // 档案页-库存预警
};
const QUERY_KEEP = {
  stock:   ['存货编码','存货名称','规格型号','现存量'],
  orders:  ['存货编码','存货名称','规格型号','订单量'],
  inbound: ['存货编码','存货名称','规格型号','入库量'],
  pricing: ['存货编码','存货名称','规格型号','含税单价'],
};

const TableStickyOverlay = {
  isNarrow() { return window.innerWidth <= 768; },

  // 🟢 v227.50：按表格 key 取该模块收起态要保留的列头文字数组；无配置返回 null（回退保留前3列）
  _resolveKeepConfig(table) {
    const key = TableUtils._deriveTableKey(table);
    if (key === 'queryResultArea' && window.QueryModule) return QUERY_KEEP[window.QueryModule.currentTab] || null;
    return key ? (COLLAPSE_KEEP[key] || null) : null;
  },
  // 🟢 v227.50：把列头文字 token 解析为列索引。
  //   匹配策略：先精确相等（t === tok），否则再“表头包含 token”（t.includes(tok)）——兼容“已入库金额(元)”等带后缀表头。
  //   注意只用单向 t.includes(tok)，不用 tok.includes(t)：否则“未入库订单量”会误命中更靠前的“订单量”子串列。
  _resolveKeepHeaders(table, tokens) {
    const ths = Array.from(table.querySelectorAll('thead th'));
    const texts = ths.map(th => (th.textContent || '').trim());
    const idxs = [];
    for (const tok of tokens) {
      let hit = -1;
      for (let i = 0; i < texts.length; i++) { if (texts[i] === tok) { hit = i; break; } } // 精确优先
      if (hit === -1) for (let i = 0; i < texts.length; i++) { if (texts[i] && texts[i].includes(tok)) { hit = i; break; } } // 再表头包含 token
      if (hit !== -1) idxs.push(hit);
    }
    return idxs;
  },

  /**
   * 给 .table-wrapper 安装移动端浮动表头/首列
   * 关键点：浮层 append 到 document.body（而不是 wrap 内），用 position:fixed 真正贴在屏幕视口；
   *   left / top / width 从 wrap.getBoundingClientRect() 实时取，滚动时更新。
   */

  // 🟢 v139：移动端列折叠——表宽超出视口时从右往左隐藏列，留「展开剩余 N 列」按钮，点击还原。
  //   替代旧的移动端固定首列浮层（mobile-float-firstcol）：用户不需要固定首列，正常显示即可。
  // 🟢 v228.14：收起/展开状态持久化（localStorage，按 tableKey 记忆）。
  //   背景：状态原先只存在 wrap._colCollapsed 内存属性上，切换模块后 DOM 整体重建 → 回到默认「收起」，
  //   用户「展开 → 离开 → 回来」会被强制收起。现在按表格 key 落盘，回来保持离开前的状态。
  //   未手动切换过的表格仍默认收起（保持原有首屏行为，不改动既有体验）。
  // 🟢 v228.93：取消持久化——按需求改为每次进入工作台都默认收起，不再记忆上次展开状态。
  //   故下方 _collapseStateSet / _collapseStateGet 已不再被调用（保留方法以防其它引用，无害）。
  COLLAPSE_STATE_KEY: 'wb_table_col_collapsed',
  _collapseStateAll() {
    try { return JSON.parse(localStorage.getItem(this.COLLAPSE_STATE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  },
  _collapseStateGet(table) {
    const key = TableUtils._deriveTableKey(table);
    if (!key) return null;
    const all = this._collapseStateAll();
    return Object.prototype.hasOwnProperty.call(all, key) ? !!all[key] : null;
  },
  _collapseStateSet(table, val) {
    const key = TableUtils._deriveTableKey(table);
    if (!key) return;
    try {
      const all = this._collapseStateAll();
      all[key] = !!val;
      localStorage.setItem(this.COLLAPSE_STATE_KEY, JSON.stringify(all));
    } catch (e) { /* 隐私模式 / 配额超限：静默降级为不记忆，不影响功能 */ }
  },

  installColumnCollapse(wrap, table) {
    // 🟢 v228.03：豁免标记 —— 带 .no-col-collapse 的表格（如「违约扣款规则」这类静态说明表）
    //   移动端一律全部显示：不折叠任何列、不挂载「展开剩余 N 列」按钮。
    if (table && table.classList && table.classList.contains('no-col-collapse')) {
      this._resetCollapse(wrap, table);
      return;
    }
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
      this._applyCollapse(wrap, table);   // 🟢 v228.93：仅当次会话展开，不落盘记忆（每次进入默认收起）
    });
    if (wrap._colCollapsed === undefined) {
      wrap._colCollapsed = true;   // 🟢 v228.93：每次进入默认收起，不读取历史记忆状态
    }
    this._applyCollapse(wrap, table);
  },

  // 🟢 v228.77：幂等写入助手 —— 值没变就不碰 DOM。
  //   背景（实测）：_applyCollapse 会被 initColumnResizers / installColumnCollapse 反复重跑，
  //   旧实现无条件 btn.textContent = '展开剩余 N 列 ▾' → 替换文本节点 → childList mutation
  //   → 触发 app.js 的 MutationObserver → rAF 里再跑 initColumnResizers → 无限自激
  //   （headless 实测 5 次/秒，真机 rAF 可达 60fps）。后果：① CPU 空转 → 滑动「停顿一下」；
  //   ② 每一轮都重跑 fitMobileTables → 高度被重写 → 内层 scrollTop 被钳 → 「回滚 2 行」。
  _setText(el, s) { if (el && el.textContent !== s) el.textContent = s; },
  _setCss(el, prop, v) { if (el && el.style[prop] !== v) el.style[prop] = v; },

  _applyCollapse(wrap, table) {
    this._applyCollapseCore(wrap, table);
  },

  _applyCollapseCore(wrap, table) {
    const ths = table.querySelectorAll('thead th');
    const colCount = ths.length;
    const btn = wrap._colCollapseBtn;
    // 🟢 v227.50：移动端收起态保留列策略
    //   有模块配置（COLLAPSE_KEEP / QUERY_KEEP）→ 按列头文字匹配保留指定列（多为“存货名称+规格型号+关键列”）；
    //   无配置（订货核对 / 出库模块 / 违约 / 低周转 / 档案页非配置区等）→ 回退“保留前 3(+复选框) 列”（v227.49 行为，满足“不改”）。
    const keepTokens = this._resolveKeepConfig(table);
    const keepIdx = keepTokens ? this._resolveKeepHeaders(table, keepTokens) : null;
    const useKeepIdx = !!(keepIdx && keepIdx.length > 0 && keepIdx.length < colCount);

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
    // 🟢 v228.13：恢复 <colgroup> 原始列宽。
    //   部分表格（如中心出库列表 .ob-list-table）带 inline table-layout:fixed + <colgroup> 固定列宽，
    //   在 fixed 布局下 colgroup 宽度优先级高于 th/td，若收起时只改 th/td 会导致 3 列仍是 118/140/108 不均分。
    if (table.dataset.origColWidths) {
      try {
        const arr = JSON.parse(table.dataset.origColWidths);
        table.querySelectorAll('colgroup col').forEach((c, i) => { c.style.width = arr[i] || ''; });
      } catch (_) {}
      delete table.dataset.origColWidths;
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

    // —— 回退分支：无配置 / 匹配不到列 → 保留前 3(+复选框) 列（v227.49 行为，订货核对/出库/违约等保持“不改”）——
    if (!useKeepIdx) {
      const hasCheckCol = !!table.querySelector('thead th.col-checkbox');
      const keepMin = Math.min(3 + (hasCheckCol ? 1 : 0), Math.max(1, colCount - 1));
      if (colCount <= keepMin) { if (btn) btn.style.display = 'none'; return; }
      if (!wrap._colCollapsed) {
        table.style.tableLayout = 'fixed'; table.style.width = 'auto'; table.style.minWidth = '0';
        // 🟢 v228.77：幂等写入（不替换文本节点 → 不再触发 MutationObserver 自激环）
        if (btn) { this._setCss(btn, 'display', ''); this._setText(btn, '收起 ▴'); btn.dataset.state = 'expanded'; }
        return;
      }
      let hidden = 0;
      if (!table.dataset.origTableLayout) table.dataset.origTableLayout = table.style.tableLayout || '';
      if (!table.dataset.origThWidths) {
        table.dataset.origThWidths = JSON.stringify(Array.from(ths).map(th => th.style.width || ''));
      }
      table.style.tableLayout = 'fixed';
      for (let i = colCount - 1; i >= keepMin; i--) { this._hideColInTable(table, i, true); ths[i].style.width = ''; hidden++; }
      const visThs = Array.from(table.querySelectorAll('thead th')).filter(th => !th.classList.contains('col-collapsed'));
      if (visThs.length > 0) this._equalizeCols(table, visThs, wrap);
      else { table.style.width = ''; table.style.minWidth = '0'; }
      if (hidden === 0) { if (btn) this._setCss(btn, 'display', 'none'); }
      else { if (btn) { this._setCss(btn, 'display', ''); this._setText(btn, `展开剩余 ${hidden} 列 ▾`); btn.dataset.state = 'collapsed'; } }
      return;
    }

    // —— 按列头文字匹配保留（useKeepIdx）：只隐藏不在 keepIdx 的列，可见列等宽分配 ——
    if (!wrap._colCollapsed) {
      // 展开态：还原所有列，恢复自然列宽，允许横向滑动看剩余列
      table.style.tableLayout = 'fixed';
      table.style.width = 'auto';
      table.style.minWidth = '0';
      if (btn) { this._setCss(btn, 'display', ''); this._setText(btn, '收起 ▴'); btn.dataset.state = 'expanded'; }
      return;
    }
    let hidden = 0;
    if (!table.dataset.origTableLayout) table.dataset.origTableLayout = table.style.tableLayout || '';
    if (!table.dataset.origThWidths) {
      table.dataset.origThWidths = JSON.stringify(Array.from(ths).map(th => th.style.width || ''));
    }
    table.style.tableLayout = 'fixed';
    const keepSet = new Set(keepIdx);
    for (let i = colCount - 1; i >= 0; i--) {
      if (!keepSet.has(i)) { this._hideColInTable(table, i, true); ths[i].style.width = ''; hidden++; }
    }
    const visThs = keepIdx.map(i => ths[i]).filter(Boolean);
    if (visThs.length > 0) this._equalizeCols(table, visThs, wrap);
    else { table.style.width = ''; table.style.minWidth = '0'; }

    if (hidden === 0) {
      if (btn) this._setCss(btn, 'display', 'none');
    } else {
      if (btn) { this._setCss(btn, 'display', ''); this._setText(btn, `展开剩余 ${hidden} 列 ▾`); btn.dataset.state = 'collapsed'; }
    }
  },

  // 🟢 v227.50：把可见列等宽分配（列宽上限 160px，统一以“小号”为准，避免两列放大/溢出）
  _equalizeCols(table, visThs, wrap) {
    const N = visThs.length;
    const wrapW = wrap.clientWidth || 360;
    const MAX_COL = 160;
    const each = Math.min(MAX_COL, Math.floor((wrapW - 2) / N));
    if (wrap.parentElement) wrap.parentElement.classList.add('col-collapse-mode');
    // 🟢 v228.22 W-5：可见列在 DOM 中未必是「前 N 列」（keep-config 分支按列头文字匹配，
    //   保留列可能落在任意索引，如现存量保留 存货名称/规格型号/现存数量=索引1/2/5）。
    //   因此必须先算出「真实可见列索引集合」，后续 colgroup 按索引命中，而不是按位置 i<N 一刀切。
    const allThs = Array.from(table.querySelectorAll('thead th'));
    const visIdx = new Set(visThs.map(th => allThs.indexOf(th)).filter(i => i >= 0));
    visThs.forEach(th => {
      th.style.width = each + 'px';
      th.style.minWidth = each + 'px';
      th.style.maxWidth = each + 'px';
      th.style.overflow = 'hidden';
      th.style.textOverflow = 'ellipsis';
      th.style.whiteSpace = 'nowrap';
    });
    table.querySelectorAll('tbody tr').forEach(tr => {
      Array.from(tr.children).forEach((td, i) => {
        if (visIdx.has(i)) {
          td.style.width = each + 'px';
          td.style.maxWidth = each + 'px';
          td.style.minWidth = each + 'px';
          td.style.overflow = 'hidden';
          td.style.textOverflow = 'ellipsis';
          td.style.whiteSpace = 'nowrap';
        }
      });
    });
    table.style.width = (each * N) + 'px';
    table.style.minWidth = (each * N) + 'px';
    // 🟢 v228.13 / v228.22 W-5：同步 <colgroup> 列宽 —— 可见列均分 each px，隐藏列归零。
    //   按 visIdx（真实可见列索引）命中，而不是按位置 i<N；否则 keep-config 保留的列若不在前 N 列，
    //   会拿到 col 宽度 0 被截断，而前 N 列的隐藏列却占了等宽（现存量「现存数量」被挤没的根因）。
    const cols = table.querySelectorAll('colgroup col');
    if (cols.length) {
      if (!table.dataset.origColWidths) {
        table.dataset.origColWidths = JSON.stringify(Array.from(cols).map(c => c.style.width || ''));
      }
      cols.forEach((c, i) => { c.style.width = (visIdx.has(i) ? each : 0) + 'px'; });
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
      // 🔴🟢 v228.77：RO「初始回调」死循环 —— observe() 后浏览器**必然**先派发一次通知，
      //   旧实现收到就 setTimeout(rebuild,180) → rebuild 里 uninstall + install → install 又
      //   new ResizeObserver → 再一次初始回调 → …… 每 180ms 无条件重装一次整个浮层。
      //   实测：3 秒 32 次重装，每次 _applyCollapse 重写 ~300 个 td/th 的 style/class
      //   （≈3000 次 DOM 写/秒，真机即掉帧「停顿」）。
      //   修法：RO 回调只认「尺寸真的变了」；初始回调仅用于记基线，不重建。
      const snap = () => `${Math.round(wrap.clientWidth)}x${Math.round(wrap.clientHeight)}|${Math.round(table.offsetWidth)}x${Math.round(table.offsetHeight)}`;
      let lastSnap = null, primed = false;
      ro = new ResizeObserver(() => {
        const s = snap();
        if (!primed) { primed = true; lastSnap = s; return; }   // observe() 的初始通知：只记基线
        if (s === lastSnap) return;                             // 尺寸未变（重装自身引起的抖动）→ 不重建
        lastSnap = s;
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
      // 🟢 v227.77：重放对齐偏好时同步设 td 内 input/textarea/select 的 textAlign，
      //   否则录入型明细表重渲染后「已记忆对齐」对 input 文本不可见。
      table.querySelectorAll('tbody tr').forEach(tr => {
        const td = tr.children[colIdx];
        if (!td) return;
        td.style.textAlign = a;
        td.querySelectorAll('input, textarea, select').forEach(el => {
          el.style.textAlign = a;
        });
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
    // 🟢 v227：表头内若含交互控件（如盘点记录列表多选删除的「全选」checkbox），
    //   保留原控件、不挂筛选/排序图标——否则重写 th.innerHTML 会把 input 冲掉（#stRecAll 消失）。
    if (th.querySelector('input, button, select')) {
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
          // 🟢 v227.77：明细表 / 含 input 的表格，点击对齐时除设 td.textAlign 外，
          //   还需同步设 td 内 input 的 textAlign——否则 input 文本对齐不动，
          //   用户感觉「点了没反应」。
          table.querySelectorAll('tbody tr').forEach(tr => {
            const td = tr.children[colIdx];
            if (!td) return;
            td.style.textAlign = align;
            td.querySelectorAll('input, textarea, select').forEach(el => {
              el.style.textAlign = align;
            });
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
        <button class="efp-action-btn efp-clear efp-clear-inline" title="清空当前列筛选，显示全部数据">取消筛选</button>
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
        ${!tableKey || !colField ? '<button class="efp-action-btn efp-clear" title="清空当前列筛选，显示全部数据">取消筛选</button>' : ''}
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

    // 🟢 v228.08 性能优化 P1-5：筛选弹窗搜索防抖。
    //   大表的列值可达数千项，每敲一个字符遍历全部 checkbox 切换 display 会造成输入卡顿。
    //   150ms 较短，保证列表筛选仍跟手。
    const applySearch = () => {
      const kw = searchInput.value.toLowerCase().trim();
      allCbs.forEach(cb => {
        const item = cb.closest('.efp-item');
        const text = cb.dataset.val.toLowerCase();
        item.style.display = (!kw || text.includes(kw)) ? '' : 'none';
      });
    };
    const debouncedSearch = this.debounce(applySearch, 150);
    searchInput.addEventListener('input', debouncedSearch);

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

    // 🟢 v228.29：「取消筛选」一键清空当前列筛选条件，恢复显示全部数据；
    // 本次用户反馈：不关闭弹窗，留在原地让用户继续操作。
    popup.querySelector('.efp-clear').addEventListener('click', () => {
      excludedSet.clear();
      searchInput.value = '';
      popup.querySelectorAll('.efp-cb').forEach(cb => {
        cb.checked = true;
        const item = cb.closest('.efp-item');
        if (item) item.style.display = '';
      });
      onConfirm({ kw: '', excluded: [] });
      // 不调用 _hideFilterPopup()，保持弹窗打开
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

    // 🟢 v228.26：走弹性权重体系的表，改用 flex 分配（并挂容器尺寸监听）
    if (this._useFlex(table, tableKey)) {
      this._applyFlexWidths(table, tableKey, getColField);
      this._observeFlexResize(table, tableKey, getColField);
    } else {
      this._applyPcConstraints(table, tableKey);
    }
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

    if (tableKey && !TablePrefs.hasAnyColWidth(tableKey) && !this._useFlex(table, tableKey)) {
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

  // ══════════════════════════════════════════════════════════════
  // 🟢 v228.26 弹性权重列宽（Flex Column Model）核心实现
  //
  // 与旧体系的三点本质差异：
  //   1. 存储：像素 → 相对权重（跨分辨率保持"列间比例"意图）
  //   2. 分配：两趟算法，minWidth 保底 + 剩余空间按权重再分配
  //   3. 时机：ResizeObserver 监听容器（而非渲染时算一次），
  //      侧边栏折叠 / 滚动条出现 / 窗口缩放 都能重排
  // ══════════════════════════════════════════════════════════════

  /** 每列可读下限兜底（px）——低于此值列头必然截断 */
  FLEX_MIN_FALLBACK: 56,

  /**
   * 是否走弹性权重体系（Flex Column Model）。
   * 策略：PC 端（>768）下，凡「非模板预设宽表的横向滚动表」一律启用弹性自适应；
   *       移动端（≤768）维持原有折叠逻辑。
   * 这样覆盖「PC 端所有表格」的自适应诉求，且不再依赖脆弱的 tableKey 白名单匹配。
   * @param {HTMLTableElement} table
   * @param {string|null} tableKey
   */
  _useFlex(table, tableKey) {
    if (window.innerWidth <= 768) return false;
    if (!tableKey) return false;
    // 已建立弹性权重的表，始终走 flex（粘性，避免回归到旧像素体系）
    if (typeof TablePrefs !== 'undefined' && TablePrefs.isFlexMigrated && TablePrefs.isFlexMigrated(tableKey)) return true;
    // PC 端其余表格一律弹性自适应：
    //   旧像素记忆的表会在此分支被迁移为 flex（而非退回横滚），契合「所有 PC 表格自适应」诉求；
    //   真正的宽表超出容器时，由 _computeFlexWidths 的 min-width 兜底自动转为横向滚动。
    //   （不再用「th 内联宽度之和 > 容器」判定横滚——该内联宽度可能来自本系统的记忆/锁宽，
    //     会误把带旧记忆的表判成「模板预设宽表」而跳过 flex，详见 F-7 验证。）
    const ths = table ? table.querySelectorAll('thead th') : [];
    return ths.length >= 2;
  },

  /** canvas 测量文本宽度（用于推算列的最小可读宽度） */
  _measureText(text, font) {
    try {
      const cv = this.__mcv || (this.__mcv = document.createElement('canvas'));
      const ctx = cv.getContext('2d');
      ctx.font = font || '700 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      return ctx.measureText(String(text || '')).width;
    } catch (e) { return String(text || '').length * 12; }
  },

  /**
   * 推算某列的最小可读宽度：列头文字 + padding + 排序箭头余量
   * 有记忆值优先用记忆值；否则按列头文字实测宽度推算。
   */
  _resolveMinWidth(th, tableKey, field) {
    const remembered = tableKey && field ? TablePrefs.getColMin(tableKey, field) : null;
    if (remembered) return remembered;
    const explicit = parseFloat(th.dataset.minW);
    if (!isNaN(explicit) && explicit > 0) return explicit;
    const lbl = th.querySelector('.th-sort-label');
    const text = ((lbl ? lbl.textContent : th.textContent) || '').trim();
    // 列头文字宽 + 左右 padding(28) + 排序箭头/筛选按钮余量(22)
    const measured = this._measureText(text) + 50;
    return Math.max(this.FLEX_MIN_FALLBACK, Math.round(measured));
  },

  /**
   * 核心：按 flex 权重 + minWidth 约束分配列宽（两趟算法）
   * @returns {{widths:number[], tableW:number, overflow:boolean}}
   */
  _computeFlexWidths(ths, flexArr, minArr, containerW) {
    const n = ths.length;
    const widths = new Array(n).fill(0);
    const locked = new Array(n).fill(false);

    // 若所有列的最小宽度之和已超出容器 → 直接按 min 铺开，出横向滚动
    const minSum = minArr.reduce((a, b) => a + b, 0);
    if (minSum >= containerW) {
      for (let i = 0; i < n; i++) widths[i] = minArr[i];
      return { widths, tableW: minSum, overflow: true };
    }

    // 趟 1：按权重分配剩余空间（先扣掉所有列的下限）
    let free = containerW - minSum;
    const flexSum = flexArr.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < n; i++) {
      widths[i] = minArr[i] + Math.round(flexArr[i] / flexSum * free);
    }

    // 趟 2：修正取整误差，让总和精确等于容器宽（消除"最后一列差几像素"的缝隙）
    let diff = containerW - widths.reduce((a, b) => a + b, 0);
    if (diff !== 0) {
      // 误差摊到最宽的那几列上（对视觉影响最小）
      const order = widths.map((w, i) => i).sort((a, b) => widths[b] - widths[a]);
      let guard = 0;
      while (diff !== 0 && guard++ < 1000) {
        for (const i of order) {
          if (diff === 0) break;
          const step = diff > 0 ? 1 : -1;
          if (widths[i] + step >= minArr[i]) { widths[i] += step; diff -= step; }
        }
      }
    }
    return { widths, tableW: containerW, overflow: false };
  },

  /**
   * 应用弹性列宽到表格
   */
  _applyFlexWidths(table, tableKey, getColField) {
    const ths = Array.from(table.querySelectorAll('thead th'));
    if (!ths.length) return false;
    const scrollParent = this._findScrollParent(table) || table.parentElement;
    const host = scrollParent || table.parentElement;
    if (!host) return false;
    const containerW = (host.clientWidth || table.offsetWidth) - 2;
    if (!(containerW > 0)) return false;

    const fields = ths.map(th => (getColField(th) || '').trim());

    // ① 无 flex 记忆 → 从当前渲染宽度推导基线权重（并尝试迁移旧 px）
    let needInit = !TablePrefs.hasAnyColFlex(tableKey);
    if (needInit && !TablePrefs.isFlexMigrated(tableKey)) {
      TablePrefs.migrateWidthsToFlex(tableKey, fields);
    }
    if (!TablePrefs.hasAnyColFlex(tableKey)) {
      const base = ths.map(th => {
        const inline = parseFloat(th.style.width);
        return (!isNaN(inline) && inline > 0) ? inline : (th.offsetWidth > 0 ? th.offsetWidth : 100);
      });
      const bTotal = base.reduce((a, b) => a + b, 0) || 1;
      // 归一化到「Σflex = 列数」，使 flex=1 表示平均宽度
      ths.forEach((th, i) => {
        const f = fields[i];
        if (f) TablePrefs.setColFlex(tableKey, f, Math.round(base[i] / bTotal * ths.length * 1000) / 1000);
      });
    }

    // ② 读取权重与下限
    const flexArr = ths.map((th, i) => {
      const f = fields[i];
      const v = f ? TablePrefs.getColFlex(tableKey, f) : null;
      return (typeof v === 'number' && v > 0) ? v : 1;
    });
    const minArr = ths.map((th, i) => this._resolveMinWidth(th, tableKey, fields[i]));

    // ③ 两趟分配
    const { widths, tableW, overflow } = this._computeFlexWidths(ths, flexArr, minArr, containerW);

    // ④ 施加
    if (getComputedStyle(table).tableLayout !== 'fixed') table.style.tableLayout = 'fixed';
    ths.forEach((th, i) => {
      th.style.width = widths[i] + 'px';
      th.style.minWidth = widths[i] + 'px';
    });
    table.style.width = tableW + 'px';
    table.style.minWidth = tableW + 'px';
    table.dataset.flexApplied = '1';
    table.dataset.flexOverflow = overflow ? '1' : '0';
    return true;
  },

  /**
   * 把用户拖出的像素宽度换算回 flex 权重并持久化。
   * 思路：Σflex 保持为「列数」不变，被拖列的新权重按其在容器中的占比重新计算，
   * 其余列按原比例瓜分剩下的权重（保证 Σflex 恒定，避免整体缩放）。
   */
  _saveFlexFromPixels(tableKey, ths, fields, draggedTh, draggedPx, containerW) {
    const n = ths.length;
    if (!(containerW > 0) || n === 0) return;
    const di = ths.indexOf(draggedTh);
    if (di < 0) return;

    const curFlex = fields.map(f => (f ? TablePrefs.getColFlex(tableKey, f) : null));
    const base = curFlex.map((v, i) => (typeof v === 'number' && v > 0) ? v : 1);
    const baseSum = base.reduce((a, b) => a + b, 0) || 1;

    // 被拖列：按像素占容器的比例 → 换算成权重（Σflex = n 的基准下）
    const newFlexDragged = Math.max(0.15, draggedPx / containerW * n);
    // 其余列：按原比例瓜分 (n - newFlexDragged)
    const restFlex = Math.max(0.1, n - newFlexDragged);
    const restBase = baseSum - base[di];
    fields.forEach((f, i) => {
      if (!f) return;
      if (i === di) { TablePrefs.setColFlex(tableKey, f, newFlexDragged); return; }
      const share = restBase > 0 ? base[i] / restBase : 1 / Math.max(1, n - 1);
      TablePrefs.setColFlex(tableKey, f, Math.max(0.1, restFlex * share));
    });
  },

  /** ResizeObserver 注册表：避免同一容器重复挂 */
  __flexObservers: null,

  /**
   * 监听容器宽度变化并重分配列宽。
   * 用 ResizeObserver 而非 window.resize —— 侧边栏折叠、纵向滚动条出现/消失
   * 都会改变可用宽度，但不一定触发 window 级事件。
   */
  _observeFlexResize(table, tableKey, getColField) {
    if (typeof ResizeObserver === 'undefined') return;
    const host = this._findScrollParent(table) || table.parentElement;
    if (!host) return;
    this.__flexObservers = this.__flexObservers || new WeakMap();

    const reapply = () => {
      if (!table.isConnected) { this._unobserveFlexResize(table); return; }
      if (window.innerWidth <= 768) return;          // 移动端走原有折叠逻辑
      try { this._applyFlexWidths(table, tableKey, getColField); } catch (e) { /* 忽略 */ }
    };

    let t = null;
    const debounced = () => { clearTimeout(t); t = setTimeout(reapply, 80); };

    let ro = this.__flexObservers.get(host);
    if (!ro) {
      ro = new ResizeObserver(debounced);
      this.__flexObservers.set(host, ro);
    }
    // 同一 host 下可能有多个表，用 Set 记录回调
    if (!host.__flexTables) host.__flexTables = new Set();
    host.__flexTables.add(table);
    try { ro.observe(host); } catch (e) { /* 忽略 */ }

    if (!this.__flexResizeBound) {
      this.__flexResizeBound = true;
      window.addEventListener('resize', () => {
        clearTimeout(this.__flexWinT);
        this.__flexWinT = setTimeout(() => {
          document.querySelectorAll('.data-table[data-flex-applied="1"]').forEach(tb => {
            const key = tb.dataset.tableKey || tb.closest('[data-table-key]')?.dataset.tableKey;
            if (!key || window.innerWidth <= 768) return;
            try { this._applyFlexWidths(tb, key, (th) => {
              const l = th.querySelector('.th-sort-label');
              return ((l ? l.textContent : th.textContent) || '').trim();
            }); } catch (e) { /* 忽略 */ }
          });
        }, 100);
      }, { passive: true });
    }
  },

  _unobserveFlexResize(table) {
    const host = this._findScrollParent(table) || table.parentElement;
    if (host && host.__flexTables) host.__flexTables.delete(table);
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
            if (field && !isNaN(finalW)) {
              TablePrefs.setColWidth(tableKey, field, finalW);   // 保留旧字段，便于回退
              // 🟢 v228.26：弹性体系下额外把"拖出的像素"换算成权重存起来，
              // 这样换个分辨率/换台机器，用户调过的列间比例依然保持。
              if (this._useFlex(table, tableKey)) {
                const ths2 = Array.from(table.querySelectorAll('thead th'));
                const fields2 = ths2.map(t => {
                  const l = t.querySelector('.th-sort-label');
                  return ((l ? l.textContent : t.textContent) || '').trim();
                });
                this._saveFlexFromPixels(tableKey, ths2, fields2, th, finalW,
                  (scrollParent ? scrollParent.clientWidth : table.offsetWidth) - 2);
              }
            }
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

  // 🟢 AUDIT-003：金额求和（以「分」为整数单位累加，规避 0.1+0.2 类浮点漂移）。
  //   fieldOrFn：字段名字符串，或 (row)=>数值 的取数函数；返回普通 Number（展示前再交给 formatMoney）。
  //   用途：违约扣款总额、对账金额汇总等关键财务聚合，避免浮点求和尾巴（如 0.30000000000000004）。
  sumMoney(rows, fieldOrFn) {
    if (!Array.isArray(rows)) return 0;
    const get = typeof fieldOrFn === 'function' ? fieldOrFn : (r) => r && r[fieldOrFn];
    return rows.reduce((s, r) => s + Math.round((parseFloat(get(r)) || 0) * 100), 0) / 100;
  },

  // 🟢 AUDIT-228-108（v229.05）：定点数量累加 —— sumMoney 的数量泛化版（金额见上）。
  //   digits 默认 4：库存/入库数量常见 2 位小数、盘点换算可产生 4 位；10^4 整数单位累加
  //   足以消除 1e-13 级浮点尾差（0.1+0.2 类），又不丢 4 位内精度。getVal 可传取数函数或 null（直取元素）。
  sumQty(arr, getVal, digits = 4) {
    const list = Array.isArray(arr) ? arr : (arr == null ? [] : [arr]);
    const get = typeof getVal === 'function' ? getVal : (v) => v;
    const p = Math.pow(10, digits);
    return list.reduce((s, it) => s + Math.round((parseFloat(get(it)) || 0) * p), 0) / p;
  },
  //   单值规整：把浮点尾差截断到 digits 位（如 roundQty(0.30000000000000004, 4) === 0.3）
  roundQty(num, digits = 4) {
    const n = parseFloat(num);
    if (!isFinite(n)) return 0;
    const p = Math.pow(10, digits);
    return Math.round(n * p) / p;
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
        <button class="wb-pager-btn wb-first" onclick="${module}.goPage(${secArg}1)" ${p === 1 ? 'disabled' : ''} aria-label="首页" title="首页"></button>
        <button class="wb-pager-btn wb-prev" onclick="${module}.goPage(${secArg}${p - 1})" ${p === 1 ? 'disabled' : ''} aria-label="上一页" title="上一页"></button>
        <span class="wb-pager-ind" aria-label="当前页 / 总页数">${p} / ${tp}</span>
        ${nums.map(i => `<button class="${i === p ? 'active' : ''}" onclick="${module}.goPage(${secArg}${i})">${i}</button>`).join('')}
        <button class="wb-pager-btn wb-next" onclick="${module}.goPage(${secArg}${p + 1})" ${p === tp ? 'disabled' : ''} aria-label="下一页" title="下一页"></button>
        <button class="wb-pager-btn wb-last" onclick="${module}.goPage(${secArg}${tp})" ${p === tp ? 'disabled' : ''} aria-label="尾页" title="尾页"></button>
      </span>
      <span style="font-size:12px;color:var(--text-secondary);">
        每页 <select aria-label="每页显示条数" onchange="${module}.changePageSize(${secArg}this.value === 'all' ? 'all' : parseInt(this.value, 10))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
          ${optsHtml}
        </select> 条
      </span>
      <span style="font-size:12px;color:var(--text-secondary);">
        跳至 <input type="number" id="${jumperId}" min="1" max="${tp}" value="${p}" aria-label="跳转到指定页码"
          onkeydown="if(event.key==='Enter')${module}.goPage(${secArg}parseInt(this.value))"
          style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
        / ${tp} 页
      </span>
    `;
    // 🟢 v228.73：渲染后调度移动端表格高度实测适配（含一次性 resize/orientation 监听）
    this._ensureMobileFit();
  },

  // ==========================================================================
  // 🟢 v228.73 方案 C：移动端表格高度实测适配 + 多表格页打标
  // --------------------------------------------------------------------------
  // 职责：
  //   1) 逐 .table-wrapper 实测其在滚动容器内的偏移，把
  //        maxHeight = 滚动容器可视高 − 表格顶偏移 − 分页条高 − 余量
  //      经行内 CSS 变量 --wb-fit-h 注入（CSS 端 var(--wb-fit-h, 兜底) 消费），
  //      使「表格下沿 = 分页条上沿」，数据行不会从吸底分页键后穿过。
  //   2) 探测「单页多表格」的详情页（可见 wrapper ≥ 2），给滚动容器打 .wb-multi-table：
  //      CSS 据此把分页条从吸底改为随表静态排列（每表各自一条），并取消吸顶残留。
  //   3) 桌面端（>768px）清除行内变量与标记，交还 CSS 静态规则。
  // 设计要点：
  //   - rect 差值（wrapper.top − 滚动容器.top）随滚动同步平移，结果滚动无关，无需监听 scroll。
  //   - 注入用 CSS 变量而非行内 max-height：CSS 端 max-height 带 !important（要压过
  //     3200 行等历史规则），行内样式打不过 !important，变量注入是唯一干净的通道。
  // ==========================================================================
  _mobileFitBound: false,
  _ensureMobileFit() {
    if (!this._mobileFitBound) {
      this._mobileFitBound = true;
      let rz = null;
      window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => this.fitMobileTables(), 120); });
      window.addEventListener('orientationchange', () => setTimeout(() => this.fitMobileTables(), 250));
      // 🟢 v228.76「滚动天花板」兜底钳制（用户完整规格①：外层拉到表头顶格就滑不动）：
      //   几何校准（fitMobileTables 区域分支）已把「原生最大滚动量」精确压到天花板（= 表格上方
      //   内容高），原生滚动到顶自然停住；本监听只兜三类残余——① 校准触 360px 下限的异常模块
      //   ② iOS 触摸回弹瞬时越界 ③ 重适配后遗留的越界 scrollTop。
      //   scroll 事件不冒泡，必须用捕获才能在 document 上收到各滚动容器的事件。
      //   天花板值由 fitMobileTables 写在容器 _wbRegionCeiling 上（非区域模式为 null → 不干预）。
      if (!document._wbCeilingGuard) {
        document._wbCeilingGuard = true;
        document.addEventListener('scroll', (e) => {
          const sc = e.target;
          const ceiling = sc ? sc._wbRegionCeiling : null;
          if (ceiling != null && sc.scrollTop - ceiling > 1) sc.scrollTop = ceiling;
        }, true);
      }
    }
    requestAnimationFrame(() => this.fitMobileTables());
  },
  // 🟢 v228.79 P2-8：PC 宽表横向溢出时，给 .table-wrapper 打 data-hscroll 标记，
  //   CSS 据此显示右侧渐隐阴影 + 滚动提示，避免"最后一列看不见"的错觉。
  //   幂等：仅当标记变化时才写 DOM，避免触发重排风暴。仅在非触屏（PC）生效。
  markTableHorizontalOverflow() {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return; // 触屏靠滑动，无需阴影提示
    const sel = '#contentArea .table-wrapper, #contentArea .ob-list-table-wrapper, #contentArea .oc-entry-table-wrapper, #contentArea .ob-entry-table-wrapper';
    try {
      document.querySelectorAll(sel).forEach(w => {
        let flag = '';
        try { if (w.scrollWidth - w.clientWidth > 4) flag = '1'; } catch (e) {}
        if ((w.dataset.hscroll || '') !== flag) w.dataset.hscroll = flag;
      });
    } catch (e) { /* 防御：检测失败不影响其它逻辑 */ }
  },

  fitMobileTables() {
    // 🟢 v228.79 P2-8：PC 宽表横向溢出标记（桌面端也会执行，早于下方的桌面提前返回）
    this.markTableHorizontalOverflow();
    const sel = '#contentArea .table-wrapper, #contentArea .ob-list-table-wrapper, #contentArea .oc-entry-table-wrapper, #contentArea .ob-entry-table-wrapper';
    const wrappers = document.querySelectorAll(sel);
    if (window.innerWidth > 768) {
      // 桌面端：清除移动端注入，交还 CSS（640px 上限）
      wrappers.forEach(w => { w.style.removeProperty('--wb-fit-h'); w._wbFitH = null; w._wbFitSig = null; });
      document.querySelectorAll('.wb-multi-table').forEach(s => s.classList.remove('wb-multi-table'));
      document.querySelectorAll('.wb-table-region').forEach(s => s.classList.remove('wb-table-region'));
      // 🟢 v228.76：同步清空滚动天花板标记（否则窗口从 ≤768 拉宽后桌面滚动会被残留钳制）
      document.querySelectorAll('.content-scroll, #contentArea').forEach(s => { s._wbRegionCeiling = null; });
      if (document.body) document.body._wbRegionCeiling = null;
      return;
    }
    if (!wrappers.length) return;
    const visible = Array.prototype.filter.call(wrappers, w => w.offsetParent && w.getBoundingClientRect().height > 0);
    const isMulti = visible.length >= 2;               // 详情类多 section 页（入库记录+关联订单+…）
    const scroll = document.querySelector('.content-scroll') || document.getElementById('contentArea');
    if (scroll) scroll.classList.toggle('wb-multi-table', isMulti);
    const vh = window.innerHeight;
    const tabbar = document.getElementById('mobileTabbar');
    const tabbarH = (tabbar && tabbar.offsetHeight) || 0;
    // 单表格模块：分页条吸底占 56px，表格须在它上方收住；多表格页：分页条随表静态，不占预算
    let pagerH = 0;
    if (!isMulti) {
      const bar = document.querySelector('#contentArea .pagination-bar');
      pagerH = (bar && bar.offsetHeight) || 56;
    }
    // 🟢 v228.75：区域模式（.wb-table-region）滚动容器集合 —— 见下方 regionMode 分支注释
    const regionScs = new Set();
    visible.forEach(w => {
      const sc = w.closest('.content-scroll') || w.closest('#contentArea') || document.body;
      const scRect = sc.getBoundingClientRect();
      // 🔴 v228.75 修复：v228.73 注释声称「wrapper.top − 容器.top 随滚动同步平移、滚动无关」实为错误——
      //   内部滚动容器（.content-scroll 自身 overflow-y:auto）的 rect 不随内容滚动平移，滚的是内容，
      //   该差值 = 内容流偏移 − scrollTop，随滚动漂移。后果：滚动状态下（如已滚到底）触发的重适配
      //   会拿到缩小甚至为负的偏移 → 经典公式误判为「短内容单屏」→ 校准循环把表格削到 160px 保底
      //   → 布局塌缩又触发重适配恢复 → 来回振荡（实测插桩：scrollTop=854 时 offsetInSc=-17）。
      //   加回 sc.scrollTop 还原为真正滚动无关的「内容流偏移」（body 滚动场景 scrollTop=0，自然退化正确）。
      const offsetInSc = (w.getBoundingClientRect().top - scRect.top) + sc.scrollTop;   // 内容流偏移，滚动无关
      const scAvailH = (sc === document.body) ? vh - tabbarH : sc.clientHeight;
      // 🟢 v228.75：regionBudget = 「表格区域满屏高」= 可视高 − 分页条 − 余量（不再扣除表格上方内容高）
      const regionBudget = Math.max(scAvailH - pagerH - 8, 160);
      let h = regionBudget - offsetInSc;      // 经典单屏适配：表格上方内容少时一屏收住（滚动容器无页滚动）
      let regionMode = false;
      if (isMulti) {
        h = Math.min(h, Math.round(vh * 0.62));   // 多表格页：单表不霸屏
      } else if (h < regionBudget * 0.6) {
        // 🟢 v228.75（用户实测截图：订单列表页三连问题）：表格上方内容过长（搜索+筛选+统计卡片+图表
        //   合计超过可视高 40%）时，经典公式把表格压到 160px 保底 → 只剩 2~3 行；且吸底分页条
        //   悬浮在图表上、与数据行穿叠。改「区域模式」：
        //     · 表格区域 = 满屏高（滚到页底时表格完整可见，≥十几行 —— 用户明确要求）；
        //     · 分页条随表静态排列（CSS .wb-table-region），永远固定在表格区域正下方，
        //       不再吸附滚动视口底 → 浏览图表/卡片时翻页键不出现，数据行绝不与翻页键穿叠。
        h = regionBudget;
        regionMode = true;
      }
      h = Math.max(h, 160);                             // 保底可用高度
      // 🔴🟢 v228.77：高度写入「幂等 + 起点复用 + 内层滚动保护」三件套
      //   旧实现致命缺陷（实测订单页）：每轮都先把**未校准**的 h 写进 --wb-fit-h（724px），
      //   再逐轮回削到校准值（662px）。写下 724px 的那一刻浏览器立即 layout ——
      //     · wrapper.clientHeight +62 → 内部 scrollTop 被按新容量钳掉 ~62px（≈2 行数据）；
      //     · 外层内容 +62 → 天花板处表格尾部被顶出可视区（最后两行看不到）。
      //   → 正是用户报的「拉到底停顿一下 → 回滚倒退 2 行 → 最后两行显示不出来 → 停不住」。
      //   ① applyH 幂等：值未变不写 DOM（稳态零写入、零 layout）；
      //   ② 几何签名未变则以上次校准值为起点（DOM 里本就是它，测量即真实状态）
      //      → 稳态 over≈0，一次测量即收敛，不再产生 62px 过冲中间态；
      //   ③ restoreInner 兜底：真发生高度变化（换页/筛选/转屏）时按新容量还原内层滚动位置。
      const sig = `${regionMode ? 1 : 0}|${isMulti ? 1 : 0}|${Math.round(offsetInSc)}|${Math.round(scAvailH)}|${Math.round(pagerH)}`;
      if (w._wbFitSig === sig && typeof w._wbFitH === 'number' && w._wbFitH >= 160) h = w._wbFitH;
      const applyH = (v) => {
        h = v;
        const s = v + 'px';
        if (w.style.getPropertyValue('--wb-fit-h') !== s) w.style.setProperty('--wb-fit-h', s);
      };
      applyH(h);
      const keepInner = w.scrollTop;
      const restoreInner = () => {
        const max = w.scrollHeight - w.clientHeight;
        const want = Math.max(0, Math.min(keepInner, max));
        if (Math.abs(w.scrollTop - want) > 0.5) w.scrollTop = want;
      };
      if (regionMode && sc !== document.body) {
        // 🟢 v228.76「滚动天花板」几何校准（用户完整规格）：
        //   目标：页面最大滚动量 S_max = scrollHeight − clientHeight **精确等于** offsetInSc
        //   （= 表格上方内容高）。达成后的终态恰好是用户要的三段式——
        //     · 外层拉到头 ⇔ 表格区域顶边正好落在可视区顶（顶格），再拉原生就滑不动；
        //     · thead 的吸附基准是 wrapper 顶边（style.css 3620 sticky!important），
        //       wrapper 顶边永不出界 → 「标题行不消失」；
        //     · 分页条随文档流恰好同时贴底出现 → 「表头顶格 + 翻页键同屏」；
        //     · 数据行由表格自身内部滚动条滚动 → 「中间数据用表格下拉条看」。
        //   分页条以下的 padding/间隙不可预知（实测订单页 70px，其中 tabbar 56），
        //   只能实测回削：over = (scrollHeight − clientHeight) − offsetInSc，over>0 削表高、
        //   over<0 增表高（依赖下方 .wb-table-region min-height 定高规则，数据不足也撑满），
        //   一轮测量一轮修正，pad 恒定 → 1~2 轮收敛。360px 下限防御异常模块（此时由
        //   document 捕获监听钳制兜底）。
        //   注：此处先打 .wb-table-region 再校准 —— min-height 定高规则依赖该 class，
        //   若等 post-loop 打标，首轮校准会在「无定高」状态下测量而出错；class 幂等，
        //   post-loop 的统一对账（摘标逻辑）不受影响。
        sc.classList.add('wb-table-region');
        let guard = 0;
        while (guard++ < 5) {
          const over = (sc.scrollHeight - sc.clientHeight) - offsetInSc;  // >0 还能再滚(表头会被顶出)；<0 到不了顶
          if (Math.abs(over) <= 1) break;
          const nh = h - over;
          if (nh < 360) { applyH(360); break; }
          applyH(nh);
        }
        sc._wbRegionCeiling = offsetInSc;               // 天花板写入容器，供 document 捕获监听兜底钳制
      } else {
        sc._wbRegionCeiling = null;                     // 经典吸底 / 多表格 / body 滚动：无天花板概念
      }
      if (regionMode) regionScs.add(sc);
      // 🔴 校准循环（v228.73 实测补丁）：Chrome 对 position:sticky;bottom:0 的分页条有
      // 「预置位」行为——只要滚动容器内容溢出 N px，吸底条在 scrollTop=0 时就预先钉在
      // 「滚到底」位置，向上压住表格底部 N px（用户截图「数据穿过翻页键」的真正机制）。
      // 任何未被公式计入的高度（容器上下 padding、标题、边框合计误差等）都会体现为
      // scrollHeight > clientHeight，此处按实测差值回削表格高度，直到内容精确收进一屏，
      // 分页条回到文档流位（= 表格底齐平），任何滚动位置都不再压表。
      // 🟢 v228.75：仅经典吸底模式需要校准；区域模式分页条在文档流内、本就不叠加，页滚动是预期行为。
      if (!isMulti && !regionMode && sc !== document.body) {
        let guard = 0;
        while (sc.scrollHeight > sc.clientHeight + 1 && guard++ < 4) {
          const nh = h - (sc.scrollHeight - sc.clientHeight) - 2;
          if (nh < 160) { applyH(160); break; }
          applyH(nh);
        }
      }
      w._wbFitH = h;                                    // 🟢 v228.77：记住本轮校准结果供下轮复用
      w._wbFitSig = sig;
      restoreInner();                                   // 🟢 v228.77：高度变过就把内层滚动还回去
    });
    // 🟢 v228.75：区域模式打标 / 摘标（筛选收起展开、图表显隐会改变上方内容高 → 模式随之切换）
    document.querySelectorAll('.wb-table-region').forEach(s => {
      if (!regionScs.has(s)) s.classList.remove('wb-table-region');
    });
    regionScs.forEach(s => s.classList.add('wb-table-region'));
    // 🟢 v228.76：重适配后若当前滚动已越过新天花板（如筛选收起 → offsetInSc 变小、
    //   或模式从经典切到区域），立即拉回天花板 —— 否则表头停在出界状态直到下次滚动。
    regionScs.forEach(s => {
      const c = s._wbRegionCeiling;
      if (c != null && s.scrollTop - c > 1) s.scrollTop = c;
    });
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


  // 🟢 v228.25 健壮性加固：安全写入 innerHTML。
  //   背景：全站 12+ 模块存在 `document.getElementById('xxx').innerHTML = ...` 直赋值写法。
  //   用户快速切模块 / 切主题时，渲染是异步的，await 回来时 DOM 已被新模块替换，
  //   getElementById 返回 null → 抛 "Cannot set properties of null (setting 'innerHTML')"
  //   并被上层 catch 成整页「加载出错」。stock.js 曾有此崩溃（v228.24 单独修过），
  //   本函数把该防护沉淀为通用能力，避免同类问题在其余模块重复出现。
  //   用法：TableUtils.setHtml('trackSummary', html) —— 元素不存在时静默跳过。
  setHtml(id, html) {
    const el = (typeof id === 'string') ? document.getElementById(id) : id;
    if (!el) return null;
    el.innerHTML = html;
    return el;
  },

  // 实体可点击链接（打通模块关联）：点击跳转 App.openEntity(type, key)
  // 文字原样显示，仅 hover 出现下划线；onmousedown 阻止冒泡，避免触发智能选区
  // 🟢 v228.25 W-4：统一详情入口形态。同一「查看详情」动作此前有三套呈现
  //   （供应商=详情按钮、合同价格=文字按钮、现存量/订单/低周转=实体链接），
  //   视觉权重/尺寸/位置不一致，用户跨模块无法形成稳定预期。
  //   现统一为「🔍 图标 + 文案」的次级入口：链接形态加 🔍 前缀图标；
  //   按钮形态（供应商/合同价格）由 .btn-detail 类统一；两者共用 .detail-entry 命中区规格。
  link(type, label, key) {
    const t = escAttr(type ?? '');
    const k = escAttr(key ?? '');
    const text = esc(label ?? '');
    const typeName = ({ order: '订单', supplier: '供应商', stock: '存货' })[type] || '存货';
    return `<a class="entity-link detail-entry" href="javascript:void(0)" title="查看${typeName}档案" aria-label="查看${typeName} ${text} 档案" onclick="App.openEntity('${t}','${k}')" onmousedown="event.stopPropagation()"><span class="de-icon" aria-hidden="true">🔍</span>${text}</a>`;
  },

  // 🟢 v228.08 性能优化 P1-5：通用防抖（debounce）。
  //   供各模块搜索输入复用：连续输入只在停止 wait 毫秒后执行一次，避免每敲一个字符
  //   就触发全表过滤 / 云端同步 / 面板重渲染。
  //   ⚠️ 仅用于「查询/渲染」类回调，禁止用于数据录入（如数量、备注输入），否则会丢输入。
  debounce(fn, wait) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
    };
  },

  // 🟢 v228.09 性能优化 P1-4：大表虚拟滚动（只渲染视口附近的行）。
  //   解决的问题：「每页=全部」时订单/入库要一次渲染 2394 行 ≈ 45,865 个 DOM 节点、3.18MB HTML。
  //   做法：行数 > threshold 才启用虚拟；上下用占位 <tr> 撑出总高度，页面仍按原方式滚动。
  //
  // opts: { items, rowHtml, thead, tableAttrs, threshold, wrapperClass, colgroup }
  //   items      —— 完整数据数组（导出/排序等仍基于它，与渲染解耦，不受虚拟化影响）
  //   rowHtml    —— (item) => '<tr>...</tr>'，与模块原行模板一致
  //   thead      —— '<tr>...</tr>' 表头串
  //   tableAttrs —— 追加到 <table> 上的属性串（如 data-table-key / style）
  //   threshold  —— 超过多少行才虚拟化（默认 150；默认分页 20/50 不触发，行为完全不变）
  //   wrapperClass —— 外层滚动容器 class（默认 'table-wrapper'；
  //                   🟢 AUDIT-228-04：出库列表用 ob-list-table-wrapper，需保持原样）
  //   colgroup   —— 完整 <colgroup>...</colgroup> 串（默认空）。
  //                 🟢 AUDIT-228-04：出库列表依赖 colgroup 固定列宽（v228.13 移动端收起态
  //                 三列均分即靠 _equalizeCols 同步 colgroup），虚拟滚动下必须保留。
  // 返回：true=已启用虚拟滚动，false=走原整表渲染。
  virtualTable(area, opts) {
    const { items, rowHtml, thead, tableAttrs = '', threshold = 150,
            wrapperClass = 'table-wrapper', colgroup = '', tableClass = 'data-table' } = opts;
    const total = (items && items.length) || 0;
    if (!area) return false;

    // 行数未超阈值：走原有整表渲染，输出结构与改动前完全一致
    if (total <= threshold) {
      area.innerHTML =
        `<div class="${wrapperClass}"><table class="${tableClass}" ${tableAttrs}>${colgroup}` +
        `<thead>${thead}</thead><tbody>${items.map(rowHtml).join('')}</tbody></table></div>`;
      return false;
    }

    const wrapId = 'vt_' + Math.random().toString(36).slice(2, 9);
    area.innerHTML =
      `<div class="${wrapperClass}" id="${wrapId}"><table class="${tableClass} vt-table" ${tableAttrs}>${colgroup}` +
      `<thead>${thead}</thead><tbody class="vt-body"></tbody></table></div>`;
    const wrap = document.getElementById(wrapId);
    if (!wrap) return false;
    const body = wrap.querySelector('.vt-body');

    let rowH = 0, raf = null, destroyed = false;
    // 查找真正滚动的容器：从 wrap 自身开始（.table-wrapper 常常就是它），再逐级向上
    function findScroller(el) {
      let n = el;
      while (n && n !== document.body && n !== document.documentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 4) return n;
        n = n.parentElement;
      }
      return null;
    }
    const cell = '<td colspan="99" style="padding:0;border:0;height:auto"></td>';

    const render = () => {
      // 区域已被移除（切换模块等）→ 自动解绑，避免监听泄漏与无效渲染
      if (destroyed || !document.body.contains(wrap)) { cleanup(); return; }
      if (!rowH) {
        // 首帧先渲染几行，实测真实行高（避免硬编码与实际样式不符导致滚动漂移）
        body.innerHTML = items.slice(0, 5).map(rowHtml).join('');
        const first = body.querySelector('tr');
        rowH = (first && first.offsetHeight) || 38;
      }
      // ⚠️ 滚动容器通常是 .table-wrapper 自身（max-height:640px; overflow-y:auto）。
      //    此时容器位置不动、是内部表格在动，所以必须用「表格相对容器视口」的偏移来算起始行，
      //    不能用容器自身的视口位置（那样会永远算成第 0 行，滚动后窗口不更新）。
      const table = wrap.querySelector('table') || wrap;
      const sc = findScroller(wrap);
      const scTop = sc ? sc.getBoundingClientRect().top : 0;
      const vh = sc ? sc.clientHeight : (window.innerHeight || document.documentElement.clientHeight || 800);
      const buffer = 5;
      let s = Math.floor((-(table.getBoundingClientRect().top - scTop)) / rowH) - buffer;
      if (s < 0) s = 0;
      const visible = Math.ceil(vh / rowH) + buffer * 2;
      if (s > total - visible) s = Math.max(0, total - visible);
      const e = Math.min(total, s + visible);
      body.innerHTML =
        (s > 0 ? `<tr class="vt-spacer" style="height:${s * rowH}px">${cell}</tr>` : '') +
        items.slice(s, e).map(rowHtml).join('') +
        (e < total ? `<tr class="vt-spacer" style="height:${(total - e) * rowH}px">${cell}</tr>` : '');
    };

    function cleanup() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
      if (raf) { cancelAnimationFrame(raf); raf = null; }
    }
    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; render(); });
    }
    // ⚠️ 本应用 html,body 为 overflow:hidden，页面本身不滚动，真正滚动的是内层容器。
    //    scroll 事件不冒泡，但在【捕获阶段】可被祖先收到 —— 因此在 document 上以 capture 监听，
    //    任何内层容器（无论初始化时是否已可滚动）的滚动都能捕获到，避免窗口停在前几行不重算。
    render();
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('scroll', onScroll, { passive: true }); // 兜底：整页滚动场景
    window.addEventListener('resize', onScroll, { passive: true });
    area._vtCleanup = cleanup;
    return true;
  },

  // 统一 Excel 导出（O1 去重）：rows 为空时提示并返回，行为与原各模块一致
  // 🟢 v228.08：XLSX 改为按需加载，本函数升级为 async。
  //   内部已处理「加载提示 + 失败提示」，13 处外部调用点无需改动（不 await 亦可正常下载）。
  async exportToExcel(rows, filename, sheetName, columns) {
    if (!rows || !rows.length) { WBModal.alert('没有数据'); return; }
    // 首次导出需下载 XLSX 组件，给出加载提示，避免点击后无反馈（不牺牲体验）
    let needHide = false;
    if (!LazyLib.has('xlsx')) {
      try {
        if (typeof showLoading === 'function') { showLoading('正在准备导出组件…'); needHide = true; }
      } catch (e) { /* 提示失败不影响导出本身 */ }
    }
    try {
      const XLSX = await LazyLib.xlsx();
      // 🟢 v229.03：列白名单 —— 传入 columns（key 数组或 {key,title} 数组）时，
      //   只导出这些列且列头/列序与工作台表格完全一致；未传则保持旧行为（全部字段原样导出）。
      let data = rows;
      if (Array.isArray(columns) && columns.length) {
        const cols = columns.map(c => (typeof c === 'string') ? { key: c, title: c } : c);
        data = rows.map(r => {
          const o = {};
          cols.forEach(({ key, title }) => { o[title] = r[key]; });
          return o;
        });
      }
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, sheetName || '数据');
      XLSX.writeFile(wb, filename);
    } catch (err) {
      console.error('[TableUtils.exportToExcel] 导出失败:', err);
      try {
        WBModal.alert('导出失败：' + (err && err.message ? err.message : '组件加载失败，请检查网络后重试'));
      } catch (e) { /* 弹窗不可用则仅记日志 */ }
    } finally {
      if (needHide) { try { if (typeof hideLoading === 'function') hideLoading(); } catch (e) {} }
    }
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
