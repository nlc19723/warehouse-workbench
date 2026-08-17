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
      <div class="filter-bar" style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px;padding:0;align-items:flex-start;">
        <div class="filter-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0;padding:0;">
          <input type="text" id="orderKw" class="filter-search-short" placeholder="搜索订单编号、供应商、存货名称..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')OrdersModule.applyFilter()">
          <input type="date" id="orderStartDate" value="${this.currentFilter.startDate || ''}" class="filter-date" title="起始日期">
          <span class="filter-sep">至</span>
          <input type="date" id="orderEndDate" value="${this.currentFilter.endDate || ''}" class="filter-date" title="结束日期">
          <button class="search-glass" onclick="OrdersModule.applyFilter()">筛选</button>
          <button class="secondary" onclick="OrdersModule.resetFilter()">重置</button>
          <button class="secondary" onclick="OrdersModule.exportData()">📥 导出</button>
        </div>
        <div class="filter-row" style="display:flex;gap:10px;margin:0;padding:0;">
          <select id="orderSupplier" title="按供应商筛选" style="max-width:200px;">
            <option value="">全部供应商</option>
            ${suppliers.map(s => `<option value="${s}" ${this.currentFilter.供应商 === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <select id="orderProject" title="按项目筛选" style="max-width:300px;">
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

    // ===== 先应用当前筛选条件到全量数据（用于统计和图表）=====
    let filteredOrders = this._applyFilters(allOrders);

    // 订单总数：按订单编号去重（基于筛选后数据）
    const uniqueOrderNos = new Set(filteredOrders.map(o => o.订单编号).filter(Boolean));
    const uniqueTotal = uniqueOrderNos.size;

    const unapproved = filteredOrders.filter(o => o.审批状态 && o.审批状态 !== '审批通过');
    const unapprovedUnique = new Set(unapproved.map(o => o.订单编号).filter(Boolean)).size;

    const uninbound = filteredOrders.filter(o => parseFloat(o.未入库量) > 0);
    const uninboundUnique = new Set(uninbound.map(o => o.订单编号).filter(Boolean)).size;

    const totalAmount = filteredOrders.reduce((s, o) => s + (parseFloat(o.原币价税合计) || 0), 0);

    document.getElementById('orderSummary').innerHTML = `
      <div class="kpi-card card-info">
        <div class="kpi-label">订单总数</div>
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

    this.currentPage = 1;
    this.renderTable();
    this.renderTrendChart(filteredOrders);
  },

  // 内部筛选：复用 currentFilter 逻辑（与 DataStore.getOrders 一致）
  _applyFilters(orders) {
    let result = orders;
    const f = this.currentFilter;
    if (f) {
      if (f.供应商) result = result.filter(o => o.供应商 === f.供应商);
      if (f.项目名称) result = result.filter(o => o.项目名称 === f.项目名称);
      if (f.审批状态) result = result.filter(o => o.审批状态 === f.审批状态);
      if (f.keyword) {
        const kw = f.keyword.toLowerCase().replace(/\s+/g, '');
        result = result.filter(o =>
          (o.订单编号 && o.订单编号.toLowerCase().includes(kw)) ||
          (o.供应商 && o.供应商.toLowerCase().includes(kw)) ||
          (o.存货名称 && o.存货名称.toLowerCase().includes(kw))
        );
      }
      if (f.startDate || f.endDate) {
        result = result.filter(o => {
          if (!o.日期) return false;
          if (f.startDate && o.日期 < f.startDate) return false;
          if (f.endDate && o.日期 > f.endDate) return false;
          return true;
        });
      }
    }
    return result;
  },

  async renderTable() {
    const result = await DataStore.getOrders(this.currentFilter, this.currentPage, this.pageSize);
    let { items, totalPages } = result;

    // 从现存量基础档案匹配填充存货编码
    if (typeof DataLoader !== 'undefined' && items.length > 0) {
      const codeMap = await DataLoader.getStockNameSpecCodeMap();
      items.forEach(o => {
        if (o.存货名称) {
          const key = (o.存货名称 + '|' + (o.规格型号 || '')).replace(/\s+/g, '');
          o._存货编码 = codeMap.get(key) || '';
        }
      });
    }

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
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>订单量</th>
              <th>未入库订单量</th>
              <th>含税单价</th>
              <th>含税金额</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(o => `
              <tr>
                <td><strong>${esc(o.订单编号)}</strong></td>
                <td>${esc(o.日期 ?? '')}</td>
                <td>${esc(o.供应商 ?? '')}</td>
                <td>${esc(o.项目名称 ?? '')}</td>
                <td>${esc(o._存货编码 ?? '')}</td>
                <td>${esc(o.存货名称 ?? '')}</td>
                <td>${esc(o.规格型号 ?? '')}</td>
                <td>${o.数量}</td>
                <td>${parseFloat(o.未入库量) > 0 ? `<span class="tag tag-warning">${o.未入库量}</span>` : '0'}</td>
                <td>${this.formatMoney(o.原币含税单价)}</td>
                <td>${this.formatMoney(o.原币价税合计)}</td>
                <td>${o.审批状态 ? `<span class="tag ${o.审批状态 === '审批通过' ? 'tag-success' : 'tag-neutral'}">${esc(o.审批状态)}</span>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(items.length, totalPages);
    TableUtils.initSmartSelect('orderTableArea');
    TableUtils.initSortableHeaders('orderTableArea', this.currentData || [], (sorted) => {
      this.currentData = sorted;
      this.currentPage = 1;
      this.renderTable();
    });
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
            label: '订单数',
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
      keyword: (document.getElementById('orderKw').value.trim() || '').replace(/\s+/g, ''),
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
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(result.items, `订单列表_${new Date().toISOString().split('T')[0]}.xlsx`, '订单列表');
  },

  formatMoney(num) {
    if (num == null || num === '') return '';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  }
};
