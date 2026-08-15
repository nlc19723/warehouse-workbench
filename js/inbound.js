// ============================================
// 入库列表模块 V3 - 统一表格 · 图表卡片并排 · 3D搜索按钮
// ============================================

const InboundModule = {
  currentFilter: {},
  currentPage: 1,
  pageSize: 20,

  async render() {
    const content = document.getElementById('contentArea');
    const [suppliers, projects] = await Promise.all([
      (async () => {
        const all = await db.inbound.toArray();
        return [...new Set(all.map(i => i.供应商).filter(Boolean))].sort();
      })(),
      (async () => {
        const all = await db.inbound.toArray();
        return [...new Set(all.map(i => i.项目名称).filter(Boolean))].sort();
      })()
    ]);

    content.innerHTML = `
      <div class="filter-bar filter-bar-two-row" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;padding:0;">
        <div class="filter-row filter-row-main" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0;padding:0;">
          <input type="text" id="inboundKw" class="filter-search-short" placeholder="搜索入库单号、供应商、物料..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')InboundModule.applyFilter()">
          <div class="filter-row-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:4px;">
            <input type="date" id="inboundStartDate" value="${this.currentFilter.startDate || ''}" class="filter-date" title="起始日期">
            <span class="filter-sep">至</span>
            <input type="date" id="inboundEndDate" value="${this.currentFilter.endDate || ''}" class="filter-date" title="结束日期">
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

    await this.loadData();
  },

  async loadData() {
    const allInbound = await db.inbound.toArray();

    // ===== 先应用当前筛选条件（用于统计和图表）=====
    let filteredInbound = this._applyFilters(allInbound);

    const uniqueInboundNos = new Set(filteredInbound.map(i => i.入库单号).filter(Boolean));
    const uniqueCount = uniqueInboundNos.size;
    const totalAmount = filteredInbound.reduce((s, i) => s + (parseFloat(i.原币价税合计) || 0), 0);
    const totalQty = filteredInbound.reduce((s, i) => s + (parseFloat(i.数量) || 0), 0);

    document.getElementById('inboundSummary').innerHTML = `
      <div class="kpi-card card-info">
        <div class="kpi-label">入库单数</div>
        <div class="kpi-value">${uniqueCount}</div>
        <div class="kpi-sub">总记录 ${allInbound.length} 条</div>
      </div>
      <div class="kpi-card card-success">
        <div class="kpi-label">入库总金额</div>
        <div class="kpi-value">¥${this.formatMoney(totalAmount)}</div>
        <div class="kpi-sub">总数量 ${this.formatNum(totalQty)}</div>
      </div>
      <div class="kpi-card card-info">
        <div class="kpi-label">入库供应商</div>
        <div class="kpi-value">${[...new Set(allInbound.map(i => i.供应商).filter(Boolean))].length}</div>
        <div class="kpi-sub">涉及项目 ${[...new Set(allInbound.map(i => i.项目名称).filter(Boolean))].length} 个</div>
      </div>
    `;

    this.allInbound = allInbound;
    this.currentPage = 1;
    this.renderTable();
    this.renderTrendChart(filteredInbound);
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
          (i.入库单号 && String(i.入库单号).toLowerCase().includes(kw)) ||
          (i.供应商 && i.供应商.toLowerCase().includes(kw)) ||
          (i.存货名称 && i.存货名称.toLowerCase().includes(kw))
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

  async renderTable() {
    const result = await DataStore.getInbound(this.currentFilter, this.currentPage, this.pageSize);
    const { items, totalPages } = result;

    const area = document.getElementById('inboundTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无入库数据</div></div>';
      document.getElementById('inboundPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>入库日期</th>
              <th>入库单号</th>
              <th>供应商</th>
              <th>项目</th>
              <th>存货编码</th>
              <th>物料</th>
              <th>规格</th>
              <th>数量</th>
              <th>含税单价</th>
              <th>金额</th>
              <th>税率</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(i => `
              <tr>
                <td>${esc(i.入库日期 || '-')}</td>
                <td><strong>${esc(i.入库单号 || '-')}</strong></td>
                <td>${esc(i.供应商 || '-')}</td>
                <td>${esc(i.项目名称 || '-')}</td>
                <td>${esc(i.存货编码 || '-')}</td>
                <td>${esc(i.存货名称 || '-')}</td>
                <td>${esc(i.规格型号 || '-')}</td>
                <td>${i.数量}</td>
                <td>${this.formatMoney(i.原币含税单价)}</td>
                <td>${this.formatMoney(i.原币价税合计)}</td>
                <td>${i.税率 ? esc(i.税率) + '%' : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(items.length, totalPages);
    TableUtils.initSmartSelect('inboundTableArea');
    TableUtils.initSortableHeaders('inboundTableArea', this.currentData || [], (sorted) => {
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
    html.push(`<button onclick="InboundModule.goPage(1)" ${page === 1 ? 'disabled' : ''}>«</button>`);
    html.push(`<button onclick="InboundModule.goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`);
    const start = Math.max(1, page - 2);
    const end = Math.min(totalPages, start + 4);
    for (let i = start; i <= end; i++) {
      html.push(`<button class="${i === page ? 'active' : ''}" onclick="InboundModule.goPage(${i})">${i}</button>`);
    }
    html.push(`<button onclick="InboundModule.goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`);
    html.push(`<button onclick="InboundModule.goPage(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>`);
    html.push(`</span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      每页 <select onchange="InboundModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
        <option value="20" ${this.pageSize===20?'selected':''}>20</option>
        <option value="50" ${this.pageSize===50?'selected':''}>50</option>
        <option value="100" ${this.pageSize===100?'selected':''}>100</option>
      </select> 条
    </span>`);

    html.push(`<span style="font-size:12px;color:var(--text-secondary);">
      跳至 <input type="number" id="inboundPageJumper" min="1" max="${totalPages}" value="${page}"
        onkeydown="if(event.key==='Enter')InboundModule.goPage(parseInt(this.value))"
        style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
      / ${totalPages} 页
    </span>`);

    document.getElementById('inboundPagination').innerHTML = html.join('');
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
    const textColor = isDark ? '#94A3B8' : '#64748B';

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
    this.pageSize = size;
    this.currentPage = 1;
    this.renderTable();
  },

  applyFilter() {
    this.currentFilter = {
      keyword: document.getElementById('inboundKw').value.trim(),
      供应商: document.getElementById('inboundSupplier').value,
      项目名称: document.getElementById('inboundProject').value,
      startDate: document.getElementById('inboundStartDate')?.value || '',
      endDate: document.getElementById('inboundEndDate')?.value || ''
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

  goPage(p) { this.currentPage = p; this.renderTable(); },

  async exportData() {
    const result = await DataStore.getInbound(this.currentFilter, 1, 100000);
    if (result.items.length === 0) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(result.items);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '入库列表');
    XLSX.writeFile(wb, `入库列表_${new Date().toISOString().split('T')[0]}.xlsx`);
  },

  formatNum(num) {
    return new Intl.NumberFormat('zh-CN').format(Math.round(num));
  },

  formatMoney(num) {
    if (!num) return '-';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  }
};
