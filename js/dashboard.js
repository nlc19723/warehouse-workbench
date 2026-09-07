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

  async render(token) {
    const content = document.getElementById('contentArea');
    const stats = await DataStore.getDashboardStats();
    const completeness = await DataStore.getCompletenessStats();
    this._completeness = completeness;

    const cfCards = this._buildCoverflowHtml();

    if (token !== undefined && token !== App._goToken) return; // 渲染令牌：过期渲染不再提交 DOM，避免快速切换互相覆盖
    content.innerHTML = this._buildDashboardHtml(stats, completeness, cfCards);

    // 🟡 修复：一次性预拉取并缓存各表，各图表方法共用，避免重复全表扫描
    this._cacheData = {};
    await Promise.all([
      this._getCached('inbound'), this._getCached('orders'), this._getCached('suppliers'),
      this._getCached('stock'), this._getCached('inventoryAlerts'), this._getCached('lowTurnover')
    ]);
    if (token !== undefined && token !== App._goToken) return;

    // 渲染子组件
    await this._renderDashboardWidgets(stats);
  },

  // 生成 CoverFlow 卡片 HTML
  _buildCoverflowHtml() {
    return this.coverflowItems.map((item, idx) => {
      const pos = this.getCoverflowPos(idx);
      return `<div class="coverflow-card ${pos.cls}" data-cf-idx="${idx}" data-module="${item.id}"
            onclick="DashboardModule.handleCoverflowClick(${idx}, '${item.id}')"
            style="z-index:${pos.zIndex}">
        <div class="cf-icon" style="background:${item.iconBg}">${item.icon}</div>
        <div class="cf-label">${item.label}</div>
        <div class="cf-desc">${item.desc}</div>
      </div>`;
    }).join('');
  },

  // 组装仪表盘整体 HTML（CoverFlow / Widget / KPI / 图表容器 / 完整性看板）
  _buildDashboardHtml(stats, completeness, cfCards) {
    return `
      <!-- 3D CoverFlow 快捷入口 -->
      <div class="coverflow-wrapper" style="position:relative;padding:0 12px;margin-bottom:18px;">
        <button class="coverflow-nav wb-pager-btn wb-prev prev-btn" onclick="DashboardModule.coverflowPrev()" aria-label="上一张" title="上一张"></button>
        <div class="coverflow-container" id="coverflowContainer">
          <div class="coverflow-stage" id="coverflowStage">
            ${cfCards}
          </div>
        </div>
        <button class="coverflow-nav wb-pager-btn wb-next next-btn" onclick="DashboardModule.coverflowNext()" aria-label="下一张" title="下一张"></button>
      </div>

      ${this.recentBarHtml()}

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
            <span class="glass-card-title"><span class="title-icon">📝</span>订单状态分布</span>
            <span class="glass-card-action" onclick="App.go('orders')">查看全部 ›</span>
          </div>
          <div class="donut-container">
            <div class="donut-chart"><canvas id="orderStatusCanvas"></canvas>
              <div class="donut-center"><div class="big-num">${stats.orderCount}</div><div class="small-label">订单总数</div></div>
            </div>
            <div class="donut-legend" id="orderStatusLegend"></div>
          </div>
        </div>
      </div>

      <!-- KPI 指标卡片 -->
      <div class="kpi-grid">
        <div class="kpi-card card-warning" onclick="App.openPanel('inventoryAlert')">
          <div class="kpi-label">需补货种类</div>
          <div class="kpi-value">${stats.needRestockCount}<span class="kpi-unit"> 种</span></div>
        </div>
        <div class="kpi-card card-warning" onclick="App.openPanel('supplier')">
          <div class="kpi-label">临近到期供应商</div>
          <div class="kpi-value">${stats.contractExpiringSoon ?? 0}<span class="kpi-unit"> 家</span></div>
        </div>
        <div class="kpi-card card-info" onclick="App.openPanel('supplier')">
          <div class="kpi-label">在供供应商数</div>
          <div class="kpi-value">${stats.activeSupplierCount ?? stats.supplierCount}<span class="kpi-unit"> 家</span></div>
        </div>
        <div class="kpi-card card-info" onclick="App.openPanel('orders')">
          <div class="kpi-label">年度采购总额</div>
          <div class="kpi-value" style="font-size:20px;">¥${TableUtils.formatMoney(stats.totalOrderAmount)}</div>
        </div>
        <div class="kpi-card card-success" onclick="App.openPanel('inbound')">
          <div class="kpi-label">年度供货总金额</div>
          <div class="kpi-value" style="font-size:20px;">¥${TableUtils.formatMoney(stats.yearInboundAmount)}</div>
        </div>
        <div class="kpi-card card-danger" onclick="App.openPanel('lowTurnover')">
          <div class="kpi-label">低周转物料</div>
          <div class="kpi-value">${stats.lowTurnoverCount}<span class="kpi-unit"> 种</span></div>
        </div>
      </div>

      <!-- 关联完整性看板（打通模块 · 反向利用已建立关系发现孤岛） -->
      ${this.completenessCardHtml(completeness)}

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
  },

  // 渲染各子组件（饼图 / 待办 / 趋势图 / 角标 / CoverFlow）
  async _renderDashboardWidgets(stats) {
    await this.renderDonut(stats);
    await this.renderTodos(stats);
    await this.renderSupplierContractChart();
    await this.renderOrderStatusChart(stats);
    await this.renderMonthlyChart();
    await this.renderTop10Chart();
    await this.renderCompareChart();
    this.updateBadges(stats);
    this.initCoverflow();
  },

  // 最近浏览：复用 App.recentEntities 栈，点击直达实体档案（无记录时不显示）
  recentBarHtml() {
    const rec = (typeof App !== 'undefined' && App.recentEntities) ? App.recentEntities : [];
    if (!rec.length) return '';
    const iconOf = (t) => t === 'stock' ? '📦' : t === 'supplier' ? '🏭' : t === 'order' ? '📝' : '🔗';
    const chips = rec.slice().reverse().map(e => {
      const lbl = esc(e.label || e.key);
      return `<span class="recent-chip" onclick="App.openEntity('${escAttr(e.type)}','${escAttr(e.key)}')">${iconOf(e.type)} ${lbl}</span>`;
    }).join('');
    return `<div class="glass-card recent-entities">
      <div class="glass-card-header"><span class="glass-card-title"><span class="title-icon">🕘</span>最近浏览</span></div>
      <div class="recent-chips">${chips}</div>
    </div>`;
  },

  // 关联完整性看板：以「孤岛」指标形式呈现，点击下钻查看明细
  completenessCardHtml(c) {
    if (!c) return '';
    const items = [
      { kind: 'stockNoInbound', icon: '📦', label: '存货无入库', count: c.counts.stockNoInbound, total: c.totals.stock, sev: c.counts.stockNoInbound > 0 },
      { kind: 'stockNoOrder', icon: '📦', label: '存货无订单', count: c.counts.stockNoOrder, total: c.totals.stock, sev: c.counts.stockNoOrder > 0 },
      { kind: 'supNoPrice', icon: '🏭', label: '供应商无合同价', count: c.counts.supNoPrice, total: c.totals.supplier, sev: c.counts.supNoPrice > 0 },
      { kind: 'supNoInbound', icon: '🏭', label: '供应商无入库', count: c.counts.supNoInbound, total: c.totals.supplier, sev: c.counts.supNoInbound > 0 },
      { kind: 'ordersNoInbound', icon: '📝', label: '订单未入库', count: c.counts.ordersNoInbound, total: c.totals.order, sev: c.counts.ordersNoInbound > 0 }
    ];
    const chips = items.map(it => `
      <div class="completeness-item ${it.sev ? 'has-issue' : 'ok'}"
           onclick="DashboardModule.showCompletenessDetail('${it.kind}')">
        <span class="completeness-icon">${it.icon}</span>
        <span class="completeness-count">${it.count}</span>
        <span class="completeness-label">${it.label}</span>
      </div>`).join('');
    const issueTotal = items.reduce((s, it) => s + (it.sev ? it.count : 0), 0);
    return `<div class="glass-card completeness-card">
      <div class="glass-card-header">
        <span class="glass-card-title"><span class="title-icon">🔗</span>关联完整性看板</span>
        <span class="glass-card-action" style="color:${issueTotal > 0 ? 'var(--status-warning,#b7791f)' : 'var(--status-success,#38a169)'};">
          ${issueTotal > 0 ? `${issueTotal} 处待完善` : '关联完整 ✓'}
        </span>
      </div>
      <div class="completeness-grid">${chips}</div>
      <div class="completeness-hint">点击任意指标，下钻查看缺失关联的实体明细</div>
    </div>`;
  },

  // 关联完整性下钻：复用全局弹窗，列出缺失关联的实体（带可点击链接直达档案）
  async showCompletenessDetail(kind) {
    const c = this._completeness;
    if (!c) return;
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    if (!overlay || !bodyEl) return;

    let title = '', headers = [], rows = [];
    if (kind === 'stockNoInbound' || kind === 'stockNoOrder') {
      const codes = kind === 'stockNoInbound' ? c.stockNoInbound : c.stockNoOrder;
      title = kind === 'stockNoInbound' ? '存货无入库记录' : '存货无订单记录';
      headers = ['存货编码', '存货名称', '规格型号'];
      const byCode = new Map((c._stockRows || []).map(r => [String(r.存货编码), r]));
      rows = codes.slice(0, 300).map(code => {
        const r = byCode.get(code) || {};
        const name = r.存货名称 || code;
        return [`<strong>${esc(name ?? '')}</strong>`, esc(r.存货名称 || ''), esc(r.规格型号 || '')];
      });
    } else if (kind === 'supNoPrice' || kind === 'supNoInbound') {
      const names = kind === 'supNoPrice' ? c.supNoPrice : c.supNoInbound;
      title = kind === 'supNoPrice' ? '供应商无合同价' : '供应商无入库记录';
      headers = ['供应商'];
      rows = names.slice(0, 300).map(n => [TableUtils.link('supplier', n, n)]);
    } else if (kind === 'ordersNoInbound') {
      title = '未入库订单（仍有未入库量）';
      headers = ['订单编号', '供应商', '存货名称', '未入库量'];
      rows = c.ordersNoInbound.slice(0, 300).map(o => [
        TableUtils.link('order', o.订单编号, o.订单编号), esc(o.供应商 || ''), esc(o.存货名称 || ''), this.fmt(o.未入库量)
      ]);
    }

    titleEl.textContent = title + (rows.length ? `（${rows.length} 条）` : '');
    bodyEl.innerHTML = rows.length
      ? `<div class="todo-detail-table"><table class="data-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c2 => `<td>${c2}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">暂无缺失记录</div></div>';
    overlay.classList.add('show');
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

  // 🟡 M7：离开仪表盘时清理（停止自动轮播定时器 + 移除全局键盘监听），由 App.go 的 onLeave 钩子调用
  onLeave() {
    this.stopAutoCoverflow();
    if (this._coverflowKeyHandler) {
      document.removeEventListener('keydown', this._coverflowKeyHandler);
      this._coverflowKeyHandler = null;
    }
    // 🟡 修复：离开时销毁所有 Chart 实例，避免内存泄漏
    ['donutChart', 'chart', 'top10Chart', 'compareChart', 'supplierContractChart', 'restockChart'].forEach(k => {
      if (this[k]) { try { this[k].destroy(); } catch (e) {
    console.warn('[dashboard.js:335] 异常(已忽略):', e);
  } this[k] = null; }
    });
  },

  // 🟡 修复：全表数据缓存，各图表方法共用，避免重复全表扫描
  _getCached(table) {
    if (!this._cacheData) this._cacheData = {};
    if (!this._cacheData[table]) this._cacheData[table] = db[table].toArray();
    return this._cacheData[table];
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

    // 键盘支持（先移除旧监听，避免重复渲染时累积）
    const handler = (e) => {
      if (e.key === 'ArrowLeft') { this.coverflowPrev(); this.resetAutoTimer(); }
      else if (e.key === 'ArrowRight') { this.coverflowNext(); this.resetAutoTimer(); }
    };
    if (this._coverflowKeyHandler) document.removeEventListener('keydown', this._coverflowKeyHandler);
    this._coverflowKeyHandler = handler;
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
    // 🟡 修复：仅按"种"划分物料健康度（安全库存 + 需补货 = 物料总数 = 中心值）。
    // 在途订单单位为"条"（未入库订单行数），是独立指标，不在本甜甜圈内参与占比，
    // 避免"条/种"混算导致分片之和 ≠ 中心值、图例误导。
    const segs = [
      { label: '安全库存', value: safe, unit: '种', color: isDark ? '#34D399' : '#6DBF9F' },
      { label: '需补货', value: stats.needRestockCount, unit: '种', color: isDark ? '#FB7185' : '#D49595' }
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
    if (stats.pendingApproval > 0) items.push({ type: 'pendingApproval', dot: 'warning', text: `${stats.pendingApproval} 条订单未审批通过`, meta: '订单列表' });
    if (stats.contractExpiringSoon > 0) items.push({ type: 'contract', dot: 'warning', text: `${stats.contractExpiringSoon} 家供应商临近到期`, meta: '供应商管理' });
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

    // 预构建存货编码映射（供下方多个分支复用）
    let codeMap = null;
    try { if (typeof DataLoader !== 'undefined') codeMap = await DataLoader.getStockNameSpecCodeMap(); } catch(e){
    /*ignore*/ console.warn('[dashboard.js:484] 异常(已忽略):', e);
  }

    if (type === 'restock') {
      title = '需补货物料明细';
      let list = await this._getCached('inventoryAlerts');

      // 补货值统一处理在现存量交叉补全之后进行（见下方）

      // 从库存表交叉补全现存量 + 重算补货值
      try {
        const stockRows = await this._getCached('stock');
        const stockByCode = new Map();
        const stockByNameSpec = new Map();
        stockRows.forEach(s => {
          if (s.存货编码) stockByCode.set(String(s.存货编码), s.现存数量);
          if (s.存货名称) { const k=(s.存货名称+'|'+(s.规格型号||'')).replace(/\s+/g,''); stockByNameSpec.set(k,s.现存数量); }
        });
        list.forEach(a => {
          if (!a.现存量 || a.现存量===0) {
            if (a.存货编码 && stockByCode.has(String(a.存货编码))) a.现存量=stockByCode.get(String(a.存货编码));
            else if (a.存货名称) {
              const k=(a.存货名称+'|'+(a.规格型号||'')).replace(/\s+/g,'');
              if (stockByNameSpec.has(k)) a.现存量=stockByNameSpec.get(k);
              else for(const [kk,vv]of stockByNameSpec){if(kk.startsWith((a.存货名称||'').replace(/\s+/g,''))){a.现存量=vv;break;}}
            }
          }
          // 注意：不再重算补货值，保留源数据原始值
        });
      }catch(e){
    /*ignore*/ console.warn('[dashboard.js:512] 异常(已忽略):', e);
  }

      // 补货值：直接使用导入时从源数据"是否需补货"(J列)读取的原始数值，不做回退计算
      list.forEach(a => { const v = parseFloat(a.补货值); a.补货值 = isNaN(v) ? 0 : v; });

      list = list.filter(a => a.补货值 && a.补货值 > 0);
      headers = ['存货编码', '存货名称', '规格型号', '现存量', '补货值', '最低库存'];
      rows = list.slice(0, 300).map(a => [a.存货编码 ?? '', a.存货名称 ?? '', a.规格型号 ?? '', this.fmt(a.现存量), this.fmt(a.补货值), this.fmt(a.最低库存预警)]);
    } else if (type === 'pendingInbound') {
      title = '未完成入库订单';
      const list = (await this._getCached('orders')).filter(o => parseFloat(o.未入库量) > 0);
      // 填充存货编码（双路取码）
      if (typeof DataLoader !== 'undefined' && DataLoader.fillStockCode) list.forEach(o => DataLoader.fillStockCode(o, codeMap));
      headers = ['订单编号', '供应商', '存货编码', '存货名称', '规格型号', '订货量', '未入库量'];
      rows = list.slice(0, 300).map(o => [o.订单编号 ?? '', o.供应商 ?? '', o._存货编码 ?? '', o.存货名称 ?? '', o.规格型号 ?? '', this.fmt(o.数量), this.fmt(o.未入库量)]);
    } else if (type === 'pendingApproval') {
      title = '未审批通过订单';
      const list = (await this._getCached('orders')).filter(o => o.审批状态 && o.审批状态 !== '审批通过');
      // 填充存货编码（双路取码，显示全部行项，不按订单编号去重）
      if (typeof DataLoader !== 'undefined' && DataLoader.fillStockCode) list.forEach(o => DataLoader.fillStockCode(o, codeMap));
      headers = ['订单编号', '日期', '供应商', '存货编码', '存货名称', '规格型号', '审批状态', '未入库量'];
      rows = list.slice(0, 300).map(o => [o.订单编号 ?? '', o.日期 || o.已下单时间 || '', o.供应商 ?? '', o._存货编码 ?? '', o.存货名称 ?? '', o.规格型号 ?? '', o.审批状态 || '', this.fmt(o.未入库量)]);
    } else if (type === 'contract') {
      title = '临近到期供应商（30-90天）';
      const now = new Date();
      const list = (await this._getCached('suppliers'))
        .map(s => {
          if (!s.年度合同到期时间) return null;
          const diff = Math.ceil((new Date(s.年度合同到期时间) - now) / DAY_MS);
          return (diff > 30 && diff <= 90) ? { s, diff } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.diff - b.diff);
      headers = ['供应商', '到期时间', '剩余天数', '状态'];
      rows = list.slice(0, 300).map(({ s, diff }) => [s.供应商 ?? '', s.年度合同到期时间 ?? '', diff + ' 天', '关注']);
    } else if (type === 'lowTurnover') {
      title = '低周转物料';
      const list = await this._getCached('lowTurnover');
      headers = ['存货编码', '存货名称', '规格型号', '现存数量', '暂无法使用量'];
      rows = list.slice(0, 300).map(l => [l.存货编码 ?? '', l.物料名称 || l.存货名称 || '', l.规格 || l.规格型号 || '', this.fmt(l.现存数量), this.fmt(l.暂无法使用量)]);
    }

    titleEl.textContent = title + (rows.length ? `（${rows.length} 条）` : '');
    bodyEl.innerHTML = rows.length
      ? `<div class="todo-detail-table"><table class="data-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">暂无相关记录</div></div>';
    overlay.classList.add('show');
  },

  fmt(v) {
    if (v === null || v === undefined || v === '') return '';
    const n = parseFloat(v);
    return isNaN(n) ? v : TableUtils.formatMoney(n);
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

    const inbound = await this._getCached('inbound');
    const orders = await this._getCached('orders');

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
          legend: { position: 'top', labels: { usePointStyle: true, padding: 20, font: { size: 11 }, color: TableUtils.chartTextColor(isDark) } }
        },
        scales: {
          y1: {
            type: 'linear', position: 'left',
            grid: { color: isDark ? 'rgba(56,189,248,0.06)' : 'rgba(148,163,184,0.08)' },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark), callback: v => TableUtils.formatMoney(v) }
          },
          y2: {
            type: 'linear', position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark), callback: v => TableUtils.formatMoney(v) }
          },
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark), maxRotation: 30 }
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

    const inbound = await this._getCached('inbound');
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
    const colors = TableUtils.CHART_PALETTE;

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
          legend: { position: 'top', labels: { usePointStyle: true, padding: 12, font: { size: 10 }, color: TableUtils.chartTextColor(isDark), boxWidth: 8 } }
        },
        scales: {
          y: {
            stacked: false,
            grid: { color: isDark ? 'rgba(56,189,248,0.06)' : 'rgba(148,163,184,0.08)' },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark) }
          },
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark), maxRotation: 30 }
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

    const inbound = await this._getCached('inbound');
    const orders = await this._getCached('orders');
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
          legend: { position: 'top', labels: { usePointStyle: true, padding: 20, font: { size: 11 }, color: TableUtils.chartTextColor(isDark) } }
        },
        scales: {
          y: {
            type: 'linear', position: 'left',
            title: { display: true, text: '入库量', color: TableUtils.chartTextColor(isDark), font: { size: 11 } },
            grid: { color: isDark ? 'rgba(56,189,248,0.06)' : 'rgba(148,163,184,0.08)' },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark) },
            beginAtZero: true
          },
          y1: {
            type: 'linear', position: 'right',
            title: { display: true, text: '订货量', color: TableUtils.chartTextColor(isDark), font: { size: 11 } },
            grid: { drawOnChartArea: false },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark) },
            beginAtZero: true
          },
          x: {
            grid: { display: false },
            ticks: { font: { size: 10 }, color: TableUtils.chartTextColor(isDark), maxRotation: 30 }
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

    const suppliers = await this._getCached('suppliers');
    const now = new Date();
    const thirtyDays = 30;
    const ninetyDays = 90;

    let expiringSoon = 0; // 30天内到期
    let expiringLater = 0; // 30-90天到期
    let safe = 0; // 90天以上
    let expired = 0; // 已过期（合同已到期）
    let noInfo = 0; // 无到期时间信息

    suppliers.forEach(s => {
      const endDate = s.最终到期时间 || s.年度合同到期时间;
      if (!endDate) {
        noInfo++;
        return;
      }
      const end = new Date(endDate);
      const diffDays = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
      if (diffDays < 0) {
        // 已过期 → 单独显示为"已到期"
        expired++;
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
        ${expired > 0 ? `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:#EF4444;"></span>已到期 ${expired} 家</div>` : ''}
        ${noInfo > 0 ? `<div class="donut-legend-item"><span class="donut-legend-dot" style="background:#94A3B8;"></span>无到期信息 ${noInfo} 家</div>` : ''}
      `;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.supplierContractChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [expiringSoon, expiringLater, safe, expired, noInfo].filter(v => v > 0),
          backgroundColor: isDark
            ? ['#FB7185', '#FBBF24', '#34D399', '#EF4444', '#64748B']
            : ['#D49595', '#D4A870', '#6DBF9F', '#EF4444', '#94A3B8'],
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

  // ===== 订单状态分布环形图（待审/已审/在途，按订单编号去重计数；复用 getDashboardStats 统一数据） =====
  async renderOrderStatusChart(stats) {
    const canvas = document.getElementById('orderStatusCanvas');
    if (!canvas) return;
    if (this.orderStatusChart) { this.orderStatusChart.destroy(); this.orderStatusChart = null; }

    // 直接使用统一计算的 stats 值（已按订单编号去重），不再单独查询数据库
    const pendingReview = stats.pendingReview || 0;   // 待审：审批状态 ≠ 审批通过
    const approved = stats.approved || 0;            // 已审：审批通过
    const inTransit = stats.inTransit || 0;          // 在途：未入库量 > 0（未完全入库）
    const legend = document.getElementById('orderStatusLegend');
    if (legend) {
      legend.innerHTML = `
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#FBBF24;"></span>待审 ${pendingReview} 单</div>
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#6DBF9F;"></span>已审 ${approved} 单</div>
        <div class="donut-legend-item"><span class="donut-legend-dot" style="background:#D49595;"></span>在途 ${inTransit} 单</div>
      `;
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    this.orderStatusChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [pendingReview, approved, inTransit].filter(v => v > 0),
          backgroundColor: isDark
            ? ['#FBBF24', '#34D399', '#FB7185']
            : ['#FBBF24', '#6DBF9F', '#D49595'],
          borderColor: isDark ? '#0F172A' : '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 8,
          offset: [0, 0, 0]
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
  }
};
