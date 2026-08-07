// ============================================
// 供应商管理模块 V3 - 统一表格 · 合同到期排序 · 20条/页
// ============================================

const SupplierModule = {
  currentFilter: {},
  currentPage: 1,
  pageSize: 20,

  async render() {
    const content = document.getElementById('contentArea');
    const types = await DataStore.getSupplierTypes();
    const departments = await DataStore.getSupplierDepartments();

    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="supplierKw" placeholder="搜索供应商名称..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')SupplierModule.applyFilter()">
        <select id="supplierType">
          <option value="">全部类型</option>
          ${types.map(t => `<option value="${t}" ${this.currentFilter.类型 === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <select id="supplierDept">
          <option value="">全部招采部门</option>
          ${departments.map(d => `<option value="${d}" ${this.currentFilter.招采部门 === d ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
        <select id="contractWarn">
          <option value="">合同状态</option>
          <option value="expiring">即将到期(30天内)</option>
          <option value="expired">已到期</option>
        </select>
        <button class="search-glass" onclick="SupplierModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="SupplierModule.resetFilter()">重置</button>
        <button class="secondary" onclick="SupplierModule.exportData()">📥 导出Excel</button>
      </div>

      <!-- 合同状态统计区 -->
      <div id="contractStatsArea"></div>

      <div id="supplierTableArea"></div>
      <div id="supplierPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadTable();
  },

  async loadTable() {
    let suppliers = await DataStore.getSuppliers(this.currentFilter);

    // 运行时补全：若已入库金额全为0，从入库表汇总
    const allZero = suppliers.length > 0 && suppliers.every(s => !s.年度已供入库金额 || s.年度已供入库金额 === 0);
    if (allZero) {
      try {
        const inbound = await db.inbound.toArray();
        const map = new Map();
        inbound.forEach(row => { const sup=row.供应商; if(sup) map.set(sup, (map.get(sup)||0)+(parseFloat(row.原币价税合计)||0)); });
        suppliers.forEach(s => { if(map.has(s.供应商)) { s.年度已供入库金额=map.get(s.供应商); if(s.年度合同金额>0) s.年度已供入库金额占比=s.年度已供入库金额/s.年度合同金额; }});
      } catch(e){/*ignore*/}
    }

    const contractWarn = document.getElementById('contractWarn')?.value;
    if (contractWarn) {
      const now = new Date();
      suppliers = suppliers.filter(s => {
        if (!s.年度合同到期时间) return false;
        const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
        if (contractWarn === 'expiring') return days >= 0 && days <= 30;
        if (contractWarn === 'expired') return days < 0;
        return true;
      });
    }

    const now = new Date();
    suppliers.sort((a, b) => {
      const daysA = a.年度合同到期时间
        ? Math.ceil((new Date(a.年度合同到期时间) - now) / (1000 * 60 * 60 * 24))
        : 99999;
      const daysB = b.年度合同到期时间
        ? Math.ceil((new Date(b.年度合同到期时间) - now) / (1000 * 60 * 60 * 24))
        : 99999;

      const aExpired = daysA < 0;
      const bExpired = daysB < 0;

      if (aExpired && !bExpired) return 1;
      if (!aExpired && bExpired) return -1;

      if (!aExpired && !bExpired) {
        if (daysA === 99999 && daysB === 99999) return 0;
        if (daysA === 99999) return 1;
        if (daysB === 99999) return -1;
        return daysA - daysB;
      }

      return daysB - daysA;
    });

    this.renderContractStats(suppliers);

    const total = suppliers.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    const items = suppliers.slice((page - 1) * this.pageSize, page * this.pageSize);

    const area = document.getElementById('supplierTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无供应商数据</div></div>';
      document.getElementById('supplierPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>供应商</th>
              <th>合同到期日</th>
              <th>剩余天数</th>
              <th>合同金额(元)</th>
              <th>已入库金额(元)</th>
              <th>已入库占比</th>
              <th>招采部门</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(s => {
              let daysTag = '';
              if (s.年度合同到期时间) {
                const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
                if (days < 0) { daysTag = `<span class="tag tag-danger">已过期${-days}天</span>`; }
                else if (days <= 30) { daysTag = `<span class="tag tag-warning">${days}天</span>`; }
                else daysTag = `<span class="tag tag-success">${days}天</span>`;
              }
              return `
                <tr>
                  <td>${s.类型 || '-'}</td>
                  <td><strong>${s.供应商}</strong></td>
                  <td>${s.年度合同到期时间 || '-'}</td>
                  <td>${daysTag || '-'}</td>
                  <td>${this.formatMoney(s.年度合同金额)}</td>
                  <td>${this.formatMoney(s.年度已供入库金额)}</td>
                  <td>${s.年度已供入库金额占比 ? (s.年度已供入库金额占比 * 100).toFixed(1) + '%' : '-'}</td>
                  <td>${s.招采部门 || '-'}</td>
                  <td><button onclick="SupplierModule.viewDetail(${s.id})" style="border:none;background:var(--accent-mint-light);color:var(--primary-deep);cursor:pointer;border-radius:8px;padding:4px 12px;font-size:12px;">详情</button></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(total, totalPages);
    TableUtils.initSmartSelect('supplierTableArea');
  },

  renderContractStats(suppliers) {
    const now = new Date();
    let normal = 0, expiring = 0, expired = 0;

    suppliers.forEach(s => {
      if (!s.年度合同到期时间) return;
      const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
      if (days < 0) expired++;
      else if (days <= 30) expiring++;
      else normal++;
    });

    document.getElementById('contractStatsArea').innerHTML = `
      <div class="contract-stats">
        <div class="contract-stat-item" style="border-left:3px solid var(--status-success);">
          <div class="cs-num">${normal}</div>
          <div class="cs-label">合同正常</div>
        </div>
        <div class="contract-stat-item csw">
          <div class="cs-num">${expiring}</div>
          <div class="cs-label">即将到期(≤30天)</div>
        </div>
        <div class="contract-stat-item csd">
          <div class="cs-num">${expired}</div>
          <div class="cs-label">已到期</div>
        </div>
      </div>
    `;
  },

  renderPagination(total, totalPages) {
    const page = this.currentPage;
    const html = [];
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>`);
    html.push(`<span class="page-btns">`);
    html.push(`<button onclick="SupplierModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="SupplierModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="SupplierModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="SupplierModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="SupplierModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="SupplierModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="supplierPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')SupplierModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);

    document.getElementById('supplierPagination').innerHTML = html.join('');
  },

  changePageSize(size) {
    this.pageSize = size;
    this.currentPage = 1;
    this.loadTable();
  },

  goPage(p) {
    this.currentPage = p;
    this.loadTable();
  },

  applyFilter() {
    this.currentFilter = {
      keyword: document.getElementById('supplierKw').value.trim(),
      类型: document.getElementById('supplierType').value,
      招采部门: document.getElementById('supplierDept').value
    };
    this.currentPage = 1;
    this.loadTable();
  },

  resetFilter() {
    this.currentFilter = {};
    this.currentPage = 1;
    this.pageSize = 20;
    document.getElementById('supplierKw').value = '';
    document.getElementById('supplierType').value = '';
    document.getElementById('supplierDept').value = '';
    const cw = document.getElementById('contractWarn');
    if (cw) cw.value = '';
    this.loadTable();
  },

  async viewDetail(id) {
    const supplier = await db.suppliers.get(id);
    if (!supplier) return;

    const [orders, inbound] = await Promise.all([
      db.orders.where('供应商').equals(supplier.供应商).limit(50).toArray(),
      db.inbound.where('供应商').equals(supplier.供应商).limit(50).toArray()
    ]);

    document.getElementById('modalTitle').textContent = supplier.供应商;
    document.getElementById('modalBody').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div><strong>类型:</strong> ${supplier.类型 || '-'}</div>
        <div><strong>招采部门:</strong> ${supplier.招采部门 || '-'}</div>
        <div><strong>签订次数:</strong> ${supplier.签订次数 || '-'}</div>
        <div><strong>合同年限:</strong> ${supplier.合同年限 || '-'}</div>
        <div><strong>合同生效:</strong> ${supplier.第一年度生效时间 || '-'}</div>
        <div><strong>合同到期:</strong> ${supplier.年度合同到期时间 || '-'}</div>
        <div><strong>合同金额:</strong> ${this.formatMoney(supplier.年度合同金额)}</div>
        <div><strong>已入库金额:</strong> ${this.formatMoney(supplier.年度已供入库金额)}</div>
        <div><strong>生产厂址:</strong> ${supplier.生产厂址 || '-'}</div>
        <div><strong>办公地址:</strong> ${supplier.地址 || '-'}</div>
      </div>

      <h4 style="margin:12px 0 8px;">最近订单(${orders.length})</h4>
      ${orders.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">暂无订单</div>' : `
        <table class="data-table">
          <thead><tr><th>订单编号</th><th>日期</th><th>物料</th><th>数量</th><th>未入库</th></tr></thead>
          <tbody>${orders.slice(0, 10).map(o => `
            <tr><td>${o.订单编号}</td><td>${o.日期}</td><td>${o.存货名称}</td><td>${o.数量}</td><td>${o.未入库量}</td></tr>
          `).join('')}</tbody>
        </table>
      `}

      <h4 style="margin:12px 0 8px;">最近入库(${inbound.length})</h4>
      ${inbound.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">暂无入库</div>' : `
        <table class="data-table">
          <thead><tr><th>入库单号</th><th>入库日期</th><th>物料</th><th>数量</th><th>金额</th></tr></thead>
          <tbody>${inbound.slice(0, 10).map(i => `
            <tr><td>${i.入库单号}</td><td>${i.入库日期}</td><td>${i.存货名称}</td><td>${i.数量}</td><td>${this.formatMoney(i.原币价税合计)}</td></tr>
          `).join('')}</tbody>
        </table>
      `}
    `;
    document.getElementById('modalOverlay').classList.add('show');
  },

  async exportData() {
    const suppliers = await db.suppliers.toArray();
    if (suppliers.length === 0) { alert('没有数据可导出'); return; }
    this.exportToExcel(suppliers, '供应商管理');
  },

  exportToExcel(data, sheetName) {
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const now = new Date();
    const filename = `${sheetName}_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.xlsx`;
    XLSX.writeFile(wb, filename);
  },

  formatMoney(num) {
    if (!num) return '-';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(num);
  }
};
