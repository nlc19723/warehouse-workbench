// ============================================
// 入库列表模块 V3 - 统一表格 · 图表卡片并排 · 3D搜索按钮
// ============================================

const InboundModule = {
  currentFilter: {},
  currentPage: 1,
  pageSize: 20,

  // 默认固定日期区间：3 个月前的 1 号 → 今日（按本地时区格式化）
  getDefaultDateRange() {
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    const end = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const start = new Date(today.getFullYear(), today.getMonth() - 3, 1);
    const startStr = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    return { start: startStr, end };
  },

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');

    // 清理可能遗留的旧日期选择器弹窗（render 会重建 input）
    if (typeof DatePicker !== 'undefined') DatePicker.unmountAll();
    // 🟢 O6：只查一次全表，后续统计/图表/表格都复用缓存，避免重复 IO
    const allInbound = await DataStore.getRows('inbound');
    this._allInbound = allInbound;
    const [suppliers, projects] = await Promise.all([
      Promise.resolve([...new Set(allInbound.map(i => i.供应商).filter(Boolean))].sort()),
      Promise.resolve([...new Set(allInbound.map(i => i.项目名称).filter(Boolean))].sort())
    ]);

    // 初始化固定日期区间（若尚未设置）
    const dr = this.getDefaultDateRange();
    if (!this.currentFilter) this.currentFilter = {};
    if (!this.currentFilter.startDate) this.currentFilter.startDate = dr.start;
    if (!this.currentFilter.endDate) this.currentFilter.endDate = dr.end;

    if (myToken !== undefined && myToken !== App._goToken) return;

    content.innerHTML = `
      <div class="filter-bar filter-bar-two-row" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;padding:0;">
        <div class="filter-row filter-row-main" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0;padding:0;">
          <input type="text" id="inboundKw" class="filter-search-short" placeholder="搜索订单编号、入库单号、供应商、物料..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')InboundModule.applyFilter()">
          <div class="filter-row-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:4px;">
            <input type="text" id="inboundStartDate" value="${this.currentFilter.startDate || ''}" class="filter-date dp-input" placeholder="起始日期" title="起始日期" onchange="InboundModule.onDateChange()" readonly>
            <span class="filter-sep">至</span>
            <input type="text" id="inboundEndDate" value="${this.currentFilter.endDate || ''}" class="filter-date dp-input" placeholder="结束日期" title="结束日期" onchange="InboundModule.onDateChange()" readonly>
          </div>
          <div class="filter-row-buttons" style="display:flex;gap:6px;">
            <button class="search-glass" onclick="InboundModule.applyFilter()">筛选</button>
            <button class="secondary" onclick="InboundModule.resetFilter()">重置</button>
            <button class="secondary" onclick="InboundModule.exportData()">📥 导出</button>
          </div>
        </div>
        <div class="filter-row filter-row-selects" style="display:flex;gap:10px;margin:0;padding:0;">
          <select id="inboundSupplier" title="按供应商筛选">
            <option value="">全部供应商</option>
            ${suppliers.map(s => `<option value="${s}" ${this.currentFilter.供应商 === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <select id="inboundProject" title="按项目筛选">
            <option value="">全部项目</option>
            ${projects.map(p => `<option value="${p}" ${this.currentFilter.项目名称 === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- 趋势图 + 统计卡片并排（图表占宽，统计卡片紧凑） -->
      <div class="chart-stats-row">
        <div class="stats-col" id="inboundSummary"></div>
        <div class="chart-col">
          <div class="glass-card" id="inboundTrendCard" style="display:none;height:100%;margin-bottom:0;">
            <div class="glass-card-header">
              <span class="glass-card-title"><span class="title-icon">📈</span>近六月入库趋势</span>
            </div>
            <div class="chart-container-sm">
              <canvas id="inboundTrendChart"></canvas>
            </div>
          </div>
        </div>
      </div>

      <div id="inboundTableArea"></div>
      <div id="inboundPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    if (window.enhanceSearchSelect) {
      enhanceSearchSelect('inboundSupplier', { placeholder: '搜索供应商', widthMode: 'full' });
      enhanceSearchSelect('inboundProject', { placeholder: '搜索项目', widthMode: 'half' });
    }

    // 挂载自定义日期选择器（替换原生 type=date，保持 id 与 change 事件不变）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.mount('inboundStartDate');
      DatePicker.mount('inboundEndDate');
    }

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const allInbound = this._allInbound || await DataStore.getRows('inbound');

    // ===== 先应用当前筛选条件（用于统计和图表）=====
    let filteredInbound = this._applyFilters(allInbound);

    const uniqueInboundNos = new Set(filteredInbound.map(i => i.入库单号).filter(Boolean));
    const uniqueCount = uniqueInboundNos.size;
    const totalAmount = filteredInbound.reduce((s, i) => s + (parseFloat(i.原币价税合计) || 0), 0);
    const totalQty = filteredInbound.reduce((s, i) => s + (parseFloat(i.数量) || 0), 0);
    const supplierCount = [...new Set(allInbound.map(i => i.供应商).filter(Boolean))].length;
    const projectCount = [...new Set(allInbound.map(i => i.项目名称).filter(Boolean))].length;

    // 先渲染表格和趋势图，再把统计卡片统一写入，避免 KPI 先单独闪现
    this.currentData = filteredInbound;
    await this.renderTable(rt);
    this.renderTrendChart(filteredInbound);

    if (rt !== undefined && rt !== App._goToken) return;
    const summary = document.getElementById('inboundSummary');
    if (summary) summary.innerHTML = `
      <div class="kpi-card card-info">
        <div class="kpi-label">入库单数</div>
        <div class="kpi-value">${uniqueCount}</div>
        <div class="kpi-sub">总记录 ${allInbound.length} 条</div>
      </div>
      <div class="kpi-card card-success">
        <div class="kpi-label">入库总金额</div>
        <div class="kpi-value">¥${TableUtils.formatMoney(totalAmount)}</div>
        <div class="kpi-sub">总数量 ${TableUtils.formatNum(totalQty)}</div>
      </div>
      <div class="kpi-card card-info">
        <div class="kpi-label">入库供应商</div>
        <div class="kpi-value">${supplierCount}</div>
        <div class="kpi-sub">涉及项目 ${projectCount} 个</div>
      </div>
    `;
  },

  // 内部筛选：复用 currentFilter 逻辑
  _applyFilters(inbound) {
    let result = inbound;
    const f = this.currentFilter;
    if (f) {
      if (f.供应商) result = result.filter(i => i.供应商 === f.供应商);
      if (f.项目名称) result = result.filter(i => i.项目名称 === f.项目名称);
      if (f.keyword) {
        const kw = f.keyword.toLowerCase();
        result = result.filter(i =>
          (i.入库单号 && String(i.入库单号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
          (i.表体订单号 && String(i.表体订单号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
          (i.供应商 && i.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
          (i.存货名称 && i.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw))
        );
      }
      if (f.startDate || f.endDate) {
        result = result.filter(i => {
          if (!i.入库日期) return false;
          if (f.startDate && i.入库日期 < f.startDate) return false;
          if (f.endDate && i.入库日期 > f.endDate) return false;
          return true;
        });
      }
    }
    return result;
  },

  async renderTable(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;

    const data = this.currentData || [];
    const total = data.length;
    const pageSize = this.pageSize === 'all' ? total : this.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    this.currentPage = page;
    const items = data.slice((page - 1) * pageSize, page * pageSize);

    if (rt !== undefined && rt !== App._goToken) return;
    const area = document.getElementById('inboundTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无入库数据</div></div>';
      document.getElementById('inboundPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table" data-table-key="inbound">
          <thead>
            <tr>
              <th>订单编号</th>
              <th>入库日期</th>
              <th>入库单号</th>
              <th>供应商</th>
              <th>项目</th>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>入库量</th>
              <th>含税单价</th>
              <th>含税金额</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(i => `
              <tr>
                <td>${(() => { const v = (i.表体订单号 ?? '').toString().trim(); return v ? TableUtils.link('order', v, v) : ''; })()}</td>
                <td>${esc(i.入库日期 ?? '')}</td>
                <td><strong>${esc(i.入库单号 ?? '')}</strong></td>
                <td>${TableUtils.link('supplier', i.供应商 ?? '', i.供应商 ?? '')}</td>
                <td>${esc(i.项目名称 ?? '')}</td>
                <td>${TableUtils.link('stock', i.存货编码 ?? '', i.存货编码 ?? '')}</td>
                <td><strong>${esc(i.存货名称 ?? '')}</strong></td>
                <td>${esc(i.规格型号 ?? '')}</td>
                <td>${i.数量}</td>
                <td>${TableUtils.formatMoney(i.原币含税单价)}</td>
                <td>${TableUtils.formatMoney(i.原币价税合计)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(total, totalPages);
    TableUtils.initSmartSelect('inboundTableArea');
    TableUtils.initSortableHeaders('inboundTableArea');
  },

  renderPagination(total, totalPages) {
    TableUtils.renderPagination('inboundPagination', { module: 'InboundModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });
  },

  renderTrendChart(allInbound) {
    const card = document.getElementById('inboundTrendCard');
    if (!card) return;
    card.style.display = 'block';

    const canvas = document.getElementById('inboundTrendChart');
    if (!canvas) return;

    if (this._trendChart) { this._trendChart.destroy(); this._trendChart = null; }

    const ctx = canvas.getContext('2d');

    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        year: d.getFullYear(),
        month: d.getMonth() + 1
      });
    }

    const monthData = months.map(m => {
      const matched = allInbound.filter(i => {
        if (!i.入库日期) return false;
        const d = new Date(i.入库日期);
        return d.getFullYear() === m.year && (d.getMonth() + 1) === m.month;
      });
      const uniqueNos = new Set(matched.map(i => i.入库单号).filter(Boolean));
      const amount = matched.reduce((s, i) => s + (parseFloat(i.原币价税合计) || 0), 0);
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
            label: '入库单数',
            data: monthData.map(d => d.count),
            borderColor: '#6DBF9F',
            backgroundColor: 'rgba(109,191,159,0.08)',
            borderWidth: 2,
            tension: 0.4,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#6DBF9F',
            yAxisID: 'y'
          },
          {
            label: '入库金额（万元）',
            data: monthData.map(d => +(d.amount / 10000).toFixed(2)),
            borderColor: '#5B9BD5',
            backgroundColor: 'rgba(91,155,213,0.06)',
            borderWidth: 2,
            tension: 0.4,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#5B9BD5',
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
            title: { display: true, text: '入库单数', color: textColor, font: { size: 11 } },
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
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.currentPage = 1;
    this.renderTable();
  },

  onDateChange() {
    const start = document.getElementById('inboundStartDate')?.value || '';
    const end = document.getElementById('inboundEndDate')?.value || '';
    if (!this.currentFilter) this.currentFilter = {};
    this.currentFilter.startDate = start;
    this.currentFilter.endDate = end;
    this.currentPage = 1;
    this.loadData();
  },

  applyFilter() {
    this.currentFilter = {
      keyword: (document.getElementById('inboundKw').value.trim() || '').replace(/\s+/g, ''),
      供应商: document.getElementById('inboundSupplier').value,
      项目名称: document.getElementById('inboundProject').value,
      startDate: document.getElementById('inboundStartDate')?.value || '',
      endDate: document.getElementById('inboundEndDate')?.value || ''
    };
    this.currentPage = 1;
    this.loadData();
  },

  resetFilter() {
    const dr = this.getDefaultDateRange();
    this.currentFilter = { startDate: dr.start, endDate: dr.end };
    this.currentPage = 1;
    this.pageSize = 20;
    this.render();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  async exportData() {
    const result = await DataStore.getInbound(this.currentFilter, 1, 100000);
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(result.items, `入库列表_${new Date().toISOString().split('T')[0]}.xlsx`, '入库列表');
  },

};
