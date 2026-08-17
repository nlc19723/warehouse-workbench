// ============================================
// 对账功能模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const ReconciliationModule = {
  suppliers: [],
  currentFilter: {},
  currentPage: 1,
  pageSize: 20,
  currentData: [],
  trendChart: null,

  async render() {
    this.suppliers = await DataStore.getOrderSuppliers();

    // 计算默认日期范围：上上月26日 至 上月25日
    // 例：现在是 2026/8 → 上上月=6月、上月=7月 → 2026/6/26 至 2026/7/25
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1; // 1~12
    // 上月 = m - 1（跨年则去年12月）
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevYear  = m === 1 ? y - 1 : y;
    // 上上月 = m - 2
    const prevPrevMonth = m === 1 ? 11 : (m === 2 ? 12 : m - 2);
    const prevPrevYear  = (m === 1 || m === 2) ? y - 1 : y;
    const pad = n => String(n).padStart(2, '0');
    const defaultStart = `${prevPrevYear}-${pad(prevPrevMonth)}-26`;
    const defaultEnd   = `${prevYear}-${pad(prevMonth)}-25`;

    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <select id="recSupplier">
          <option value="">选择供应商</option>
          ${this.suppliers.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <input type="date" id="recStartDate" value="${defaultStart}">
        <span style="color:var(--text-secondary);">至</span>
        <input type="date" id="recEndDate" value="${defaultEnd}">
        <button class="search-glass" onclick="ReconciliationModule.applyFilter()">查询</button>
        <button class="secondary" onclick="ReconciliationModule.exportData()">📥 导出</button>
      </div>

      <div id="recSummary"></div>
      <div id="recTableArea"></div>
      <div id="recPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.applyFilter();
  },

  async applyFilter() {
    const supplier = document.getElementById('recSupplier').value;
    const startDate = document.getElementById('recStartDate').value;
    const endDate = document.getElementById('recEndDate').value;

    this.currentFilter = { supplier, startDate, endDate };
    this.currentPage = 1;

    let inbound = await db.inbound.toArray();

    if (supplier) {
      inbound = inbound.filter(i => i.供应商 === supplier);
    }
    if (startDate) {
      inbound = inbound.filter(i => i.入库日期 && i.入库日期 >= startDate);
    }
    if (endDate) {
      inbound = inbound.filter(i => i.入库日期 && i.入库日期 <= endDate);
    }

    const uniqueInboundNos = new Set(inbound.map(i => i.入库单号).filter(Boolean));

    const summary = {};
    inbound.forEach(i => {
      const key = i.供应商 || '未知';
      if (!summary[key]) summary[key] = { qty: 0, amount: 0, uniqueNos: new Set() };
      summary[key].qty += parseFloat(i.数量) || 0;
      summary[key].amount += parseFloat(i.原币价税合计) || 0;
      if (i.入库单号) summary[key].uniqueNos.add(i.入库单号);
    });

    const supplierList = Object.entries(summary).sort((a, b) => b[1].amount - a[1].amount);
    const totalAmount = supplierList.reduce((s, e) => s + e[1].amount, 0);

    document.getElementById('recSummary').innerHTML = `
      <div class="chart-stats-row" style="margin-bottom:14px;">
        <!-- 左侧：按供应商汇总 (2/3) -->
        <div class="glass-card" style="flex:0 0 58%;min-width:320px;margin-bottom:0;">
          <div class="glass-card-header"><span class="glass-card-title"><span class="title-icon">📊</span>按供应商汇总</span></div>
          <div class="table-wrapper" style="max-height:260px;">
            <table class="data-table">
              <thead><tr><th>供应商</th><th>入库单数</th><th>入库量</th><th>金额(元)</th><th>占比</th></tr></thead>
              <tbody>${supplierList.map(([name, info]) => `
                <tr>
                  <td><strong>${esc(name)}</strong></td>
                  <td>${info.uniqueNos.size}</td>
                  <td>${this.formatNum(info.qty)}</td>
                  <td>${this.formatMoney(info.amount)}</td>
                  <td>${totalAmount > 0 ? ((info.amount / totalAmount) * 100).toFixed(1) + '%' : ''}</td>
                </tr>
              `).join('')}</tbody>
            </table>
          </div>
        </div>
        <!-- 右侧：趋势图 (1/3) -->
        <div class="glass-card" style="flex:0 0 38%;min-width:280px;margin-bottom:0;">
          <div class="glass-card-header">
            <span class="glass-card-title"><span class="title-icon">📈</span>供应商近6月供货金额趋势</span>
          </div>
          <div class="chart-container-sm">
            <canvas id="recTrendChart"></canvas>
          </div>
        </div>
      </div>

      ${supplierList.length > 0 ? '' : '<div class="empty-state" style="margin-bottom:14px;"><div class="empty-text">暂无对账数据</div></div>'}
    `;

    this.currentData = inbound;
    this.renderTable();
    // 渲染供应商趋势图
    await this.renderSupplierTrendChart(supplier, inbound);
  },

  renderTable() {
    const data = this.currentData;
    const total = data.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    const items = data.slice((page - 1) * this.pageSize, page * this.pageSize);

    const area = document.getElementById('recTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无对账数据</div></div>';
      document.getElementById('recPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr><th>入库日期</th><th>入库单号</th><th>供应商</th><th>存货编码</th><th>存货名称</th><th>规格型号</th><th>入库量</th><th>含税单价</th><th>含税金额</th></tr>
          </thead>
          <tbody>
            ${items.map(i => `
              <tr>
                <td>${esc(i.入库日期 ?? '')}</td>
                <td>${esc(i.入库单号 ?? '')}</td>
                <td>${esc(i.供应商 ?? '')}</td>
                <td>${esc(i.存货编码 ?? '')}</td>
                <td>${esc(i.存货名称 ?? '')}</td>
                <td>${esc(i.规格型号 ?? '')}</td>
                <td>${i.数量}</td>
                <td>${this.formatMoney(i.原币含税单价)}</td>
                <td>${this.formatMoney(i.原币价税合计)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    const html = [];
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>`);
    html.push(`<span class="page-btns">`);
    html.push(`<button onclick="ReconciliationModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="ReconciliationModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="ReconciliationModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="ReconciliationModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="ReconciliationModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="ReconciliationModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="recPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')ReconciliationModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);
    document.getElementById('recPagination').innerHTML = html.join('');

    TableUtils.initSmartSelect('recTableArea');
  },

  changePageSize(size) {
    this.pageSize = size;
    this.currentPage = 1;
    this.renderTable();
  },

  goPage(p) {
    this.currentPage = p;
    this.renderTable();
  },

  exportData() {
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(this.currentData, `对账单_${new Date().toISOString().split('T')[0]}.xlsx`, '对账单');
  },

  // ===== 供应商近6月供货金额趋势图 =====
  async renderSupplierTrendChart(selectedSupplier, inbound) {
    const canvas = document.getElementById('recTrendChart');
    if (!canvas) return;
    if (this.trendChart) { this.trendChart.destroy(); this.trendChart = null; }

    const now = new Date();
    const sixMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      sixMonths.push({
        label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        year: d.getFullYear(),
        month: d.getMonth() + 1
      });
    }

    // 如果有选定的供应商，只显示该供应商数据；否则显示所有
    const filterFn = selectedSupplier
      ? (i) => i.供应商 === selectedSupplier
      : (i) => true;

    const monthAmounts = sixMonths.map(m => {
      const matched = inbound.filter(i => {
        if (!i.入库日期 || !filterFn(i)) return false;
        const d = new Date(i.入库日期);
        return d.getFullYear() === m.year && (d.getMonth() + 1) === m.month;
      });
      return matched.reduce((s, i) => s + (parseFloat(i.原币价税合计) || 0), 0);
    });

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#94A3B8' : '#64748B';
    const gridColor = isDark ? 'rgba(148,163,184,0.12)' : 'rgba(148,163,184,0.18)';

    const chartLabel = selectedSupplier
      ? `${selectedSupplier} 供货金额`
      : '全部供应商供货金额';

    this.trendChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: sixMonths.map(m => m.label.substring(5)),
        datasets: [{
          label: chartLabel,
          data: monthAmounts.map(a => +(a / 10000).toFixed(2)),
          borderColor: isDark ? '#34D399' : '#6DBF9F',
          backgroundColor: isDark ? 'rgba(52,211,153,0.15)' : 'rgba(109,191,159,0.15)',
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          pointRadius: 5,
          pointBackgroundColor: isDark ? '#34D399' : '#6DBF9F',
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointHoverRadius: 7,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: {
            position: 'top',
            labels: { color: textColor, font: { size: 11 }, usePointStyle: true, padding: 15 }
          },
          tooltip: {
            backgroundColor: isDark ? 'rgba(15,23,42,0.9)' : 'rgba(255,255,255,0.95)',
            titleColor: textColor,
            bodyColor: textColor,
            borderColor: 'rgba(148,163,184,0.2)',
            borderWidth: 1,
            callbacks: {
              label: (ctx) => `¥${ctx.raw.toFixed(2)} 万元`
            }
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: textColor, font: { size: 11 } }
          },
          y: {
            grid: { color: gridColor },
            ticks: {
              color: textColor,
              font: { size: 11 },
              callback: v => '¥' + v + '万'
            },
            beginAtZero: true
          }
        }
      }
    });
  },

  formatMoney(num) {
    if (num == null || num === '') return '';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  },

  formatNum(num) {
    return new Intl.NumberFormat('zh-CN').format(Math.round(num));
  }
};
