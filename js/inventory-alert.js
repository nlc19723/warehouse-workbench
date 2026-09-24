// ============================================
// 库存预警模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const InventoryAlertModule = {
  currentFilter: { keyword: '', category: '', status: 'yes' },
  currentPage: 1,
  pageSize: AppConfig.app.defaultPageSize,
  currentData: [],

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar filter-bar-m">
        <input type="text" id="alertKw" class="fb-search" placeholder="搜索物料名称、编码..." value="${escAttr(this.currentFilter.keyword || '')}" onkeydown="if(event.key==='Enter')InventoryAlertModule.applyFilter()">
        <div class="fb-row fb-row--fields">
          <div class="fb-field"><select id="alertCategory">
            <option value="">全部分类</option>
            <option value="A" ${this.currentFilter.category === 'A' ? 'selected' : ''}>A类</option>
            <option value="A工程类" ${this.currentFilter.category === 'A工程类' ? 'selected' : ''}>A工程类</option>
            <option value="B" ${this.currentFilter.category === 'B' ? 'selected' : ''}>B类</option>
            <option value="C" ${this.currentFilter.category === 'C' ? 'selected' : ''}>C类</option>
            <option value="C工程类" ${this.currentFilter.category === 'C工程类' ? 'selected' : ''}>C工程类</option>
            <option value="D" ${this.currentFilter.category === 'D' ? 'selected' : ''}>D类</option>
            <option value="未使用类" ${this.currentFilter.category === '未使用类' ? 'selected' : ''}>未使用类</option>
          </select></div>
          <div class="fb-field"><select id="alertStatus" onchange="InventoryAlertModule.applyFilter()">
            <option value="yes" ${this.currentFilter.status === 'yes' ? 'selected' : ''}>需补货</option>
            <option value="urgent" ${this.currentFilter.status === 'urgent' ? 'selected' : ''}>急</option>
            <option value="no" ${this.currentFilter.status === 'no' ? 'selected' : ''}>正常</option>
            <option value="" ${this.currentFilter.status === '' ? 'selected' : ''}>全部状态</option>
          </select></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="InventoryAlertModule.applyFilter()">筛选</button>
          <button class="btn--ghost" onclick="InventoryAlertModule.resetFilter()">重置</button>
          <button class="btn--ghost" onclick="InventoryAlertModule.exportData()">📥 导出</button>
        </div>
      </div>

      <div id="alertSummary"></div>
      <div id="alertTableArea"></div>
      <div id="alertPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    // 🟢 v227.58：移动端筛选栏下拉框按内部最长选项字符长度动态等分（文本框两行等长）
    if (window.FilterLayout) FilterLayout.balanceAll();

    await this.loadData(myToken);
  },

  /**
   * 🟢 v229.04：全派生装配（共享方法）
   * 存货编码/名称/规格/现存量 ← 现存量主档 stock；最低/最高 ← 配置水位；分类/月均 ← 入库快照；
   * 在途/仓库/项目 ← 订单拆分；补货值/状态 ← 带状触发；类型 ← 合同价格关联。
   * 库存预警模块与查询系统「存量」板块共用本方法，保证两处数据同源同值。
   */
  async buildDerivedAlerts() {
    let stockRows, orderRows, inboundRows, pricingRows;
    try {
      [stockRows, orderRows, inboundRows, pricingRows] = await Promise.all([
        DataStore.getStock(),
        DataStore.getRows('orders'),
        DataStore.getRows('inbound'),
        DataStore.getRows('pricing')
      ]);
    } catch (e) { console.warn('[inventory-alert] 数据加载失败:', e); return []; }

    // 类型：合同价格表编码关联（一码多价取首个非空类型）
    const typeByCode = new Map();
    pricingRows.forEach(p => {
      const code = String(p.存货编码 ?? '').trim();
      if (code && !typeByCode.has(code)) typeByCode.set(code, p.类型 || '');
    });

    // 分类快照 + 月均入库（入库列表聚合；数据不刷新时命中缓存）
    const snap = StockAlertRules.computeClassificationSnapshot(inboundRows);
    // 在途拆分（订单列表：全部/仓库/项目）
    const ordersMap = StockAlertRules.computeOrdersSplit(orderRows);
    const CFG = window.StockAlertConfig;

    return stockRows.map(s => {
      const code = String(s.存货编码 || '').trim();
      const name = s.存货名称 || '';
      const lv = CFG.STOCK_LEVELS[code] || [0, 0];
      const onhand = parseFloat(s.现存数量) || 0;
      const cls = snap.get(code);
      const os = ordersMap.get(code) || { all: 0, wh: 0, proj: 0 };
      const rs = StockAlertRules.computeRestock(code, name, lv[0], lv[1], onhand);
      return {
        存货编码: code,
        存货名称: name,
        规格型号: s.规格型号 || '',
        分类: cls ? cls.cat : '未使用类',
        近一年月均入库量: cls ? cls.K : 0,
        最低库存预警: lv[0],
        最高库存: lv[1],
        现存量: onhand,
        补货值: rs.value,
        派生状态: rs.status,
        在途订单: StockAlertRules.round2(os.all),
        所上或库房: StockAlertRules.round2(os.wh),
        工程项目: StockAlertRules.round2(os.proj),
        类型: typeByCode.get(code) || ''
      };
    });
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;

    // 🟢 v229.04：v229.00 全派生装配抽为 buildDerivedAlerts（查询系统存量板块同源复用）
    let alerts = await this.buildDerivedAlerts();
    if (!alerts.length) return;

    const kw = (this.currentFilter.keyword || '').replace(/\s+/g, '').toLowerCase();
    const category = this.currentFilter.category || '';
    // 状态默认「需补货」，但允许用户切换其他状态
    const status = this.currentFilter.status || '';

    if (kw) {
      // 🟡 M9：输入侧已归一化（去空白），数据侧同样去空白再比较，避免含空格/全角空格的存货名称匹配失败
      alerts = alerts.filter(a =>
        (a.存货名称 && a.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
        (a.存货编码 && String(a.存货编码).replace(/\s+/g, '').toLowerCase().includes(kw))
      );
    }
    if (category) {
      alerts = alerts.filter(a => a.分类 === category);
    }
    // 🟢 v229.00：状态三态（急/需补货/正常）由规则派生，急也计入需补货
    if (status === 'yes') {
      alerts = alerts.filter(a => a.派生状态 !== '正常');
    } else if (status === 'urgent') {
      alerts = alerts.filter(a => a.派生状态 === '急');
    } else if (status === 'no') {
      alerts = alerts.filter(a => a.派生状态 === '正常');
    }

    const needRestock = alerts.filter(a => a.派生状态 !== '正常');
    const totalNeedQty = needRestock.reduce((s, a) => s + (parseFloat(a.补货值) || 0), 0);
    const urgentCount = alerts.filter(a => a.派生状态 === '急').length;

    if (rt !== undefined && rt !== App._goToken) return;
    TableUtils.setHtml('alertSummary', `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货种类</div>
          <div class="kpi-value">${needRestock.length}<span class="kpi-unit">/ ${alerts.length}</span></div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货量</div>
          <div class="kpi-value">${TableUtils.formatNum(totalNeedQty)}</div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">急(已穿带下)</div>
          <div class="kpi-value">${urgentCount}</div>
        </div>
      </div>
    `);

    this.currentData = alerts;
    this.renderTable(rt);
  },

  applyFilter() {
    this.currentFilter.keyword = (document.getElementById('alertKw')?.value || '').trim();
    this.currentFilter.category = document.getElementById('alertCategory')?.value || '';
    this.currentFilter.status = document.getElementById('alertStatus')?.value || '';
    this.currentPage = 1;
    this.loadData();
  },

  resetFilter() {
    this.currentFilter = { keyword: '', category: '', status: 'yes' };
    this.currentPage = 1;
    const kwInput = document.getElementById('alertKw');
    const catSelect = document.getElementById('alertCategory');
    const statusSelect = document.getElementById('alertStatus');
    if (kwInput) kwInput.value = '';
    if (catSelect) catSelect.value = '';
    if (statusSelect) statusSelect.value = 'yes';
    this.loadData();
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

    const area = document.getElementById('alertTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无预警数据</div></div>';
      TableUtils.setHtml('alertPagination', '');
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table" data-table-key="inventoryAlert">
          <thead>
            <tr>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>分类</th>
              <th>月均入库</th>
              <th>最低库存</th>
              <th>最高库存</th>
              <th>现存量</th>
              <th>补货值</th>
              <th>在途订单</th>
              <th>状态</th>
              <th>仓库</th>
              <th>项目</th>
              <th>类型</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(a => {
              // 🟢 v229.00：状态三态渲染（急/需补货/正常），补货值>0 红色加粗
              const st = a.派生状态 || '正常';
              const needRestock = st !== '正常';
              const catTag = (a.分类 === 'A' || a.分类 === 'A工程类') ? 'tag-success'
                : a.分类 === 'B' ? 'tag-warning' : 'tag-neutral';
              return `
                <tr class="${needRestock ? 'row-warning' : ''}">
                  <td>${TableUtils.link('stock', a.存货编码 ?? '', a.存货编码 ?? '')}</td>
                  <td><strong>${esc(a.存货名称 ?? '')}</strong></td>
                  <td>${esc(a.规格型号 ?? '')}</td>
                  <td>${a.分类 ? `<span class="tag ${catTag}">${esc(a.分类)}</span>` : ''}</td>
                  <td>${TableUtils.formatNum(a.近一年月均入库量)}</td>
                  <td>${TableUtils.formatNum(a.最低库存预警)}</td>
                  <td>${TableUtils.formatNum(a.最高库存)}</td>
                  <td>${TableUtils.formatNum(a.现存量)}</td>
                  <td style="${needRestock ? 'color:var(--status-danger);font-weight:600;' : ''}">${a.补货值 ? TableUtils.formatNum(a.补货值) : ''}</td>
                  <td>${a.在途订单 ? TableUtils.formatNum(a.在途订单) : ''}</td>
                  <td>${st === '急' ? '<span class="tag tag-danger">急</span>' : st === '需补货' ? '<span class="tag tag-warning">需补货</span>' : '<span class="tag tag-success">正常</span>'}</td>
                  <td>${a.所上或库房 ? esc(String(a.所上或库房).substring(0, 15)) + (String(a.所上或库房).length > 15 ? '...' : '') : ''}</td>
                  <td>${a.工程项目 ? esc(String(a.工程项目).substring(0, 15)) + (String(a.工程项目).length > 15 ? '...' : '') : ''}</td>
                  <td>${esc(String(a.类型 ?? '').substring(0, 15))}${String(a.类型 ?? '').length > 15 ? '...' : ''}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('alertPagination', { module: 'InventoryAlertModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    TableUtils.initSmartSelect('alertTableArea');
    TableUtils.initSortableHeaders('alertTableArea');
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.currentPage = 1;
    this.renderTable();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    // 🟢 v229.03：导出列 = 工作台表格当前 14 列（列名与表头一致），不再导出内部字段名
    const cols = ['存货编码', '存货名称', '规格型号', '分类',
      { key: '近一年月均入库量', title: '月均入库' },
      { key: '最低库存预警', title: '最低库存' }, '最高库存', '现存量', '补货值', '在途订单',
      { key: '派生状态', title: '状态' },
      { key: '所上或库房', title: '仓库' },
      { key: '工程项目', title: '项目' }, '类型'];
    TableUtils.exportToExcel(this.currentData, `库存预警_${new Date().toISOString().split('T')[0]}.xlsx`, '库存预警', cols);
  }
};
