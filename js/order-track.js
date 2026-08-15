// ============================================
// 订单跟踪模块 V2 - 去重统计 + 升级分页
// ============================================

const OrderTrackModule = {
  currentPage: 1,
  pageSize: 50,

  async render() {
    const content = document.getElementById('contentArea');
    const suppliers = await DataStore.getOrderSuppliers();

    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="trackKw" placeholder="搜索订单编号、供应商、物料..." onkeydown="if(event.key==='Enter')OrderTrackModule.applyFilter()">
        <select id="trackSupplier">
          <option value="">全部供应商</option>
          ${suppliers.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <button class="search-glass" onclick="OrderTrackModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="OrderTrackModule.resetFilter()">重置</button>
        <button class="secondary" onclick="OrderTrackModule.exportData()">📥 导出</button>
      </div>

      <div id="trackSummary"></div>
      <div class="card" style="padding:0;">
        <div id="trackTableArea" class="table-wrapper" style="overflow-x:auto;"></div>
      </div>
      <div id="trackPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    let orders = await db.orders.toArray();
    const kw = document.getElementById('trackKw')?.value.trim();
    const supplier = document.getElementById('trackSupplier')?.value;

    if (kw) {
      const kwLower = kw.toLowerCase();
      orders = orders.filter(o =>
        (o.订单编号 && String(o.订单编号).toLowerCase().includes(kwLower)) ||
        (o.供应商 && o.供应商.toLowerCase().includes(kwLower)) ||
        (o.存货名称 && o.存货名称.toLowerCase().includes(kwLower))
      );
    }
    if (supplier) {
      orders = orders.filter(o => o.供应商 === supplier);
    }

    // 仅显示有未入库量的订单
    const pending = orders.filter(o => parseFloat(o.未入库量) > 0);

    // ===== 去重统计 =====
    const uniqueOrderNos = new Set(pending.map(o => o.订单编号).filter(Boolean));
    const uniqueCount = uniqueOrderNos.size;
    const totalUninbound = pending.reduce((s, o) => s + (parseFloat(o.未入库量) || 0), 0);
    const totalUninboundAmount = pending.reduce((s, o) => s + (parseFloat(o.未入总金额) || 0), 0);

    document.getElementById('trackSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">未入库订单数</div>
          <div class="kpi-value">${uniqueCount}</div>
          <div class="kpi-sub">总记录 ${pending.length} 条</div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">未入库总量</div>
          <div class="kpi-value">${this.formatNum(totalUninbound)}</div>
        </div>
        <div class="kpi-card card-danger">
          <div class="kpi-label">未入金额(元)</div>
          <div class="kpi-value">¥${this.formatMoney(totalUninboundAmount)}</div>
        </div>
      </div>
    `;

    this.currentData = pending;
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() {
    this.loadData();
  },

  resetFilter() {
    document.getElementById('trackKw').value = '';
    document.getElementById('trackSupplier').value = '';
    this.loadData();
  },

  renderTable() {
    const data = this.currentData;
    const total = data.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    const items = data.slice((page - 1) * this.pageSize, page * this.pageSize);

    if (items.length === 0) {
      document.getElementById('trackTableArea').innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">所有订单已全部入库</div></div>';
      document.getElementById('trackPagination').innerHTML = '';
      return;
    }

    document.getElementById('trackTableArea').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>订单编号</th>
            <th>下单时间</th>
            <th>供应商</th>
            <th>项目</th>
            <th>物料</th>
            <th>规格</th>
            <th>订单量</th>
            <th>已入库</th>
            <th>未入库</th>
            <th>入库进度</th>
            <th>未入金额</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(o => {
            const totalQty = parseFloat(o.数量) || 0;
            const inbound = parseFloat(o.累计入库数量) || 0;
            const pendingQty = parseFloat(o.未入库量) || 0;
            const percent = totalQty > 0 ? Math.min(100, Math.round((inbound / totalQty) * 100)) : 0;
            const progressClass = percent >= 80 ? '' : percent >= 50 ? 'warning' : 'danger';
            return `
              <tr>
                <td><strong>${esc(o.订单编号)}</strong></td>
                <td>${esc(o.日期 || o.已下单时间 || '-')}</td>
                <td>${esc(o.供应商)}</td>
                <td>${esc(o.项目名称 || '-')}</td>
                <td>${esc(o.存货名称)}</td>
                <td>${esc(o.规格型号 || '-')}</td>
                <td>${o.数量}</td>
                <td>${o.累计入库数量 || 0}</td>
                <td><strong>${pendingQty}</strong></td>
                <td>
                  <div class="progress-bar" style="width:80px;">
                    <div class="progress-fill ${progressClass}" style="width:${percent}%;"></div>
                  </div>
                  <span style="font-size:11px;color:var(--text-secondary);">${percent}%</span>
                </td>
                <td>${this.formatMoney(o.未入总金额)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    // 升级分页 - pagination-bar 标准格式
    const html = [];
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>`);
    html.push(`<span class="page-btns">`);
    html.push(`<button onclick="OrderTrackModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="OrderTrackModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="OrderTrackModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="OrderTrackModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="OrderTrackModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="OrderTrackModule.changePageSize(this.value)" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize === 20 ? 'selected' : ''}>20</option>
        <option value="50" ${this.pageSize === 50 ? 'selected' : ''}>50</option>
        <option value="100" ${this.pageSize === 100 ? 'selected' : ''}>100</option>
      </select> 条
    </span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="trackPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')OrderTrackModule.jumpPage()"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);

    document.getElementById('trackPagination').innerHTML = html.join('');

    TableUtils.initSortableHeaders('trackTableArea', this.currentData, (sorted) => {
      this.currentData = sorted;
      this.currentPage = 1;
      this.renderTable();
    });
  },

  changePageSize(size) {
    this.pageSize = parseInt(size);
    this.currentPage = 1;
    this.renderTable();
  },

  jumpPage() {
    const input = document.getElementById('trackPageJumper');
    if (!input) return;
    const p = parseInt(input.value);
    if (isNaN(p) || p < 1) return;
    this.goPage(p);
  },

  goPage(p) {
    this.currentPage = p;
    this.renderTable();
  },

  exportData() {
    if (!this.currentData || this.currentData.length === 0) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(this.currentData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '订单跟踪');
    XLSX.writeFile(wb, `订单跟踪_${new Date().toISOString().split('T')[0]}.xlsx`);
  },

  formatNum(num) {
    return new Intl.NumberFormat('zh-CN').format(Math.round(num));
  },

  formatMoney(num) {
    if (!num) return '-';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  }
};
