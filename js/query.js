// ============================================
// 查询系统 V4 - 板块高亮修复 · 自动搜索 · 分页优化
// ============================================

const QueryModule = {
  currentTab: 'stock', // stock | orders | inbound | pricing
  page: 1, pageSize: AppConfig.app.queryPageSize,
  searchKW: '', results: [],
  currentFilter: {}, // 跨模块带参跳转（M1）：App.go 注入的 { keyword } 自动触发搜索
  startDate: '',
  endDate: '',
  HISTORY_KEY: 'wb_query_search_history',
  HISTORY_MAX: 5,
  _historyOpen: false,

  // 默认固定日期区间：3 个月前的 1 号 → 今日（按本地时区格式化）
  getDefaultDateRange() {
    const pad = n => String(n).padStart(2, '0');
    const today = new Date();
    const end = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const start = new Date(today.getFullYear(), today.getMonth() - 3, 1);
    const startStr = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
    return { start: startStr, end };
  },

  tabs: [
    { id: 'stock', label: '存量', icon: '🏪' },
    { id: 'orders', label: '订单', icon: '📝' },
    { id: 'inbound', label: '入库', icon: '📥' },
    { id: 'pricing', label: '供应商价格', icon: '💰' },
  ],

  // 🟢 O11：表头单一数据源 —— 始终从实际数据对象键动态派生，不再维护冗余 columns 列表
  // （无数据兜底返回空数组；renderResults 在 total===0 时走 empty-state，不会用此渲染表头）
  getColumns() {
    const data = (this.fullData && this.fullData.length) ? this.fullData : this.results;
    if (data && data.length) return Object.keys(data[0]);
    return [];
  },

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    // 跨模块带参跳转（M1）：App.go 注入的 currentFilter.keyword 自动触发搜索
    if (this.currentFilter && this.currentFilter.keyword) {
      this.searchKW = this.currentFilter.keyword;
      this.currentFilter.keyword = '';
    }
    // 首次进入时初始化固定日期区间；用户可修改，切出切回不重置
    if (!this.startDate || !this.endDate) {
      const dr = this.getDefaultDateRange();
      this.startDate = dr.start;
      this.endDate = dr.end;
    }

    const content = document.getElementById('contentArea');

    // 清理可能遗留的旧日期选择器弹窗（render 会重建 input）
    if (typeof DatePicker !== 'undefined') DatePicker.unmountAll();

    const tabBtns = this.tabs.map(t =>
      `<button class="tab-btn ${t.id === this.currentTab ? 'active' : ''}" onclick="QueryModule.switchTab('${t.id}')">${t.icon} ${t.label}</button>`
    ).join('');

    // 日期区间：与 tab 分开显示，仅约束订单 / 入库两个板块；首次默认近 3 个月，可编辑
    // 版式与订单列表完全一致：日期框放在 .filter-bar 内，与搜索框、按钮同一行
    content.innerHTML = `
      <div class="tab-bar" style="display:flex;align-items:center;gap:4px;">${tabBtns}</div>
      <div class="filter-bar filter-bar-m" style="margin-bottom:14px;">
        <input type="text" id="querySearch" class="fb-search filter-search-short" autocomplete="off" placeholder="多关键词搜索（空格/逗号分隔）..." value="${this.escapeHtml(this.searchKW)}" onkeydown="if(event.key==='Enter')QueryModule.doSearch()" onfocus="QueryModule.showHistory()">
        <div class="fb-row fb-row--date">
          <div class="fb-field"><input type="text" id="queryStartDate" value="${escAttr(this.startDate)}" class="filter-date dp-input" placeholder="起始日期" title="起始日期" onchange="QueryModule.onDateChange()" readonly></div>
          <span class="fb-sep filter-sep">至</span>
          <div class="fb-field"><input type="text" id="queryEndDate" value="${escAttr(this.endDate)}" class="filter-date dp-input" placeholder="结束日期" title="结束日期" onchange="QueryModule.onDateChange()" readonly></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="QueryModule.doSearch()">搜索</button>
          <button class="btn--ghost" onclick="QueryModule.clearSearch()">清空</button>
        </div>
      </div>
      <div id="queryResultArea"></div>
    `;

    // 挂载自定义日期选择器（替换原生 type=date，保持 id 与 change 事件不变）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.mount('queryStartDate');
      DatePicker.mount('queryEndDate');
    }
    // 🟢 v227.58：移动端筛选栏分轨（查询系统无下拉框，仅分日期组/按钮行）
    if (window.FilterLayout) FilterLayout.balanceAll();

    if (this.results.length > 0) {
      this.renderResults(myToken);
    } else if (this.searchKW) {
      // 有搜索词但无结果：先加载数据再搜索
      await this.loadTabData(myToken);
      if (this.searchKW) this.doSearchSilent();
    } else {
      await this.loadTabData(myToken);
    }
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  switchTab(tabId) {
    this.currentTab = tabId;
    this.page = 1;
    this.results = [];
    // 🟢 v209 AUDIT-107：传入 token 启用竞态守卫（快速切 tab 时旧渲染自动失效），并补 catch 避免异常静默
    const token = (App._goToken = (App._goToken || 0) + 1);
    this.render(token).catch(e => console.error('[query] switchTab 渲染失败:', e));
  },

  async loadTabData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    const data = await this.fetchTabData();
    this.fullData = data;   // 全量原始数据，二次搜索始终基于它重新过滤（避免在上次结果集上叠加过滤）
    this.results = data;
    if (!this.searchKW) {
      this.renderResults(rt);
    }
  },

  async fetchTabData() {
    switch (this.currentTab) {
      case 'stock': {
        const alerts = await DataStore.getRows('inventoryAlerts');
        // 从 stock（中心库房现存量）表获取真实库存数据
        const stockRows = await DataStore.getRows('stock');
        const stockByCode = new Map();
        const stockByNameSpec = new Map();
        stockRows.forEach(s => {
          if (s.存货编码) stockByCode.set(String(s.存货编码), s.现存数量);
          if (s.存货名称) {
            const key = TableUtils.buildStockKey(s.存货名称, s.规格型号);
            stockByNameSpec.set(key, s.现存数量);
          }
        });

        return alerts.map((a, idx) => {
          // 交叉获取真实现存量
          let realStock = a.现存量 || 0;
          if (!realStock || realStock === 0) {
            if (a.存货编码 && stockByCode.has(String(a.存货编码))) {
              realStock = stockByCode.get(String(a.存货编码));
            } else if (a.存货名称) {
              const key = TableUtils.buildStockKey(a.存货名称, a.规格型号);
              if (stockByNameSpec.has(key)) realStock = stockByNameSpec.get(key);
              else {
                for (const [k, v] of stockByNameSpec) {
                  if (k.startsWith((a.存货名称 || '').replace(/\s+/g, ''))) { realStock = v; break; }
                }
              }
            }
          }
          return {
            '序号': idx + 1,
            '存货编码': a.存货编码 || '',
            '存货名称': a.存货名称 || '',
            '规格型号': a.规格型号 || '',
            '月均入库量': a.近一年月均入库量 || 0,
            '现存量': realStock,
            // 🟢 v228.03：这两列值为 0 时留空（不显示 0），避免满屏 0 干扰阅读；非 0 值照常显示
            '是否需补货': a.补货值 || '',
            '在途订单': a.在途订单 || '',
            '所上或库房': a.所上或库房 || '',
            '工程项目': a.工程项目 || '',
          };
        });
      }
      case 'orders': {
        const orders = await DataStore.getRows('orders');
        let list = orders.map(o => ({
          '订单编号': o.订单编号 || '',
          '日期': o.日期 || '',
          '项目名称': o.项目名称 || '',
          '供应商': o.供应商 || '',
          '存货编号': o.存货编号 || '',
          '存货名称': o.存货名称 || '',
          '规格型号': o.规格型号 || '',
          '订单量': o.数量 || 0,
          '未入库订单量': o.未入库量 || 0,
        }));
        list = this._filterByDateRange(list, '日期');
        return list;
      }
      case 'inbound': {
        const inbound = await DataStore.getRows('inbound');
        let list = inbound.map(i => ({
          '订单编号': i.表体订单号 || '',  // 🟢 v190：列名与入库列表对齐（与入库表单体订单号同字段）
          '入库日期': i.入库日期 || '',
          '项目名称': i.项目名称 || '',
          '入库单号': i.入库单号 || '',
          '供应商': i.供应商 || '',
          '存货编码': i.存货编码 || '',
          '存货名称': i.存货名称 || '',
          '规格型号': i.规格型号 || '',
          '入库量': i.数量 || 0,
        }));
        list = this._filterByDateRange(list, '入库日期');
        return list;
      }
      case 'pricing': {
        const pricing = await DataStore.getRows('pricing');
        return pricing.map(p => ({
          '供应商': p.供应商 || '',
          '存货编码': p.存货编码 || '',
          '存货名称': p.存货名称 || '',
          '规格型号': p.规格型号 || '',
          '主计量': p.主计量 || '',
          '生效日期': p.生效日期 || '',
          '失效日期': p.失效日期 || '',
          '含税单价': p.含税单价 || 0,
        }));
      }
      default: return [];
    }
  },

  doSearch() {
    const input = document.getElementById('querySearch');
    if (input) this.searchKW = input.value.trim();
    if (!this.searchKW) { this.loadTabData(); return; }
    this.saveHistoryAsync(this.searchKW);
    this.performSearch();
    this.renderResults();
    this.hideHistory();
  },

  // 静默搜索（不读取 input，用已有 searchKW）
  doSearchSilent() {
    if (!this.searchKW) return;
    this.performSearch();
    this.renderResults();
  },

  performSearch() {
    const keywords = this.searchKW.split(/[\s,，]+/).filter(Boolean).map(k => k.toLowerCase());
    const cols = this.getColumns();
    // 始终基于全量原始数据 fullData 过滤，再写入 results（二次搜索不会在上次结果集上叠加）
    const base = (this.fullData && this.fullData.length) ? this.fullData : this.results;
    if (keywords.length > 0) {
      this.results = base.filter(row =>
        keywords.every(kw =>
          cols.some(col => {
            const val = row[col];
            return val !== undefined && val !== null && String(val).toLowerCase().includes(kw);
          })
        )
      );
    } else {
      this.results = base.slice();
    }
    this.page = 1;
  },

  clearSearch() {
    this.searchKW = '';
    const input = document.getElementById('querySearch');
    if (input) input.value = '';
    this.loadTabData();
  },

  // ===== 搜索历史（localStorage 长期记忆，最近 5 条）=====
  getHistory() {
    try {
      const raw = localStorage.getItem(this.HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(Boolean).slice(0, this.HISTORY_MAX) : [];
    } catch (e) { return []; }
  },
  // 读取搜索历史：优先云端设置（跨设备），无云端回退 localStorage
  async getHistoryAsync() {
    if (typeof DataStore !== 'undefined' && DataStore.getSetting) {
      try {
        const cloud = await DataStore.getSetting('search_history_query');
        if (Array.isArray(cloud) && cloud.length) return cloud.slice(0, this.HISTORY_MAX);
      } catch (e) {
    console.warn('[query.js:277] 异常(已忽略):', e);
  }
    }
    return this.getHistory();
  },
  // 保存搜索历史：localStorage + 云端双写
  async saveHistoryAsync(kw) {
    kw = (kw || '').trim();
    if (!kw) return;
    let arr = this.getHistory().filter(k => k !== kw);
    arr.unshift(kw);
    arr = arr.slice(0, this.HISTORY_MAX);
    try { localStorage.setItem(this.HISTORY_KEY, JSON.stringify(arr)); } catch (e) {
    console.warn('[query.js:288] 异常(已忽略):', e);
  }
    if (typeof DataStore !== 'undefined' && DataStore.setSetting) {
      DataStore.setSetting('search_history_query', arr).catch(() => {});
    }
  },
  removeHistory(kw) {
    const arr = this.getHistory().filter(k => k !== kw);
    try { localStorage.setItem(this.HISTORY_KEY, JSON.stringify(arr)); } catch (e) {
    console.warn('[query.js:295] 异常(已忽略):', e);
  }
    if (this._historyOpen) this.showHistory();
  },
  clearHistory() {
    try { localStorage.removeItem(this.HISTORY_KEY); } catch (e) {
    console.warn('[query.js:299] 异常(已忽略):', e);
  }
    this.hideHistory();
  },

  // 显示历史对话框（模仿浏览器"保存的信息"浮层样式）
  async showHistory() {
    const input = document.getElementById('querySearch');
    if (!input) return;
    const list = await this.getHistoryAsync();
    let pop = document.getElementById('qhPop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'qhPop';
      pop.className = 'qh-pop';
      document.body.appendChild(pop);
      pop.addEventListener('mousedown', (e) => e.preventDefault()); // 防失焦关闭导致点不到
      pop.addEventListener('click', (e) => {
        const item = e.target.closest('.qh-item');
        const del = e.target.closest('.qh-del');
        if (del) { this.removeHistory(del.dataset.kw); return; }
        if (item) { this.applyHistory(item.dataset.kw); }
      });
    }
    if (!list.length) { this.hideHistory(); return; }
    pop.innerHTML = `
      <div class="qh-head"><span>🕘 最近搜索</span><span class="qh-clear" onclick="QueryModule.clearHistory()">清空</span></div>
      <div class="qh-list">
        ${list.map(k => `<div class="qh-item" data-kw="${this.escapeHtml(k)}"><span class="qh-text">${this.escapeHtml(k)}</span><span class="qh-del" data-kw="${this.escapeHtml(k)}" title="删除">×</span></div>`).join('')}
      </div>`;
    // 定位到输入框下方
    const r = input.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.left = r.left + 'px';
    pop.style.minWidth = Math.max(r.width, 220) + 'px';
    pop.style.display = 'block';
    this._historyOpen = true;
    if (!this._docClose) {
      this._docClose = (e) => {
        const pop = document.getElementById('qhPop');
        const inp = document.getElementById('querySearch');
        if (pop && pop.style.display !== 'none' && !pop.contains(e.target) && e.target !== inp) this.hideHistory();
      };
    }
    setTimeout(() => document.addEventListener('click', this._docClose), 0);
  },
  hideHistory() {
    const pop = document.getElementById('qhPop');
    if (pop) pop.style.display = 'none';
    if (this._docClose) document.removeEventListener('click', this._docClose);
    this._historyOpen = false;
  },
  applyHistory(kw) {
    const input = document.getElementById('querySearch');
    if (input) input.value = kw;
    this.hideHistory();
    this.doSearch();
  },

  renderResults(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const area = document.getElementById('queryResultArea');
    if (!area) return;
    const total = this.results.length;
    const pageSize = this.pageSize === 'all' ? total : this.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    const start = (this.page - 1) * pageSize;
    const pageData = this.results.slice(start, start + pageSize);
    const cols = this.getColumns();

    if (total === 0) {
      area.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">未找到匹配数据</div><div class="empty-hint">尝试其他关键词或切换版块</div></div>`;
      return;
    }

    // 🟢 v193：列名 → link 实体类型映射。
    // 同一行内 订单编号/存货编码/供应商 全部 link 化，避免「订单编号能点、旁边不能点」的体验割裂。
    const ENTITY_COL = {
      '订单编号': 'order',
      '表体订单号': 'order',
      '存货编码': 'stock',
      '存货编号': 'stock',
      '供应商': 'supplier'
    };
    const colHeaders = cols.map(c => `<th>${esc(c)}</th>`).join('');
    const rowsHtml = pageData.map(row =>
      `<tr>${cols.map(c => {
        let val = row[c] ?? '';
        const linkType = ENTITY_COL[c];
        if (linkType) {
          // 用原始 string 作为 label/key（订单号/存货编码/供应商在数据层都是 string，
          //   不会被下方数字千分位分支污染），避免格式化破坏 link
          const strVal = String(val).trim();
          return `<td>${strVal ? TableUtils.link(linkType, strVal, strVal) : ''}</td>`;
        }
        // 🟢 v117：序号列始终保持纯数字（不千分位），其他数字列正常千分位
        if (c === '序号') { val = String(val); }
        else if (typeof val === 'number') { val = val.toLocaleString(); }
        return `<td>${esc(val)}</td>`;
      }).join('')}</tr>`
    ).join('');


    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>${colHeaders}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div id="queryPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;
    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（查询页使用 30/50/100/全部）
    TableUtils.renderPagination('queryPagination', { module: 'QueryModule', total, totalPages, page: this.page, pageSize: this.pageSize, pageSizes: [30, 50, 100, 'all'] });
    TableUtils.initSmartSelect('queryResultArea');
    TableUtils.initSortableHeaders('queryResultArea');
  },

  // 用户调整时间区间后保存并重新加载当前 tab
  onDateChange() {
    const startInput = document.getElementById('queryStartDate');
    const endInput = document.getElementById('queryEndDate');
    if (startInput) this.startDate = startInput.value;
    if (endInput) this.endDate = endInput.value;
    this.page = 1;
    this.loadTabData();
  },

  // 按日期区间过滤（仅对订单 / 入库生效）
  _filterByDateRange(list, dateField) {
    if (!this.startDate && !this.endDate) return list;
    return list.filter(item => {
      const d = item[dateField];
      if (!d) return false;
      if (this.startDate && d < this.startDate) return false;
      if (this.endDate && d > this.endDate) return false;
      return true;
    });
  },

  goPage(p) {
    const pageSize = this.pageSize === 'all' ? this.results.length : this.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(this.results.length / pageSize) : 1;
    if (p < 1 || p > totalPages) return;
    this.page = p;
    this.renderResults();
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.page = 1;
    this.renderResults();
  }
};
