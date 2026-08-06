// ============================================
// 现存量模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const StockModule = {
  currentData: [],
  currentPage: 1,
  pageSize: 20,

  async render() {
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="stockKw" placeholder="搜索物料编码、名称、规格..." onkeydown="if(event.key==='Enter')StockModule.applyFilter()">
        <button class="search-glass" onclick="StockModule.applyFilter()">🔍 搜索</button>
        <button class="secondary" onclick="StockModule.resetFilter()">重置</button>
        <button class="secondary" onclick="StockModule.exportData()">📥 导出</button>
      </div>

      <div id="stockSummary"></div>
      <div id="stockTableArea"></div>
      <div id="stockPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    let stocks = await db.stock.toArray();
    const kw = document.getElementById('stockKw')?.value.trim().toLowerCase();

    if (kw) {
      stocks = stocks.filter(s =>
        (s.存货编码 && s.存货编码.toLowerCase().includes(kw)) ||
        (s.存货名称 && s.存货名称.toLowerCase().includes(kw)) ||
        (s.规格型号 && s.规格型号.toLowerCase().includes(kw))
      );
    }

    const totalQty = stocks.reduce((s, c) => s + (parseFloat(c.现存数量) || 0), 0);
    const updateTime = stocks.length > 0 ? stocks[0].数据更新时间 : '-';

    document.getElementById('stockSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-info">
          <div class="kpi-label">物料种类</div>
          <div class="kpi-value">${stocks.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">总库存数量</div>
          <div class="kpi-value">${this.formatNum(totalQty)}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">更新时间</div>
          <div class="kpi-value" style="font-size:14px;">${updateTime}</div>
        </div>
      </div>
    `;

    this.currentData = stocks;
    this.currentPage = 1;
    this.renderTable();
  },

  renderTable() {
    const data = this.currentData;
    const total = data.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    const items = data.slice((page - 1) * this.pageSize, page * this.pageSize);

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
                <td>${s.仓库名称 || '-'}</td>
                <td>${s.存货编码 || '-'}</td>
                <td><strong>${s.存货名称}</strong></td>
                <td>${s.规格型号 || '-'}</td>
                <td><strong style="color:${s.现存数量 < 10 ? 'var(--status-danger)' : 'var(--text-main)'};">${this.formatNum(s.现存数量)}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    const html = [];
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>`);
    html.push(`<span class="page-btns">`);
    html.push(`<button onclick="StockModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="StockModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="StockModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="StockModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="StockModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="StockModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="stockPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')StockModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);
    document.getElementById('stockPagination').innerHTML = html.join('');

    TableUtils.initSmartSelect('stockTableArea');
  },

  changePageSize(size) {
    this.pageSize = size;
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() { this.loadData(); },

  resetFilter() {
    document.getElementById('stockKw').value = '';
    this.loadData();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    if (!this.currentData || this.currentData.length === 0) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(this.currentData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '现存量');
    XLSX.writeFile(wb, `现存量_${new Date().toISOString().split('T')[0]}.xlsx`);
  },

  formatNum(num) {
    return new Intl.NumberFormat('zh-CN').format(Math.round(num || 0));
  }
};
