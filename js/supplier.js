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
          <option value="expiring">即将到期(&lt;30天)</option>
          <option value="near">临近期(30-90天)</option>
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
        if (contractWarn === 'near') return days > 30 && days <= 90;
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
              <th>合同年限</th>
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
              const ratio = s.年度已供入库金额占比 || 0;
              const pct = Math.round(ratio * 100);
              // 颜色规则：<60%草绿色，60-80%蛋黄色，>80%暗红色
              const barClass = pct >= 80 ? 'danger' : pct >= 60 ? 'warning' : '';
              return `
                <tr>
                  <td>${esc(s.类型 ?? '')}</td>
                  <td><strong>${esc(s.供应商)}</strong></td>
                  <td>${esc(s.合同年限 ?? '')}</td>
                  <td>${esc(s.年度合同到期时间 ?? '')}</td>
                  <td>${daysTag || ''}</td>
                  <td>${this.formatMoney(s.年度合同金额)}</td>
                  <td>${this.formatMoney(s.年度已供入库金额)}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div class="progress-bar" style="width:70px;">
                        <div class="progress-fill ${barClass}" style="width:${pct}%;"></div>
                      </div>
                      <span style="font-size:11px;color:var(--text-secondary);min-width:36px;">${pct}%</span>
                    </div>
                  </td>
                  <td>${esc(s.招采部门 ?? '')}</td>
                  <td><button onclick="SupplierModule.viewDetail(${JSON.stringify(s.id)})" style="border:none;background:var(--accent-mint-light);color:var(--primary-deep);cursor:pointer;border-radius:8px;padding:4px 12px;font-size:12px;">详情</button></td>
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
    let expiring = 0, near = 0, safe = 0, expired = 0;

    suppliers.forEach(s => {
      if (!s.年度合同到期时间) return;
      const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
      if (days < 0) expired++;
      else if (days <= 30) expiring++;
      else if (days <= 90) near++;
      else safe++;
    });

    document.getElementById('contractStatsArea').innerHTML = `
      <div class="contract-stats">
        <div class="contract-stat-item csw">
          <div class="cs-label">即将到期(&lt;30天)</div>
          <div class="cs-num">${expiring}</div>
        </div>
        <div class="contract-stat-item csnear">
          <div class="cs-label">临近期(30-90天)</div>
          <div class="cs-num">${near}</div>
        </div>
        <div class="contract-stat-item cssafe">
          <div class="cs-label">合同安全(&gt;90天)</div>
          <div class="cs-num">${safe}</div>
        </div>
        <div class="contract-stat-item csd">
          <div class="cs-label">已到期</div>
          <div class="cs-num">${expired}</div>
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

    // 获取该供应商的全部订单和入库记录，按日期降序取最近10条
    const [allOrders, allInbound] = await Promise.all([
      db.orders.where('供应商').equals(supplier.供应商).toArray(),
      db.inbound.where('供应商').equals(supplier.供应商).toArray()
    ]);

    // 按日期降序排列，取前10条
    const orders = allOrders
      .sort((a, b) => (b.日期 || '').localeCompare(a.日期 || ''))
      .slice(0, 10);
    const inbound = allInbound
      .sort((a, b) => (b.入库日期 || '').localeCompare(a.入库日期 || ''))
      .slice(0, 10);

    // 从现存量基础档案匹配填充存货编码
    if (typeof DataLoader !== 'undefined') {
      const codeMap = await DataLoader.getStockNameSpecCodeMap();
      if (orders.length > 0) orders.forEach(o => {
        if (o.存货名称) { const k = TableUtils.buildStockKey(o.存货名称, o.规格型号); o._存货编码 = codeMap.get(k) || ''; }
      });
      if (inbound.length > 0) inbound.forEach(i => {
        if (i.存货名称) { const k = TableUtils.buildStockKey(i.存货名称, i.规格型号); i._存货编码 = codeMap.get(k) || ''; }
      });
    }

    // 计算最近3个月订单/入库趋势图数据
    const trendData = this._calcTrendData(allOrders, allInbound);

    document.getElementById('modalTitle').textContent = supplier.供应商;
    document.getElementById('modalBody').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div><strong>类型:</strong> ${esc(supplier.类型 ?? '')}</div>
        <div><strong>招采部门:</strong> ${esc(supplier.招采部门 ?? '')}</div>
        <div><strong>签订次数:</strong> ${esc(supplier.签订次数 ?? '')}</div>
        <div><strong>合同年限:</strong> ${esc(supplier.合同年限 ?? '')}</div>
        <div><strong>合同生效:</strong> ${esc(supplier.第一年度生效时间 ?? '')}</div>
        <div><strong>合同到期:</strong> ${esc(supplier.年度合同到期时间 ?? '')}</div>
        <div><strong>合同金额:</strong> ${this.formatMoney(supplier.年度合同金额)}</div>
        <div><strong>已入库金额:</strong> ${this.formatMoney(supplier.年度已供入库金额)}</div>
        <div><strong>生产厂址:</strong> ${esc(supplier.生产厂址 ?? '')}</div>
        <div><strong>办公地址:</strong> ${esc(supplier.地址 ?? '')}</div>
      </div>

      <!-- 趋势图区域 -->
      <div style="margin-bottom:16px;">
        <h4 style="margin:0 0 8px;font-size:14px;">📈 近3月趋势对比</h4>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="glass-card" style="padding:12px;margin:0;">
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">订单金额（万元）</div>
            <canvas id="supDetailOrderChart" height="120"></canvas>
          </div>
          <div class="glass-card" style="padding:12px;margin:0;">
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">入库金额（万元）</div>
            <canvas id="supDetailInboundChart" height="120"></canvas>
          </div>
        </div>
      </div>

      <h4 style="margin:12px 0 8px;">最近订单(10)</h4>
      ${orders.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">暂无订单</div>' : `
        <table class="data-table">
          <thead><tr><th>订单编号</th><th>日期</th><th>存货编码</th><th>存货名称</th><th>数量</th><th>未入库</th></tr></thead>
          <tbody>${orders.map(o => `
            <tr><td>${esc(o.订单编号 ?? '')}</td><td>${esc(o.日期 ?? '')}</td><td>${esc(o._存货编码 ?? '')}</td><td>${esc(o.存货名称 ?? '')}</td><td>${esc(o.数量 ?? '')}</td><td>${esc(o.未入库量 ?? '')}</td></tr>
          `).join('')}</tbody>
        </table>
      `}

      <h4 style="margin:12px 0 8px;">最近入库(10)</h4>
      ${inbound.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">暂无入库</div>' : `
        <table class="data-table">
          <thead><tr><th>入库单号</th><th>入库日期</th><th>存货编码</th><th>存货名称</th><th>数量</th><th>含税金额</th></tr></thead>
          <tbody>${inbound.map(i => `
            <tr><td>${esc(i.入库单号 ?? '')}</td><td>${esc(i.入库日期 ?? '')}</td><td>${esc(i._存货编码 ?? '')}</td><td>${esc(i.存货名称 ?? '')}</td><td>${esc(i.数量 ?? '')}</td><td>${this.formatMoney(i.原币价税合计)}</td></tr>
          `).join('')}</tbody>
        </table>
      `}
    `;
    document.getElementById('modalOverlay').classList.add('show');

    // 渲染趋势图
    setTimeout(() => this._renderTrendCharts(trendData), 100);
  },

  // 计算最近3个月的订单/入库趋势数据
  _calcTrendData(orders, inbound) {
    const months = [];
    const now = new Date();
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        year: d.getFullYear(),
        month: d.getMonth() + 1
      });
    }

    const orderAmounts = months.map(m => {
      return orders
        .filter(o => {
          if (!o.日期) return false;
          const d = new Date(o.日期);
          return d.getFullYear() === m.year && (d.getMonth() + 1) === m.month;
        })
        .reduce((sum, o) => sum + (parseFloat(o.原币价税合计) || 0), 0) / 10000; // 转万元
    });

    const inboundAmounts = months.map(m => {
      return inbound
        .filter(i => {
          if (!i.入库日期) return false;
          const d = new Date(i.入库日期);
          return d.getFullYear() === m.year && (d.getMonth() + 1) === m.month;
        })
        .reduce((sum, i) => sum + (parseFloat(i.原币价税合计) || 0), 0) / 10000; // 转万元
    });

    return { labels: months.map(m => m.label), orderAmounts, inboundAmounts };
  },

  // 渲染趋势图
  _renderTrendCharts(data) {
    const chartOpts = (label, color, values) => ({
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [{
          label: label,
          data: values,
          borderColor: color,
          backgroundColor: color + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: color
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { font: { size: 11 } } },
          x: { ticks: { font: { size: 11 } } }
        }
      }
    });

    const orderCanvas = document.getElementById('supDetailOrderChart');
    const inboundCanvas = document.getElementById('supDetailInboundChart');

    // 🟡 先销毁旧实例（M4）：反复打开详情弹窗会累积 Chart 实例（Chart.js 全局注册表），
    // 旧实例不销毁会导致内存泄漏、动画帧持续运行。
    if (this._supOrderChart) { try { this._supOrderChart.destroy(); } catch (e) {} this._supOrderChart = null; }
    if (orderCanvas && typeof Chart !== 'undefined') {
      this._supOrderChart = new Chart(orderCanvas, chartOpts('订单金额', '#357ABD', data.orderAmounts));
    }
    if (this._supInboundChart) { try { this._supInboundChart.destroy(); } catch (e) {} this._supInboundChart = null; }
    if (inboundCanvas && typeof Chart !== 'undefined') {
      this._supInboundChart = new Chart(inboundCanvas, chartOpts('入库金额', '#28a745', data.inboundAmounts));
    }
  },

  async exportData() {
    const suppliers = await db.suppliers.toArray();
    if (suppliers.length === 0) { alert('没有数据可导出'); return; }
    this.exportToExcel(suppliers, '供应商管理');
  },

  exportToExcel(data, sheetName) {
    // 🟢 O1：复用统一导出（文件名格式保持原样：名称_YYYYMMDD.xlsx）
    const now = new Date();
    const filename = `${sheetName}_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.xlsx`;
    TableUtils.exportToExcel(data, filename, sheetName);
  },

  formatMoney(num) {
    if (num == null || num === '') return '';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(num);
  }
};
