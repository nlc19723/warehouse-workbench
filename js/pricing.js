// ============================================
// 合同价格模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const PricingModule = {
  currentData: [],
  currentPage: 1,
  pageSize: 20,
  currentFilter: {}, // 跨模块带参跳转（M1）：App.go 注入的 { keyword } 自动填入搜索框

  // 计算默认生效日期区间：最小生效日期 至 今日
  getDefaultDateRange(pricing) {
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    const end = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    let minDate = '';
    if (pricing && pricing.length > 0) {
      const dates = pricing.map(p => p.生效日期).filter(Boolean).sort();
      if (dates.length > 0) minDate = dates[0];
    }
    return { start: minDate || end, end };
  },

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    const allPricing = await DataStore.getPricing();
    const [suppliers, types] = await Promise.all([
      Promise.resolve([...new Set(allPricing.map(p => p.供应商).filter(Boolean))].sort()),
      DataStore.getPricingTypes()
    ]);

    // 首次进入：根据数据自动填充默认生效日期区间
    const dr = this.getDefaultDateRange(allPricing);
    if (!this.currentFilter) this.currentFilter = {};
    if (!this.currentFilter.startDate) this.currentFilter.startDate = dr.start;
    if (!this.currentFilter.endDate) this.currentFilter.endDate = dr.end;

    if (myToken !== undefined && myToken !== App._goToken) return;

    // 清理可能遗留的旧日期选择器弹窗（render 会重建 input）
    if (typeof DatePicker !== 'undefined') DatePicker.unmountAll();

    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="pricingKw" placeholder="搜索供应商、物料..." value="${this.currentFilter.keyword || ''}" onkeydown="if(event.key==='Enter')PricingModule.applyFilter()">
        <select id="pricingSupplier">
          <option value="">全部供应商</option>
          ${suppliers.map(s => `<option value="${s}" ${this.currentFilter.供应商 === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <select id="pricingType">
          <option value="">全部类型</option>
          ${types.map(t => `<option value="${t}" ${this.currentFilter.类型 === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
        <input type="text" id="pricingStartDate" value="${this.currentFilter.startDate || ''}" class="filter-date dp-input" placeholder="生效起始日期" title="生效起始日期" onchange="PricingModule.onDateChange()" readonly>
        <span class="filter-sep">至</span>
        <input type="text" id="pricingEndDate" value="${this.currentFilter.endDate || ''}" class="filter-date dp-input" placeholder="生效结束日期" title="生效结束日期" onchange="PricingModule.onDateChange()" readonly>
        <button class="search-glass" onclick="PricingModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="PricingModule.resetFilter()">重置</button>
        <button class="secondary" onclick="PricingModule.exportData()">📥 导出</button>
      </div>

      <div id="pricingSummary"></div>
      <div id="pricingTableArea"></div>
      <div id="pricingPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    if (window.enhanceSearchSelect) {
      enhanceSearchSelect('pricingSupplier', { placeholder: '搜索供应商', widthMode: 'full' });
    }

    // 挂载自定义日期选择器（替换原生 type=date，保持 id 与 change 事件不变）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.mount('pricingStartDate');
      DatePicker.mount('pricingEndDate');
    }

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    let pricing = await DataStore.getPricing();
    const kw = (this.currentFilter.keyword || '').trim().toLowerCase();
    const supplier = this.currentFilter.供应商 || '';
    const type = this.currentFilter.类型 || '';
    const startDate = this.currentFilter.startDate || '';
    const endDate = this.currentFilter.endDate || '';

    if (kw) {
      pricing = pricing.filter(p =>
        (p.供应商 && p.供应商.toLowerCase().includes(kw)) ||
        (p.存货名称 && p.存货名称.toLowerCase().includes(kw))
      );
    }
    if (supplier) pricing = pricing.filter(p => p.供应商 === supplier);
    if (type) pricing = pricing.filter(p => p.类型 === type);
    if (startDate || endDate) {
      pricing = pricing.filter(p => {
        if (!p.生效日期) return false;
        if (startDate && p.生效日期 < startDate) return false;
        if (endDate && p.生效日期 > endDate) return false;
        return true;
      });
    }

    const now = new Date();
    const active = pricing.filter(p => {
      if (!p.生效日期 || !p.失效日期) return false;
      return new Date(p.生效日期) <= now && new Date(p.失效日期) >= now;
    });
    const avgPrice = active.length > 0 ? active.reduce((s, p) => s + (parseFloat(p.含税单价) || 0), 0) / active.length : 0;

    if (rt !== undefined && rt !== App._goToken) return;
    document.getElementById('pricingSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-info">
          <div class="kpi-label">价格记录数</div>
          <div class="kpi-value">${pricing.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">有效价格</div>
          <div class="kpi-value">${active.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">平均含税价</div>
          <div class="kpi-value">¥${TableUtils.formatMoney(avgPrice)}</div>
        </div>
      </div>
    `;

    this.currentData = pricing;
    this.renderTable(rt);
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
    const now = new Date();

    const area = document.getElementById('pricingTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无价格数据</div></div>';
      document.getElementById('pricingPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>供应商</th>
              <th>类型</th>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>单位</th>
              <th>含税单价</th>
              <th>税率</th>
              <th>不含税单价</th>
              <th>生效日期</th>
              <th>失效日期</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(p => {
              let status = '<span class="tag tag-neutral">未知</span>';
              if (p.生效日期 && p.失效日期) {
                const start = new Date(p.生效日期);
                const end = new Date(p.失效日期);
                if (now < start) status = '<span class="tag tag-info">未生效</span>';
                else if (now > end) status = '<span class="tag tag-neutral">已失效</span>';
                else status = '<span class="tag tag-success">有效</span>';
              }
              return `
                <tr>
                  <td>${TableUtils.link('supplier', p.供应商 ?? '', p.供应商 ?? '')}</td>
                  <td>${esc(p.类型 ?? '')}</td>
                  <td>${TableUtils.link('stock', p.存货编码 ?? '', p.存货编码 ?? '')}</td>
                  <td><strong>${esc(p.存货名称 ?? '')}</strong></td>
                  <td>${esc(p.规格型号 ?? '')}</td>
                  <td>${esc(p.主计量 ?? '')}</td>
                  <td><strong>¥${TableUtils.formatMoney(p.含税单价)}</strong></td>
                  <td>${p.税率 ? esc(p.税率) + '%' : ''}</td>
                  <td>¥${TableUtils.formatMoney(p.单价)}</td>
                  <td>${esc(p.生效日期 ?? '')}</td>
                  <td>${esc(p.失效日期 ?? '')}</td>
                  <td>${status}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('pricingPagination', { module: 'PricingModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    TableUtils.initSmartSelect('pricingTableArea');
    TableUtils.initSortableHeaders('pricingTableArea');
  },

  onDateChange() {
    const startInput = document.getElementById('pricingStartDate');
    const endInput = document.getElementById('pricingEndDate');
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
      keyword: (document.getElementById('pricingKw')?.value || '').trim(),
      供应商: document.getElementById('pricingSupplier')?.value || '',
      类型: document.getElementById('pricingType')?.value || '',
      startDate: document.getElementById('pricingStartDate')?.value || '',
      endDate: document.getElementById('pricingEndDate')?.value || ''
    };
    this.currentPage = 1;
    this.loadData();
  },

  async resetFilter() {
    const allPricing = await DataStore.getPricing();
    const dr = this.getDefaultDateRange(allPricing);
    this.currentFilter = { keyword: '', 供应商: '', 类型: '', startDate: dr.start, endDate: dr.end };
    this.currentPage = 1;
    this.pageSize = 20;
    const kwInput = document.getElementById('pricingKw');
    const supSelect = document.getElementById('pricingSupplier');
    const typeSelect = document.getElementById('pricingType');
    const startInput = document.getElementById('pricingStartDate');
    const endInput = document.getElementById('pricingEndDate');
    if (kwInput) kwInput.value = '';
    if (supSelect) supSelect.value = '';
    if (typeSelect) typeSelect.value = '';
    if (startInput) startInput.value = dr.start;
    if (endInput) endInput.value = dr.end;
    this.loadData();
  },

  goPage(p) { this.currentPage = p; this.renderTable(); },

  exportData() {
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(this.currentData, `合同价格_${new Date().toISOString().split('T')[0]}.xlsx`, '合同价格');
  }
};
