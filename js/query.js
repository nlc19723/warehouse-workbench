// ============================================
// 查询系统 V4 - 板块高亮修复 · 自动搜索 · 分页优化
// ============================================

// 🟢 v230.27：搜索归一化。消除全/半角括号、全/半角空格、不间断空格等不可见差异
//   —— 用户从合同/列表复制的项目名与底层存储值字符串不完全一致（「（一期）」vs「(一期)」）
//   会导致同项目名搜索零命中。搜索词与单元格值都先归一化再比较。
function normalizeKw(s) {
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角标点/字母/数字→半角
    .replace(/\u3000/g, ' ')              // 全角空格→半角
    .replace(/\u00A0/g, ' ')              // 不间断空格→半角
    .replace(/\s+/g, ' ')                 // 合并连续空白
    .trim()
    .toLowerCase();
}

const QueryModule = {
  currentTab: 'stock', // stock | orders | inbound | pricing
  page: 1, pageSize: AppConfig.app.queryPageSize,
  searchKW: '', results: [],
  currentFilter: {}, // 跨模块带参跳转（M1）：App.go 注入的 { keyword } 自动触发搜索
  startDate: '',
  endDate: '',
  HISTORY_KEY: 'wb_query_search_history',
  // 🟢 v230.28：订单编号 → 行关闭人（仅用于行标记，不进数据行，避免多出列）
  _closedBy: {},
  HISTORY_MAX: 5,
  _historyOpen: false,

  // 默认固定日期区间：3 个月前的 1 号 → 今日（按本地时区格式化）
  // 🟢 v230.25（用户反馈）：结束日期即「最新日期」= 当日。每次重新进入工作台（刷新/重开）时
  //   moduleState 不再跨刷新恢复（app.js v230.25），本默认值即首次进入的展示值；
  //   同一次使用过程中修改日期后切模块再回来仍记忆修改值（内存态）。
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
    { id: 'pricing', label: '价格', icon: '💰' },
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
        <input type="text" id="querySearch" class="fb-search filter-search-short" autocomplete="off" placeholder="多关键词搜索（空格/逗号分隔）..." value="${escAttr(this.searchKW)}" onkeydown="if(event.key==='Enter')QueryModule.doSearch()" onfocus="QueryModule.showHistory()">
        <div class="fb-row fb-row--date">
          <div class="fb-field"><input type="text" id="queryStartDate" value="${escAttr(this.startDate)}" class="filter-date dp-input" placeholder="起始日期" title="起始日期" onchange="QueryModule.onDateChange()" readonly></div>
          <span class="fb-sep filter-sep">至</span>
          <div class="fb-field"><input type="text" id="queryEndDate" value="${escAttr(this.endDate)}" class="filter-date dp-input" placeholder="结束日期" title="结束日期" onchange="QueryModule.onDateChange()" readonly></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="QueryModule.doSearch()">🔍 搜索</button>
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

  // 🟢 AUDIT-228-01（v228.18）：原实现用 textContent→innerHTML，浏览器对「文本节点」序列化
  //   只转义 & < >，**不转义 " 与 '**。当本函数被用于 HTML 属性插值（value="${...}" / data-kw="${...}"）
  //   时，双引号可闭合属性、追加任意事件属性 → 属性逃逸型 XSS（已实测可注入 onfocus 并执行）。
  //   现改为与全局 esc/escAttr 一致的完整转义表（含引号），文本与属性两种场景都安全。
  // 🟢 v229.91（AUDIT-229-08）：原 escapeHtml/escapeAttr 两个局部方法与全局 esc/escAttr
  //   完全等价（同一张转义表），收敛为直接调用全局助手，避免多套实现并存导致漏用。

  switchTab(tabId) {
    this.currentTab = tabId;
    this.page = 1;
    this.results = [];
    // 🟢 v209 AUDIT-107：传入 token 启用竞态守卫（快速切 tab 时旧渲染自动失效），并补 catch 避免异常静默
    const token = (App._goToken = (App._goToken || 0) + 1);
    this.render(token).catch(e => console.error('[query] switchTab 渲染失败:', e));
  },

  // 🟢 v230.23：tab 数据缓存（切 tab 秒回）。key = tab + 日期参数 + 依赖表行引用
  //   （DataStore.invalidate 后 getRows 产生新引用即失效，无脏读窗口）。
  //   缓存行仅只读使用（slice/filter/map 安全，严禁原地 sort/reverse）。
  _tabCache: null,

  async loadTabData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    const data = await this.fetchTabData();
    this.fullData = data;   // 全量原始数据，二次搜索始终基于它重新过滤（避免在上次结果集上叠加过滤）
    // 🟢 v230.28：非订单板块清空行关闭标记（入库板块也有「订单编号」键，残留会误标）
    if (this.currentTab !== 'orders') this._closedBy = {};
    this.results = data;
    if (!this.searchKW) {
      this.renderResults(rt);
    }
  },

  async fetchTabData() {
    // ① 缓存校验：日期参数 + 依赖表引用均未变 → 直接命中
    const tab = this.currentTab;
    const dateKey = (tab === 'orders' || tab === 'inbound') ? `${this.startDate}|${this.endDate}` : '';
    const c = this._tabCache;
    if (c && c.tab === tab && c.dateKey === dateKey) {
      if (tab === 'stock') {
        // 存量板块派生自库存预警装配，依赖四表——任一张表被 invalidate（引用变化）即失效
        const [s, o, i, pr] = await Promise.all([
          DataStore.getRows('stock'), DataStore.getRows('orders'),
          DataStore.getRows('inbound'), DataStore.getRows('pricing')
        ]);
        if (c.refStock === s && c.refOrders === o && c.refInbound === i && c.refPricing === pr) return c.rows;
      } else if (tab === 'orders') {
        const o = await DataStore.getRows('orders');
        if (c.refOrders === o) return c.rows;
      } else if (tab === 'inbound') {
        const i = await DataStore.getRows('inbound');
        if (c.refInbound === i) return c.rows;
      } else if (tab === 'pricing') {
        const p = await DataStore.getRows('pricing');
        if (c.refPricing === p) return c.rows;
      }
    }

    const rows = await this._fetchTabDataUncached();

    // ② 写入缓存（各 tab 依赖表不同，按需记引用）
    const entry = { tab, dateKey, rows };
    if (tab === 'stock') {
      const [s, o, i, pr] = await Promise.all([
        DataStore.getRows('stock'), DataStore.getRows('orders'),
        DataStore.getRows('inbound'), DataStore.getRows('pricing')
      ]);
      entry.refStock = s; entry.refOrders = o; entry.refInbound = i; entry.refPricing = pr;
    }
    else if (tab === 'orders') entry.refOrders = await DataStore.getRows('orders');
    else if (tab === 'inbound') entry.refInbound = await DataStore.getRows('inbound');
    else if (tab === 'pricing') entry.refPricing = await DataStore.getRows('pricing');
    this._tabCache = entry;
    return rows;
  },

  async _fetchTabDataUncached() {
    switch (this.currentTab) {
      case 'stock': {
        // 🟢 v229.04：存量板块全部列派生自库存预警模块（buildDerivedAlerts 共享装配）。
        // 圈红三列对标库存预警列名：是否需补货→补货值、所上或库房→仓库、工程项目→项目。
        const alerts = (typeof InventoryAlertModule !== 'undefined')
          ? await InventoryAlertModule.buildDerivedAlerts()
          : [];
        return alerts.map((a, idx) => ({
          '序号': idx + 1,
          '存货编码': a.存货编码 || '',
          '存货名称': a.存货名称 || '',
          '规格型号': a.规格型号 || '',
          '月均入库量': a.近一年月均入库量 || 0,
          '现存量': a.现存量 || 0,
          // 0 值留空（v228.03 行为延续），避免满屏 0 干扰阅读
          '补货值': a.补货值 || '',
          '在途订单': a.在途订单 || '',
          '仓库': a.所上或库房 || '',
          '项目': a.工程项目 || '',
        }));
      }
      case 'orders': {
        // 🟢 v229.04：派生订单列表模块（DataStore.getOrders 同源装配，含 _存货编码 归一），日期过滤同款
        const result = await DataStore.getOrders({ startDate: this.startDate, endDate: this.endDate }, 1, 1000000);
        const ordersItems = result.items || [];
        // 🟢 v230.28（用户报障：查询系统订单板块搜「楠璞」缺「远传电子水表（有线立式）」，
        //   而订单列表搜该项目能查到）：v230.49 曾把「订单跟踪」模块的业务规则对齐过来 ——
        //   排除「行关闭人」非空的订单行。实测该规则让查询系统静默丢弃真实存在的订单数据
        //   （底层 orders 表有、订单列表有、查询系统搜不到），属数据查询工具的功能性缺陷：
        //   「已关闭」是跟踪/送货语义，不该让查询系统查不到事实数据。
        //   现改为：全量展示，关闭状态以 _closedBy 映射（订单编号→关闭人）供行渲染标记，
        //   悬停行可见「行关闭：xxx」。注意行关闭信息不写进行对象，避免 getColumns()
        //   （取 Object.keys(row)）多出一列、改变表格结构。
        const closedBy = {};
        ordersItems.forEach(o => {
          const who = o.行关闭人 && String(o.行关闭人).trim();
          if (who) closedBy[String(o.订单编号 || '')] = who;
        });
        this._closedBy = closedBy;
        return ordersItems.map(o => ({
          '订单编号': o.订单编号 || '',
          '日期': o.日期 || '',
          '项目名称': o.项目名称 || '',
          '供应商': o.供应商 || '',
          '存货编号': o._存货编码 || o.存货编号 || '',
          '存货名称': o.存货名称 || '',
          '规格型号': o.规格型号 || '',
          '订单量': o.数量 || 0,
          '未入库订单量': o.未入库量 || 0,
        }));
      }
      case 'inbound': {
        // 🟢 v229.04：派生入库列表模块（DataStore.getInbound 同源装配），日期过滤同款
        const result = await DataStore.getInbound({ startDate: this.startDate, endDate: this.endDate }, 1, 1000000);
        return (result.items || []).map(i => ({
          '订单编号': i.表体订单号 || '',  // 🟢 v190：列名与入库列表对齐（与入库表单体订单号同字段）
          '入库日期': i.入库日期 || '',
          '项目名称': i.项目名称 || '',
          '入库单号': i.入库单号 || '',
          '供应商': i.供应商 || '',
          '存货编码': i.存货编码 || '',
          '存货名称': i.存货名称 || '',
          '规格型号': i.规格型号 || '',
          '入库量': i.数量 || 0,
          '备注': i.表体备注 || '',  // 🟢 v229.89：末列关联入库列表「表体备注」
        }));
      }
      case 'pricing': {
        // 🟢 v229.04：板块更名「价格」，派生供应商价格（合同价格）模块同源数据
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
      // 🟢 v230.27（用户报障：订单 tab 搜「棚膜抛秧（一期）给水项目」零结果，列表里明明有）：
      //   搜索是子串包含匹配（includes），对全/半角括号、全/半角空格、不间断空格等
      //   不可见差异-sensitive —— 用户从合同/列表复制的项目名与底层存储值字符串不完全
      //   一致（如「（一期）」vs「(一期)」），导致同项目名搜索零命中。修复：搜索词与
      //   单元格值都先归一化（全角→半角、空格归一、去首尾/合并空白）再比较。
      this.results = base.filter(row =>
        keywords.every(kw => {
          const kwN = normalizeKw(kw);
          return cols.some(col => {
            const val = row[col];
            if (val === undefined || val === null) return false;
            return normalizeKw(String(val)).includes(kwN);
          });
        })
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
    // 🟢 v229.98（AUDIT-229-98-02①）：await 之前先标记「正在打开」。此前 _docClose 要等 await 返回后才注册，
    //   这段空窗期里用户点别处无人处理；await 返回后浮层照样弹出并补注册 → 失焦后浮层"复活"。
    if (this._historyOpening) return;   // 已有一次在 await 中 → 不并发叠加（避免回来后重复弹/重复挂监听）
    this._historyOpening = true;
    let list;
    try { list = await this.getHistoryAsync(); } finally { this._historyOpening = false; }
    // await 期间用户可能已点别处（失焦）或已切模块（输入框被 render 换掉、不在 DOM 里）→ 放弃本次弹出
    if (!input.isConnected || (document.activeElement && document.activeElement !== input)) return;
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
        ${list.map(k => `<div class="qh-item" data-kw="${escAttr(k)}"><span class="qh-text">${esc(k)}</span><span class="qh-del" data-kw="${escAttr(k)}" title="删除">×</span></div>`).join('')}
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
    // 🟢 v229.98（AUDIT-229-98-02②）：记住这个延时 id —— 若在它触发前就 hide（如切模块），
    //   监听会在 removeEventListener 之后才被补挂上，document 级监听照样残留到下一个模块。
    this._docCloseTimer = setTimeout(() => { this._docCloseTimer = null; document.addEventListener('click', this._docClose); }, 0);
  },
  // 🟢 v229.98（AUDIT-229-98-02②）：qhPop 挂在 document.body 上、不随模块 DOM 销毁。
  //   本方法是唯一的收口（隐藏 + 摘 document 监听 + 撤待挂计时器），切模块时由 App.go 主动调用。
  hideHistory() {
    const pop = document.getElementById('qhPop');
    if (pop) pop.style.display = 'none';
    if (this._docCloseTimer) { clearTimeout(this._docCloseTimer); this._docCloseTimer = null; }
    if (this._docClose) document.removeEventListener('click', this._docClose);
    this._historyOpen = false;
    this._historyOpening = false;
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
      // 🟢 v230.27：按关键词数给出有效引导（单关键词时提示缩短/换词，多关键词时说明 AND 语义）
      const kwCount = (this.searchKW || '').split(/[\s,，]+/).filter(Boolean).length;
      const hint = kwCount > 1
        ? '多个关键词需同时满足，可减少关键词后重试'
        : '可尝试缩短关键词（如只输入项目名中的几个字）';
      area.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-text">未找到匹配数据</div><div class="empty-hint">${hint}</div></div>`;
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
    // 🟢 v230.28：订单 tab 下「行关闭人」非空的行加标记（悬停显示关闭人），
    //   数据本身照常展示与搜索，仅做状态提示。
    const rowsHtml = pageData.map(row => {
      const closedWho = this._closedBy && this._closedBy[String(row['订单编号'] ?? '')];
      const rowAttrs = closedWho
        ? ` class="qb-row-closed" title="行关闭：${escAttr(closedWho)}"`
        : '';
      return `<tr${rowAttrs}>${cols.map(c => {
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
        // 🟢 v230.29：已关闭订单的「未入库订单量」用蓝底红字标签标识（对齐库存预警 tag-info 视觉），
        //   数值后追加「（已关闭）」说明已关闭状态；不再整行淡化。
        //   🟢 v230.30（用户反馈）：未入库量为 0 的关闭行不再加标签与字样 —— 0 本身无待送量，
        //   圈出来反而添乱，普通显示即可。
        //   ⚠️ 该字样只存在于渲染层，data-value 仍是纯数值，表头筛选按数值比较。
        if (closedWho && c === '未入库订单量' && parseFloat(val) > 0) {
          return `<td data-value="${escAttr(String(val))}"><span class="tag tag-info qb-closed-stock" title="行关闭：${escAttr(closedWho)}">${esc(val)}（已关闭）</span></td>`;
        }
        return `<td>${esc(val)}</td>`;
      }).join('')}</tr>`;
    }).join('');


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
    // 🟢 v230.23：innerHTML 之后、paint 之前同步应用列宽（首帧即最终宽，消除列宽二段跳）。
    //   本表无 data-table-key，_deriveTableKey 会回退到容器 id「queryResultArea」作为记忆键。
    if (typeof TableUtils !== 'undefined' && TableUtils.applyColumnWidthsNow) {
      try { TableUtils.applyColumnWidthsNow(area); } catch (e) { /* 列宽应用失败不影响数据渲染 */ }
    }
    TableUtils.initExcelSelection('queryResultArea');
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
