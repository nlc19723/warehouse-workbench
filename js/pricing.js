// ============================================
// 合同价格模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const PricingModule = {
  currentData: [],
  currentPage: 1,
  pageSize: 20,

  async render() {
    const content = document.getElementById('contentArea');
    const [suppliers, types] = await Promise.all([
      (async () => {
        const all = await db.pricing.toArray();
        return [...new Set(all.map(p => p.供应商).filter(Boolean))].sort();
      })(),
      DataStore.getPricingTypes()
    ]);

    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="pricingKw" placeholder="搜索供应商、物料..." onkeydown="if(event.key==='Enter')PricingModule.applyFilter()">
        <select id="pricingSupplier">
          <option value="">全部供应商</option>
          ${suppliers.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <select id="pricingType">
          <option value="">全部类型</option>
          ${types.map(t => `<option value="${t}">${t}</option>`).join('')}
        </select>
        <button class="search-glass" onclick="PricingModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="PricingModule.resetFilter()">重置</button>
        <button class="secondary" onclick="PricingModule.exportData()">📥 导出</button>
      </div>

      <div id="pricingSummary"></div>
      <div id="pricingTableArea"></div>
      <div id="pricingPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    let pricing = await db.pricing.toArray();
    const kw = document.getElementById('pricingKw')?.value.trim().toLowerCase();
    const supplier = document.getElementById('pricingSupplier')?.value;
    const type = document.getElementById('pricingType')?.value;

    if (kw) {
      pricing = pricing.filter(p =>
        (p.供应商 && p.供应商.toLowerCase().includes(kw)) ||
        (p.存货名称 && p.存货名称.toLowerCase().includes(kw))
      );
    }
    if (supplier) pricing = pricing.filter(p => p.供应商 === supplier);
    if (type) pricing = pricing.filter(p => p.类型 === type);

    const now = new Date();
    const active = pricing.filter(p => {
      if (!p.生效日期 || !p.失效日期) return false;
      return new Date(p.生效日期) <= now && new Date(p.失效日期) >= now;
    });
    const avgPrice = active.length > 0 ? active.reduce((s, p) => s + (parseFloat(p.含税单价) || 0), 0) / active.length : 0;

    document.getElementById('pricingSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-info">
          <div class="kpi-label">价格记录数</div>
          <div class="kpi-value">${pricing.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">有效价格</div>
          <div class="kpi-value">${active.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">平均含税价</div>
          <div class="kpi-value">¥${this.formatMoney(avgPrice)}</div>
        </div>
      </div>
    `;

    this.currentData = pricing;
    this.currentPage = 1;
    this.renderTable();
  },

  renderTable() {
    const data = this.currentData;
    const total = data.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    const items = data.slice((page - 1) * this.pageSize, page * this.pageSize);
    const now = new Date();

    const area = document.getElementById('pricingTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无价格数据</div></div>';
      document.getElementById('pricingPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>供应商</th>
              <th>类型</th>
              <th>存货编码</th>
              <th>物料</th>
              <th>规格</th>
              <th>单位</th>
              <th>含税单价</th>
              <th>税率</th>
              <th>不含税单价</th>
              <th>生效日期</th>
              <th>失效日期</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(p => {
              let status = '<span class="tag tag-neutral">未知</span>';
              if (p.生效日期 && p.失效日期) {
                const start = new Date(p.生效日期);
                const end = new Date(p.失效日期);
                if (now < start) status = '<span class="tag tag-info">未生效</span>';
                else if (now > end) status = '<span class="tag tag-neutral">已失效</span>';
                else status = '<span class="tag tag-success">有效</span>';
              }
              return `
                <tr>
                  <td>${p.供应商 || '-'}</td>
                  <td>${p.类型 || '-'}</td>
                  <td>${p.存货编码 || '-'}</td>
                  <td><strong>${p.存货名称}</strong></td>
                  <td>${p.规格型号 || '-'}</td>
                  <td>${p.主计量 || '-'}</td>
                  <td><strong>¥${this.formatMoney(p.含税单价)}</strong></td>
                  <td>${p.税率 ? p.税率 + '%' : '-'}</td>
                  <td>¥${this.formatMoney(p.单价)}</td>
                  <td>${p.生效日期 || '-'}</td>
                  <td>${p.失效日期 || '-'}</td>
                  <td>${status}</td>
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
    html.push(`<button onclick="PricingModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="PricingModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="PricingModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="PricingModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="PricingModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="PricingModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="pricingPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')PricingModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);
    document.getElementById('pricingPagination').innerHTML = html.join('');

    TableUtils.initSmartSelect('pricingTableArea');
  },

  changePageSize(size) {
    this.pageSize = size;
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() { this.loadData(); },

  resetFilter() {
    document.getElementById('pricingKw').value = '';
    document.getElementById('pricingSupplier').value = '';
    document.getElementById('pricingType').value = '';
    this.loadData();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    if (!this.currentData || this.currentData.length === 0) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(this.currentData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '合同价格');
    XLSX.writeFile(wb, `合同价格_${new Date().toISOString().split('T')[0]}.xlsx`);
  },

  formatMoney(num) {
    if (!num) return '-';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  }
};
