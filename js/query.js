// ============================================
// 查询系统 V4 - 板块高亮修复 · 自动搜索 · 分页优化
// ============================================

const QueryModule = {
  currentTab: 'stock', // stock | orders | inbound | pricing
  page: 1, pageSize: 20,
  searchKW: '', results: [],

  tabs: [
    { id: 'stock', label: '存量', icon: '🏪' },
    { id: 'orders', label: '订单', icon: '📝' },
    { id: 'inbound', label: '入库', icon: '📥' },
    { id: 'pricing', label: '供应商价格', icon: '💰' },
  ],

  // 各版块表头（严格对齐超级查询系统工作表）
  columns: {
    stock: ['序号','存货编码','存货名称','规格型号','月均入库量','现存量','是否需补货','在途订单','所上或库房','工程项目'],
    orders: ['订单编号','日期','项目名称','供应商','存货编号','存货名称','规格型号','数量','未入库量'],
    inbound: ['表体订单号','入库日期','项目名称','入库单号','供应商','存货编码','存货名称','规格型号','数量'],
    pricing: ['供应商','存货编码','存货名称','规格型号','主计量','生效日期','失效日期','含税单价'],
  },

  async render() {
    const content = document.getElementById('contentArea');
    const tabBtns = this.tabs.map(t =>
      `<button class="tab-btn ${t.id === this.currentTab ? 'active' : ''}" onclick="QueryModule.switchTab('${t.id}')">${t.icon} ${t.label}</button>`
    ).join('');

    content.innerHTML = `
      <div class="tab-bar">${tabBtns}</div>
      <div class="filter-bar">
        <input type="text" id="querySearch" placeholder="多关键词搜索（空格/逗号分隔）..." style="max-width:400px;flex:0 1 400px;" value="${this.escapeHtml(this.searchKW)}" onkeydown="if(event.key==='Enter')QueryModule.doSearch()">
        <button class="search-glass" onclick="QueryModule.doSearch()">搜索</button>
        <button class="secondary" onclick="QueryModule.clearSearch()">清空</button>
      </div>
      <div id="queryResultArea"></div>
    `;

    if (this.results.length > 0) {
      this.renderResults();
    } else if (this.searchKW) {
      // 有搜索词但无结果：先加载数据再搜索
      await this.loadTabData();
      if (this.searchKW) this.doSearchSilent();
    } else {
      await this.loadTabData();
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
    // 调用 render() 重建 tab-bar 修复高亮，同时保留搜索词
    this.render();
  },

  async loadTabData() {
    const data = await this.fetchTabData();
    this.results = data;
    this.page = 1;
    if (!this.searchKW) {
      this.renderResults();
    }
  },

  async fetchTabData() {
    switch (this.currentTab) {
      case 'stock': {
        const alerts = await db.inventoryAlerts.toArray();
        // 从 stock（中心库房现存量）表获取真实库存数据
        const stockRows = await db.stock.toArray();
        const stockByCode = new Map();
        const stockByNameSpec = new Map();
        stockRows.forEach(s => {
          if (s.存货编码) stockByCode.set(String(s.存货编码), s.现存数量);
          if (s.存货名称) {
            const key = (s.存货名称 + '|' + (s.规格型号 || '')).replace(/\s+/g, '');
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
              const key = (a.存货名称 + '|' + (a.规格型号 || '')).replace(/\s+/g, '');
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
            '是否需补货': a.补货值 || 0,
            '在途订单': a.在途订单 || 0,
            '所上或库房': a.所上或库房 || '',
            '工程项目': a.工程项目 || '',
          };
        });
      }
      case 'orders': {
        const orders = await db.orders.toArray();
        return orders.map(o => ({
          '订单编号': o.订单编号 || '',
          '日期': o.日期 || '',
          '项目名称': o.项目名称 || '',
          '供应商': o.供应商 || '',
          '存货编号': o.存货编号 || '',
          '存货名称': o.存货名称 || '',
          '规格型号': o.规格型号 || '',
          '数量': o.数量 || 0,
          '未入库量': o.未入库量 || 0,
        }));
      }
      case 'inbound': {
        const inbound = await db.inbound.toArray();
        return inbound.map(i => ({
          '表体订单号': i.表体订单号 || '',
          '入库日期': i.入库日期 || '',
          '项目名称': i.项目名称 || '',
          '入库单号': i.入库单号 || '',
          '供应商': i.供应商 || '',
          '存货编码': i.存货编码 || '',
          '存货名称': i.存货名称 || '',
          '规格型号': i.规格型号 || '',
          '数量': i.数量 || 0,
        }));
      }
      case 'pricing': {
        const pricing = await db.pricing.toArray();
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
    this.performSearch();
    this.renderResults();
  },

  // 静默搜索（不读取 input，用已有 searchKW）
  doSearchSilent() {
    if (!this.searchKW) return;
    this.performSearch();
    this.renderResults();
  },

  performSearch() {
    const keywords = this.searchKW.split(/[\s,，]+/).filter(Boolean).map(k => k.toLowerCase());
    const cols = this.columns[this.currentTab];
    // 在原始数据上搜索（需要重新加载原始数据）
    // 这里用当前 results 做搜索 —— loadTabData 先加载全量，再过滤
    // 但为了确保每次搜索基于全量数据，我们在此不做修改（results 在 loadTabData 时是全量的）
    if (keywords.length > 0) {
      const filtered = this.results.filter(row =>
        keywords.every(kw =>
          cols.some(col => {
            const val = row[col];
            return val !== undefined && val !== null && String(val).toLowerCase().includes(kw);
          })
        )
      );
      this.results = filtered;
    }
    this.page = 1;
  },

  clearSearch() {
    this.searchKW = '';
    const input = document.getElementById('querySearch');
    if (input) input.value = '';
    this.loadTabData();
  },

  renderResults() {
    const area = document.getElementById('queryResultArea');
    if (!area) return;
    const total = this.results.length;
    const totalPages = Math.ceil(total / this.pageSize);
    const start = (this.page - 1) * this.pageSize;
    const pageData = this.results.slice(start, start + this.pageSize);
    const cols = this.columns[this.currentTab];

    if (total === 0) {
      area.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">未找到匹配数据</div><div class="empty-hint">尝试其他关键词或切换版块</div></div>`;
      return;
    }

    const colHeaders = cols.map(c => `<th>${c}</th>`).join('');
    const rowsHtml = pageData.map(row =>
      `<tr>${cols.map(c => {
        let val = row[c] ?? '';
        if (typeof val === 'number') val = val.toLocaleString();
        return `<td>${val}</td>`;
      }).join('')}</tr>`
    ).join('');

    const pageNumbers = [];
    for (let i = Math.max(1, this.page - 2); i <= Math.min(totalPages, this.page + 2); i++) {
      pageNumbers.push(i);
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>${colHeaders}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="pagination-bar" style="justify-content:center;gap:8px;">
        <span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>
        <span class="page-btns">
          <button ${this.page<=1?'disabled':''} onclick="QueryModule.goPage(1)">«</button>
          <button ${this.page<=1?'disabled':''} onclick="QueryModule.goPage(${this.page-1})">‹</button>
          ${pageNumbers.map(p => `<button class="${p===this.page?'active':''}" onclick="QueryModule.goPage(${p})">${p}</button>`).join('')}
          <button ${this.page>=totalPages?'disabled':''} onclick="QueryModule.goPage(${this.page+1})">›</button>
          <button ${this.page>=totalPages?'disabled':''} onclick="QueryModule.goPage(${totalPages})">»</button>
        </span>
        <span style="font-size:12px;color:var(--text-secondary);">
          每页
          <select onchange="QueryModule.changePageSize(parseInt(this.value))" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;">
            <option value="20" ${this.pageSize===20?'selected':''}>20</option>
            <option value="30" ${this.pageSize===30?'selected':''}>30</option>
            <option value="50" ${this.pageSize===50?'selected':''}>50</option>
          </select> 条
        </span>
        <span style="font-size:12px;color:var(--text-secondary);">
          跳至 <input type="number" id="pageJumper" min="1" max="${totalPages}" value="${this.page}"
            onkeydown="if(event.key==='Enter')QueryModule.goPage(parseInt(this.value))"
            style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;">
          / ${totalPages} 页
        </span>
      </div>
    `;
    TableUtils.initSmartSelect('queryResultArea');
  },

  goPage(p) {
    const totalPages = Math.ceil(this.results.length / this.pageSize);
    if (p < 1 || p > totalPages) return;
    this.page = p;
    this.renderResults();
  },

  changePageSize(size) {
    this.pageSize = size;
    this.page = 1;
    this.renderResults();
  }
};
