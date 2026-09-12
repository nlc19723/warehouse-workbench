// ============================================
// 现存量模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const StockModule = {
  currentData: [],
  currentFilter: { keyword: '' },
  currentPage: 1,
  pageSize: AppConfig.app.defaultPageSize,
  // 🟢 v197：A3 批量打印二维码（多选状态：选中编码 Set）
  selectedCodes: new Set(),
  // 🟢 v198：多选模式开关 —— 默认 false（不渲染勾选列），点击「批量打印二维码」才进入
  bulkMode: false,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar filter-bar-m" data-mod="stock">
        <input type="text" id="stockKw" class="fb-search" placeholder="搜索物料编码、名称、规格..." value="${escAttr(this.currentFilter.keyword || '')}" onkeydown="if(event.key==='Enter')StockModule.applyFilter()">
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="StockModule.applyFilter()">🔍 搜索</button>
          <button class="btn--ghost" onclick="StockModule.resetFilter()">重置</button>
          <!-- 🟢 v227.76：现存量工具栏顺序（搜索 → 重置 → 导出 → 打印二维码 → 退出打印） -->
          <button class="btn--ghost" onclick="StockModule.exportData()">📥 导出</button>
          <!-- 🟢 v227.76：A3 批量打印二维码 → 打印二维码；默认不渲染勾选列，
               首次点击进入多选模式（显示勾选框 + 退出打印按钮），再次点击才真正打印所选。 -->
          <button class="btn--ghost" id="stockBulkBtn" onclick="StockModule.toggleBulk()">🖨 打印二维码</button>
          <button class="btn--ghost btn-hidden" id="stockBulkExitBtn" onclick="StockModule.exitBulk()">✖ 退出打印</button>
        </div>
      </div>

      <div id="stockSummary"></div>
      <div id="stockTableArea"></div>
      <div id="stockPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    let stocks = await DataStore.getStock();
    const kw = (this.currentFilter.keyword || '').trim().toLowerCase();

    if (kw) {
      stocks = stocks.filter(s =>
        (s.存货编码 && s.存货编码.toLowerCase().includes(kw)) ||
        (s.存货名称 && s.存货名称.toLowerCase().includes(kw)) ||
        (s.规格型号 && s.规格型号.toLowerCase().includes(kw))
      );
    }

    const totalQty = stocks.reduce((s, c) => s + (parseFloat(c.现存数量) || 0), 0);
    const updateTime = stocks.length > 0 ? stocks[0].数据更新时间 : '';

    if (rt !== undefined && rt !== App._goToken) return;
    document.getElementById('stockSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-info">
          <div class="kpi-label">物料种类</div>
          <div class="kpi-value">${stocks.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">总库存数量</div>
          <div class="kpi-value">${TableUtils.formatNum(totalQty)}</div>
        </div>
      </div>
    `;

    this.currentData = stocks;
    this.renderTable(rt);
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

    const area = document.getElementById('stockTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无库存数据</div></div>';
      document.getElementById('stockPagination').innerHTML = '';
      return;
    }

    // 🟢 v198：勾选列仅在多选模式下渲染（不渲染 = 真正少一列，避免列折叠/排序按索引错位）
    const bulk = !!this.bulkMode;
    // col-checkbox：告诉移动端列折叠「首列是复选框」，折叠时多留一列，避免只剩勾选框
    const checkTh = bulk
      ? '<th class="stock-check-th col-checkbox"><input type="checkbox" id="stockSelAll" aria-label="全选当前页"></th>'
      : '';

    // 🟢 AUDIT-228-04（v228.18）：整表 innerHTML → TableUtils.virtualTable。
    //   ≤150 行时输出结构与改动前完全一致；「每页=全部」时只渲染视口附近的行，
    //   避免一次性生成数千行（二维码 SVG 尤其重）。导出/排序仍基于完整 items，不受影响。
    const thead = `
            <tr>
              ${checkTh}
              <th>二维码</th>
              <th>仓库</th>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>现存数量</th>
            </tr>`;
    const rowHtml = (s) => {
      const code = String(s.存货编码 ?? '').trim();
      const checked = code && this.selectedCodes.has(code) ? 'checked' : '';
      return `
              <tr>
                ${bulk ? `<td class="col-checkbox"><input type="checkbox" class="stock-row-check" data-stock-code="${esc(code)}" ${checked} aria-label="选择 ${esc(code)}"></td>` : ''}
                <td>${window.QR ? QR.thumb(code, s.存货名称, s.规格型号) : ''}</td>
                <td>${esc(s.仓库名称 ?? '')}</td>
                <td>${TableUtils.link('stock', s.存货编码 ?? '', s.存货编码 ?? '')}</td>
                <td><strong>${esc(s.存货名称 ?? '')}</strong></td>
                <td>${esc(s.规格型号 ?? '')}</td>
                <td><strong style="color:${parseFloat(s.现存数量) < 10 ? 'var(--status-danger)' : 'var(--text-main)'};">${TableUtils.formatNum(s.现存数量)}</strong></td>
              </tr>`;
    };
    TableUtils.virtualTable(area, { items, rowHtml, thead, threshold: 150 });

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('stockPagination', { module: 'StockModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    TableUtils.initSmartSelect('stockTableArea');
    TableUtils.initSortableHeaders('stockTableArea');

    // 🟢 v197：A3 多选 + 全选 + 计数
    this._bindBulkSelect();
  },

  // 🟢 v197：A3 批量打印辅助（多选/全选/计数/打印）
  // 🟢 v198：非多选模式下表格里没有勾选框，直接跳过绑定
  _bindBulkSelect() {
    if (!this.bulkMode) return;
    const area = document.getElementById('stockTableArea');
    if (!area) return;
    const selAll = document.getElementById('stockSelAll');
    if (selAll) {
      const pageCodes = [...area.querySelectorAll('.stock-row-check')].map(c => c.getAttribute('data-stock-code'));
      const allChecked = pageCodes.length > 0 && pageCodes.every(c => c && this.selectedCodes.has(c));
      selAll.checked = allChecked;
      selAll.indeterminate = !allChecked && pageCodes.some(c => c && this.selectedCodes.has(c));
      selAll.onchange = () => {
        pageCodes.forEach(c => {
          if (!c) return;
          if (selAll.checked) this.selectedCodes.add(c);
          else this.selectedCodes.delete(c);
        });
        area.querySelectorAll('.stock-row-check').forEach(b => { b.checked = selAll.checked; });
        this._updateSelCount();
      };
    }
    area.querySelectorAll('.stock-row-check').forEach(b => {
      b.onchange = () => {
        const code = b.getAttribute('data-stock-code');
        if (!code) return;
        if (b.checked) this.selectedCodes.add(code);
        else this.selectedCodes.delete(code);
        // 同步全选态
        const all = [...area.querySelectorAll('.stock-row-check')];
        const checked = all.filter(x => x.checked).length;
        if (selAll) {
          selAll.checked = checked === all.length && all.length > 0;
          selAll.indeterminate = checked > 0 && checked < all.length;
        }
        this._updateSelCount();
      };
    });
    this._updateSelCount();
  },

  _updateSelCount() {
    const el = document.getElementById('stockSelCount');
    if (el) el.textContent = '(' + this.selectedCodes.size + ')';
  },

  // 🟢 v198：切换多选模式 —— 首次点击进入（渲染勾选列 + 显示退出按钮），再次点击执行打印
  toggleBulk() {
    if (!this.bulkMode) {
      this.bulkMode = true;
      this._setBulkUI();
      this.renderTable();
      return;
    }
    this.printSelected();
  },

  // 🟢 v198：退出多选模式（收起勾选列并清空已选）
  exitBulk() {
    if (!this.bulkMode) return;
    this.bulkMode = false;
    this.selectedCodes = new Set();
    this._setBulkUI();
    this.renderTable();
  },

  // 🟢 v227.76：刷新批量按钮文案 / 退出按钮显隐 / 计数（默认仅显示「打印二维码」，多选模式才显示「退出打印」）
  _setBulkUI() {
    const btn = document.getElementById('stockBulkBtn');
    const exitBtn = document.getElementById('stockBulkExitBtn');
    if (btn) {
      btn.innerHTML = this.bulkMode
        ? '🖨 打印所选 <span id="stockSelCount"></span>'
        : '🖨 打印二维码';
    }
    if (exitBtn) exitBtn.classList.toggle('btn-hidden', !this.bulkMode);
    this._updateSelCount();
  },

  // 清除跨页选择（重置时调用，避免脏数据）
  clearSelection() {
    this.selectedCodes = new Set();
    this._updateSelCount();
  },

  async printSelected() {
    const codes = [...this.selectedCodes];
    if (codes.length === 0) { WBModal.alert('请勾选要打印二维码的存货（点击每行最左侧的复选框）'); return; }
    if (!window.QR) { WBModal.alert('二维码组件未就绪，请稍后再试'); return; }
    // 名称/规格优先从当前筛选结果里取（零额外查询）
    const map = new Map();
    (this.currentData || []).forEach(s => {
      const c = String(s.存货编码 ?? '').trim();
      if (c) map.set(c, { name: s.存货名称 || '', spec: s.规格型号 || '' });
    });
    // 🟢 v198：先勾选再筛选 → 当前结果里查不到的编码，回落到全量库存补查
    const missing = codes.filter(c => !map.has(c));
    if (missing.length) {
      try {
        const all = await DataStore.getStock();
        const need = new Set(missing);
        (all || []).forEach(s => {
          const c = String(s.存货编码 ?? '').trim();
          if (c && need.has(c) && !map.has(c)) map.set(c, { name: s.存货名称 || '', spec: s.规格型号 || '' });
        });
      } catch (_) {
    /* 补查失败不阻断打印，缺信息时只显示二维码 */ console.warn('[stock.js:249] 异常(已忽略):', e);
  }
    }
    // 仍缺信息的编码用空名（打印时只显示二维码）
    const items = codes.map(code => ({ code, name: (map.get(code) || {}).name || '', spec: (map.get(code) || {}).spec || '' }));
    window.QR.printBulk(items);
    // 打印完清空本批选择，保留多选模式，方便接着勾下一批
    this.selectedCodes = new Set();
    this.renderTable();
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() {
    this.currentFilter.keyword = (document.getElementById('stockKw')?.value || '').trim();
    this.currentPage = 1;
    this.loadData();
  },

  resetFilter() {
    this.currentFilter = { keyword: '' };
    this.currentPage = 1;
    // 🟢 v198：重置时一并退出多选模式并清空已选（只渲染一次，由 loadData 触发）
    this.bulkMode = false;
    this.selectedCodes = new Set();
    const input = document.getElementById('stockKw');
    if (input) input.value = '';
    this._setBulkUI();
    this.loadData();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    // 🟢 v201：导出仅包含下方数据表格的当前可见列（与 UI 展示一致）
    //   二维码列在表格里只是缩略图，不导出；列顺序与表头一致：仓库/编码/名称/规格/数量
    const exportRows = this.currentData.map(s => ({
      '仓库':     s.仓库名称 ?? '',
      '存货编码': s.存货编码 ?? '',
      '存货名称': s.存货名称 ?? '',
      '规格型号': s.规格型号 ?? '',
      '现存数量': s.现存数量 ?? ''
    }));
    TableUtils.exportToExcel(exportRows, `现存量_${new Date().toISOString().split('T')[0]}.xlsx`, '现存量');
  }
};
