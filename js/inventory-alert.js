// ============================================
// 库存预警模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const InventoryAlertModule = {
  currentPage: 1,
  pageSize: 20,
  currentData: [],

  async render() {
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="alertKw" placeholder="搜索物料名称、编码..." onkeydown="if(event.key==='Enter')InventoryAlertModule.applyFilter()">
        <select id="alertCategory">
          <option value="">全部分类</option>
          <option value="A">A类</option>
          <option value="B">B类</option>
          <option value="C">C类</option>
          <option value="不使用类">不使用类</option>
        </select>
        <select id="alertStatus">
          <option value="">全部状态</option>
          <option value="yes" selected>需补货</option>
          <option value="no">正常</option>
        </select>
        <button class="search-glass" onclick="InventoryAlertModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="InventoryAlertModule.resetFilter()">重置</button>
        <button class="secondary" onclick="InventoryAlertModule.exportData()">📥 导出</button>
      </div>

      <div id="alertSummary"></div>
      <div id="alertTableArea"></div>
      <div id="alertPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    let alerts = await db.inventoryAlerts.toArray();
    const kw = document.getElementById('alertKw')?.value.trim().toLowerCase();
    const category = document.getElementById('alertCategory')?.value;
    const status = document.getElementById('alertStatus')?.value;

    if (kw) {
      alerts = alerts.filter(a =>
        (a.存货名称 && a.存货名称.toLowerCase().includes(kw)) ||
        (a.存货编码 && a.存货编码.toLowerCase().includes(kw))
      );
    }
    if (category) {
      alerts = alerts.filter(a => a.分类 === category);
    }
    if (status === 'yes') {
      alerts = alerts.filter(a => a.是否需补货 === '是' || a.是否需补货 === true);
    } else if (status === 'no') {
      alerts = alerts.filter(a => a.是否需补货 !== '是' && a.是否需补货 !== true);
    }

    const needRestock = alerts.filter(a => a.是否需补货 === '是' || a.是否需补货 === true);
    const totalNeedQty = needRestock.reduce((s, a) => s + (parseFloat(a.在途订单) || 0), 0);

    document.getElementById('alertSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货种类</div>
          <div class="kpi-value">${needRestock.length}<span class="kpi-unit">/ ${alerts.length}</span></div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货量(在途)</div>
          <div class="kpi-value">${this.formatNum(totalNeedQty)}</div>
        </div>
      </div>
    `;

    this.currentData = alerts;
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() { this.loadData(); },

  resetFilter() {
    document.getElementById('alertKw').value = '';
    document.getElementById('alertCategory').value = '';
    document.getElementById('alertStatus').value = '';
    this.loadData();
  },

  renderTable() {
    const data = this.currentData;
    const total = data.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    const items = data.slice((page - 1) * this.pageSize, page * this.pageSize);

    const area = document.getElementById('alertTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无预警数据</div></div>';
      document.getElementById('alertPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格</th>
              <th>分类</th>
              <th>月均入库</th>
              <th>最低库存</th>
              <th>最高库存</th>
              <th>现存量</th>
              <th>在途订单</th>
              <th>状态</th>
              <th>仓库/项目</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(a => {
              const needRestock = a.是否需补货 === '是' || a.是否需补货 === true;
              return `
                <tr class="${needRestock ? 'row-warning' : ''}">
                  <td>${a.存货编码 || '-'}</td>
                  <td><strong>${a.存货名称}</strong></td>
                  <td>${a.规格型号 || '-'}</td>
                  <td>${a.分类 ? `<span class="tag ${a.分类 === 'A' ? 'tag-success' : a.分类 === 'B' ? 'tag-warning' : 'tag-neutral'}">${a.分类}</span>` : '-'}</td>
                  <td>${this.formatNum(a.近一年月均入库量)}</td>
                  <td>${this.formatNum(a.最低库存预警)}</td>
                  <td>${this.formatNum(a.最高库存)}</td>
                  <td>${this.formatNum(a.现存量)}</td>
                  <td>${this.formatNum(a.在途订单)}</td>
                  <td>${needRestock ? '<span class="tag tag-danger">需补货</span>' : '<span class="tag tag-success">正常</span>'}</td>
                  <td>${String(a.所上或库房 || '-').substring(0, 15)}${String(a.所上或库房 || '').length > 15 ? '...' : ''}</td>
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
    html.push(`<button onclick="InventoryAlertModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="InventoryAlertModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="InventoryAlertModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="InventoryAlertModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="InventoryAlertModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="InventoryAlertModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="alertPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')InventoryAlertModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);
    document.getElementById('alertPagination').innerHTML = html.join('');

    TableUtils.initSmartSelect('alertTableArea');
  },

  changePageSize(size) {
    this.pageSize = size;
    this.currentPage = 1;
    this.renderTable();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    if (!this.currentData || this.currentData.length === 0) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(this.currentData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '库存预警');
    XLSX.writeFile(wb, `库存预警_${new Date().toISOString().split('T')[0]}.xlsx`);
  },

  formatNum(num) {
    if (num === 0 || !num) return '-';
    return new Intl.NumberFormat('zh-CN').format(num);
  }
};
