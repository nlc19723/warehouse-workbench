// ============================================
// 库存预警模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

// 🟢 v229.80：移动端（纯触摸设备 / 窄屏）统一判定。优先复用 excel-select.js 暴露的
//   TableUtils.isTouchLayout 保持同一口径；旧缓存下该函数缺失时退回宽度判定（行为一致）。
function _isTouchLayout() {
  try {
    if (typeof TableUtils !== 'undefined' && TableUtils && typeof TableUtils.isTouchLayout === 'function') {
      return !!TableUtils.isTouchLayout();
    }
    if (typeof window.isTouchLayout === 'function') return !!window.isTouchLayout();
  } catch (e) { /* 忽略，走下面的宽度兜底 */ }
  try { return window.innerWidth <= 820; } catch (e2) { return false; }
}

const InventoryAlertModule = {
  currentFilter: { keyword: '', category: '', status: 'yes' },
  currentPage: 1,
  pageSize: AppConfig.app.defaultPageSize,
  currentData: [],

  // 🟢 L1：批量复制（键盘 + 右键菜单）
  selectedIdx: new Set(),
  anchorIdx: -1,
  // 🟢 L2：Excel 式单元格框选（左键按住拖动 = 连续矩形选区；Ctrl+C 复制选区）
  COL_KEYS: ['存货编码', '存货名称', '规格型号', '分类', '近一年月均入库量', '最低库存预警',
    '最高库存', '现存量', '补货值', '在途订单', '派生状态', '所上或库房', '工程项目', '类型'],
  NUMERIC_COL_IDX: [4, 5, 6, 7, 8, 9],
  selRange: null,        // {r1, c1, r2, c2}（r = currentData 行下标，c = 列下标）
  anchorCell: null,      // {r, c} 拖拽锚点
  _cellDragging: false,
  _cellDragBound: false,
  _keyBound: false,
  _ctxBound: false,
  _ctxMenu: null,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    // 🟢 L1：进入模块先清空上次的选区/选择条/右键菜单，避免跨模块残留
    this.clearSelection();
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar filter-bar-m">
        <input type="text" id="alertKw" class="fb-search" placeholder="搜索物料名称、编码..." value="${escAttr(this.currentFilter.keyword || '')}" onkeydown="if(event.key==='Enter')InventoryAlertModule.applyFilter()">
        <div class="fb-row fb-row--fields">
          <div class="fb-field"><select id="alertCategory">
            <option value="">全部分类</option>
            <option value="A" ${this.currentFilter.category === 'A' ? 'selected' : ''}>A类</option>
            <option value="A工程类" ${this.currentFilter.category === 'A工程类' ? 'selected' : ''}>A工程类</option>
            <option value="B" ${this.currentFilter.category === 'B' ? 'selected' : ''}>B类</option>
            <option value="C" ${this.currentFilter.category === 'C' ? 'selected' : ''}>C类</option>
            <option value="C工程类" ${this.currentFilter.category === 'C工程类' ? 'selected' : ''}>C工程类</option>
            <option value="D" ${this.currentFilter.category === 'D' ? 'selected' : ''}>D类</option>
            <option value="未使用类" ${this.currentFilter.category === '未使用类' ? 'selected' : ''}>未使用类</option>
          </select></div>
          <div class="fb-field"><select id="alertStatus" onchange="InventoryAlertModule.applyFilter()">
            <option value="yes" ${this.currentFilter.status === 'yes' ? 'selected' : ''}>需补货</option>
            <option value="urgent" ${this.currentFilter.status === 'urgent' ? 'selected' : ''}>急</option>
            <option value="no" ${this.currentFilter.status === 'no' ? 'selected' : ''}>正常</option>
            <option value="" ${this.currentFilter.status === '' ? 'selected' : ''}>全部状态</option>
          </select></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="InventoryAlertModule.applyFilter()">筛选</button>
          <button class="btn--ghost" onclick="InventoryAlertModule.resetFilter()">重置</button>
          <button class="btn--ghost" onclick="InventoryAlertModule.exportData()">📥 导出</button>
        </div>
      </div>

      <div id="alertSummary"></div>
      <div id="alertTableArea"></div>
      <div id="alertPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    // 🟢 v227.58：移动端筛选栏下拉框按内部最长选项字符长度动态等分（文本框两行等长）
    if (window.FilterLayout) FilterLayout.balanceAll();

    await this.loadData(myToken);
    // 🟢 L1：绑定行选/右键/键盘（area 每次 render 重建，监听只挂一次）
    this.bindSelection();
  },

  /**
   * 🟢 v229.04：全派生装配（共享方法）
   * 存货编码/名称/规格/现存量 ← 现存量主档 stock；最低/最高 ← 配置水位；分类/月均 ← 入库快照；
   * 在途/仓库/项目 ← 订单拆分；补货值/状态 ← 带状触发；类型 ← 合同价格关联。
   * 库存预警模块与查询系统「存量」板块共用本方法，保证两处数据同源同值。
   */
  async buildDerivedAlerts() {
    let stockRows, orderRows, inboundRows, pricingRows;
    try {
      [stockRows, orderRows, inboundRows, pricingRows] = await Promise.all([
        DataStore.getStock(),
        DataStore.getRows('orders'),
        DataStore.getRows('inbound'),
        DataStore.getRows('pricing')
      ]);
    } catch (e) { console.warn('[inventory-alert] 数据加载失败:', e); return []; }

    // 类型：合同价格表编码关联（一码多价取首个非空类型）
    const typeByCode = new Map();
    pricingRows.forEach(p => {
      const code = String(p.存货编码 ?? '').trim();
      if (code && !typeByCode.has(code)) typeByCode.set(code, p.类型 || '');
    });

    // 分类快照 + 月均入库（入库列表聚合；数据不刷新时命中缓存）
    const snap = StockAlertRules.computeClassificationSnapshot(inboundRows);
    // 在途拆分（订单列表：全部/仓库/项目）
    const ordersMap = StockAlertRules.computeOrdersSplit(orderRows);
    const CFG = window.StockAlertConfig;

    return stockRows.map(s => {
      const code = String(s.存货编码 || '').trim();
      const name = s.存货名称 || '';
      const lv = CFG.STOCK_LEVELS[code] || [0, 0];
      const onhand = parseFloat(s.现存数量) || 0;
      const cls = snap.get(code);
      const os = ordersMap.get(code) || { all: 0, wh: 0, proj: 0 };
      const rs = StockAlertRules.computeRestock(code, name, lv[0], lv[1], onhand);
      return {
        存货编码: code,
        存货名称: name,
        规格型号: s.规格型号 || '',
        分类: cls ? cls.cat : '未使用类',
        近一年月均入库量: cls ? cls.K : 0,
        最低库存预警: lv[0],
        最高库存: lv[1],
        现存量: onhand,
        补货值: rs.value,
        派生状态: rs.status,
        在途订单: StockAlertRules.round2(os.all),
        所上或库房: StockAlertRules.round2(os.wh),
        工程项目: StockAlertRules.round2(os.proj),
        类型: typeByCode.get(code) || ''
      };
    });
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;

    // 🟢 v229.04：v229.00 全派生装配抽为 buildDerivedAlerts（查询系统存量板块同源复用）
    let alerts = await this.buildDerivedAlerts();
    if (!alerts.length) return;

    const kw = (this.currentFilter.keyword || '').replace(/\s+/g, '').toLowerCase();
    const category = this.currentFilter.category || '';
    // 状态默认「需补货」，但允许用户切换其他状态
    const status = this.currentFilter.status || '';

    if (kw) {
      // 🟡 M9：输入侧已归一化（去空白），数据侧同样去空白再比较，避免含空格/全角空格的存货名称匹配失败
      alerts = alerts.filter(a =>
        (a.存货名称 && a.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
        (a.存货编码 && String(a.存货编码).replace(/\s+/g, '').toLowerCase().includes(kw))
      );
    }
    if (category) {
      alerts = alerts.filter(a => a.分类 === category);
    }
    // 🟢 v229.00：状态三态（急/需补货/正常）由规则派生，急也计入需补货
    if (status === 'yes') {
      alerts = alerts.filter(a => a.派生状态 !== '正常');
    } else if (status === 'urgent') {
      alerts = alerts.filter(a => a.派生状态 === '急');
    } else if (status === 'no') {
      alerts = alerts.filter(a => a.派生状态 === '正常');
    }

    const needRestock = alerts.filter(a => a.派生状态 !== '正常');
    const totalNeedQty = needRestock.reduce((s, a) => s + (parseFloat(a.补货值) || 0), 0);
    const urgentCount = alerts.filter(a => a.派生状态 === '急').length;

    if (rt !== undefined && rt !== App._goToken) return;
    TableUtils.setHtml('alertSummary', `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货种类</div>
          <div class="kpi-value">${needRestock.length}<span class="kpi-unit">/ ${alerts.length}</span></div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货量</div>
          <div class="kpi-value">${TableUtils.formatNum(totalNeedQty)}</div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">急(已穿带下)</div>
          <div class="kpi-value">${urgentCount}</div>
        </div>
      </div>
    `);

    this.currentData = alerts;
    // 🟢 L1：筛选导致数据集变化，旧选区索引已失效，清空
    this.selectedIdx.clear();
    this.anchorIdx = -1;
    this.renderTable(rt);
  },

  applyFilter() {
    this.currentFilter.keyword = (document.getElementById('alertKw')?.value || '').trim();
    this.currentFilter.category = document.getElementById('alertCategory')?.value || '';
    this.currentFilter.status = document.getElementById('alertStatus')?.value || '';
    this.currentPage = 1;
    this.loadData();
  },

  resetFilter() {
    this.currentFilter = { keyword: '', category: '', status: 'yes' };
    this.currentPage = 1;
    const kwInput = document.getElementById('alertKw');
    const catSelect = document.getElementById('alertCategory');
    const statusSelect = document.getElementById('alertStatus');
    if (kwInput) kwInput.value = '';
    if (catSelect) catSelect.value = '';
    if (statusSelect) statusSelect.value = 'yes';
    this.loadData();
  },

  renderTable(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const data = this.currentData;
    const total = data.length;
    const pageSize = this.pageSize === 'all' ? total : this.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    this.currentPage = page;
    const items = data.slice((page - 1) * pageSize, page * pageSize);
    const base = (page - 1) * pageSize; // 🟢 L1：当前页首行在 currentData 中的全局索引

    const area = document.getElementById('alertTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无预警数据</div></div>';
      TableUtils.setHtml('alertPagination', '');
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table" data-table-key="inventoryAlert">
          <thead>
            <tr>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>分类</th>
              <th>月均入库</th>
              <th>最低库存</th>
              <th>最高库存</th>
              <th>现存量</th>
              <th>补货值</th>
              <th>在途订单</th>
              <th>状态</th>
              <th>仓库</th>
              <th>项目</th>
              <th>类型</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((a, i) => {
              // 🟢 v229.00：状态三态渲染（急/需补货/正常），补货值>0 红色加粗
              const st = a.派生状态 || '正常';
              const needRestock = st !== '正常';
              const gIdx = base + i; // 🟢 L1：全局索引（跨页唯一）
              // 🟢 v229.20：分类 2B 暖色 ABC 递减（A深红 > B橙 > C浅黄 > D描边灰）
              const catTag = (a.分类 === 'A' || a.分类 === 'A工程类') ? 'cat-b1'
                : a.分类 === 'B' ? 'cat-b2'
                : a.分类 === 'C' ? 'cat-b3' : 'cat-b4';
              return `
                <tr class="${needRestock ? 'row-warning' : ''} ${this.selectedIdx.has(gIdx) ? 'row-selected' : ''}" data-idx="${gIdx}">
                  <td>${TableUtils.link('stock', a.存货编码 ?? '', a.存货编码 ?? '')}</td>
                  <td style="font-weight:600">${esc(a.存货名称 ?? '')}</td>
                  <td style="font-weight:600">${esc(a.规格型号 ?? '')}</td>
                  <td>${a.分类 ? `<span class="tag ${catTag}">${esc(a.分类)}</span>` : ''}</td>
                  <td>${TableUtils.formatNum(a.近一年月均入库量)}</td>
                  <td>${TableUtils.formatNum(a.最低库存预警)}</td>
                  <td>${TableUtils.formatNum(a.最高库存)}</td>
                  <td>${a.现存量 !== undefined && a.现存量 !== null && a.现存量 !== '' ? (parseFloat(a.现存量) === 0 ? `<span class="tag tag-danger">${TableUtils.formatNum(a.现存量)}</span>` : `<span class="tag tag-info">${TableUtils.formatNum(a.现存量)}</span>`) : ''}</td>
                  <td style="${needRestock ? 'color:var(--status-danger);font-weight:600;' : ''}">${a.补货值 ? TableUtils.formatNum(a.补货值) : ''}</td>
                  <td>${a.在途订单 ? TableUtils.formatNum(a.在途订单) : ''}</td>
                  <td>${st === '急' ? '<span class="tag tag-danger">急</span>' : st === '需补货' ? '<span class="tag tag-warning">需补货</span>' : '<span class="tag tag-success">正常</span>'}</td>
                  <td>${a.所上或库房 ? esc(String(a.所上或库房).substring(0, 15)) + (String(a.所上或库房).length > 15 ? '...' : '') : ''}</td>
                  <td>${a.工程项目 ? esc(String(a.工程项目).substring(0, 15)) + (String(a.工程项目).length > 15 ? '...' : '') : ''}</td>
                  <td>${esc(String(a.类型 ?? '').substring(0, 15))}${String(a.类型 ?? '').length > 15 ? '...' : ''}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('alertPagination', { module: 'InventoryAlertModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    // 🟢 L2：Excel 式单元格框选取代拖拽求和气泡，本表不再绑定 SmartSelect
    TableUtils.initSortableHeaders('alertTableArea');

    // 🟢 翻页/重渲染后同步选区高亮与底部选择条
    this._applyRowHighlight();
    this._applyCellHighlight();
    this._updateSelBar();
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.currentPage = 1;
    this.renderTable();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    // 🟢 v229.03：导出列 = 工作台表格当前 14 列（列名与表头一致），不再导出内部字段名
    const cols = ['存货编码', '存货名称', '规格型号', '分类',
      { key: '近一年月均入库量', title: '月均入库' },
      { key: '最低库存预警', title: '最低库存' }, '最高库存', '现存量', '补货值', '在途订单',
      { key: '派生状态', title: '状态' },
      { key: '所上或库房', title: '仓库' },
      { key: '工程项目', title: '项目' }, '类型'];
      TableUtils.exportToExcel(this.currentData, `库存预警_${new Date().toISOString().split('T')[0]}.xlsx`, '库存预警', cols);
  },

  // ============================================================
  // 🟢 L1：批量复制（PC 行选 + 键盘 + 右键菜单 + 选择条）
  // ============================================================

  /** 绑定单元格框选/右键/键盘监听（幂等） */
  bindSelection() {
    const area = document.getElementById('alertTableArea');
    if (!area) return;
    if (!area._selBound) {
      area.addEventListener('mousedown', (e) => this._onCellMouseDown(e));
      area.addEventListener('contextmenu', (e) => this._onCtx(e));
      area._selBound = true;
    }
    if (!this._cellDragBound) {
      document.addEventListener('mousemove', (e) => this._onCellDragMove(e));
      document.addEventListener('mouseup', () => this._onCellDragEnd());
      this._cellDragBound = true;
    }
    if (!this._keyBound) {
      document.addEventListener('keydown', (e) => this._onKey(e));
      this._keyBound = true;
    }
    if (!this._ctxBound) {
      document.addEventListener('mousedown', (e) => {
        if (this._ctxMenu && !this._ctxMenu.contains(e.target)) this._hideCtx();
      });
      document.addEventListener('scroll', () => this._hideCtx(), true);
      this._ctxBound = true;
    }
  },

  /** Excel 式：左键按下 = 选中该格；拖动 = 矩形连续选区；Shift+按下 = 从锚点扩展 */
  _onCellMouseDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.entity-link, a, button, input, select, .col-resize-handle')) return;
    const td = e.target.closest('td');
    if (!td || td.closest('thead')) return;
    const tr = td.parentElement;
    const r = parseInt(tr.getAttribute('data-idx'), 10);
    if (isNaN(r)) return;
    const c = td.cellIndex;

    if (e.shiftKey && this.anchorCell) {
      // Shift：保持锚点，扩展到当前格
      this.selRange = {
        r1: Math.min(this.anchorCell.r, r), c1: Math.min(this.anchorCell.c, c),
        r2: Math.max(this.anchorCell.r, r), c2: Math.max(this.anchorCell.c, c)
      };
    } else {
      this.anchorCell = { r, c };
      this.selRange = { r1: r, c1: c, r2: r, c2: c };
    }
    this._cellDragging = true;
    e.preventDefault(); // 阻止原生文字选区
    this._applyRowHighlight();
    this._applyCellHighlight();
    this._updateSelBar();
  },

  _onCellDragMove(e) {
    if (!this._cellDragging || !this.anchorCell) return;
    const td = e.target.closest && e.target.closest('#alertTableArea tbody td');
    if (!td) return;
    const r = parseInt(td.parentElement.getAttribute('data-idx'), 10);
    if (isNaN(r)) return;
    const c = td.cellIndex;
    this.selRange = {
      r1: Math.min(this.anchorCell.r, r), c1: Math.min(this.anchorCell.c, c),
      r2: Math.max(this.anchorCell.r, r), c2: Math.max(this.anchorCell.c, c)
    };
    this._applyCellHighlight();
    this._updateSelBar();
  },

  _onCellDragEnd() {
    this._cellDragging = false;
  },

  /** 单元格选区高亮（仅当前页可见行） */
  _applyCellHighlight() {
    const area = document.getElementById('alertTableArea');
    if (!area) return;
    area.querySelectorAll('tbody td.cell-picked').forEach(td => td.classList.remove('cell-picked'));
    if (!this.selRange) return;
    const { r1, c1, r2, c2 } = this.selRange;
    area.querySelectorAll('tbody tr').forEach(tr => {
      const r = parseInt(tr.getAttribute('data-idx'), 10);
      if (isNaN(r) || r < r1 || r > r2) return;
      const tds = tr.children;
      for (let c = c1; c <= c2 && c < tds.length; c++) tds[c].classList.add('cell-picked');
    });
  },

  /** 选区内数值列合计（保留原拖拽求和的价值） */
  _rangeSum() {
    if (!this.selRange) return null;
    const { r1, c1, r2, c2 } = this.selRange;
    const numCols = this.NUMERIC_COL_IDX.filter(c => c >= c1 && c <= c2);
    if (!numCols.length) return null;
    let sum = 0;
    for (let r = r1; r <= r2 && r < this.currentData.length; r++) {
      numCols.forEach(c => {
        const v = parseFloat(this.currentData[r][this.COL_KEYS[c]]);
        if (!isNaN(v)) sum += v;
      });
    }
    return sum;
  },

  /** 复制单元格选区为 TSV（含表头行，可直接粘贴进 Excel） */
  copyRange() {
    if (!this.selRange) {
      if (typeof showToast === 'function') showToast('未选择单元格', 'warn');
      return;
    }
    const { r1, c1, r2, c2 } = this.selRange;
    const rows = r2 - r1 + 1, cols = c2 - c1 + 1;
    const keys = this.COL_KEYS.slice(c1, c2 + 1);
    const body = [];
    for (let r = r1; r <= r2 && r < this.currentData.length; r++) {
      body.push(keys.map(k => {
        const v = this.currentData[r][k];
        if (v === undefined || v === null || v === '') return '';
        return (typeof v === 'number') ? TableUtils.formatNum(v) : String(v);
      }));
    }
    // 🟢 v229.83：复制结果不含表头（用户要求）——只复制选区数据行，不再把列名拼到首行。
    const tsv = ClipboardUtils.toTSV(body);
    ClipboardUtils.copy(tsv).then(ok => {
      if (typeof showToast === 'function') {
        showToast(ok ? `已复制 ${rows} 行 × ${cols} 列到剪贴板` : '复制失败，请手动选择后重试',
          ok ? 'success' : 'error');
      }
    });
  },

  _onCtx(e) {
    const tr = e.target.closest('tr');
    if (!tr || tr.closest('thead')) return;
    const idx = parseInt(tr.getAttribute('data-idx'), 10);
    if (isNaN(idx)) return;
    e.preventDefault();
    const additive = e.ctrlKey || e.metaKey;
    if (!this.selectedIdx.has(idx)) {
      if (!additive) this.selectedIdx.clear();
      this.selectedIdx.add(idx);
      this.anchorIdx = idx;
      this._applyRowHighlight();
      this._updateSelBar();
    }
    this._showCtx(e.clientX, e.clientY, idx);
  },

  _onKey(e) {
    const area = document.getElementById('alertTableArea');
    if (!area || !document.body.contains(area)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      this.selectAll();
    } else if (mod && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      if (this.selRange) this.copyRange();                                  // 🟢 L2：优先复制单元格选区
      else if (this.selectedIdx.size > 0) {
        this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'codeQty');
      }
    } else if (e.key === 'Escape') {
      this.clearSelection();
    }
  },

  _selectRange(a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) this.selectedIdx.add(i);
    this.anchorIdx = b;
  },

  _applyRowHighlight() {
    const area = document.getElementById('alertTableArea');
    if (!area) return;
    area.querySelectorAll('tbody tr').forEach(tr => {
      const idx = parseInt(tr.getAttribute('data-idx'), 10);
      tr.classList.toggle('row-selected', this.selectedIdx.has(idx));
    });
  },

  selectAll() {
    this.currentData.forEach((_, i) => this.selectedIdx.add(i));
    this.anchorIdx = this.currentData.length - 1;
    // 🟢 L2：全选 = 全部单元格 + 全部行（两种复制路径都可用）
    this.selRange = { r1: 0, c1: 0, r2: Math.max(0, this.currentData.length - 1), c2: this.COL_KEYS.length - 1 };
    this.anchorCell = { r: 0, c: 0 };
    this._applyRowHighlight();
    this._applyCellHighlight();
    this._updateSelBar();
  },

  clearSelection() {
    this.selectedIdx.clear();
    this.anchorIdx = -1;
    this.selRange = null;
    this.anchorCell = null;
    this._applyRowHighlight();
    this._applyCellHighlight();
    this._updateSelBar();
    this._hideCtx();
  },

  /** 底部选择条：单元格选区（复制选区/全选/清空）或行选（预设复制） */
  _updateSelBar() {
    // 🟢 v229.80：移动端不创建选择条 —— 手机上批量复制属桌面向操作，浮条会遮住分页栏
    //   （用户实测反馈）；CSS 媒体查询已兜底隐藏，这里不再创建避免不可见的残留状态。
    //   判定复用 excel-select 的 isTouchLayout（同一口径，含 iPad Pro 横屏这类宽屏纯触摸设备）。
    if (_isTouchLayout()) { const b = document.getElementById('iaSelBar'); if (b) b.remove(); return; }
    let bar = document.getElementById('iaSelBar');
    const n = this.selectedIdx.size;
    const rg = this.selRange;
    const cellN = rg ? (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1) : 0;
    if (n === 0 && cellN === 0) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'iaSelBar';
      bar.className = 'sel-bar';
      document.body.appendChild(bar);
      bar.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]') && e.target.closest('[data-act]').getAttribute('data-act');
        if (!act) return;
        if (act === 'range') this.copyRange();
        else if (act === 'codeQty') this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'codeQty');
        else if (act === 'code') this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'code');
        else if (act === 'qty') this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'qty');
        else if (act === 'full') this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'full');
        else if (act === 'all') this.selectAll();
        else if (act === 'clear') this.clearSelection();
      });
    }
    let inner = '';
    if (cellN > 0) {
      const sum = this._rangeSum();
      const sumTxt = (sum !== null && sum !== 0)
        ? ` · 数值合计 <b>${TableUtils.formatSum ? TableUtils.formatSum(sum) : sum.toLocaleString('zh-CN')}</b>` : '';
      inner = `
        <span class="sel-bar-count">已选 <b>${rg.r2 - rg.r1 + 1}</b> 行 × <b>${rg.c2 - rg.c1 + 1}</b> 列 · ${cellN} 格${sumTxt}</span>
        <button class="sel-btn" data-act="range">📋 复制选区</button>
        <button class="sel-btn" data-act="all">全选</button>
        <button class="sel-btn ghost" data-act="clear">清空</button>`;
    } else {
      inner = `
        <span class="sel-bar-count">已选 <b>${n}</b> 行 · 共 ${this.currentData.length}</span>
        <button class="sel-btn" data-act="code">📋 编码</button>
        <button class="sel-btn" data-act="qty">📋 数量</button>
        <button class="sel-btn" data-act="full">📋 整行TSV</button>
        <button class="sel-btn" data-act="all">全选</button>
        <button class="sel-btn ghost" data-act="clear">清空</button>`;
    }
    bar.innerHTML = `<div class="sel-bar-inner">${inner}</div>`;
    requestAnimationFrame(() => bar.classList.add('show'));
  },

  /** 复制指定行；formatKey 决定列集 */
  copyRows(rows, formatKey) {
    if (!rows || !rows.length) {
      if (typeof showToast === 'function') showToast('未选择任何行', 'warn');
      return;
    }
    const COLS = {
      code: ['存货编码'],
      qty: ['现存量'],
      codeQty: ['存货编码', '现存量'],
      codeNameQty: ['存货编码', '存货名称', '现存量'],
      codeRestock: ['存货编码', '补货值'],
      full: ['存货编码', '存货名称', '规格型号', '分类', '近一年月均入库量', '最低库存预警',
        '最高库存', '现存量', '补货值', '在途订单', '派生状态', '所上或库房', '工程项目', '类型']
    };
    const cols = COLS[formatKey] || COLS.codeQty;
    const body = rows.map(r => cols.map(k => {
      const v = r[k];
      if (v === undefined || v === null || v === '') return '';
      return (typeof v === 'number') ? TableUtils.formatNum(v) : String(v);
    }));
    const tsv = ClipboardUtils.toTSV([cols, ...body]);
    ClipboardUtils.copy(tsv).then(ok => {
      if (typeof showToast === 'function') {
        showToast(ok ? `已复制 ${rows.length} 行 · ${cols.length} 列到剪贴板` : '复制失败，请手动选择后重试',
          ok ? 'success' : 'error');
      }
    });
  },

  _showCtx(x, y, idx) {
    this._hideCtx();
    const row = this.currentData[idx];
    if (!row) return;
    const selN = this.selectedIdx.size;
    const item = (label, act) => `<div class="ctx-item" data-act="${act}">${label}</div>`;
    const m = document.createElement('div');
    m.className = 'ctx-menu';
    m.innerHTML = `
      ${item('复制本行（整行 TSV）', 'rowFull')}
      ${item('复制「编码」', 'rowCode')}
      ${item('复制「现存量」', 'rowQty')}
      ${item('复制「编码 + 现存量」', 'rowCodeQty')}
      ${item('复制「编码 + 名称 + 现存量」', 'rowCodeNameQty')}
      ${item('复制「编码 + 补货值」', 'rowCodeRestock')}
      <div class="ctx-sep"></div>
      ${selN > 1 ? item(`复制所选（${selN} 行 · 整行）`, 'selFull') : ''}
      ${selN > 1 ? item(`复制所选（${selN} 行 · 编码）`, 'selCode') : ''}
      ${selN > 1 ? item(`复制所选（${selN} 行 · 数量）`, 'selQty') : ''}
      ${item(this.selectedIdx.has(idx) ? '取消选此行' : '选此行', 'toggle')}
      ${item('全选（共 ' + this.currentData.length + ' 行）', 'all')}
    `;
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    m.style.left = Math.max(8, left) + 'px';
    m.style.top = Math.max(8, top) + 'px';
    requestAnimationFrame(() => m.classList.add('show'));
    this._ctxMenu = m;
    m.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]') && ev.target.closest('[data-act]').getAttribute('data-act');
      if (!act) return;
      this._ctxAct(act, idx);
      this._hideCtx();
    });
  },

  _ctxAct(act, idx) {
    const row = this.currentData[idx];
    switch (act) {
      case 'rowFull': this.copyRows([row], 'full'); break;
      case 'rowCode': this.copyRows([row], 'code'); break;
      case 'rowQty': this.copyRows([row], 'qty'); break;
      case 'rowCodeQty': this.copyRows([row], 'codeQty'); break;
      case 'rowCodeNameQty': this.copyRows([row], 'codeNameQty'); break;
      case 'rowCodeRestock': this.copyRows([row], 'codeRestock'); break;
      case 'selFull': this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'full'); break;
      case 'selCode': this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'code'); break;
      case 'selQty': this.copyRows([...this.selectedIdx].sort((a, b) => a - b).map(i => this.currentData[i]), 'qty'); break;
      case 'toggle':
        if (this.selectedIdx.has(idx)) this.selectedIdx.delete(idx);
        else { this.selectedIdx.add(idx); this.anchorIdx = idx; }
        this._applyRowHighlight();
        this._updateSelBar();
        break;
      case 'all': this.selectAll(); break;
    }
  },

  _hideCtx() {
    if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
  }
};
