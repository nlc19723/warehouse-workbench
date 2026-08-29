// ============================================
// 库存预警模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const InventoryAlertModule = {
  currentFilter: { keyword: '', category: '', status: 'yes' },
  currentPage: 1,
  pageSize: 20,
  currentData: [],

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="alertKw" placeholder="搜索物料名称、编码..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')InventoryAlertModule.applyFilter()">
        <select id="alertCategory">
          <option value="">全部分类</option>
          <option value="A" ${this.currentFilter.category === 'A' ? 'selected' : ''}>A类</option>
          <option value="B" ${this.currentFilter.category === 'B' ? 'selected' : ''}>B类</option>
          <option value="C" ${this.currentFilter.category === 'C' ? 'selected' : ''}>C类</option>
          <option value="不使用类" ${this.currentFilter.category === '不使用类' ? 'selected' : ''}>不使用类</option>
        </select>
        <select id="alertStatus" onchange="InventoryAlertModule.applyFilter()">
          <option value="yes" ${this.currentFilter.status === 'yes' ? 'selected' : ''}>需补货</option>
          <option value="no" ${this.currentFilter.status === 'no' ? 'selected' : ''}>正常</option>
          <option value="" ${this.currentFilter.status === '' ? 'selected' : ''}>全部状态</option>
        </select>
        <button class="search-glass" onclick="InventoryAlertModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="InventoryAlertModule.resetFilter()">重置</button>
        <button class="secondary" onclick="InventoryAlertModule.exportData()">📥 导出</button>
      </div>

      <div id="alertSummary"></div>
      <div id="alertTableArea"></div>
      <div id="alertPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    let alerts = await DataStore.getInventoryAlerts();

    // ===== 补货值：直接使用导入时从源数据"是否需补货"(J列)读取的原始数值 =====
    // 不做任何回退计算；若值为空(NaN)则设为0
    alerts.forEach(a => {
      const v = parseFloat(a.补货值);
      a.补货值 = isNaN(v) ? 0 : v;
    });

    // 从 stock（中心库房现存量）表交叉获取真实现存量
    try {
      const stockRows = await DataStore.getStock();
      const stockByCode = new Map();
      const stockByNameSpec = new Map();
      stockRows.forEach(s => {
        if (s.存货编码) stockByCode.set(String(s.存货编码), s.现存数量);
        if (s.存货名称) {
          const key = TableUtils.buildStockKey(s.存货名称, s.规格型号);
          stockByNameSpec.set(key, s.现存数量);
        }
      });
      let fixedCount = 0;
      alerts.forEach(a => {
        if (!a.现存量 || a.现存量 === 0) {
          if (a.存货编码 && stockByCode.has(String(a.存货编码))) {
            a.现存量 = stockByCode.get(String(a.存货编码)); fixedCount++;
          }
          else if (a.存货名称) {
            const key = TableUtils.buildStockKey(a.存货名称, a.规格型号);
            if (stockByNameSpec.has(key)) { a.现存量 = stockByNameSpec.get(key); fixedCount++; }
            else {
              for (const [k, v] of stockByNameSpec) {
                if (k.startsWith((a.存货名称 || '').replace(/\s+/g, ''))) { a.现存量 = v; fixedCount++; break; }
              }
            }
          }
        }
        // 注意：不再重算补货值，保留源数据原始值
      });
      if (fixedCount > 0) console.log(`[inventory-alert] 从库存表补全 ${fixedCount}/${alerts.length} 条现存量`);
    } catch(e) { console.warn('[inventory-alert] 库存表关联失败:', e); }

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
    if (status === 'yes') {
      alerts = alerts.filter(a => (a.补货值 && a.补货值 > 0));
    } else if (status === 'no') {
      alerts = alerts.filter(a => !a.补货值 || a.补货值 <= 0);
    }

    const needRestock = alerts.filter(a => a.补货值 && a.补货值 > 0);
    const totalNeedQty = needRestock.reduce((s, a) => s + (parseFloat(a.补货值) || 0), 0);

    if (rt !== undefined && rt !== App._goToken) return;
    document.getElementById('alertSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货种类</div>
          <div class="kpi-value">${needRestock.length}<span class="kpi-unit">/ ${alerts.length}</span></div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">需补货量(在途)</div>
          <div class="kpi-value">${TableUtils.formatNum(totalNeedQty)}</div>
        </div>
      </div>
    `;

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
      document.getElementById('alertPagination').innerHTML = '';
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
            </tr>
          </thead>
          <tbody>
            ${items.map(a => {
              const needRestock = (a.补货值 && a.补货值 > 0) ? true : false;
              return `
                <tr class="${needRestock ? 'row-warning' : ''}">
                  <td>${TableUtils.link('stock', a.存货编码 ?? '', a.存货编码 ?? '')}</td>
                  <td><strong>${esc(a.存货名称 ?? '')}</strong></td>
                  <td>${esc(a.规格型号 ?? '')}</td>
                  <td>${a.分类 ? `<span class="tag ${a.分类 === 'A' ? 'tag-success' : a.分类 === 'B' ? 'tag-warning' : 'tag-neutral'}">${esc(a.分类)}</span>` : ''}</td>
                  <td>${TableUtils.formatNum(a.近一年月均入库量)}</td>
                  <td>${TableUtils.formatNum(a.最低库存预警)}</td>
                  <td>${TableUtils.formatNum(a.最高库存)}</td>
                  <td>${TableUtils.formatNum(a.现存量)}</td>
                  <td style="${needRestock ? 'color:var(--status-danger);font-weight:600;' : ''}">${TableUtils.formatNum(a.补货值)}</td>
                  <td>${TableUtils.formatNum(a.在途订单)}</td>
                  <td>${needRestock ? '<span class="tag tag-danger">需补货</span>' : '<span class="tag tag-success">正常</span>'}</td>
                  <td>${esc(String(a.所上或库房 ?? '').substring(0, 15))}${String(a.所上或库房 ?? '').length > 15 ? '...' : ''}</td>
                  <td>${esc(String(a.工程项目 ?? '').substring(0, 15))}${String(a.工程项目 ?? '').length > 15 ? '...' : ''}</td>
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
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(this.currentData, `库存预警_${new Date().toISOString().split('T')[0]}.xlsx`, '库存预警');
  }
};
