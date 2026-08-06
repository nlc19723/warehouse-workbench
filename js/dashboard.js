// ============================================
// 仪表盘首页 V3 - 3D CoverFlow · 双模主题 · 多维度趋势图
// ============================================

const DashboardModule = {
  chart: null,
  donutChart: null,
  top10Chart: null,
  compareChart: null,
  supplierContractChart: null,
  restockChart: null,
  coverflowIndex: 0,
  coverflowTimer: null,
  coverflowPaused: false,

  // CoverFlow 快捷入口模块定义
  coverflowItems: [
    { id: 'query', icon: '🔍', label: '查询系统', desc: '存量·订单·入库·价格', iconBg: 'var(--accent-lavender-light)' },
    { id: 'inventoryAlert', icon: '⚠️', label: '库存预警', desc: '补货提醒·在途跟踪', iconBg: 'var(--accent-coral-light)' },
    { id: 'supplier', icon: '🏭', label: '供应商管理', desc: '合同·绩效·评估', iconBg: 'var(--accent-warm-light)' },
    { id: 'orderTrack', icon: '📦', label: '订单跟踪', desc: '进度·履约·异常', iconBg: 'var(--accent-coral-light)' },
    { id: 'orders', icon: '📝', label: '订单列表', desc: '采购·审批·统计', iconBg: 'var(--status-info-bg)' },
    { id: 'stock', icon: '🏪', label: '现存量', desc: '库存·库位·盘点', iconBg: 'var(--accent-mint-light)' },
    { id: 'inbound', icon: '📥', label: '入库列表', desc: '收货·验收·入库', iconBg: 'var(--accent-mint-light)' },
    { id: 'pricing', icon: '💰', label: '合同价格', desc: '报价·比价·审批', iconBg: 'var(--accent-lavender-light)' },
  ],

  async render() {
    const content = document.getElementById('contentArea');
    const stats = await DataStore.getDashboardStats();

    // 生成 CoverFlow HTML
    const cfCards = this.coverflowItems.map((item, idx) => {
      const pos = this.getCoverflowPos(idx);
      return `<div class="coverflow-card ${pos.cls}" data-cf-idx="${idx}" data-module="${item.id}"
            onclick="DashboardModule.handleCoverflowClick(${idx}, '${item.id}')"
            style="z-index:${pos.zIndex}">
        <div class="cf-icon" style="background:${item.iconBg}">${item.icon}</div>
        <div class="cf-label">${item.label}</div>
        <div class="cf-desc">${item.desc}</div>
      </div>`;
    }).join('');

    content.innerHTML = `
      <!-- 3D CoverFlow 快捷入口 -->
      <div class="coverflow-wrapper" style="position:relative;padding:0 12px;margin-bottom:18px;">
        <button class="coverflow-nav prev-btn" onclick="DashboardModule.coverflowPrev()">‹</button>
        <div class="coverflow-container" id="coverflowContainer">
          <div class="coverflow-stage" id="coverflowStage">
            ${cfCards}
          </div>
        </div>
        <button class="coverflow-nav next-btn" onclick="DashboardModule.coverflowNext()">›</button>
      </div>

      <!-- 数据概览Widget（一行4个：待办 + 3个饼图） -->
      <div class="data-widgets">
        <div class="glass-card dash-todo-card">
          <div class="glass-card-header">
            <span class="glass-card-title"><span class="title-icon">📋</span>待办事项</span>
            <span class="glass-card-action" onclick="App.go('inventoryAlert')">查看全部 ›</span>
          </div>
          <div class="todo-list" id="todoListArea"></div>
        </div>
        <div class="glass-card dash-donut-card">
          <div class="glass-card-header">
            <span class="glass-card-title"><span class="title-icon">📊</span>库存健康度</span>
          </div>
          <div class="donut-container">
            <div class="donut-chart"><canvas id="donutCanvas"></canvas>
              <div class="donut-center"><div class="big-num">${stats.stockCount}</div><div class="small-label">物料总数</div></div>
            </div>
            <div class="donut-legend" id="donutLegend"></div>
          </div>
        </div>
        <div class="glass-card dash-donut-card">
          <div class="glass-card-header">
            <span class="glass-card-title"><span class="title-icon">🏭</span>供应商合同状态</span>
          </div>
          <div class="donut-container">
            <div class="donut-chart"><canvas id="supplierContractCanvas"></canvas>
              <div class="donut-center"><div class="big-num">${stats.supplierCount}</div><div class="small-label">供应商总数</div></div>
            </div>
            <div class="donut-legend" id="supplierContractLegend"></div>
          </div>
        </div>
        <div class="glass-card dash-donut-card">
          <div class="glass-card-header">
            <span class="glass-card-title"><span class="title-icon">📦</span>库存补货分布</span>
          </div>
          <div class="donut-container">
            <div class="donut-chart"><canvas id="restockCanvas"></canvas>
              <div class="donut-center"><div class="big-num">${stats.stockCount}</div><div class="small-label">物料总数</div></div>
            </div>
            <div class="donut-legend" id="restockLegend"></div>
          </div>
        </div>
      </div>

      <!-- KPI 指标卡片 -->
      <div class="kpi-grid">
        <div class="kpi-card card-warning" onclick="App.openPanel('inventoryAlert')">
          <div class="kpi-label">需补货种类</div>
          <div class="kpi-value">${stats.needRestockCount}<span class="kpi-unit"> 种</span></div>
        </div>
        <div class="kpi-card card-danger" onclick="App.openPanel('supplier')">
          <div class="kpi-label">合同到期预警</div>
          <div class="kpi-value">${stats.contractWarnings}<span class="kpi-unit"> 家</span></div>
        </div>
        <div class="kpi-card card-info" onclick="App.openPanel('supplier')">
          <div class="kpi-label">供应商总数</div>
          <div class="kpi-value">${stats.supplierCount}<span class="kpi-unit"> 家</span></div>
        </div>
        <div class="kpi-card card-info" onclick="App.openPanel('orders')">
          <div class="kpi-label">订单总数</div>
          <div class="kpi-value">${stats.orderCount}</div>
        </div>
        <div class="kpi-card card-warning" onclick="App.openPanel('orderTrack')">
          <div class="kpi-label">在途订单</div>
          <div class="kpi-value">${stats.pendingInbound}</div>
        </div>
        <div class="kpi-card card-info" onclick="App.openPanel('inbound')">
          <div class="kpi-label">入库记录</div>
          <div class="kpi-value">${stats.inboundCount}</div>
        </div>
        <div class="kpi-card card-success" onclick="App.openPanel('stock')">
          <div class="kpi-label">物料种类</div>
          <div class="kpi-value">${stats.stockCount}</div>
        </div>
        <div class="kpi-card card-info" onclick="App.openPanel('orders')">
          <div class="kpi-label">年度采购总额</div>
          <div class="kpi-value" style="font-size:20px;">¥${this.formatMoney(stats.totalOrderAmount)}</div>
        </div>
        <div class="kpi-card card-danger" onclick="App.openPanel('lowTurnover')">
          <div class="kpi-label">低周转物料</div>
          <div class="kpi-value">${stats.lowTurnoverCount}<span class="kpi-unit"> 种</span></div>
        </div>
      </div>

      <!-- 月度入库金额/订单金额趋势 -->
      <div class="glass-card">
        <div class="glass-card-header">
          <span class="glass-card-title"><span class="title-icon">📈</span>月度入库金额 / 订单金额趋势</span>
        </div>
        <div class="chart-container"><canvas id="monthlyChart"></canvas></div>
      </div>

      <!-- 常用材料 TOP10 近6月入库量 -->
      <div class="glass-card">
        <div class="glass-card-header">
          <span class="glass-card-title"><span class="title-icon">🏆</span>常用材料 TOP10 近半年月入库量</span>
        </div>
        <div class="chart-container"><canvas id="top10Chart"></canvas></div>
      </div>

      <!-- 近6月入库量 vs 订货量 -->
      <div class="glass-card">
        <div class="glass-card-header">
          <span class="glass-card-title"><span class="title-icon">⚖️</span>近半年入库量 vs 订货量对比</span>
        </div>
        <div class="chart-container"><canvas id="compareChart"></canvas></div>
      </div>
    `;

    // 渲染子组件
    await this.renderDonut(stats);
    await this.renderTodos(stats);
    await this.renderSupplierContractChart();
    await this.renderRestockChart();
    await this.renderMonthlyChart();
    await this.renderTop10Chart();
    await this.renderCompareChart();
    this.updateBadges(stats);
    this.initCoverflow();
  },

  // ===== 3D CoverFlow =====
  getCoverflowPos(idx) {
    const diff = idx - this.coverflowIndex;
    const total = this.coverflowItems.length;
    // 环形处理
    let adj = ((diff % total) + total) % total;
    if (adj > total / 2) adj -= total;
    if (adj === 0) return { cls: 'active', zIndex: 10 };
    if (adj === 1) return { cls: 'next', zIndex: 5 };
    if (adj === -1) return { cls: 'prev', zIndex: 5 };
    if (adj === 2) return { cls: 'next2', zIndex: 3 };
    if (adj === -2) return { cls: 'prev2', zIndex: 3 };
    return { cls: 'hidden', zIndex: 1 };
  },

  updateCoverflow() {
    const cards = document.querySelectorAll('.coverflow-card');
    cards.forEach(card => {
      const idx = parseInt(card.getAttribute('data-cf-idx'));
      const pos = this.getCoverflowPos(idx);
      card.className = 'coverflow-card ' + pos.cls;
      card.style.zIndex = pos.zIndex;
    });
  },

  coverflowPrev() {
    const total = this.coverflowItems.length;
    this.coverflowIndex = ((this.coverflowIndex - 1) % total + total) % total;
    this.updateCoverflow();
    this.updateCoverflowEdgeState();
  },

  coverflowNext() {
    const total = this.coverflowItems.length;
    this.coverflowIndex = (this.coverflowIndex + 1) % total;
    this.updateCoverflow();
    this.updateCoverflowEdgeState();
  },

  // 更新边界按钮状态
  updateCoverflowEdgeState() {
    const prevBtn = document.querySelector('.coverflow-nav.prev-btn');
    const nextBtn = document.querySelector('.coverflow-nav.next-btn');
    if (prevBtn) prevBtn.classList.toggle('at-edge', this.coverflowIndex === 0);
    if (nextBtn) nextBtn.classList.toggle('at-edge', this.coverflowIndex === this.coverflowItems.length - 1);
  },

  // 自动轮播
  startAutoCoverflow() {
    this.stopAutoCoverflow();
    this.coverflowTimer = setInterval(() => {
      if (!this.coverflowPaused) this.coverflowNext();
    }, 4000);
  },

  stopAutoCoverflow() {
    if (this.coverflowTimer) { clearInterval(this.coverflowTimer); this.coverflowTimer = null; }
  },

  openCoverflowItem(moduleId) {
    // 如果是侧边栏已有模块，跳转页面；否则打开弹窗
    const validModules = ['dashboard', 'query', 'inventoryAlert', 'stock', 'orders', 'supplier', 'inbound', 'orderTrack', 'pricing', 'reconciliation', 'lowTurnover', 'breach'];
    if (validModules.includes(moduleId)) {
      App.go(moduleId);
    } else {
      App.openPanel(moduleId);
    }
  },

  // 处理 CoverFlow 卡片点击 —— 点击任意卡片立即居中
  handleCoverflowClick(idx, moduleId) {
    // 如果已经是当前激活卡片 → 直接导航
    if (idx === this.coverflowIndex) {
      this.openCoverflowItem(moduleId);
      return;
    }
    // 非激活卡片 → 立即切换到该卡片（无动画延迟，立即居中）
    const prevIdx = this.coverflowIndex;
    this.coverflowIndex = idx;
    // 强制重排确保样式即时生效
    this.updateCoverflow();
    this.updateCoverflowEdgeState();
    this.resetAutoTimer();
    // 短暂延迟后导航（让用户看到居中效果）
    setTimeout(() => {
      this.openCoverflowItem(moduleId);
    }, 350);
  },

  initCoverflow() {
    this.updateCoverflow();
    this.updateCoverflowEdgeState();
    this.startAutoCoverflow();

    // hover 暂停自动轮播
    const wrapper = document.querySelector('.coverflow-wrapper');
    if (wrapper) {
      wrapper.addEventListener('mouseenter', () => { this.coverflowPaused = true; });
      wrapper.addEventListener('mouseleave', () => { this.coverflowPaused = false; });
    }

    // 键盘支持
    const handler = (e) => {
      if (e.key === 'ArrowLeft') { this.coverflowPrev(); this.resetAutoTimer(); }
      else if (e.key === 'ArrowRight') { this.coverflowNext(); this.resetAutoTimer(); }
    };
    document.addEventListener('keydown', handler);
    // 滚轮支持
    const container = document.getElementById('coverflowContainer');
    if (container) {
      container.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaX > 0 || e.deltaY > 0) this.coverflowNext();
        else this.coverflowPrev();
        this.resetAutoTimer();
      }, { passive: false });
    }
  },

  // 手动操作后重置自动轮播计时
  resetAutoTimer() {
    this.stopAutoCoverflow();
    this.startAutoCoverflow();
  },

  // ===== 甜甜圈图（库存健康度，与另外两个饼图保持一致的视觉与交互） =====
  async renderDonut(stats) {
    const canvas = document.getElementById('donutCanvas');
    if (!canvas) return;
    if (this.donutChart) { this.donutChart.destroy(); this.donutChart = null; }
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const safe = stats.stockCount - stats.needRestockCount;
    const segs = [
      { label: '安全库存', value: safe, unit: '种', color: isDark ? '#34D399' : '#6DBF9F' },
      { label: '需补货', value: stats.needRestockCount, unit: '种', color: isDark ? '#FB7185' : '#D49595' },
      { label: '在途订单', value: stats.pendingInbound, unit: '条', color: isDark ? '#FBBF24' : '#D4A870' }
    ].filter(s => s.value > 0);
    this.donutChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: segs.map(s => s.value),
          backgroundColor: segs.map(s => s.color),
          borderColor: isDark ? '#0F172A' : '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 8
        }]
      },
      options: {
        cutout: '65%',
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        animation: { animateRotate: true, duration: 1000 }
      }
    });
    const legend = document.getElementById('donutLegend');
    if (legend) {
      legend.innerHTML = segs.map(s =>
        `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:${s.color};"></span>${s.label} ${s.value} ${s.unit}</div>`
      ).join('') || '<div class="donut-legend-item">暂无数据</div>';
    }
  },

  // ===== 待办列表（可点击查看明细） =====
  async renderTodos(stats) {
    const area = document.getElementById('todoListArea');
    if (!area) return;
    const items = [];
    if (stats.needRestockCount > 0) items.push({ type: 'restock', dot: 'urgent', text: `${stats.needRestockCount} 种物料库存不足`, meta: '库存预警' });
    if (stats.pendingInbound > 0) items.push({ type: 'pendingInbound', dot: 'warning', text: `${stats.pendingInbound} 条订单未完成入库`, meta: '订单跟踪' });
    if (stats.contractWarnings > 0) items.push({ type: 'contract', dot: 'urgent', text: `${stats.contractWarnings} 家供应商合同到期`, meta: '供应商管理' });
    if (stats.lowTurnoverCount > 0) items.push({ type: 'lowTurnover', dot: 'warning', text: `${stats.lowTurnoverCount} 种低周转物料`, meta: '低周转材料' });
    if (items.length === 0) items.push({ dot: 'warning', text: '暂无待办事项 ✓', meta: '' });
    area.innerHTML = items.map(i =>
      `<div class="todo-item ${i.type ? 'todo-clickable' : ''}" ${i.type ? `onclick="DashboardModule.showTodoDetail('${i.type}')"` : ''}>
        <div class="todo-dot ${i.dot}"></div>
        <span class="todo-text">${i.text}</span>
        ${i.meta ? `<span class="todo-meta">${i.meta} ›</span>` : ''}
      </div>`
    ).join('');
  },

  // ===== 待办明细弹窗 =====
  async showTodoDetail(type) {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    if (!overlay || !bodyEl) return;

    let title = '', headers = [], rows = [];
    if (type === 'restock') {
      title = '需补货物料明细';
      const list = (await db.inventoryAlerts.toArray()).filter(a => a.是否需补货 === '是' || a.是否需补货 === true);
      headers = ['存货名称', '规格', '现存量'];
      rows = list.slice(0, 300).map(a => [a.存货名称 || '-', a.规格型号 || '-', this.fmt(a.现存量)]);
    } else if (type === 'pendingInbound') {
      title = '未完成入库订单';
      const list = (await db.orders.toArray()).filter(o => parseFloat(o.未入库量) > 0);
      headers = ['订单编号', '供应商', '存货名称', '规格', '订货量', '未入库量'];
      rows = list.slice(0, 300).map(o => [o.订单编号 || '-', o.供应商 || '-', o.存货名称 || '-', o.规格型号 || '-', this.fmt(o.数量), this.fmt(o.未入库量)]);
    } else if (type === 'contract') {
      title = '合同即将到期供应商';
      const now = new Date();
      const list = (await db.suppliers.toArray())
        .map(s => {
          if (!s.年度合同到期时间) return null;
          const diff = Math.ceil((new Date(s.年度合同到期时间) - now) / 86400000);
          return (diff <= 90 && diff >= 0) ? { s, diff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.diff - b.diff);
      headers = ['供应商', '到期时间', '剩余天数', '状态'];
      rows = list.slice(0, 300).map(({ s, diff }) => [s.供应商 || '-', s.年度合同到期时间 || '-', diff + ' 天', diff <= 30 ? '紧急' : '关注']);
    } else if (type === 'lowTurnover') {
      title = '低周转物料';
      const list = await db.lowTurnover.toArray();
      headers = ['物料名称', '规格', '现存数量', '暂无法使用量'];
      rows = list.slice(0, 300).map(l => [l.物料名称 || l.存货名称 || '-', l.规格 || l.规格型号 || '-', this.fmt(l.现存数量), this.fmt(l.暂无法使用量)]);
    }

    titleEl.textContent = title + (rows.length ? `（${rows.length} 条）` : '');
    bodyEl.innerHTML = rows.length
      ? `<div class="todo-detail-table"><table class="data-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">暂无相关记录</div></div>';
    overlay.classList.add('show');
  },

  fmt(v) {
    if (v === null || v === undefined || v === '') return '-';
    const n = parseFloat(v);
    return isNaN(n) ? v : this.formatMoney(n);
  },

  updateBadges(stats) {
    const badge = document.getElementById('badgeAlert');
    if (badge) {
      badge.textContent = stats.needRestockCount > 0 ? stats.needRestockCount : '0';
      badge.style.display = stats.needRestockCount > 0 ? '' : 'none';
    }
  },

  // ===== 月度入库金额 + 订单金额趋势 =====
  async renderMonthlyChart() {
    const canvas = document.getElementById('monthlyChart');
    if (!canvas) return;
    if (this.chart) { this.chart.destroy(); this.chart = null; }

    const inbound = await db.inbound.toArray();
    const orders = await db.orders.toArray();

    // 入库金额按月汇总
    const inboundByMonth = {};
    inbound.forEach(i => {
      if (!i.入库日期) return;
      const ym = i.入库日期.substring(0, 7);
      inboundByMonth[ym] = (inboundByMonth[ym] || 0) + (parseFloat(i.原币价税合计) || 0);
    });
    // 订单金额按月汇总
    const ordersByMonth = {};
    orders.forEach(o => {
      if (!o.日期) return;
      const ym = o.日期.substring(0, 7);
      ordersByMonth[ym] = (ordersByMonth[ym] || 0) + (parseFloat(o.原币价税合计) || 0);
    });

    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: months.map(m => {
          const [y, mon] = m.split('-');
          return `${y}年${parseInt(mon)}月`;
        }),
        datasets: [
          {
            label: '入库金额(元)',
            data: months.map(m => inboundByMonth[m] || 0),
            borderColor: isDark ? '#38BDF8' : '#3B82C4',
            backgroundColor: isDark ? 'rgba(56,189,248,0.08)' : 'rgba(59,130,196,0.08)',
            fill: true, tension: 0.4, borderWidth: 2, pointRadius: 2,
            yAxisID: 'y1'
          },
          {
            label: '订单金额(元)',
            data: months.map(m => ordersByMonth[m] || 0),
            borderColor: isDark ? '#A78BFA' : '#8B5CF6',
            backgroundColor: isDark ? 'rgba(167,139,250,0.08)' : 'rgba(139,92,246,0.08)',
            fill: true, tension: 0.4, borderWidth: 2, pointRadius: 2,
            yAxisID: 'y2'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, padding: 20, font: { size: 11 }, color: isDark ? '#94A3B8' : '#64748B' } }
        },
        scales: {
          y1: {
            type: 'linear', position: 'left',
            grid: { color: isDark ? 'rgba(56,189,248,0.06)' : 'rgba(148,163,184,0.08)' },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B', callback: v => this.formatMoney(v) }
          },
          y2: {
            type: 'linear', position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B', callback: v => this.formatMoney(v) }
          },
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B', maxRotation: 30 }
          }
        }
      }
    });
  },

  // ===== TOP10 材料近6月入库量柱状图 =====
  async renderTop10Chart() {
    const canvas = document.getElementById('top10Chart');
    if (!canvas) return;
    if (this.top10Chart) { this.top10Chart.destroy(); this.top10Chart = null; }

    const inbound = await db.inbound.toArray();
    const now = new Date();
    const sixMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      sixMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // 按物料汇总入库量
    const matQty = {};
    inbound.forEach(i => {
      if (!i.入库日期 || !i.存货名称) return;
      const ym = i.入库日期.substring(0, 7);
      if (!sixMonths.includes(ym)) return;
      const key = i.存货名称;
      if (!matQty[key]) matQty[key] = {};
      matQty[key][ym] = (matQty[key][ym] || 0) + (parseFloat(i.数量) || 0);
    });

    // TOP10 按总入库量排序
    const top10 = Object.entries(matQty)
      .map(([name, months]) => ({ name, total: Object.values(months).reduce((a, b) => a + b, 0), months }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const colors = ['#3B82C4','#6DBF9F','#A78BFA','#D49595','#D4A870','#38BDF8','#34D399','#FB7185','#FBBF24','#8B5CF6'];

    const datasets = top10.map((item, idx) => ({
      label: item.name.length > 8 ? item.name.substring(0, 8) + '…' : item.name,
      data: sixMonths.map(m => item.months[m] || 0),
      backgroundColor: colors[idx % colors.length] + (isDark ? 'CC' : '99'),
      borderColor: colors[idx % colors.length],
      borderWidth: 1, borderRadius: 3,
    }));

    this.top10Chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: sixMonths.map(m => {
        const [y, mon] = m.split('-');
        return `${y}年${parseInt(mon)}月`;
      }), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, padding: 12, font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B', boxWidth: 8 } }
        },
        scales: {
          y: {
            stacked: false,
            grid: { color: isDark ? 'rgba(56,189,248,0.06)' : 'rgba(148,163,184,0.08)' },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B' }
          },
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B', maxRotation: 30 }
          }
        }
      }
    });
  },

  // ===== 近6月入库量 vs 订货量对比 =====
  async renderCompareChart() {
    const canvas = document.getElementById('compareChart');
    if (!canvas) return;
    if (this.compareChart) { this.compareChart.destroy(); this.compareChart = null; }

    const inbound = await db.inbound.toArray();
    const orders = await db.orders.toArray();
    const now = new Date();
    const sixMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      sixMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const inboundQty = {};
    inbound.forEach(i => {
      if (!i.入库日期) return;
      const ym = i.入库日期.substring(0, 7);
      if (!sixMonths.includes(ym)) return;
      inboundQty[ym] = (inboundQty[ym] || 0) + (parseFloat(i.数量) || 0);
    });
    const orderQty = {};
    orders.forEach(o => {
      if (!o.日期) return;
      const ym = o.日期.substring(0, 7);
      if (!sixMonths.includes(ym)) return;
      orderQty[ym] = (orderQty[ym] || 0) + (parseFloat(o.数量) || 0);
    });

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.compareChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: sixMonths.map(m => {
          const [y, mon] = m.split('-');
          return `${y}年${parseInt(mon)}月`;
        }),
        datasets: [
          {
            label: '入库量',
            data: sixMonths.map(m => inboundQty[m] || 0),
            borderColor: isDark ? '#34D399' : '#6DBF9F',
            backgroundColor: isDark ? 'rgba(52,211,153,0.1)' : 'rgba(109,191,159,0.1)',
            fill: true, tension: 0.4, borderWidth: 2, pointRadius: 3,
            yAxisID: 'y'
          },
          {
            label: '订货量',
            data: sixMonths.map(m => orderQty[m] || 0),
            borderColor: isDark ? '#38BDF8' : '#3B82C4',
            backgroundColor: isDark ? 'rgba(56,189,248,0.1)' : 'rgba(59,130,196,0.1)',
            fill: true, tension: 0.4, borderWidth: 2, pointRadius: 3,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, padding: 20, font: { size: 11 }, color: isDark ? '#94A3B8' : '#64748B' } }
        },
        scales: {
          y: {
            type: 'linear', position: 'left',
            title: { display: true, text: '入库量', color: isDark ? '#94A3B8' : '#64748B', font: { size: 11 } },
            grid: { color: isDark ? 'rgba(56,189,248,0.06)' : 'rgba(148,163,184,0.08)' },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B' },
            beginAtZero: true
          },
          y1: {
            type: 'linear', position: 'right',
            title: { display: true, text: '订货量', color: isDark ? '#94A3B8' : '#64748B', font: { size: 11 } },
            grid: { drawOnChartArea: false },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B' },
            beginAtZero: true
          },
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: isDark ? '#94A3B8' : '#64748B', maxRotation: 30 }
          }
        }
      }
    });
  },

  // ===== 供应商合同状态分布饼图 =====
  async renderSupplierContractChart() {
    const canvas = document.getElementById('supplierContractCanvas');
    if (!canvas) return;
    if (this.supplierContractChart) { this.supplierContractChart.destroy(); this.supplierContractChart = null; }

    const suppliers = await db.suppliers.toArray();
    const now = new Date();
    const thirtyDays = 30;
    const ninetyDays = 90;

    let expiringSoon = 0; // 30天内到期
    let expiringLater = 0; // 30-90天到期
    let safe = 0; // 90天以上
    let noContract = 0; // 无到期时间

    suppliers.forEach(s => {
      const endDate = s.最终到期时间 || s.年度合同到期时间;
      if (!endDate) {
        noContract++;
        return;
      }
      const end = new Date(endDate);
      const diffDays = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
      // 已过期的供应商不计入"即将到期"（只统计未来30天内到期的）
      if (diffDays < 0) {
        // 已过期：归入临近到期或单独分类，此处归入 noContract 类别
        noContract++;
        return;
      }
      if (diffDays <= thirtyDays) {
        expiringSoon++;
      } else if (diffDays <= ninetyDays) {
        expiringLater++;
      } else {
        safe++;
      }
    });

    const legend = document.getElementById('supplierContractLegend');
    if (legend) {
      legend.innerHTML = `
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#D49595;"></span>即将到期(≤30天) ${expiringSoon} 家</div>
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#D4A870;"></span>临近到期(30-90天) ${expiringLater} 家</div>
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#6DBF9F;"></span>合同安全(>90天) ${safe} 家</div>
        ${noContract > 0 ? `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:#94A3B8;"></span>无到期信息 ${noContract} 家</div>` : ''}
      `;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.supplierContractChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [expiringSoon, expiringLater, safe, noContract].filter(v => v > 0),
          backgroundColor: isDark
            ? ['#FB7185', '#FBBF24', '#34D399', '#64748B']
            : ['#D49595', '#D4A870', '#6DBF9F', '#94A3B8'],
          borderColor: isDark ? '#0F172A' : '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 8,
          offset: [0, 0, 0, 0]
        }]
      },
      options: {
        cutout: '65%',
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        animation: {
          animateRotate: true,
          duration: 1000
        }
      }
    });
  },

  // ===== 库存补货分布饼图 =====
  async renderRestockChart() {
    const canvas = document.getElementById('restockCanvas');
    if (!canvas) return;
    if (this.restockChart) { this.restockChart.destroy(); this.restockChart = null; }

    const alerts = await db.inventoryAlerts.toArray();
    const needRestock = alerts.filter(a => a.是否需补货 === '是').length;
    const onTheWay = alerts.filter(a => parseFloat(a.在途订单) > 0).length;
    const safe = alerts.length - needRestock;

    // 在途和需补货可能有重叠，计算独立值
    const both = alerts.filter(a => a.是否需补货 === '是' && parseFloat(a.在途订单) > 0).length;
    const onlyNeedRestock = needRestock - both;
    const onlyOnTheWay = onTheWay - both;

    const legend = document.getElementById('restockLegend');
    if (legend) {
      legend.innerHTML = `
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#D49595;"></span>需补货 ${needRestock} 种</div>
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#D4A870;"></span>在途订单 ${onTheWay} 种</div>
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#6DBF9F;"></span>库存安全 ${safe} 种</div>
      `;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.restockChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [onlyNeedRestock, onlyOnTheWay, both, safe].filter(v => v > 0),
          backgroundColor: isDark
            ? ['#FB7185', '#FBBF24', '#A78BFA', '#34D399']
            : ['#D49595', '#D4A870', '#A78BFA', '#6DBF9F'],
          borderColor: isDark ? '#0F172A' : '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 8,
          offset: [0, 0, 0, 0]
        }]
      },
      options: {
        cutout: '65%',
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        animation: {
          animateRotate: true,
          duration: 1000
        }
      }
    });
  },

  formatMoney(num) {
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(num || 0);
  }
};
