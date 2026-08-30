// ============================================
// 对账功能模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const ReconciliationModule = {
  suppliers: [],
  currentFilter: {},
  currentPage: 1,
  pageSize: AppConfig.app.defaultPageSize,
  currentData: [],
  trendChart: null,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    this.suppliers = await DataStore.getOrderSuppliers();
    if (myToken !== undefined && myToken !== App._goToken) return;

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

    const saved = this.currentFilter || {};
    const startDate = saved.startDate || defaultStart;
    const endDate = saved.endDate || defaultEnd;
    const supplier = saved.supplier || '';

    const content = document.getElementById('contentArea');

    // 清理可能遗留的旧日期选择器弹窗（render 会重建 input）
    if (typeof DatePicker !== 'undefined') DatePicker.unmountAll();

    content.innerHTML = `
      <div class="filter-bar">
        <select id="recSupplier">
          <option value="">选择供应商</option>
          ${this.suppliers.map(s => `<option value="${escAttr(s)}" ${supplier === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select>
        <input type="text" id="recStartDate" value="${escAttr(startDate)}" class="dp-input" placeholder="起始日期" readonly>
        <span style="color:var(--text-secondary);">至</span>
        <input type="text" id="recEndDate" value="${escAttr(endDate)}" class="dp-input" placeholder="结束日期" readonly>
        <button class="glass-btn-3d" onclick="ReconciliationModule.shiftPrevMonth()" title="把两个日期的月份都 -1 并自动查询">📅 上个月</button>
        <button class="glass-btn-3d" onclick="ReconciliationModule.shiftNextMonth()" title="把两个日期的月份都 +1 并自动查询">📅 下个月</button>
        <button class="search-glass" onclick="ReconciliationModule.applyFilter()">查询</button>
        <button class="secondary" onclick="ReconciliationModule.exportData()">📥 导出</button>
      </div>

      <div id="recSummary"></div>
      <div id="recTableArea"></div>
      <div id="recPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    if (window.enhanceSearchSelect) {
      enhanceSearchSelect('recSupplier', { placeholder: '搜索供应商', widthMode: 'full' });
    }

    // 挂载自定义日期选择器（替换原生 type=date，保持 id 与 change 事件不变）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.mount('recStartDate');
      DatePicker.mount('recEndDate');
    }

    await this.applyFilter(myToken);
  },

  // 把左边两个日期的月份都 +1 并立即查询（跨年自动进位；超出月末自动夹紧）
  shiftNextMonth() {
    ['recStartDate', 'recEndDate'].forEach(id => {
      const el = document.getElementById(id);
      if (!el || !el.value) return;
      const d = new Date(el.value + 'T00:00:00');
      if (isNaN(d.getTime())) return;
      // 月份 +1，跨年自动进位；JS new Date(y, m, day) 当 day 越界会自动进位到下月，
      // 故先取下月最后一天作为"上限日"，再用 min(原日, 上限) 达到月末夹紧。
      const targetYear = d.getFullYear() + Math.floor((d.getMonth() + 1) / 12);
      const targetMonth0 = (d.getMonth() + 1) % 12;       // 0~11
      const lastDayOfTarget = new Date(targetYear, targetMonth0 + 1, 0).getDate();
      const finalDay = Math.min(d.getDate(), lastDayOfTarget);
      el.value = `${targetYear}-${String(targetMonth0 + 1).padStart(2,'0')}-${String(finalDay).padStart(2,'0')}`;
    });

    this.applyFilter();
  },

  // 把左边两个日期的月份都 -1 并立即查询（跨年自动进位；超出月末自动夹紧）
  shiftPrevMonth() {
    ['recStartDate', 'recEndDate'].forEach(id => {
      const el = document.getElementById(id);
      if (!el || !el.value) return;
      const d = new Date(el.value + 'T00:00:00');
      if (isNaN(d.getTime())) return;
      // 月份 -1，跨年自动进位（1月→上年12月）；同样先取下月最后一天作上限夹紧月末。
      const targetYear = d.getFullYear() + Math.floor((d.getMonth() - 1) / 12); // getMonth()=0(1月)→-1年
      const targetMonth0 = (d.getMonth() + 11) % 12;     // 0~11，上个月
      const lastDayOfTarget = new Date(targetYear, targetMonth0 + 1, 0).getDate();
      const finalDay = Math.min(d.getDate(), lastDayOfTarget);
      el.value = `${targetYear}-${String(targetMonth0 + 1).padStart(2,'0')}-${String(finalDay).padStart(2,'0')}`;
    });
    this.applyFilter();
  },

  async applyFilter(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const supplier = document.getElementById('recSupplier').value;
    const startDate = document.getElementById('recStartDate').value;
    const endDate = document.getElementById('recEndDate').value;

    this.currentFilter = { supplier, startDate, endDate };
    this.currentPage = 1;

    let inbound = await DataStore.getRows('inbound');

    // 供应商→年度合同金额 映射（"按供应商汇总"占比列分母：入库金额 ÷ 合同金额）
    let supplierContracts = {};
    try {
      const suppliersAll = await db.suppliers.toArray();
      suppliersAll.forEach(s => { supplierContracts[s.供应商] = parseFloat(s.年度合同金额) || 0; });
    } catch (e) {
    console.warn('[reconciliation.js:130] 异常(已忽略):', e);
  }

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
      // 🟢 v209 AUDIT-307：原始浮点累加，显示/占比时再舍入。
      // 原先逐行 Math.round 累加会累积误差（实测 5 行差 0.02，1000 行差 0.48），
      // 与趋势图「先求和再舍入」口径不一致，现在统一为「先汇总后舍入」。
      summary[key].amount += (parseFloat(i.原币价税合计) || 0);
      if (i.入库单号) summary[key].uniqueNos.add(i.入库单号);
    });

    const supplierList = Object.entries(summary).sort((a, b) => b[1].amount - a[1].amount);

    if (rt !== undefined && rt !== App._goToken) return;
    document.getElementById('recSummary').innerHTML = `
      <div class="chart-stats-row" style="margin-bottom:14px;">
        <!-- 左侧：按供应商汇总 (2/3) -->
        <div class="glass-card" style="flex:0 0 58%;min-width:320px;margin-bottom:0;">
          <div class="glass-card-header"><span class="glass-card-title"><span class="title-icon">📊</span>按供应商汇总</span></div>
          <div class="table-wrapper" style="max-height:260px;">
            <table class="data-table">
              <thead><tr><th>供应商</th><th>入库单数</th><th>入库量</th><th>金额(元)</th><th title="分子=所选日期范围内入库金额；分母=该供应商年度合同金额（自然年）">占合同比</th></tr></thead>
              <tbody>${supplierList.map(([name, info]) => `
                <tr>
                  <td><strong>${esc(name)}</strong></td>
                  <td>${info.uniqueNos.size}</td>
                  <td>${TableUtils.formatNum(info.qty)}</td>
                  <td>${TableUtils.formatMoney(info.amount)}</td>
                  <td>${(() => { const ca = supplierContracts[name] || 0; return ca > 0 ? ((info.amount / ca) * 100).toFixed(1) + '%' : '—'; })()}</td>
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
    this.renderTable(rt);
    // 渲染供应商趋势图
    await this.renderSupplierTrendChart(supplier, inbound);
  },

  renderTable(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const data = this.currentData;
    const total = data.length;
    const pageSize = this.pageSize === 'all' ? total : this.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    this.currentPage = page;
    const items = data.slice((page - 1) * pageSize, page * pageSize);

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
                <td>${TableUtils.link('supplier', i.供应商 ?? '', i.供应商 ?? '')}</td>
                <td>${TableUtils.link('stock', i.存货编码 ?? '', i.存货编码 ?? '')}</td>
                <td>${esc(i.存货名称 ?? '')}</td>
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

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('recPagination', { module: 'ReconciliationModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    TableUtils.initSmartSelect('recTableArea');
    TableUtils.initSortableHeaders('recTableArea');
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
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
      return Math.round(matched.reduce((s, i) => s + (parseFloat(i.原币价税合计) || 0), 0) * 100) / 100;
    });

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = TableUtils.chartTextColor(isDark);
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
  }
};
