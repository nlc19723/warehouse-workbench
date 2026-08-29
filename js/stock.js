// ============================================
// 现存量模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const StockModule = {
  currentData: [],
  currentFilter: { keyword: '' },
  currentPage: 1,
  pageSize: 20,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="stockKw" placeholder="搜索物料编码、名称、规格..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')StockModule.applyFilter()">
        <button class="search-glass" onclick="StockModule.applyFilter()">🔍 搜索</button>
        <button class="secondary" onclick="StockModule.resetFilter()">重置</button>
        <button class="secondary" onclick="StockModule.exportData()">📥 导出</button>
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

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>仓库</th>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>现存数量</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(s => `
              <tr>
                <td>${esc(s.仓库名称 ?? '')}</td>
                <td>${TableUtils.link('stock', s.存货编码 ?? '', s.存货编码 ?? '')}</td>
                <td><strong>${esc(s.存货名称 ?? '')}</strong></td>
                <td>${esc(s.规格型号 ?? '')}</td>
                <td><strong style="color:${parseFloat(s.现存数量) < 10 ? 'var(--status-danger)' : 'var(--text-main)'};">${TableUtils.formatNum(s.现存数量)}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('stockPagination', { module: 'StockModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    TableUtils.initSmartSelect('stockTableArea');
    TableUtils.initSortableHeaders('stockTableArea');
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
    const input = document.getElementById('stockKw');
    if (input) input.value = '';
    this.loadData();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(this.currentData, `现存量_${new Date().toISOString().split('T')[0]}.xlsx`, '现存量');
  }
};
