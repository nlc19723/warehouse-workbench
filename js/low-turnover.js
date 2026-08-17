// ============================================
// 低周转材料模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const LowTurnoverModule = {
  currentData: [],
  currentPage: 1,
  pageSize: 20,

  async render() {
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="ltKw" placeholder="搜索物料名称..." onkeydown="if(event.key==='Enter')LowTurnoverModule.applyFilter()">
        <button class="search-glass" onclick="LowTurnoverModule.applyFilter()">🔍 搜索</button>
        <button class="secondary" onclick="LowTurnoverModule.resetFilter()">重置</button>
        <button class="secondary" onclick="LowTurnoverModule.exportData()">📥 导出</button>
      </div>

      <div id="ltSummary"></div>
      <div id="ltTableArea"></div>
      <div id="ltPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    let items = await db.lowTurnover.toArray();
    const kw = document.getElementById('ltKw')?.value.trim().toLowerCase();
    if (kw) {
      items = items.filter(i =>
        (i.存货名称 && i.存货名称.toLowerCase().includes(kw)) ||
        (i.存货编码 && i.存货编码.toLowerCase().includes(kw))
      );
    }

    const totalQty = items.reduce((s, c) => s + (parseFloat(c.现存数量) || 0), 0);
    const totalUnavailable = items.reduce((s, c) => s + (parseFloat(c.暂无法使用量) || 0), 0);

    document.getElementById('ltSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">低周转物料种类</div>
          <div class="kpi-value">${items.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">现存总量</div>
          <div class="kpi-value">${this.formatNum(totalQty)}</div>
        </div>
        <div class="kpi-card card-danger">
          <div class="kpi-label">暂无法使用量</div>
          <div class="kpi-value">${this.formatNum(totalUnavailable)}</div>
        </div>
      </div>
    `;

    this.currentData = items;
    this.currentPage = 1;
    this.renderTable();
  },

  renderTable() {
    const data = this.currentData;
    const total = data.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    const items = data.slice((page - 1) * this.pageSize, page * this.pageSize);

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
                  <td>${esc(i.存货编码 ?? '')}</td>
                  <td><strong>${esc(i.存货名称)}</strong></td>
                  <td>${esc(i.规格型号 ?? '')}</td>
                  <td>${this.formatNum(total)}</td>
                  <td>${this.formatNum(unavailable)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    const html = [];
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>`);
    html.push(`<span class="page-btns">`);
    html.push(`<button onclick="LowTurnoverModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="LowTurnoverModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="LowTurnoverModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="LowTurnoverModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="LowTurnoverModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="LowTurnoverModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="ltPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')LowTurnoverModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);
    document.getElementById('ltPagination').innerHTML = html.join('');

    TableUtils.initSmartSelect('ltTableArea');
  },

  changePageSize(size) {
    this.pageSize = size;
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() { this.loadData(); },
  resetFilter() {
    document.getElementById('ltKw').value = '';
    this.loadData();
  },
  goPage(p) { this.currentPage = p; this.renderTable(); },
  exportData() {
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(this.currentData, `低周转_${new Date().toISOString().split('T')[0]}.xlsx`, '低周转');
  },
  formatNum(num) {
    return new Intl.NumberFormat('zh-CN').format(Math.round(num || 0));
  }
};
