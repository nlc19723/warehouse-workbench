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
  // 🟢 v229.98（AUDIT-229-98-11）：按【单张表】清空表头列筛选记忆。
  //   原来的 clearFilters() 是「全量清空」，用于进入工作台时收尾；顶部「重置」按钮只需要清当前模块的表，
  //   若全清会连其它模块用户已设好的筛选一起抹掉。
  clearFiltersFor(tableKey) {
    if (!tableKey) return;
    const all = this._read();
    if (all.filters && all.filters[tableKey]) {
      delete all.filters[tableKey];
      this._write(all);
    }
  },
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
  orderTrack:        ['存货编码','存货名称','规格型号','未入库订单量'], // 订单跟踪：🟢 v229.40 表格带 data-table-key="orderTrack"，_deriveTableKey 优先取它（旧键 trackTableArea 永远匹配不到 → 一直在走前3列回退）
  ltTableArea:       ['存货编码','存货名称','规格型号','现存数量'],   // 🟢 v229.40 低周转材料（表头“现存数量”，首列“仓库”收起态隐藏）
  breachTableArea:   ['公司名称','存货名称','规格型号','扣款金额'],   // 🟢 v229.40 违约台账
  stockTableArea:    ['存货编码','存货名称','规格型号','现存数量'],   // 现存量（表头叫“现存数量”）
  inventoryAlert:    ['存货编码','存货名称','规格型号','补货值'],
  stArea:            ['存货编码','存货名称','规格型号','现存量','盘点数量'],
  stRecArea:         ['存货编码','存货名称','规格型号','现存量','盘点数量'],   // 盘点记录列表：v228.43 同步补「现存量」
  pricingTableArea:  ['存货编码','存货名称','规格型号','含税单价'],
  recTableArea:      ['存货编码','存货名称','规格型号','含税金额'],
  supplierTableArea: ['供应商','本期合同到期','已入库金额'], // 🟢 v229.40 供应商管理（特殊3列）：旧 token「合同到期日」匹配不到实际表头「本期合同到期」导致只剩2列，已修正
  'stk-alert':       ['分类','现存量','补货值'],           // 档案页-库存预警
};
const QUERY_KEEP = {
  stock:   ['存货编码','存货名称','规格型号','现存量'],
  // 🟢 v229.40 订单板块：最左侧增加「订单编号」列；旧 token「存货编码」匹配不到实际表头「存货编号」（该板块派生列名叫“存货编号”），已按实际表头修正
  orders:  ['订单编号','存货名称','规格型号','订单量'],
  inbound: ['存货编码','存货名称','规格型号','入库量'],
  pricing: ['存货编码','存货名称','规格型号','含税单价'],
};
// 🟢 v229.40：收起态指定列「自动换行完整显示」（列头文字匹配）。收起态默认 nowrap+ellipsis 截断，
//   但供应商名称等长文本列需要换行显示完整——命中列覆盖为 white-space:normal（等宽列内多行撑高行）。
const COLLAPSE_WRAP = {
  supplierTableArea: ['供应商'],
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

  // 🟢 v229.45：会话级手动展开记忆（内存，不落盘）——同一模块内翻页/重渲染后保持用户手动展开态；
  //   模块切换（uninstallAll）时清空 → 「每次进入工作台默认收起」（v228.93）语义不变。
  _sessionExpand: {},
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
      // 🟢 v229.45：记录用户手动意图 → 翻页重渲染后按 tableKey 恢复
      const sk = TableUtils._deriveTableKey(table);
      if (sk) this._sessionExpand[sk] = !wrap._colCollapsed;
      this._applyCollapse(wrap, table);   // 🟢 v228.93：仅当次会话展开，不落盘记忆（每次进入默认收起）
    });
    if (wrap._colCollapsed === undefined) {
      // 🟢 v229.45：翻页/重渲染重建 wrap 时，若用户本会话手动展开过同 key 表格 → 保持展开；
      //   否则维持 v228.93 默认收起
      const sk = TableUtils._deriveTableKey(table);
      wrap._colCollapsed = !(sk && this._sessionExpand[sk] === true);
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
    //   无配置（订货核对 / 出库模块 / 档案页非配置区等）→ 回退“保留前 3(+复选框) 列”（v227.49 行为，满足“不改”）。
    //   🟢 v229.40：违约台账 / 低周转材料 已补配置，订单跟踪配置键修正为 orderTrack。
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
      } catch (_) { console.warn('[js/table-utils.js:398] 异常(已忽略):', _); }
      delete table.dataset.origThWidths;
    }
    // 🟢 v228.13：恢复 <colgroup> 原始列宽。
    //   部分表格（如中心出库列表 .ob-list-table）带 inline table-layout:fixed + <colgroup> 固定列宽，
    //   在 fixed 布局下 colgroup 宽度优先级高于 th/td，若收起时只改 th/td 会导致 3 列仍是 118/140/108 不均分。
    if (table.dataset.origColWidths) {
      try {
        const arr = JSON.parse(table.dataset.origColWidths);
        table.querySelectorAll('colgroup col').forEach((c, i) => { c.style.width = arr[i] || ''; });
      } catch (_) { console.warn('[js/table-utils.js:408] 异常(已忽略):', _); }
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
        // 🟢 v229.40：展开态布局策略——有显式列宽（th inline width / colgroup）的表格维持 fixed 布局
        //   （列宽按声明生效、总宽超出容器 → 横向滚动条）；无任何显式列宽的表格在 fixed+width:auto 下
        //   会被压进容器宽 → 无溢出 → 无横向滚动条、滑不到右侧（违约台账 13 列实测）。
        //   此类表格回退 auto 自然布局：移动端 td nowrap + min-width:88px 兜底，内容自然撑宽可滑动。
        if (this._hasWidthSpec(table, ths)) { table.style.tableLayout = 'fixed'; table.style.width = 'auto'; table.style.minWidth = '0'; }
        else { table.style.tableLayout = 'auto'; table.style.width = ''; table.style.minWidth = ''; }
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
      // 展开态：还原所有列，允许横向滑动看剩余列
      // 🟢 v229.40：同上——无显式列宽的表格回退 auto 自然布局，保证展开后有横向滚动条可滑到右侧
      if (this._hasWidthSpec(table, ths)) {
        table.style.tableLayout = 'fixed';
        table.style.width = 'auto';
        table.style.minWidth = '0';
      } else {
        table.style.tableLayout = 'auto';
        table.style.width = '';
        table.style.minWidth = '';
      }
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
    // 🟢 v229.40：按模块配置把指定可见列覆盖为「自动换行完整显示」（如供应商名称长文本）
    this._applyColWrap(table);
  },

  // 🟢 v229.40：表格是否带显式列宽（th inline width 或 colgroup col width）——决定展开态用 fixed 还是 auto 布局
  _hasWidthSpec(table, ths) {
    if (Array.from(ths).some(th => { const w = th.style.width; return w && w !== 'auto'; })) return true;
    return !!table.querySelector('colgroup col[style*="width"]');
  },

  // 🟢 v229.40：收起态指定列自动换行完整显示——覆盖 _equalizeCols 设的 nowrap+ellipsis，
  //   命中列改为 white-space:normal + word-break，长文本在等宽列内多行撑高行（如供应商名称）。
  _applyColWrap(table) {
    if (!table) return;
    const key = TableUtils._deriveTableKey(table);
    const tokens = key ? (COLLAPSE_WRAP[key] || null) : null;
    if (!tokens) return;
    const allThs = Array.from(table.querySelectorAll('thead th'));
    const idxs = this._resolveKeepHeaders(table, tokens);
    const visIdx = new Set(idxs.filter(i => i >= 0 && allThs[i] && !allThs[i].classList.contains('col-collapsed')));
    if (!visIdx.size) return;
    allThs.forEach((th, i) => {
      if (visIdx.has(i)) { th.style.whiteSpace = 'normal'; th.style.wordBreak = 'break-word'; th.style.textOverflow = ''; }
    });
    table.querySelectorAll('tbody tr').forEach(tr => {
      Array.from(tr.children).forEach((td, i) => {
        if (visIdx.has(i)) {
          td.style.whiteSpace = 'normal';
          td.style.wordBreak = 'break-word';
          td.style.textOverflow = '';
          td.style.overflow = 'hidden';
        }
      });
    });
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
    // 🟢 v229.45：模块切换 = 离开当前模块 → 清空会话级手动展开记忆（翻页保持展开，切模块重置收起）
    this._sessionExpand = {};
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

  // 🟢 v230.0a（AUDIT-230-0a）：表级运行时注册表。
  //   把每张已初始化表格的「列字段 / 排序状态 / 表头 th / 容器 / 列筛选闭包 / 表格元素」集中登记，
  //   供筛选条件可视化 chips 的「单删/清全部/清排序」回调精确操作对应表格，而不依赖全局遍历。
  _tableRegistry: {},

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
   *                            table?: HTMLTableElement —— 🟢 v229.98：指定操作哪张表（见下方 P1-9 说明）
   */
  initSortableHeaders(containerId, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    // 🟢 v229.98（AUDIT-229-98-12）：原先无条件取容器内【第一张】.data-table。
    //   当一个容器里有并列的多张表时（如订单档案「关联完整订单」+「入库明细」），
    //   第二张表会被打上 sortableInitialized 标记却从未绑定 —— 结果是它没有筛选图标、也不能排序。
    //   现在允许调用方用 opts.table 精确指定目标表（自动初始化链路会传）。
    const _explicit = (opts.table && opts.table.tagName === 'TABLE' && container.contains(opts.table)) ? opts.table : null;
    const table = _explicit || container.querySelector('.data-table');
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
    // 🟢 v230.0b（AUDIT-230-0b）：排序状态升级为「有序多键」。
    //   · keys = [{col, dir}, ...]，前一个 key 优先级最高（Excel 的多级排序语义）。
    //   · 为向后兼容既有单列路径（_applyTableSortAndFilter / chips / onSortChange 均读 col/dir），
    //     col/dir 始终镜像 keys[0]（主排序键）；keys 为空时 col=-1 / dir=0。
    //   · 单列点击（无 Shift）→ 只保留一个 key；Shift+点击 → 把该列追加/切换为次级键。
    const sortState = { col: -1, dir: 0, keys: [] };
    if (opts.initialSort && typeof opts.initialSort.col === 'number'
        && [0, 1, 2].includes(opts.initialSort.dir)) {
      sortState.col = opts.initialSort.dir === 0 ? -1 : opts.initialSort.col;
      sortState.dir = opts.initialSort.dir;
      if (sortState.dir !== 0) sortState.keys = [{ col: sortState.col, dir: sortState.dir }];
    }
    // 🟢 v230.0a（AUDIT-230-0a）：汇总行开关 + 登记到运行时表（供筛选 chips 回调精确操作对应表）
    if (opts.summary !== false) table.dataset.summary = '1'; else delete table.dataset.summary;
    table.dataset.tableKey = tableKey;
    this._tableRegistry[tableKey] = { ths, colFields, columnFilters, sortState, table, container, opts };

    if (tableKey) this._applyAlignPreferences(table, ths, colFields, tableKey);

    let hasRestoredFilter = false;
    if (tableKey) {
      const restored = this._restoreColumnFilters(ths, colFields, tableKey);
      Object.assign(columnFilters, restored.columnFilters);
      hasRestoredFilter = restored.hasRestoredFilter;
    }

    ths.forEach((th, colIdx) => {
      this._bindHeaderInteractions(th, colIdx, { ths, table, tableKey, colFields, columnFilters, sortState, opts, container });
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

    // 🟢 v229.98（AUDIT-229-98-13）：初始化完成时打标记。
    //   此前只有「自动初始化」链路会标记，业务模块自己显式调用时不会 →
    //   MutationObserver 会发现这张表没标记，于是再初始化一遍（重写一遍 th.innerHTML 冲掉刚挂好的监听）。
    //   统一在这里标记，双绑消除，也让显式调用的模块不必各写一行。
    try { table.dataset.sortableInitialized = '1'; } catch (e) { /* 只读 dataset 场景忽略 */ }

    if (window.TableStickyOverlay) TableStickyOverlay.install(container);

    // 🟢 v230.0a（AUDIT-230-0a）：注入样式 + 渲染筛选 chips + 汇总行 + 非虚拟表 tbody 变更监听
    this._injectExtrasStyle();
    this._renderChipsFor(table, tableKey, columnFilters, sortState, colFields, container);
    if (table.dataset.summary === '1') {
      if (!this._isVirtualTable(table)) {
        // 非虚拟表：监听 tbody 子节点变化（模块重渲 / 翻页），rAF 防抖刷新汇总行
        if (table._summaryObserver) { try { table._summaryObserver.disconnect(); } catch (e) { console.warn('[js/table-utils.js:893] 异常(已忽略):', e); } }
        const tb = table.querySelector('tbody');
        if (tb) {
          let scheduled = false;
          const obs = new MutationObserver(() => {
            if (scheduled) return; scheduled = true;
            requestAnimationFrame(() => { scheduled = false; try { TableUtils._refreshSummary(table); } catch (e) { console.warn('[js/table-utils.js:899] 异常(已忽略):', e); } });
          });
          obs.observe(tb, { childList: true });
          table._summaryObserver = obs;
        }
      }
      this._refreshSummary(table);
    }
  },

  /**
   * 🟢 v229.98（AUDIT-229-98-11）：清空当前视图内所有表格的「表头列筛选」。
   *   背景：模块顶部「重置」按钮只清 currentFilter / 日期 / 关键词，表头列筛选
   *   （存在 TablePrefs 里）照旧生效 —— 用户点了重置却发现行数没变，以为功能坏了；
   *   而且那份筛选会跨刷新存活，只能用浏览器刷新页面才能甩掉。
   *   做法：清内存中的 columnFilters → 清该表的持久化筛选 → 复位行可见性与筛选图标激活态；
   *   虚拟滚动表额外把数据集还原为原始全量并重渲染。调用后由模块自己 loadData/render 刷新剩余状态即可。
   * @param {HTMLElement} [root] 默认 document
   */
  clearColumnFiltersInView(root) {
    const base = root || document;
    const tables = base.querySelectorAll('.data-table');
    const touched = [];
    tables.forEach((table) => {
      const key = TableUtils._deriveTableKey(table);
      if (key) { TablePrefs.clearFiltersFor(key); touched.push(key); }
      // 复位当前渲染出来的行（下次重渲染会重建，这里保证「不重渲染也能立刻看到全量」）
      const tbody = table.querySelector('tbody');
      if (tbody) {
        Array.from(tbody.children).forEach((tr) => {
          if (tr.classList.contains('vt-spacer')) return;
          tr.style.display = '';
        });
      }
      table.querySelectorAll('.th-filter-icon.active').forEach((ic) => ic.classList.remove('active'));
      // 虚拟表：把数据集还原成原始全量并重渲染窗口
      if (Array.isArray(table._vtRawItems)) {
        table._vtItems = table._vtRawItems.slice();
        table._vtTextRows = undefined;
        if (typeof table._vtRender === 'function') table._vtRender();
      }
      table._vtTextRows = undefined;
    });
    return touched;
  },

  // ==========================================================================
  // 🟢 v230.0a（AUDIT-230-0a）：筛选条件可视化条 + 底部汇总行
  // --------------------------------------------------------------------------
  // 目标：对标 Excel 缺失能力，直接消解 P1-1（重置不同步让用户以为功能坏了）。
  //   · 筛选 chips：把当前生效的列筛选 / 排序以「列名: 条件 ✕」可视化呈现，
  //     单删 = 清该列筛选；「清除全部筛选」= 清该表全部筛选+排序，所见即所得。
  //   · 底部汇总行：数值列显示「合计 / 均值」，随筛选/排序/翻页联动。
  // 设计纪律：
  //   · chips 空态 display:none（零布局占用），仅在确有生效条件时出现；
  //   · 汇总行聚合数据源统一为「当前可见/筛选后的行」——虚拟表用 _vtItems 完整数据集，
  //     其余表用 DOM 可见行（display!=none），两条路径都对「业务筛选+表头列筛选」一致；
  //   · 虚拟表汇总按「数据代际(vtSummaryGen)」增量刷新，避免每帧滚动重算。
  // ==========================================================================

  // 🟢 v230.20（审查收敛）：转义实现收敛到全局唯一入口（config.js window.esc/escAttr）。
  //   全局 esc 覆盖 & < > " ' 五种字符，比原内部实现（_escHtml 仅 4 种）多转义单引号——
  //   文本渲染视觉一致、属性值更安全。保留方法名使既有 9 处调用点零改动。
  _escHtml(s) { return esc(s); },
  _escAttr(s) { return escAttr(s); },

  // 把「单元格原文」清洗为可求和数值（货币/千分位/百分号兼容）
  _parseNumeric(raw) {
    if (raw === '' || raw === '-' || raw === '—' || raw === '/') return null;
    const cleaned = String(raw).replace(/[¥$￥,\s，%\s]/g, '');
    if (cleaned === '') return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  },
  _formatSummary(n, isMoney) {
    if (!isFinite(n)) n = 0;
    let s;
    const abs = Math.abs(n);
    if (abs >= 10000) s = n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
    else s = (Math.round(n * 100) / 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    return isMoney ? '¥' + s : s;
  },

  // —— 筛选 chips ——
  _chipConditionText(state) {
    const kw = (state && state.kw) || '';
    const ex = (state && state.excluded) || [];
    if (kw && ex.length) return '含"' + kw + '"·排除' + ex.length + '项';
    if (kw) return '含"' + kw + '"';
    if (ex.length) return '排除' + ex.length + '项';
    return '';
  },

  // 找到（或创建）某 tableKey 对应的 chips 挂载点：插在表格包裹层之前；
  // 无包裹层时退回容器顶部。已存在则复用（模块重渲后不重复建）。
  _findChipsHost(tableKey, table, container) {
    let host = null;
    try { host = document.querySelector('.tb-filter-chips[data-key="' + (window.CSS && CSS.escape ? CSS.escape(tableKey) : tableKey) + '"]'); } catch (e) { /* 选择器异常兜底 */ }
    if (host) return host;
    host = document.createElement('div');
    host.className = 'tb-filter-chips';
    host.dataset.key = tableKey;
    let inserted = false;
    const anchor = (table && table.closest && table.closest('.table-wrapper'))
      || (table && table.parentElement && table.parentElement !== container ? table.parentElement : null)
      || table;
    // 🟢 v230.24（全模块卡顿走查发现）：原先用 container.contains(anchor) 判断后直接
    //   insertBefore(host, anchor) —— contains 是「后代关系」，insertBefore 却要求 anchor 是
    //   container 的【直接子节点】；当表格嵌在孙层（如存货档案详情页
    //   sectionId > 滚动层 > .table-wrapper > table）时 contains 通过但 insertBefore 抛
    //   NotFoundError，且异常会中断 initSortableHeaders 的后续初始化（chips 不渲染）。
    //   改为父子关系精确判断，深层 anchor 自然落到下方的容器顶部兜底。
    if (container && anchor && anchor !== container && anchor.parentNode === container) {
      container.insertBefore(host, anchor);
      inserted = true;
    }
    if (!inserted && container) container.insertBefore(host, container.firstChild);
    else if (!inserted) document.body.appendChild(host);
    return host;
  },

  // 读取某表当前生效的列筛选（从 TablePrefs 持久化反查），供 chips 渲染
  getActiveFilters(tableKey) {
    const out = [];
    if (!tableKey) return out;
    const all = (TablePrefs && TablePrefs._read) ? TablePrefs._read() : {};
    const fmap = all && all.filters && all.filters[tableKey];
    if (!fmap) return out;
    Object.keys(fmap).forEach((field) => {
      const st = fmap[field];
      if (st && (st.kw || (st.excluded && st.excluded.length))) {
        out.push({ colField: field, label: field, state: st });
      }
    });
    return out;
  },
  // 🟢 v230.0b：读取某表当前生效的排序（单键返回对象，多键返回 { multi: [{colField,dir}...] }）
  getActiveSorts(tableKey) {
    const reg = this._tableRegistry[tableKey];
    if (!reg || !reg.sortState || !reg.colFields) return null;
    const keys = Array.isArray(reg.sortState.keys) ? reg.sortState.keys.filter(k => k.dir !== 0 && k.col >= 0) : [];
    if (keys.length > 1) {
      return { multi: keys.map(k => ({ colField: reg.colFields[k.col], dir: k.dir })) };
    }
    const k0 = keys[0] || (reg.sortState.dir !== 0 && reg.sortState.col >= 0
      ? { col: reg.sortState.col, dir: reg.sortState.dir } : null);
    if (k0) return { colField: reg.colFields[k0.col], dir: k0.dir };
    return null;
  },

  // 核心：根据某表当前的 columnFilters（内存闭包）+ 排序状态，渲染其 chips 条
  _renderChipsFor(table, tableKey, columnFilters, sortState, colFields, container) {
    if (!tableKey) return;
    const host = this._findChipsHost(tableKey, table, container);
    if (!host) return;
    const filters = [];
    if (colFields && columnFilters) {
      colFields.forEach((field, ci) => {
        if (!field) return;
        const st = TablePrefs.getFilter(tableKey, field);
        if (st && (st.kw || (st.excluded && st.excluded.length))) {
          filters.push({ colField: field, label: field, state: st });
        }
      });
    }
    const sort = (sortState && sortState.dir !== 0 && sortState.col >= 0 && colFields)
      ? { colField: colFields[sortState.col], dir: sortState.dir } : null;
    // 🟢 v230.0b：多键排序时，附带完整多键列表供 chips 逐键展示
    const sortKeys = (sortState && Array.isArray(sortState.keys) && sortState.keys.length > 1 && colFields)
      ? sortState.keys.map((k, i) => ({ colField: colFields[k.col], dir: k.dir, rank: i + 1 }))
      : null;
    this.renderFilterChips(host, tableKey, {
      filters,
      sort,
      sortKeys,
      onRemoveFilter: (colField) => this._removeColumnFilter(tableKey, colField),
      onRemoveSort: () => this._resetSort(tableKey),
      onRemoveSortKey: (colField) => this._removeSortKey(tableKey, colField),
      onClearAll: () => this._clearAllFor(tableKey),
    });
  },

  // 纯 DOM 构建：把 filters/sort 渲染成 chips（空则隐藏整条）
  renderFilterChips(host, tableKey, cfg) {
    if (!host) return;
    const filters = cfg.filters || [];
    const sort = cfg.sort || null;
    const sortKeys = cfg.sortKeys || null;
    const hasActive = filters.length || sort;
    // 🟢 v230.17：高级筛选模块已整体移除——chips 条不再常驻，仅在确有生效条件时出现。
    if (!tableKey) { host.innerHTML = ''; host.classList.remove('active'); return; }
    // 🔴 SPEC-230-01 修复（v230.20）：无条件 add('active') 使空 chips 条常驻占位
    //   （4 模块实测复现：无筛选/排序时仍显示空白条）。改为按 hasActive 切换；
    //   顺带移除死类 active-has——全仓无任何对应 CSS 规则。
    host.classList.toggle('active', !!hasActive);
    if (!hasActive) { host.innerHTML = ''; return; }
    let html = '<div class="tb-chips-inner">';

    filters.forEach((f) => {
      const txt = this._chipConditionText(f.state);
      html += '<span class="tb-chip tb-chip-filter">'
        + '<span class="tb-chip-label">' + this._escHtml(f.label) + '</span>'
        + '<span class="tb-chip-cond">' + this._escHtml(txt) + '</span>'
        + '<button class="tb-chip-x" aria-label="移除该列筛选" data-field="' + this._escAttr(f.colField) + '">✕</button></span>';
    });

    // 排序 chips：多键逐键展示（带优先级序号），单键保持原样式
    if (sortKeys && sortKeys.length) {
      sortKeys.forEach((k) => {
        const arrow = k.dir === 1 ? '↑' : '↓';
        html += '<span class="tb-chip tb-chip-sort">'
          + '<span class="tb-chip-rank">' + k.rank + '</span>'
          + '<span class="tb-chip-label">' + this._escHtml(k.colField) + '</span>'
          + '<span class="tb-chip-cond">' + arrow + '</span>'
          + '<button class="tb-chip-x" aria-label="移除该排序键" data-sortfield="' + this._escAttr(k.colField) + '">✕</button></span>';
      });
    } else if (sort) {
      const arrow = sort.dir === 1 ? '↑' : '↓';
      html += '<span class="tb-chip tb-chip-sort">'
        + '<span class="tb-chip-label">排序</span>'
        + '<span class="tb-chip-cond">' + this._escHtml(sort.colField) + ' ' + arrow + '</span>'
        + '<button class="tb-chip-x" aria-label="移除排序">✕</button></span>';
    }
    if (hasActive) html += '<button class="tb-chip-clear" data-clear="1">清除全部筛选</button>';
    html += '</div>';
    host.innerHTML = html;
    host.querySelectorAll('.tb-chip-filter .tb-chip-x').forEach((b) => {
      b.addEventListener('click', () => { try { cfg.onRemoveFilter(b.dataset.field); } catch (e) { console.warn('[js/table-utils.js:1120] 异常(已忽略):', e); } });
    });
    host.querySelectorAll('.tb-chip-sort .tb-chip-x').forEach((b) => {
      if (b.dataset.sortfield && cfg.onRemoveSortKey) {
        b.addEventListener('click', () => { try { cfg.onRemoveSortKey(b.dataset.sortfield); } catch (e) { console.warn('[js/table-utils.js:1124] 异常(已忽略):', e); } });
      } else {
        b.addEventListener('click', () => { try { cfg.onRemoveSort(); } catch (e) { console.warn('[js/table-utils.js:1126] 异常(已忽略):', e); } });
      }
    });
    const clr = host.querySelector('.tb-chip-clear');
    if (clr) clr.addEventListener('click', () => { try { cfg.onClearAll(); } catch (e) { console.warn('[js/table-utils.js:1130] 异常(已忽略):', e); } });
  },

  // chips「单删某列筛选」：清持久化 + 清内存闭包 + 重放其余筛选 + 重渲 chips/汇总行
  _removeColumnFilter(tableKey, colField) {
    const reg = this._tableRegistry[tableKey];
    if (TablePrefs) TablePrefs.setFilter(tableKey, colField, { kw: '', excluded: [] });
    if (!reg) return;
    delete reg.columnFilters[colField];
    this._applyTableSortAndFilter(reg.table, reg.sortState.col, reg.sortState.dir, reg.columnFilters, reg.sortState.keys);
    const ci = reg.colFields ? reg.colFields.indexOf(colField) : -1;
    if (ci >= 0 && reg.ths && reg.ths[ci]) {
      const ic = reg.ths[ci].querySelector('.th-filter-icon');
      if (ic) ic.classList.remove('active');
    }
    this._renderChipsFor(reg.table, tableKey, reg.columnFilters, reg.sortState, reg.colFields, reg.container);
    this._refreshSummary(reg.table);
  },

  // chips「移除排序」：复位排序状态 + 重放 + 重渲
  _resetSort(tableKey) {
    const reg = this._tableRegistry[tableKey];
    if (!reg) return;
    reg.sortState.col = -1;
    reg.sortState.dir = 0;
    reg.sortState.keys = [];
    this._refreshArrowState(reg.ths, -1, 0, []);
    this._applyTableSortAndFilter(reg.table, -1, 0, reg.columnFilters, []);
    this._renderChipsFor(reg.table, tableKey, reg.columnFilters, reg.sortState, reg.colFields, reg.container);
    this._refreshSummary(reg.table);
  },

  // 🟢 v230.0b：chips「移除某个排序键」——多键排序里单删一键，其余键顺序不变并重排
  _removeSortKey(tableKey, colField) {
    const reg = this._tableRegistry[tableKey];
    if (!reg || !reg.sortState) return;
    const ci = reg.colFields ? reg.colFields.indexOf(colField) : -1;
    if (ci < 0) return;
    if (!Array.isArray(reg.sortState.keys)) reg.sortState.keys = [];
    reg.sortState.keys = reg.sortState.keys.filter((k) => k.col !== ci);
    this._syncSortStateFromKeys(reg.sortState);
    this._refreshArrowState(reg.ths, reg.sortState.col, reg.sortState.dir, reg.sortState.keys);
    this._applyTableSortAndFilter(reg.table, reg.sortState.col, reg.sortState.dir, reg.columnFilters, reg.sortState.keys);
    this._renderChipsFor(reg.table, tableKey, reg.columnFilters, reg.sortState, reg.colFields, reg.container);
    this._refreshSummary(reg.table);
  },

  // chips「清除全部筛选」：清该表全部列筛选 + 排序，所见即所得
  _clearAllFor(tableKey) {
    const reg = this._tableRegistry[tableKey];
    if (TablePrefs) TablePrefs.clearFiltersFor(tableKey);
    if (!reg) return;
    Object.keys(reg.columnFilters).forEach((k) => { delete reg.columnFilters[k]; });
    const tbody = reg.table.querySelector('tbody');
    if (tbody) Array.from(tbody.children).forEach((tr) => { if (!tr.classList.contains('vt-spacer')) tr.style.display = ''; });
    reg.table.querySelectorAll('.th-filter-icon.active').forEach((ic) => ic.classList.remove('active'));
    if (Array.isArray(reg.table._vtRawItems)) {
      reg.table._vtItems = reg.table._vtRawItems.slice();
      reg.table._vtTextRows = undefined;
      if (typeof reg.table._vtRender === 'function') reg.table._vtRender();
    }
    reg.sortState.col = -1;
    reg.sortState.dir = 0;
    reg.sortState.keys = [];
    this._refreshArrowState(reg.ths, -1, 0, []);
    this._renderChipsFor(reg.table, tableKey, reg.columnFilters, reg.sortState, reg.colFields, reg.container);
    this._refreshSummary(reg.table);
  },

  // —— 底部汇总行 ——
  // 聚合数据源：虚拟表=完整数据集(_vtItems)，其余=DOM 可见行(display!=none)
  _getAggregationSource(table) {
    if (this._isVirtualTable(table)) {
      this._ensureVtTextRows(table);
      return table._vtTextRows || [];
    }
    const tbody = table.querySelector('tbody');
    const rows = [];
    if (tbody) tbody.querySelectorAll('tr:not(.vt-spacer)').forEach((tr) => {
      if (tr.style.display === 'none') return;
      const cells = [];
      for (const td of tr.children) cells.push(this._cellValue(td));
      rows.push(cells);
    });
    return rows;
  },

  // 虚拟表用完整数据集求单元格原文（与筛选弹窗同源，懒构建并缓存）
  _ensureVtTextRows(table) {
    if (Array.isArray(table._vtTextRows)) return;
    const items = table._vtItems || [];
    const rowHtml = table._vtRowHtml;
    const valueAt = (typeof table._vtValueAt === 'function') ? table._vtValueAt : null;
    const thCount = table.querySelectorAll('thead th').length;
    table._vtTextRows = items.map((it, rowIdx) => {
      if (typeof rowHtml === 'function') {
        const tmp = document.createElement('tbody');
        tmp.innerHTML = rowHtml(it, rowIdx);
        const tr = tmp.querySelector('tr');
        if (!tr) return [];
        return Array.from(tr.children).map((td) => this._cellValue(td));
      }
      if (valueAt) {
        const row = [];
        for (let c = 0; c < thCount; c++) { const v = valueAt(it, c); row.push(v == null ? '' : String(v)); }
        return row;
      }
      return [];
    });
  },

  // 数值列识别：表头含 NUMERIC_KEYWORDS 且数据中确有可解析数值
  _detectNumericCols(table, ths, rows) {
    const cols = [];
    Array.from(ths).forEach((th, ci) => {
      const label = (th.querySelector && th.querySelector('.th-sort-label')) ? th.querySelector('.th-sort-label').textContent : th.textContent;
      const text = (label || '').trim();
      if (!this.NUMERIC_KEYWORDS.some((k) => text.includes(k))) return;
      let ok = false;
      for (const r of rows) {
        const n = this._parseNumeric(r[ci]);
        if (n !== null) { ok = true; break; }
      }
      if (ok) cols.push(ci);
    });
    return cols;
  },

  _renderSummaryRow(table) {
    const tbody = table.querySelector('tbody');
    const thead = table.querySelector('thead');
    if (!tbody) return;
    const ths = thead ? thead.querySelectorAll('th') : [];
    const rows = this._getAggregationSource(table);
    const old = table.querySelector('tfoot.tb-summary-row');
    if (!rows.length) { if (old) old.remove(); return; }
    const numericCols = this._detectNumericCols(table, ths, rows);
    if (!numericCols.length) { if (old) old.remove(); return; }

    const sums = {}, counts = {};
    numericCols.forEach((ci) => { sums[ci] = 0; counts[ci] = 0; });
    rows.forEach((r) => {
      numericCols.forEach((ci) => {
        const n = this._parseNumeric(r[ci]);
        if (n !== null) { sums[ci] += n; counts[ci] += 1; }
      });
    });

    // 🟢 v230.10：列对齐继承 —— 汇总格与对应列的数据格保持同一 text-align。
    //   旧实现硬编码 text-align:right，而 .data-table tbody td 默认居中（且用户可用对齐按钮
    //   inline 覆盖成 left/right/center），导致汇总值与数据列错位——这正是「排版不正 /
    //   汇总数据没有居中」的根因。
    //   取值顺序：数据行 td inline（真实来源，v227.77 _applyAlignPrefs 就写在这里）
    //             → thead th inline → center 默认。
    //   注意不可反过来先读 th：.data-table thead th[style*="text-align"] 被 CSS 强制居中，
    //   th 的 inline 值并不代表该列真实对齐。
    const _colAlign = (ci) => {
      let a = '';
      if (tbody.rows[0] && tbody.rows[0].cells[ci]) a = tbody.rows[0].cells[ci].style.textAlign || '';
      if (!a && ths[ci] && ths[ci].style) a = ths[ci].style.textAlign || '';
      return (a === 'left' || a === 'right' || a === 'center') ? a : 'center';
    };

    const firstNum = numericCols[0];
    const cells = [];
    let labelDone = false;
    Array.from(ths).forEach((th, ci) => {
      // 首个数值列之前的非数值列（序号/编码/名称/规格…）由标签格一次 colspan 吸收，
      // 不再把「合计 N 行」塞进极窄的序号列里撑破/溢出（v230.10 修「排版不正」）。
      if (ci < firstNum) {
        if (ci === 0) {
          cells.push('<td class="tb-summary-label" colspan="' + Math.max(firstNum, 1) + '" style="text-align:' + _colAlign(0) + '">'
            + '<span class="tb-summary-tag">合计</span><span class="tb-summary-count">' + rows.length + '</span> 行</td>');
          labelDone = true;
        }
        return;
      }
      if (numericCols.indexOf(ci) >= 0) {
        const isMoney = /(金额|单价|价格|总价|扣款|价税)/.test(th.textContent || '');
        const avg = counts[ci] ? sums[ci] / counts[ci] : 0;
        // 兜底：若首列本身就是数值列（firstNum===0），无处安放标签 → 内联到首个数值格前缀，
        // 保证列数与数据行严格一致（绝不新增一列导致整体错位）。
        const labelPrefix = (!labelDone && ci === firstNum)
          ? '<span class="tb-summary-tag">合计</span><span class="tb-summary-count">' + rows.length + '</span> 行 '
          : '';
        if (labelPrefix) labelDone = true;
        cells.push('<td class="tb-summary-num" style="text-align:' + _colAlign(ci) + '">' + labelPrefix
          + '<b class="tb-summary-val">' + this._formatSummary(sums[ci], isMoney)
          + '</b><span class="tb-summary-avg">均 ' + this._formatSummary(avg, isMoney) + '</span></td>');
      } else {
        cells.push('<td style="text-align:' + _colAlign(ci) + '"></td>');
      }
    });

    const tfoot = document.createElement('tfoot');
    tfoot.className = 'tb-summary-row';
    tfoot.innerHTML = '<tr>' + cells.join('') + '</tr>';
    if (old) table.replaceChild(tfoot, old); else table.appendChild(tfoot);
  },

  // 统一刷新入口（被排序/筛选应用、虚拟渲染、MutationObserver 调用）
  _refreshSummary(table) {
    if (!table || table.dataset.summary !== '1') return;
    if (this._isVirtualTable(table)) {
      if (table._vtSummaryGen === table._vtSummaryRenderedGen) return; // 滚动帧未变，跳过
      table._vtSummaryRenderedGen = table._vtSummaryGen;
    }
    this._renderSummaryRow(table);
  },

  // 一次性注入 chips / 汇总行样式（设计令牌，带兜底色）
  _injectExtrasStyle() {
    if (document.getElementById('tb-extras-style')) return;
    const css = ''
      // 🟢 v230.15：筛选状态栏 chips 重设计——「状态标签（浅色 tint 实底 tag）」+
      //   「行动入口（冰川蓝玻璃主按钮）」+「文字型清除」三类视觉语言分层，告别旧版
      //   「三色描边幽灵 chip + 无底幽灵入口」的杂乱观感；暗色主题逐条适配。
      + '.tb-filter-chips{display:none;flex-wrap:wrap;gap:8px;margin:0 0 10px;}'
      + '.tb-filter-chips.active{display:flex;}'
      + '.tb-chips-inner{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}'
      // chip 通用：浅色 tint 实底 + 同色系深字 + 6px 圆角（现代 tag 语言）
      + '.tb-chip{display:inline-flex;align-items:center;gap:6px;border-radius:6px;padding:2px 4px 2px 9px;font-size:12px;line-height:20px;border:1px solid transparent;}'
      + '.tb-chip-label{font-weight:600;}'
      + '.tb-chip-label::after{content:"";display:inline-block;width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.5;margin-left:6px;vertical-align:2px;}'
      + '.tb-chip-cond{font-weight:400;opacity:.78;}'
      + '.tb-chip-x{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;background:transparent;color:inherit;opacity:.55;cursor:pointer;font-size:11px;line-height:1;border-radius:50%;transition:opacity .15s,background .15s;margin-right:1px;}'
      + '.tb-chip-x:hover{opacity:1;background:rgba(15,23,42,.10);}'
      // 列筛选 chip：冰川蓝 tint（与全站主色同源）
      + '.tb-chip-filter{background:rgba(91,155,213,.13);border-color:rgba(91,155,213,.30);color:#1E4A7A;}'
      // 排序 chip：紫 tint
      + '.tb-chip-sort{background:rgba(139,92,246,.10);border-color:rgba(139,92,246,.24);color:#5B21B6;}'
      // 暗色适配：tint 提亮 + 亮字
      + '[data-theme="dark"] .tb-chip-filter{background:rgba(91,155,213,.18);border-color:rgba(91,155,213,.40);color:#BFDBF7;}'
      + '[data-theme="dark"] .tb-chip-sort{background:rgba(139,92,246,.20);border-color:rgba(139,92,246,.44);color:#DDD6FE;}'
      + '[data-theme="dark"] .tb-chip-x:hover{background:rgba(255,255,255,.14);}'
      // 🟢 v230.0b：多列排序优先级序号 + 逻辑分隔徽标
      + '.th-sort-rank{display:inline-flex;align-items:center;justify-content:center;min-width:14px;height:14px;padding:0 3px;margin-left:4px;border-radius:7px;background:#8b5cf6;color:#fff;font-size:9px;line-height:1;vertical-align:middle;}'
      + '.tb-chip-sort .tb-chip-rank{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;border-radius:8px;background:#7C3AED;color:#fff;font-size:10px;font-weight:700;line-height:1;}'
      // 「清除全部」：纯文字按钮（去掉旧虚线幽灵框），hover 转 danger 红——语义即破坏性操作
      + '.tb-chip-clear{border:none;background:transparent;color:var(--text-secondary,#64748b);border-radius:6px;padding:3px 9px;font-size:12px;font-weight:600;cursor:pointer;line-height:20px;transition:color .15s,background .15s;margin-left:2px;}'
      + '.tb-chip-clear:hover{color:#dc2626;background:rgba(220,38,38,.08);}'
      + '[data-theme="dark"] .tb-chip-clear:hover{color:#f87171;background:rgba(248,113,113,.12);}'
      // 🟢 v230.11：汇总行回归普通行（去掉上轮误加的 position:sticky;bottom:0 吸底）——
      //   用户明确要求「汇总行应该拉到最后才显示」：它就是表格的合计行，属于数据末尾，
      //   不是常驻工具条。tfoot 本就 append 在 tbody 之后，非 sticky 即随内容滚到底才出现。
      //   （附带收益：各浏览器对 tfoot 上 sticky 的支持并不一致，去掉后渲染更可预期。）
      + '.tb-summary-row{}'
      + '.tb-summary-row td{background:rgba(91,155,213,.06);font-weight:600;'
      + 'border-top:2px solid var(--primary,#5b9bd5);'
      + 'border-bottom:1px solid var(--card-border,#dbe6f0);'
      + 'border-right:1px solid rgba(94,154,208,0.18);'
      + 'color:var(--text-main,#0f172a);padding:7px 10px;font-size:12px;'
      + 'text-align:center;vertical-align:middle;font-variant-numeric:tabular-nums;}'
      + '.tb-summary-row td:last-child{border-right:none;}'
      + '[data-theme="dark"] .tb-summary-row td{background:rgba(56,189,248,.10);border-top-color:rgba(56,189,248,.55);border-right-color:rgba(94,154,208,0.22);border-bottom-color:rgba(94,154,208,0.22);}'
      + '.tb-summary-label{font-size:12px;color:var(--text-secondary,#64748b);white-space:nowrap;}'
      + '.tb-summary-tag{display:inline-flex;align-items:center;height:18px;padding:0 8px;margin-right:6px;border-radius:9px;background:var(--primary,#5b9bd5);color:#fff;font-size:11px;font-weight:600;letter-spacing:.5px;vertical-align:middle;}'
      + '.tb-summary-count{font-weight:700;color:var(--primary,#5b9bd5);font-size:13px;padding:0 1px;}'
      + '.tb-summary-num{white-space:nowrap;line-height:1.35;}'
      + '.tb-summary-val{display:block;font-size:13px;font-weight:700;color:var(--text-main,#0f172a);}'
      + '.tb-summary-avg{display:block;margin-top:1px;font-size:10px;font-weight:400;color:var(--text-secondary,#94a3b8);letter-spacing:.2px;}';
    const style = document.createElement('style');
    style.id = 'tb-extras-style';
    style.textContent = css;
    document.head.appendChild(style);
  },

  /**
   * 🟢 v229.98（AUDIT-229-98-14）：给「模块自己手写 innerHTML 渲染」的表格挂载数据集。
   *   背景：筛选弹窗的候选值有两种取法 —— 有 _vtItems 时取【全量数据集】，否则退回【当前页 DOM 行】。
   *   走 virtualTable 的表两种分页都有 _vtItems，没问题；但自己拼 <table> 的模块（库存预警等）
   *   只能看到当前页那几十行，导致「翻到别的页才出现的取值，筛选弹窗里根本没有」——
   *   用户会误以为数据里没有这个值。
   *   修法：模块在渲染完表格后调用本函数把全量数据挂上去，候选值立即覆盖所有页。
   *   @param {HTMLTableElement|HTMLElement} tableOrHost 表格元素或其容器
   *   @param {Array} items 该表【当前筛选后】的完整数据行（不是当前页）
   *   @param {function} [rowHtml] (item) => '<tr>...</tr>' 行渲染器（优先，取值与画面完全一致）
   *   @param {function} [valueAt] (item, colIdx) => string 取值器（没有行渲染器时用，次之）
   */
  attachDataset(tableOrHost, items, rowHtml, valueAt) {
    if (!tableOrHost) return;
    const table = (tableOrHost.tagName === 'TABLE') ? tableOrHost : tableOrHost.querySelector('.data-table');
    if (!table || !Array.isArray(items)) return;
    try {
      table._vtItems = items;
      if (typeof rowHtml === 'function') table._vtRowHtml = rowHtml;
      if (typeof valueAt === 'function') table._vtValueAt = valueAt;
      table._vtTextRows = undefined; // 取值缓存失效，下次打开弹窗重算
    } catch (e) { /* 只读场景忽略 */ }
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
    const { ths, table, tableKey, colFields, columnFilters, sortState, opts, container } = ctx;
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
        this._applyTableSortAndFilter(table, sortState.col, sortState.dir, columnFilters, sortState.keys);
        this._renderChipsFor(table, tableKey, columnFilters, sortState, colFields, container);
        this._refreshSummary(table);
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
        // 🟢 v230.0b（AUDIT-230-0b）：Shift+点击 = 多列排序（追加/切换次级键）；普通点击 = 单列三态排序。
        if (e.shiftKey) {
          this._toggleMultiSortKey(ths, sortState, colIdx);
        } else {
          sortState.keys = [];
          if (sortState.col === colIdx) {
            sortState.dir = sortState.dir === 1 ? 2 : sortState.dir === 2 ? 0 : 1;
          } else {
            sortState.dir = 1;
          }
          sortState.col = sortState.dir === 0 ? -1 : colIdx;
          if (sortState.dir !== 0) sortState.keys = [{ col: colIdx, dir: sortState.dir }];
        }
        this._syncSortStateFromKeys(sortState);
        this._refreshArrowState(ths, sortState.col, sortState.dir, sortState.keys);
        this._applyTableSortAndFilter(table, sortState.col, sortState.dir, columnFilters, sortState.keys);
        this._renderChipsFor(table, tableKey, columnFilters, sortState, colFields, container);
        this._refreshSummary(table);
        if (typeof opts.onSortChange === 'function') {
          const field = colFields[sortState.col] || '';
          opts.onSortChange(field, sortState.dir);
        }
      });
    }

    if (columnFilters[colIdx]) filterIcon.classList.add('active');
  },


  // 🟢 v230.0b（AUDIT-230-0b）：Shift+点击表头 —— 把该列追加/切换为次级排序键。
  //   规则（对标 Excel）：
  //     · 该列不在 keys 中 → 以升序追加到末尾；
  //     · 该列已在 keys 中 → 升→降→移除 三态循环；
  //     · 移除后其余键顺序不变（前一个键自动升为主键）。
  _toggleMultiSortKey(ths, sortState, colIdx) {
    if (!Array.isArray(sortState.keys)) sortState.keys = [];
    const keys = sortState.keys;
    const i = keys.findIndex((k) => k.col === colIdx);
    if (i < 0) {
      keys.push({ col: colIdx, dir: 1 });
    } else if (keys[i].dir === 1) {
      keys[i].dir = 2;
    } else {
      keys.splice(i, 1);
    }
    this._syncSortStateFromKeys(sortState);
  },

  // 把 keys[0] 镜像回 col/dir（保持既有单列路径的字段语义）；keys 空则复位为无排序。
  _syncSortStateFromKeys(sortState) {
    const keys = (sortState && Array.isArray(sortState.keys)) ? sortState.keys : [];
    if (keys.length) {
      sortState.col = keys[0].col;
      sortState.dir = keys[0].dir;
    } else {
      sortState.col = -1;
      sortState.dir = 0;
    }
    return sortState;
  },

  // 🟢 v230.0b：更新表头排序指示 —— 支持多列同时高亮，并给非主键显示优先级序号（1/2/3…）。
  _refreshArrowState(ths, col, dir, keys) {
    const multi = Array.isArray(keys) && keys.length > 1;
    const rankMap = {};
    if (Array.isArray(keys)) keys.forEach((k, i) => { rankMap[k.col] = i + 1; });
    ths.forEach((th, i) => {
      const label = th.querySelector('.th-sort-label');
      if (!label) return;
      // 重置所有表头样式
      label.classList.remove('sort-asc', 'sort-desc');
      label.style.color = '';
      // 清掉上一轮可能残留的优先级序号
      const oldRank = th.querySelector('.th-sort-rank');
      if (oldRank) oldRank.remove();
      // 当前排序列高亮（多列时全部高亮）
      const active = Array.isArray(keys) && keys.length
        ? keys.some((k) => k.col === i)
        : (i === col);
      let thisDir = dir;
      if (Array.isArray(keys) && keys.length) {
        const hit = keys.find((k) => k.col === i);
        if (hit) thisDir = hit.dir;
      }
      if (active) {
        if (thisDir === 1) { label.classList.add('sort-asc'); }
        else if (thisDir === 2) { label.classList.add('sort-desc'); }
        // 多列排序时给每列标注优先级序号（第 1 序号也不额外标，靠箭头识别即可；这里序号从 1 起全标更直观）
        if (multi && rankMap[i]) {
          const badge = document.createElement('span');
          badge.className = 'th-sort-rank';
          badge.textContent = String(rankMap[i]);
          label.appendChild(badge);
        }
      }
    });
  },

  _applyTableSortAndFilter(table, sortCol, sortDir, filters, sortKeys) {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    // 🟢 v229.97（AUDIT-229-97-01）：虚拟滚动表改走「数据集路径」。
    //   虚拟表 tbody 里混着 <tr class="vt-spacer"> 占位行（只有 1 个 colspan 单元格、值为空）：
    //   ① 参与排序 → 占位行被 appendChild 重排逻辑挤到数据行之前（实测从第 17 位跳到第 0 位）→ 布局破损；
    //   ② 参与筛选 → 空值不含关键词 → 被 display:none → 虚拟总高度塌陷；
    //   ③ 更根本的问题：DOM 里只渲染了视口附近十几行，在 DOM 层排序/筛选等于「只处理了可见的十几行」，
    //      下一次滚动仍按原始 items 重画 → 排序结果被还原。
    //   故虚拟模式下把排序与筛选下沉到完整数据集，再触发窗口重渲染，彻底根除三类冲突。
    if (this._isVirtualTable(table)) {
      this._applyVirtualSortAndFilter(table, sortCol, sortDir, filters, sortKeys);
      return;
    }

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
        const excludedSet = new Set(excluded.map(v => String(v).toLowerCase()));
        rows.forEach(tr => {
          const td = tr.children[col];
          // 🟢 v229.91（AUDIT-229-01）：改用 _cellValue —— 录入型单元格（<input>）的值在 value 里，
          //   textContent 读不到、还会混入 🔍 图标，导致「勾选筛选后表格毫无变化」。
          const raw = this._cellValue(td).toLowerCase();
          // 🟢 v229.48：空单元格按弹窗展示名「(空)」参与匹配 —— 修复未勾选 (空) 后空值行仍被带出的漏排
          const val = raw === '' ? '(空)' : raw;
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
          // 🟢 v229.91（AUDIT-229-01）：同上，改用 _cellValue
          const val = this._cellValue(td).toLowerCase();
          if (!val.includes(k)) tr.style.display = 'none';
        });
      }
    });

    // 3) 排序（仅对可见行原地重排）—— 🟢 v230.0b：支持多键稳定排序
    if (sortDir !== 0 && sortCol >= 0) {
      const keys = this._normalizeSortKeys(sortKeys, sortCol, sortDir);
      const visible = rows.filter(tr => tr.style.display !== 'none');
      visible.sort((a, b) => this._compareRowsByKeys(a, b, keys, (td) => this._cellToComparable(td)));
      visible.forEach(tr => tbody.appendChild(tr));
    }
    // 🟢 v230.0a（AUDIT-230-0a）：排序/筛选后刷新底部汇总行（数据源=DOM 可见行）
    this._refreshSummary(table);
  },

  // 🟢 v230.0b：把调用方传入的 sortKeys（可能为空）规整为 [{col,dir}, ...] 有序数组。
  //   兼容只传 sortCol/sortDir 的旧路径（构造单键数组）。
  _normalizeSortKeys(sortKeys, sortCol, sortDir) {
    let keys = Array.isArray(sortKeys) ? sortKeys.filter(k => k && k.dir !== 0 && k.col >= 0) : [];
    if (!keys.length && sortDir !== 0 && sortCol >= 0) keys = [{ col: sortCol, dir: sortDir }];
    return keys;
  },

  // 🟢 v230.0b：按有序多键逐级比较。getCmp(td) 返回该单元格的可比较值（DOM 路径传 _cellToComparable）。
  _compareRowsByKeys(ra, rb, keys, getCmp) {
    for (const k of keys) {
      const va = getCmp(ra.children[k.col]);
      const vb = getCmp(rb.children[k.col]);
      let r = 0;
      if (typeof va === 'number' && typeof vb === 'number') {
        r = va - vb;
      } else {
        const sa = String(va), sb = String(vb);
        r = sa.localeCompare(sb, 'zh');
      }
      if (r !== 0) return k.dir === 1 ? r : -r;
    }
    return 0;
  },

  // 🟢 v229.97（AUDIT-229-97-01）：判断表格是否处于虚拟滚动模式。
  //   virtualTable 挂 `_vtItems`（数据集）+ `_vtRender`（窗口重渲染入口）两者齐全才算，
  //   避免把「小表走整表渲染但也挂了 _vtItems」的情况误判成虚拟模式（那条路径必须继续走 DOM 重排，
  //   否则 _vtRender 不存在会导致筛选/排序静默失效）。
  _isVirtualTable(table) {
    return !!(table && Array.isArray(table._vtItems) && typeof table._vtRender === 'function');
  },

  // 把一行 rowHtml(item) 解析成各单元格取值数组（虚拟模式没有真实 <tr>，只能从模板串求值）。
  // 取值语义与 DOM 路径的 _cellValue 保持一致（录入型单元格取 input 的 value）。
  _vtRowValues(item, rowHtml) {
    try {
      const tmp = document.createElement('table');
      tmp.innerHTML = '<tbody>' + rowHtml(item) + '</tbody>';
      const tr = tmp.querySelector('tr');
      if (!tr) return [];
      return Array.from(tr.children).map(td => this._cellValue(td));
    } catch (e) {
      return [];
    }
  },

  // 🟢 v229.97（AUDIT-229-97-01）：虚拟表专用的排序/筛选 —— 作用于完整数据集而非 DOM。
  //   - 始终从 `_vtRawItems`（首次进入时保存的原始全量）重新计算，避免筛选结果叠加丢失数据；
  //   - 每行按 rowHtml 求值一次并缓存（200 行量级可接受，且仅在排序/筛选变更时触发）；
  //   - 过滤语义复用 _valuePassesFilter，排序语义复用 _cellToComparableRaw，保证与 DOM 路径完全一致；
  //   - 结束后写回 `_vtItems` 并触发窗口重渲染，占位行高度由 virtualTable 自行按新总数重算。
  _applyVirtualSortAndFilter(table, sortCol, sortDir, filters, sortKeys) {
    if (!table._vtRawItems) table._vtRawItems = table._vtItems.slice();
    const raw = table._vtRawItems;
    const rowHtml = table._vtRowHtml;
    if (typeof rowHtml !== 'function') return;

    const cache = new Map();
    const valuesOf = (item) => {
      let v = cache.get(item);
      if (!v) { v = this._vtRowValues(item, rowHtml); cache.set(item, v); }
      return v;
    };

    let list = raw.filter(item => {
      const vals = valuesOf(item);
      if (!this._rowPassesOtherFilters((c) => vals[c] ?? '', filters, -1)) return false;
      return true;
    });

    if (sortDir !== 0 && sortCol >= 0) {
      const keys = this._normalizeSortKeys(sortKeys, sortCol, sortDir);
      list = list.slice().sort((a, b) => {
        for (const k of keys) {
          const va = this._cellToComparableRaw(String(valuesOf(a)[k.col] ?? ''));
          const vb = this._cellToComparableRaw(String(valuesOf(b)[k.col] ?? ''));
          let r = 0;
          if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
          else r = String(va).localeCompare(String(vb), 'zh');
          if (r !== 0) return k.dir === 1 ? r : -r;
        }
        return 0;
      });
    }

    table._vtItems = list;
    table._vtTextRows = undefined; // 🟢 v230.0a：数据集已变，失效取值缓存以便汇总行重算
    table._vtSummaryGen = (table._vtSummaryGen || 0) + 1; // 🟢 v230.0a：数据代际+1，触发汇总行重算
    table._vtRender();
    this._refreshSummary(table);
  },
  _cellToComparable(td) {
    if (!td) return '';
    // 🟢 v229.91（AUDIT-229-02）：改用 _cellValue —— 原用 textContent 时，录入型列各行都读到相同的 🔍，
    //   比较恒等 → 出现「点了排序但顺序不变」。
    return this._cellToComparableRaw(this._cellValue(td));
  },

  // 🟢 v229.97（AUDIT-229-97-01）：把「单元格原文 → 可比较值」抽成纯值版本。
  //   虚拟滚动路径没有真实 td 元素（只有 rowHtml 字符串解析出的单元格值），
  //   需要与 DOM 路径共用同一套比较语义，避免两条路径排序结果漂移。
  _cellToComparableRaw(raw) {
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

    // 🟢 v229.90：virtualTable 模式优先用完整数据集（table._vtItems）取列值；
    //   否则降级到当前 tbody DOM 行（小表全量行已在 DOM 中）。
    // 🟢 v229.95：两种路径都改为「分面」取值 —— 候选值只从通过其它列当前筛选的行里取，
    //   使弹窗随当前筛选结果收窄（修：筛了 月均入库=0 后，分类弹窗仍列全部分类的问题）。
    let sortedValues;
    if (table && Array.isArray(table._vtItems)) {
      sortedValues = this._collectColumnValuesFromItems(table, colIdx, currentFilters);
    } else {
      const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
      const facetedRows = rows.filter(tr => this._rowPassesOtherFilters(
        (c) => this._cellValue(tr.children[c]), currentFilters, colIdx));
      sortedValues = this._collectColumnValues(facetedRows, colIdx).sortedValues;
    }

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

  // 🟢 v229.90：统一单元格取值 —— 录入型单元格（<input>/<select>/<textarea>）的值在
  //   value 属性里，textContent 拿不到，反而会把旁边的图标按钮（如 🔍）误当作值；
  //   非表单单元格仍回退 textContent。修复订单核对等录入表筛选弹窗「只显示图标不显示编码」。
  _cellValue(td) {
    if (!td) return '';
    // 🟢 v230.29：单元格可用 data-value 声明「参与筛选/排序的纯值」。
    //   背景：单元格里除数值外还有装饰文本（如查询系统未入库量的「（已关闭）」），
    //   textContent 会把字样一起读进去，导致表头筛选的分面候选值/排除匹配失真。
    //   有 data-value 时一律以它为准，无则回退原逻辑（向后兼容，零副作用）。
    try {
      const dv = td.getAttribute('data-value');
      if (dv !== null && dv !== '') return dv.trim();
      const holder = td.querySelector('[data-value]');
      if (holder) {
        const hv = holder.getAttribute('data-value');
        if (hv !== null && hv !== '') return hv.trim();
      }
    } catch (e) { /* 取值失败回退原逻辑 */ }
    const ctrl = td.querySelector('input, select, textarea');
    if (ctrl && ctrl.value !== undefined) return (ctrl.value ?? '').trim();
    return (td.textContent || '').trim();
  },

  // 🟢 v229.95：判断「单个单元格值(小写原文)」是否通过某列筛选条件 —— 与 _applyTableSortAndFilter 完全同语义：
  //   · excluded：空值按展示名「(空)」参与匹配，命中即不通过；
  //   · kw：小写原文 includes 命中才算通过。
  //   供筛选弹窗做「分面候选值」复用，避免两处语义漂移。
  _valuePassesFilter(rawLower, fs) {
    if (!fs) return true;
    const excluded = Array.isArray(fs.excluded) ? fs.excluded
                    : (Array.isArray(fs.unchecked) ? fs.unchecked : []); // 旧格式兼容
    if (excluded.length > 0) {
      const set = new Set(excluded.map(v => String(v).toLowerCase()));
      const val = rawLower === '' ? '(空)' : rawLower;
      if (set.has(val)) return false;
    }
    const kw = (typeof fs === 'string') ? fs : (fs && fs.kw) || '';
    if (kw) {
      const k = String(kw).toLowerCase();
      if (!rawLower.includes(k)) return false;
    }
    return true;
  },

  // 🟢 v229.95：分面筛选 —— 打开某列(colIdx)筛选弹窗时，候选值只从「通过其它所有列当前筛选」的行里取，
  //   使弹窗随当前筛选结果收窄（如：筛了 月均入库=0 后，分类弹窗只剩「未使用类」这一项）。
  //   getCell(col) 返回该行第 col 列单元格原文（DOM 路径用 _cellValue，虚拟路径用 _vtTextRows 缓存值）。
  //   当前列自身(colIdx)的筛选不参与，保证用户仍能在「已筛集合」内切换该列取值、以及能看到全部可选值。
  _rowPassesOtherFilters(getCell, filters, selfCol) {
    if (!filters) return true;
    for (const ci of Object.keys(filters)) {
      const col = parseInt(ci, 10);
      if (col === selfCol) continue;
      const fs = filters[ci];
      if (!fs) continue;
      const raw = String(getCell(col) ?? '').toLowerCase();
      if (!this._valuePassesFilter(raw, fs)) return false;
    }
    return true;
  },

  _collectColumnValues(rows, colIdx) {
    const valueMap = new Map();
    rows.forEach(tr => {
      const td = tr.children[colIdx];
      const rawVal = this._cellValue(td);
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

  // 🟢 v229.90：virtualTable 模式下 tbody 仅渲染视口附近的行（含 vt-spacer 撑开行），
  //   直接读 DOM 会漏掉绝大多数数据。改为从完整数据集 table._vtItems 提取列值，
  //   保证「选择每页全部」后筛选弹窗能列出该列全部数据。懒构建并缓存，仅首次打开弹窗时计算。
  // 🟢 v229.95：候选值改为「分面」——只取通过其它列当前筛选的行（currentFilters，排除当前列 colIdx），
  //   使弹窗随当前筛选结果收窄（修：筛了 月均入库=0 后，分类弹窗仍列全部分类）。
  _collectColumnValuesFromItems(table, colIdx, currentFilters) {
    if (!Array.isArray(table._vtTextRows)) {
      const items = table._vtItems || [];
      const rowHtml = table._vtRowHtml;
      // 🟢 v229.98（AUDIT-229-98-14）：模块手写 innerHTML 的表格没有行渲染器，
      //   退化用它提供的取值器 _vtValueAt(item, colIdx) 直接取数据，候选值同样能覆盖全部分页。
      const valueAt = typeof table._vtValueAt === 'function' ? table._vtValueAt : null;
      table._vtTextRows = items.map((it, rowIdx) => {
        if (typeof rowHtml === 'function') {
          const tmp = document.createElement('tbody');
          tmp.innerHTML = rowHtml(it, rowIdx);
          const tr = tmp.querySelector('tr');
          if (!tr) return [];
          return Array.from(tr.children).map((td) => this._cellValue(td));
        }
        if (valueAt) {
          const ths = Math.max(table.querySelectorAll('thead th').length, 0);
          const row = [];
          for (let c = 0; c < ths; c++) {
            const v = valueAt(it, c);
            row.push(v === undefined || v === null ? '' : String(v));
          }
          return row;
        }
        return [];
      });
    }
    const valueMap = new Map();
    (table._vtTextRows || []).forEach((row) => {
      if (!this._rowPassesOtherFilters((c) => row[c], currentFilters, colIdx)) return;
      const rawVal = (row[colIdx] !== undefined) ? String(row[colIdx]).trim() : '';
      const displayVal = rawVal === '' ? '(空)' : rawVal;
      valueMap.set(displayVal, (valueMap.get(displayVal) || 0) + 1);
    });
    return Array.from(valueMap.entries()).sort((a, b) => {
      const na = parseFloat(a[0]), nb = parseFloat(b[0]);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      if (!isNaN(na)) return -1;
      if (!isNaN(nb)) return 1;
      return a[0].localeCompare(b[0], 'zh');
    });
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
          // 🟢 v229.91（AUDIT-229-03）：改用取值助手 —— 录入型单元格取 input 的 value，
          //   否则框选求和会把 🔍 图标当成值、数值恒为 NaN。
          const val = parseFloat(TableUtils._cellValue(td).replace(/[¥,，%]/g, '').trim());
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
   * 🟢 v230.23（用户报障：切模块/切 tab 时表格列宽「先按内容排一版、再跳成最终宽度」）：
   * 同步应用列宽到 root 内所有 .data-table —— 在模块 render 的 innerHTML 之后、同一任务内
   * （浏览器 paint 之前）调用，让首帧即最终列宽，从根上消除二段跳。
   * 与 initColumnResizers 的区别：只做「列宽应用 + 拖拽手柄」，不做移动端折叠补挂等重活
   * （那些仍由 app.js 的 MutationObserver rAF 回调兜底，异步到货的表单数据也靠它）。
   * 幂等：已锁宽的表按当前容器宽度重算（flex 表重分配 / 旧表重施 PC 约束），结果稳定。
   * @param {HTMLElement} [root] 默认 document
   */
  applyColumnWidthsNow(root) {
    const scope = root || document;
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    const colField = (th) => { const l = th.querySelector('.th-sort-label'); return (l ? l.textContent : th.textContent).trim(); };
    scope.querySelectorAll('.data-table').forEach(t => {
      if (!t.querySelector('thead')) return;
      const key = this._deriveTableKey(t) || null;
      if (t.dataset.colResize === '1') {
        // 已初始化过：仅按当前容器宽度重算（不重复锁基线/写偏好）
        if (this._useFlex(t, key)) this._applyFlexWidths(t, key, colField);
        else this._applyPcConstraints(t, key);
        return;
      }
      this.initColumnResize(t, { tableKey: key, getColField: colField });
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
        // 🟢 v229.98（AUDIT-229-98-12）：把【这张表】本身传进去。此前只传容器 id，
        //   initSortableHeaders 恒取容器内第一张表 → 多表容器里第二张及以后从未被真正绑定。
        this.initSortableHeaders(containerId, { tableKey, table });
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
        <i class="pg-word">每页</i> <select aria-label="每页显示条数" onchange="${module}.changePageSize(${secArg}this.value === 'all' ? 'all' : parseInt(this.value, 10))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
          ${optsHtml}
        </select> <i class="pg-word">条</i>
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
    // 🟢 v230.24（全模块卡顿走查发现）：翻页 / 改每页条数走「模块 renderTable 重建表格 DOM」路径，
    //   此前列宽只靠 MutationObserver 的 rAF 回调兜底（晚一帧）→ 用户看到「先按内容宽渲染、
    //   再跳成最终宽」的二段跳（实测 stock/inbound/pricing/lowTurnover/orderTrack 跳 30-120px，
    //   与用户报障的查询/库存预警同类）。所有模块均为「先写表格 DOM、再调本方法」时序，
    //   故在此统一收口：render 已同步完成、paint 尚未发生，此刻把列宽应用到位，首帧即最终宽。
    //   与 App.go 的 applyColumnWidthsNow 收口同思路；query/inventoryAlert 模块内双保险保留。
    if (typeof this.applyColumnWidthsNow === 'function') {
      try {
        const pgEl = document.getElementById(containerId);
        let scope = pgEl && pgEl.parentElement ? pgEl.parentElement : null;
        if (!scope || !scope.querySelector('.data-table')) scope = document.getElementById('contentArea');
        this.applyColumnWidthsNow(scope);
      } catch (e) { /* 列宽应用失败不影响分页渲染 */ }
    }
    // 🟢 v230.26（用户报障：下拉框文字「抖一下再居中」）：分页栏的「每页条数」select 也是
    //   原生 → SearchSelect 异步增强（MutationObserver + 120ms），翻页重建分页栏时同样抖动。
    //   此处同步增强，与列宽收口同址；App.go 收口覆盖模块切换首屏，本处覆盖翻页/改条数路径。
    //   注意 scope 要取分页栏容器自身（renderPagination 把 select 写进 containerId 的
    //   innerHTML），而非其 parentElement——后者不含分页栏 select，会扫空。
    if (typeof window.autoEnhanceSelects === 'function') {
      try {
        const pgEl2 = document.getElementById(containerId);
        window.autoEnhanceSelects(pgEl2 || document.getElementById('contentArea') || document);
      } catch (e) { /* 增强失败不影响分页渲染 */ }
    }
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
        try { if (w.scrollWidth - w.clientWidth > 4) flag = '1'; } catch (e) { console.warn('[js/table-utils.js:3136] 异常(已忽略):', e); }
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
      // 🟢 v229.98（AUDIT-229-98-31）：日期比较前统一归一化。
      //   数据里混着 "2026/08/04" 这种斜杠写法时，直接字符串比较会失准 ——
      //   '/' (0x2F) > '-' (0x2D)，于是很旧的斜杠日期反而被判成"大于 cutoff"而保留下来。
      //   取前 10 位并把 "/" 换成 "-"，与 filterByDateRange 同口径。
      const day = String(v).slice(0, 10).replace(/\//g, '-');
      return day >= cutoff;
    });
  },

  /**
   * 🟢 v229.96：按日期区间过滤（含两端端点；from / to 为空表示该端不限制）
   *  - 与 filterRecent3M 同源语义：无日期值的行不通过
   *  - 日期取前 10 位参与比较，并把 "/" 归一化为 "-"，
   *    兼容 "2026-08-04" / "2026-08-04 00:00:00" / "2026/08/04" 三种写法
   *  - 供存货档案详情页「日期区间」控件复用（控制入库记录/关联订单/出库记录三表）
   */
  filterByDateRange(rows, dateField, from, to) {
    const f = (from || '').slice(0, 10);
    const t = (to || '').slice(0, 10);
    return (rows || []).filter(r => {
      const v = r && r[dateField];
      if (!v) return false;
      const d = String(v).slice(0, 10).replace(/\//g, '-');
      if (f && d < f) return false;
      if (t && d > t) return false;
      return true;
    });
  },

  // 存货编码查找键：名称|规格，去空白（O5 去重，逻辑与原内联完全一致）
  buildStockKey(name, spec) {
    return ((name || '') + '|' + (spec || '')).replace(/\s+/g, '');
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
      // 🟢 v229.90：挂完整数据集，供筛选弹窗取列值（小表 DOM 已全量，二者结果一致）
      const _t = area.querySelector('.data-table');
      if (_t) { _t._vtItems = items; _t._vtRowHtml = rowHtml; _t._vtTextRows = undefined; }
      return false;
    }

    const wrapId = 'vt_' + Math.random().toString(36).slice(2, 9);
    area.innerHTML =
      `<div class="${wrapperClass}" id="${wrapId}"><table class="${tableClass} vt-table" ${tableAttrs}>${colgroup}` +
      `<thead>${thead}</thead><tbody class="vt-body"></tbody></table></div>`;
    const wrap = document.getElementById(wrapId);
    if (!wrap) return false;
    const body = wrap.querySelector('.vt-body');
    // 🟢 v229.90：挂完整数据集，供筛选弹窗取列值（虚拟模式 tbody 仅渲染视口行）
    const _vtTable = wrap.querySelector('table');
    if (_vtTable) { _vtTable._vtItems = items; _vtTable._vtRowHtml = rowHtml; _vtTable._vtTextRows = undefined; }

    // 🟢 v229.94：变高虚拟滚动——单元格换行后各行高度可能 1~2 行不等，
    //   不再假设「统一行高」，改为逐行实测高度（heights[]），未测得行用 estRowH 估算。
    const heights = new Array(total).fill(0); // 实测行高，0=尚未测得
    let estRowH = 0, raf = null, destroyed = false;
    const hAt = (i) => heights[i] || estRowH || 38;
    const sumH = (from, to) => { let s = 0; for (let i = from; i < to; i++) s += hAt(i); return s; };
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
      // 🟢 v229.97（AUDIT-229-97-01）：每帧都读取最新的数据集。
      //   表头排序/筛选会把结果写回 table._vtItems（行数与顺序都可能变），
      //   窗口起止行、占位高度必须跟着新总数算，否则会渲染出越界区间或高度不匹配的占位行。
      const its = (_vtTable && Array.isArray(_vtTable._vtItems)) ? _vtTable._vtItems : items;
      const tot = its.length;
      // 筛选后可能一条不剩 —— 明确给空态，避免用户面对一片空白以为功能坏了
      if (tot === 0) {
        body.innerHTML = `<tr class="vt-empty"><td colspan="99" style="padding:22px;text-align:center;color:var(--text-secondary,#64748B);">无符合筛选条件的数据</td></tr>`;
        return;
      }
      if (!estRowH) {
        // 首帧先渲染几行，实测真实行高（避免硬编码与实际样式不符导致滚动漂移）
        body.innerHTML = its.slice(0, 5).map(rowHtml).join('');
        const first = body.querySelector('tr');
        estRowH = (first && first.offsetHeight) || 38;
      }
      // ⚠️ 滚动容器通常是 .table-wrapper 自身（max-height:640px; overflow-y:auto）。
      //    此时容器位置不动、是内部表格在动，所以必须用「表格相对容器视口」的偏移来算起始行，
      //    不能用容器自身的视口位置（那样会永远算成第 0 行，滚动后窗口不更新）。
      const table = wrap.querySelector('table') || wrap;
      const sc = findScroller(wrap);
      const scTop = sc ? sc.getBoundingClientRect().top : 0;
      const vh = sc ? sc.clientHeight : (window.innerHeight || document.documentElement.clientHeight || 800);
      const buffer = 5;
      // 由滚动偏移 y 累加「逐行实测/估算高度」定位首个可见行（支持变高）
      const y = -(table.getBoundingClientRect().top - scTop);
      let s = 0, acc = 0;
      while (s < tot && acc + hAt(s) <= y) { acc += hAt(s); s++; }
      if (s > buffer) s -= buffer; else s = 0;
      const visible = Math.ceil(vh / (estRowH || 38)) + buffer * 2;
      if (s > tot - visible) s = Math.max(0, tot - visible);
      const e = Math.min(tot, s + visible);
      const topH = sumH(0, s);
      const botH = sumH(e, tot);
      body.innerHTML =
        (s > 0 ? `<tr class="vt-spacer" style="height:${topH}px">${cell}</tr>` : '') +
        its.slice(s, e).map(rowHtml).join('') +
        (e < tot ? `<tr class="vt-spacer" style="height:${botH}px">${cell}</tr>` : '');
      // 渲染后回填本窗口实际行高，供后续滚动（上方未测行仍用 estRowH 估算，测得后自动校正）
      const rowsEls = body.querySelectorAll('tr:not(.vt-spacer)');
      for (let k = 0; k < rowsEls.length; k++) {
        const idx = s + k;
        if (idx < tot) heights[idx] = rowsEls[k].offsetHeight;
      }
      // 🟢 v230.0a（AUDIT-230-0a）：滚动/筛选/排序后按数据代际刷新底部汇总行（仅代际变化才重算）
      try { TableUtils._refreshSummary(_vtTable); } catch (e) { console.warn('[js/table-utils.js:3486] 异常(已忽略):', e); }
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
    // 🟢 v229.97（AUDIT-229-97-01）：把「窗口重渲染」与「原始全量数据」挂到表格上，
    //   供 TableUtils._applyVirtualSortAndFilter 在表头排序/筛选时下沉处理并刷新视图。
    //   _vtRawItems 是未经排序/筛选的原始顺序副本，每次 virtualTable 重建都会重置，
    //   保证"取消筛选/恢复无排序"能回到原始数据集，不会出现筛选结果叠加后数据越筛越少。
    if (_vtTable) { _vtTable._vtRender = render; _vtTable._vtRawItems = items.slice(); _vtTable._vtSummaryGen = (_vtTable._vtSummaryGen || 0) + 1; _vtTable._vtTextRows = undefined; }
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
      if (needHide) { try { if (typeof hideLoading === 'function') hideLoading(); } catch (e) { console.warn('[js/table-utils.js:3552] 异常(已忽略):', e); } }
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
