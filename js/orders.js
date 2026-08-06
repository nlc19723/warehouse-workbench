// ============================================
// 订单列表模块 V3 - 统一表格 · 图表卡片并排 · 3D搜索按钮
// ============================================

const OrdersModule = {
  currentFilter: {},
  currentPage: 1,
  pageSize: 20,

  async render() {
    const content = document.getElementById('contentArea');
    const [suppliers, projects, statuses] = await Promise.all([
      DataStore.getOrderSuppliers(),
      DataStore.getOrderProjects(),
      (async () => {
        const all = await db.orders.toArray();
        return [...new Set(all.map(o => o.审批状态).filter(Boolean))];
      })()
    ]);

    content.innerHTML = `
      <div class="filter-bar filter-bar-two-row" style="display:flex;flex-direction:column;gap:2px;margin-bottom:6px;padding:0;">
        <div class="filter-row filter-row-main" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0;padding:0;">
          <input type="text" id="orderKw" class="filter-search-short" placeholder="搜索订单编号、供应商、物料..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')OrdersModule.applyFilter()">
          <div class="filter-row-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:4px;">
            <input type="date" id="orderStartDate" value="${this.currentFilter.startDate || ''}" class="filter-date" title="起始日期">
            <span class="filter-sep">至</span>
            <input type="date" id="orderEndDate" value="${this.currentFilter.endDate || ''}" class="filter-date" title="结束日期">
            <button class="search-glass" onclick="OrdersModule.applyFilter()">筛选</button>
            <button class="secondary" onclick="OrdersModule.resetFilter()">重置</button>
            <button class="secondary" onclick="OrdersModule.exportData()">📥 导出</button>
          </div>
        </div>
        <div class="filter-row filter-row-selects" style="display:flex;gap:10px;margin:0;padding:0;">
          <select id="orderSupplier" title="按供应商筛选">
            <option value="">全部供应商</option>
            ${suppliers.map(s => `<option value="${s}" ${this.currentFilter.供应商 === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <select id="orderProject" title="按项目筛选">
            <option value="">全部项目</option>
            ${projects.map(p => `<option value="${p}" ${this.currentFilter.项目名称 === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
          <select id="orderStatus" title="按审批状态筛选">
            <option value="">全部状态</option>
            ${statuses.map(s => `<option value="${s}" ${this.currentFilter.审批状态 === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- 趋势图 + 统计卡片并排（图表占宽，统计紧凑） -->
      <div class="chart-stats-row">
        <div class="stats-col" id="orderSummary"></div>
        <div class="chart-col">
          <div class="glass-card" id="orderTrendCard" style="display:none;height:100%;margin-bottom:0;">
            <div class="glass-card-header">
              <span class="glass-card-title"><span class="title-icon">📈</span>近三月订单趋势</span>
            </div>
            <div class="chart-container-sm">
              <canvas id="orderTrendChart"></canvas>
            </div>
          </div>
        </div>
      </div>

      <div id="orderTableArea"></div>
      <div id="orderPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    const allOrders = await db.orders.toArray();

    // 订单总数：按订单编号去重
    const uniqueOrderNos = new Set(allOrders.map(o => o.订单编号).filter(Boolean));
    const uniqueTotal = uniqueOrderNos.size;

    const unapproved = allOrders.filter(o => o.审批状态 && o.审批状态 !== '审批通过');
    const unapprovedUnique = new Set(unapproved.map(o => o.订单编号).filter(Boolean)).size;

    const uninbound = allOrders.filter(o => parseFloat(o.未入库量) > 0);
    const uninboundUnique = new Set(uninbound.map(o => o.订单编号).filter(Boolean)).size;

    const totalAmount = allOrders.reduce((s, o) => s + (parseFloat(o.原币价税合计) || 0), 0);

    document.getElementById('orderSummary').innerHTML = `
      <div class="kpi-card card-info">
        <div class="kpi-label">订单总数（去重）</div>
        <div class="kpi-value">${uniqueTotal}</div>
        <div class="kpi-sub">总金额 ¥${this.formatMoney(totalAmount)}</div>
      </div>
      <div class="kpi-card card-warning">
        <div class="kpi-label">未审批通过</div>
        <div class="kpi-value">${unapprovedUnique}</div>
        <div class="kpi-sub">占总数 ${uniqueTotal > 0 ? (unapprovedUnique / uniqueTotal * 100).toFixed(1) : 0}%</div>
      </div>
      <div class="kpi-card card-danger">
        <div class="kpi-label">未入库订单</div>
        <div class="kpi-value">${uninboundUnique}</div>
        <div class="kpi-sub">占总数 ${uniqueTotal > 0 ? (uninboundUnique / uniqueTotal * 100).toFixed(1) : 0}%</div>
      </div>
    `;

    this.allOrders = allOrders;
    this.totalCount = uniqueTotal;
    this.currentPage = 1;
    this.renderTable();
    this.renderTrendChart(allOrders);
  },

  async renderTable() {
    const result = await DataStore.getOrders(this.currentFilter, this.currentPage, this.pageSize);
    const { items, totalPages } = result;

    const area = document.getElementById('orderTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无订单数据</div></div>';
      document.getElementById('orderPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>订单编号</th>
              <th>日期</th>
              <th>供应商</th>
              <th>项目</th>
              <th>物料</th>
              <th>规格</th>
              <th>数量</th>
              <th>未入库</th>
              <th>单价</th>
              <th>金额</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(o => `
              <tr>
                <td><strong>${o.订单编号}</strong></td>
                <td>${o.日期 || '-'}</td>
                <td>${o.供应商 || '-'}</td>
                <td>${o.项目名称 || '-'}</td>
                <td>${o.存货名称 || '-'}</td>
                <td>${o.规格型号 || '-'}</td>
                <td>${o.数量}</td>
                <td>${o.未入库量 > 0 ? `<span class="tag tag-warning">${o.未入库量}</span>` : '0'}</td>
                <td>${this.formatMoney(o.原币含税单价)}</td>
                <td>${this.formatMoney(o.原币价税合计)}</td>
                <td>${o.审批状态 ? `<span class="tag ${o.审批状态 === '审批通过' ? 'tag-success' : 'tag-neutral'}">${o.审批状态}</span>` : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(items.length, totalPages);
    TableUtils.initSmartSelect('orderTableArea');
  },

  renderPagination(total, totalPages) {
    const page = this.currentPage;
    const html = [];
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>`);
    html.push(`<span class="page-btns">`);
    html.push(`<button onclick="OrdersModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="OrdersModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="OrdersModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="OrdersModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="OrdersModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="OrdersModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="orderPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')OrdersModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);

    document.getElementById('orderPagination').innerHTML = html.join('');
  },

  renderTrendChart(allOrders) {
    const card = document.getElementById('orderTrendCard');
    if (!card) return;
    card.style.display = 'block';

    const canvas = document.getElementById('orderTrendChart');
    if (!canvas) return;

    if (this._trendChart) { this._trendChart.destroy(); this._trendChart = null; }

    const ctx = canvas.getContext('2d');

    const now = new Date();
    const months = [];
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        year: d.getFullYear(),
        month: d.getMonth() + 1
      });
    }

    const monthData = months.map(m => {
      const matched = allOrders.filter(o => {
        if (!o.日期) return false;
        const d = new Date(o.日期);
        return d.getFullYear() === m.year && (d.getMonth() + 1) === m.month;
      });
      const uniqueNos = new Set(matched.map(o => o.订单编号).filter(Boolean));
      const amount = matched.reduce((s, o) => s + (parseFloat(o.原币价税合计) || 0), 0);
      return { count: uniqueNos.size, amount };
    });

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gridColor = isDark ? 'rgba(148,163,184,0.12)' : 'rgba(148,163,184,0.18)';
    const textColor = isDark ? '#94A3B8' : '#64748B';

    this._trendChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          {
            label: '订单数（去重）',
            data: monthData.map(d => d.count),
            borderColor: '#5B9BD5',
            backgroundColor: 'rgba(91,155,213,0.08)',
            borderWidth: 2,
            tension: 0.4,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#5B9BD5',
            yAxisID: 'y'
          },
          {
            label: '订单金额（万元）',
            data: monthData.map(d => +(d.amount / 10000).toFixed(2)),
            borderColor: '#D4A870',
            backgroundColor: 'rgba(212,168,112,0.06)',
            borderWidth: 2,
            tension: 0.4,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#D4A870',
            borderDash: [5, 3],
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: {
            position: 'top',
            labels: { color: textColor, font: { size: 11 }, usePointStyle: true, padding: 20 }
          },
          tooltip: {
            backgroundColor: isDark ? 'rgba(15,23,42,0.9)' : 'rgba(255,255,255,0.95)',
            titleColor: textColor,
            bodyColor: textColor,
            borderColor: 'rgba(148,163,184,0.2)',
            borderWidth: 1
          }
        },
        scales: {
          x: {
            grid: { color: gridColor },
            ticks: { color: textColor, font: { size: 11 } }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            title: { display: true, text: '订单数', color: textColor, font: { size: 11 } },
            grid: { color: gridColor },
            ticks: { color: textColor, font: { size: 11 } },
            beginAtZero: true
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            title: { display: true, text: '万元', color: textColor, font: { size: 11 } },
            grid: { drawOnChartArea: false },
            ticks: { color: textColor, font: { size: 11 } },
            beginAtZero: true
          }
        }
      }
    });
  },

  changePageSize(size) {
    this.pageSize = size;
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() {
    this.currentFilter = {
      keyword: document.getElementById('orderKw').value.trim(),
      供应商: document.getElementById('orderSupplier').value,
      项目名称: document.getElementById('orderProject').value,
      审批状态: document.getElementById('orderStatus').value,
      startDate: document.getElementById('orderStartDate')?.value || '',
      endDate: document.getElementById('orderEndDate')?.value || ''
    };
    this.currentPage = 1;
    this.loadData();
  },

  resetFilter() {
    this.currentFilter = {};
    this.currentPage = 1;
    this.pageSize = 20;
    this.render();
  },

  goPage(p) {
    this.currentPage = p;
    this.renderTable();
  },

  async exportData() {
    const result = await DataStore.getOrders(this.currentFilter, 1, 100000);
    if (result.items.length === 0) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(result.items);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '订单列表');
    XLSX.writeFile(wb, `订单列表_${new Date().toISOString().split('T')[0]}.xlsx`);
  },

  formatMoney(num) {
    if (!num) return '-';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  }
};
