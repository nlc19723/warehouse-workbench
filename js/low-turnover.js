// ============================================
// 低周转材料模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const LowTurnoverModule = {
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
        <input type="text" id="ltKw" placeholder="搜索物料名称..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')LowTurnoverModule.applyFilter()">
        <button class="search-glass" onclick="LowTurnoverModule.applyFilter()">🔍 搜索</button>
        <button class="secondary" onclick="LowTurnoverModule.resetFilter()">重置</button>
        <button class="secondary" onclick="LowTurnoverModule.exportData()">📥 导出</button>
      </div>

      <div id="ltSummary"></div>
      <div id="ltTableArea"></div>
      <div id="ltPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    let items = await DataStore.getLowTurnover();
    const kw = (this.currentFilter.keyword || '').trim().toLowerCase();
    if (kw) {
      items = items.filter(i =>
        (i.存货名称 && i.存货名称.toLowerCase().includes(kw)) ||
        (i.存货编码 && i.存货编码.toLowerCase().includes(kw))
      );
    }

    const totalQty = items.reduce((s, c) => s + (parseFloat(c.现存数量) || 0), 0);
    const totalUnavailable = items.reduce((s, c) => s + (parseFloat(c.暂无法使用量) || 0), 0);

    if (rt !== undefined && rt !== App._goToken) return;
    document.getElementById('ltSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">低周转物料种类</div>
          <div class="kpi-value">${items.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">现存总量</div>
          <div class="kpi-value">${TableUtils.formatNum(totalQty)}</div>
        </div>
        <div class="kpi-card card-danger">
          <div class="kpi-label">暂无法使用量</div>
          <div class="kpi-value">${TableUtils.formatNum(totalUnavailable)}</div>
        </div>
      </div>
    `;

    this.currentData = items;
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

    const area = document.getElementById('ltTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无低周转物料</div></div>';
      document.getElementById('ltPagination').innerHTML = '';
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
              <th>暂无法使用量</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(i => {
              const total = parseFloat(i.现存数量) || 0;
              const unavailable = parseFloat(i.暂无法使用量) || 0;
              const available = total - unavailable;
              return `
                <tr class="${available <= 0 ? 'row-danger' : ''}">
                  <td>${esc(i.仓库名称 ?? '')}</td>
                  <td>${TableUtils.link('stock', i.存货编码 ?? '', i.存货编码 ?? '')}</td>
                  <td><strong>${esc(i.存货名称 ?? '')}</strong></td>
                  <td>${esc(i.规格型号 ?? '')}</td>
                  <td>${TableUtils.formatNum(total)}</td>
                  <td>${TableUtils.formatNum(unavailable)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('ltPagination', { module: 'LowTurnoverModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    TableUtils.initSmartSelect('ltTableArea');
    TableUtils.initSortableHeaders('ltTableArea');
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() {
    this.currentFilter.keyword = (document.getElementById('ltKw')?.value || '').trim();
    this.currentPage = 1;
    this.loadData();
  },
  resetFilter() {
    this.currentFilter = { keyword: '' };
    this.currentPage = 1;
    const input = document.getElementById('ltKw');
    if (input) input.value = '';
    this.loadData();
  },
  goPage(p) { this.currentPage = p; this.renderTable(); },
  exportData() {
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(this.currentData, `低周转_${new Date().toISOString().split('T')[0]}.xlsx`, '低周转');
  }
};
