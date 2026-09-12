// ============================================
// 订单列表模块 V3 - 统一表格 · 图表卡片并排 · 3D搜索按钮
// ============================================

const OrdersModule = {
  currentFilter: {},
  currentPage: 1,
  pageSize: AppConfig.app.defaultPageSize,

  // 计算默认订单日期区间：最小订单日期 至 今日
  getDefaultDateRange(orders) {
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    const end = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    let minDate = '';
    if (orders && orders.length > 0) {
      const dates = orders.map(o => o.日期).filter(Boolean).sort();
      if (dates.length > 0) minDate = dates[0];
    }
    return { start: minDate || end, end };
  },

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    const allOrders = await DataStore.getRows('orders');
    const suppliers = [...new Set(allOrders.map(o => o.供应商).filter(Boolean))].sort();
    const projects = [...new Set(allOrders.map(o => o.项目名称).filter(Boolean))].sort();
    const statuses = [...new Set(allOrders.map(o => o.审批状态).filter(Boolean))];

    // 首次进入：根据实际数据填充默认日期区间
    const dr = this.getDefaultDateRange(allOrders);
    if (!this.currentFilter) this.currentFilter = {};
    if (!this.currentFilter.startDate) this.currentFilter.startDate = dr.start;
    if (!this.currentFilter.endDate) this.currentFilter.endDate = dr.end;

    if (myToken !== undefined && myToken !== App._goToken) return;

    // 清理可能遗留的旧日期选择器弹窗（render 会重建 input）
    if (typeof DatePicker !== 'undefined') DatePicker.unmountAll();

    content.innerHTML = `
      <div class="filter-bar filter-bar-m" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;padding:0;align-items:stretch;">
        <div class="filter-row filter-row-main" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0;padding:0;">
          <input type="text" id="orderKw" class="filter-search-short" placeholder="搜索订单编号、供应商、存货名称..." value="${escAttr(this.currentFilter.keyword || '')}" onkeydown="if(event.key==='Enter')OrdersModule.applyFilter()">
          <div class="filter-row-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:4px;">
            <input type="text" id="orderStartDate" value="${escAttr(this.currentFilter.startDate || '')}" class="filter-date dp-input" placeholder="起始日期" title="起始日期" onchange="OrdersModule.onDateChange()" readonly>
            <span class="filter-sep">至</span>
            <input type="text" id="orderEndDate" value="${escAttr(this.currentFilter.endDate || '')}" class="filter-date dp-input" placeholder="结束日期" title="结束日期" onchange="OrdersModule.onDateChange()" readonly>
          </div>
          <div class="filter-row-selects" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0;padding:0;">
            <select id="orderSupplier" title="按供应商筛选" style="min-width:120px;flex:1 1 140px;max-width:220px;">
              <option value="">全部供应商</option>
              ${suppliers.map(s => `<option value="${escAttr(s)}" ${this.currentFilter.供应商 === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
            <select id="orderProject" title="按项目筛选" style="min-width:120px;flex:1 1 140px;max-width:300px;">
              <option value="">全部项目</option>
              ${projects.map(p => `<option value="${escAttr(p)}" ${this.currentFilter.项目名称 === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
            </select>
            <select id="orderStatus" title="按审批状态筛选" style="min-width:110px;flex:0 0 auto;">
              <option value="">全部状态</option>
              ${statuses.map(s => `<option value="${escAttr(s)}" ${this.currentFilter.审批状态 === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
          </div>
          <div class="filter-row-buttons" style="display:flex;gap:6px;margin-left:auto;">
            <button class="btn--primary" onclick="OrdersModule.applyFilter()">筛选</button>
            <button class="btn--ghost" onclick="OrdersModule.resetFilter()">重置</button>
            <button class="btn--ghost" onclick="OrdersModule.exportData()">📥 导出</button>
          </div>
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

    if (window.enhanceSearchSelect) {
      enhanceSearchSelect('orderSupplier', { placeholder: '搜索供应商', widthMode: 'full' });
      enhanceSearchSelect('orderProject', { placeholder: '搜索项目', widthMode: 'half' });
    }

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const allOrders = await DataStore.getRows('orders');

    // ===== 先应用当前筛选条件到全量数据（用于统计和图表）=====
    let filteredOrders = this._applyFilters(allOrders);

    // 订单总数：按订单编号去重（基于筛选后数据）
    const uniqueOrderNos = new Set(filteredOrders.map(o => o.订单编号).filter(Boolean));
    const uniqueTotal = uniqueOrderNos.size;

    const unapproved = filteredOrders.filter(o => o.审批状态 && o.审批状态 !== '审批通过');
    const unapprovedUnique = new Set(unapproved.map(o => o.订单编号).filter(Boolean)).size;

    const uninbound = filteredOrders.filter(o => parseFloat(o.未入库量) > 0);
    const uninboundUnique = new Set(uninbound.map(o => o.订单编号).filter(Boolean)).size;

    const totalAmount = TableUtils.sumMoney(filteredOrders, '原币价税合计'); // 🟢 AUDIT-003 整数分聚合

    if (rt !== undefined && rt !== App._goToken) return;
    document.getElementById('orderSummary').innerHTML = `
      <div class="kpi-card card-info">
        <div class="kpi-label">订单总数</div>
        <div class="kpi-value">${uniqueTotal}</div>
        <div class="kpi-sub">总金额 ¥${TableUtils.formatMoney(totalAmount)}</div>
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

    await this.renderTable(rt);
    this.renderTrendChart(filteredOrders);

    // 挂载自定义日期选择器（替换原生 type=date，保持 id 与 change 事件不变）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.mount('orderStartDate');
      DatePicker.mount('orderEndDate');
    }
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

  async renderTable(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const result = await DataStore.getOrders(this.currentFilter, this.currentPage, this.pageSize);
    let { items, total, totalPages } = result;
    this.currentPage = Math.min(this.currentPage, Math.max(1, totalPages || 1));

    // 填充存货编码（双路取码，详见 DataLoader.fillStockCode）
    if (items.length > 0 && typeof DataLoader !== 'undefined') {
      let codeMap = null;
      if (DataLoader.getStockNameSpecCodeMap) {
        try { codeMap = await DataLoader.getStockNameSpecCodeMap(); } catch (e) { codeMap = null; }
      }
      items.forEach(o => DataLoader.fillStockCode(o, codeMap));
    }

    if (rt !== undefined && rt !== App._goToken) return;
    const area = document.getElementById('orderTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无订单数据</div></div>';
      document.getElementById('orderPagination').innerHTML = '';
      return;
    }

    // 🟢 v228.09 性能优化 P1-4：拆出「表头」与「行模板」。
    //   行数 >150（如「每页=全部」的 2394 行）时由 virtualTable 只渲染视口附近的行，
    //   DOM 节点从 ~4.6 万降到数百；默认 20/50 条分页仍走整表渲染，输出与改动前完全一致。
    const thead = `
            <tr>
              <th>订单编号</th>
              <th>日期</th>
              <th>供应商</th>
              <th>项目</th>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>订单量</th>
              <th style="width:80px;">未入库订单量</th>
              <th>含税单价</th>
              <th>含税金额</th>
              <th>状态</th>
            </tr>`;
    const rowHtml = (o) => `
              <tr>
                <td><strong>${TableUtils.link('order', o.订单编号 ?? '', o.订单编号 ?? '')}</strong></td>
                <td>${esc(o.日期 ?? '')}</td>
                <td>${TableUtils.link('supplier', o.供应商 ?? '', o.供应商 ?? '')}</td>
                <td>${esc(o.项目名称 ?? '')}</td>
                <td>${TableUtils.link('stock', o._存货编码 ?? '', o._存货编码 ?? '')}</td>
                <td><strong>${esc(o.存货名称 ?? '')}</strong></td>
                <td>${esc(o.规格型号 ?? '')}</td>
                <td>${o.数量}</td>
                <td>${parseFloat(o.未入库量) > 0 ? `<span class="tag tag-warning">${o.未入库量}</span>` : '0'}</td>
                <td>${TableUtils.formatMoney(o.原币含税单价)}</td>
                <td>${TableUtils.formatMoney(o.原币价税合计)}</td>
                <td>${o.审批状态 ? `<span class="tag ${o.审批状态 === '审批通过' ? 'tag-success' : 'tag-neutral'}">${esc(o.审批状态)}</span>` : ''}</td>
              </tr>`;
    TableUtils.virtualTable(area, { items, rowHtml, thead, tableAttrs: 'data-table-key="orders"', threshold: 150 });

    this.renderPagination(total, totalPages);
    TableUtils.initSmartSelect('orderTableArea');
    TableUtils.initSortableHeaders('orderTableArea');
  },

  renderPagination(total, totalPages) {
    TableUtils.renderPagination('orderPagination', { module: 'OrdersModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });
  },

  // 🟢 v228.08：Chart 改为按需加载 —— 本函数升级为 async，先加载 chart 组件再绘制。
  //   调用点无需 await：图表异步补上，加载失败仅跳过图表、不影响列表主流程。
  async renderTrendChart(allOrders) {
    const card = document.getElementById('orderTrendCard');
    if (!card) return;
    card.style.display = 'block';


    // 🟢 v228.08：chart.min.js 不再随首屏预载，首次绘制前动态加载
    try { await LazyLib.chart(); }
    catch (e) { console.warn('[orders] 图表组件加载失败，已跳过趋势图:', e && e.message); return; }
    // 在 await 之后再取 canvas：若期间 DOM 被重建，取到的是最新元素，不会因旧引用失效而误跳过
    const canvas = document.getElementById('orderTrendChart');
    if (!canvas) return;
    if (typeof Chart === 'undefined') return;

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
      const amount = TableUtils.sumMoney(matched, '原币价税合计'); // 🟢 AUDIT-003 整数分聚合
      return { count: uniqueNos.size, amount };
    });

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const gridColor = isDark ? 'rgba(148,163,184,0.12)' : 'rgba(148,163,184,0.18)';
    const textColor = TableUtils.chartTextColor(isDark);

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

  onDateChange() {
    const startInput = document.getElementById('orderStartDate');
    const endInput = document.getElementById('orderEndDate');
    if (startInput) this.currentFilter.startDate = startInput.value;
    if (endInput) this.currentFilter.endDate = endInput.value;
    this.currentPage = 1;
    this.loadData();
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
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

  async resetFilter() {
    const allOrders = await DataStore.getRows('orders');
    const dr = this.getDefaultDateRange(allOrders);
    this.currentFilter = { keyword: '', 供应商: '', 项目名称: '', 审批状态: '', startDate: dr.start, endDate: dr.end };
    this.currentPage = 1;
    this.pageSize = AppConfig.app.defaultPageSize;
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
  }
};
