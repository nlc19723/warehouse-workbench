// ============================================
// 主应用入口 V3 - 固定边栏 · 头像/名称/心情 · 设置抽屉
// ============================================

const App = {
  currentModule: 'dashboard',
  sidebarOpen: false,
  sidebarCollapsed: false,

  // 模块映射表
  modules: {
    dashboard: { title: '首页仪表盘', instance: DashboardModule },
    supplier: { title: '供应商管理', instance: SupplierModule },
    query: { title: '查询系统', instance: QueryModule },
    reconciliation: { title: '对账功能', instance: ReconciliationModule },
    orderTrack: { title: '订单跟踪', instance: OrderTrackModule },
    inventoryAlert: { title: '库存预警', instance: InventoryAlertModule },
    orders: { title: '订单列表', instance: OrdersModule },
    inbound: { title: '入库列表', instance: InboundModule },
    stock: { title: '现存量', instance: StockModule },
    pricing: { title: '合同价格', instance: PricingModule },
    lowTurnover: { title: '低周转材料', instance: LowTurnoverModule },
    breach: { title: '违约台账', instance: BreachModule },
    outbound: { title: '出库', instance: OutboundModule },
    outboundList: { title: '出库列表', instance: OutboundListModule }
  },

  async init() {
    this.bindSidebarToggle();
    this.bindSidebarNav();
    this.bindHamburger();
    this.bindPanel();
    this.bindModal();
    this.bindGlobalSearch();
    this.startClock();
    this.initTheme();
    this.initSidebarState();
    this.initSidebarCustomizations();
    this.initSettingsDrawer();

    // 先清理旧版本数据库
    showLoading('正在准备数据库...');
    await cleanOldDB();
    await db.open();
    console.log('IndexedDB opened, version:', db.verno);

    try {
      const imported = await DataLoader.init();
      if (imported) {
        hideLoading(); // 先关闭加载遮罩，再渲染模块
        this.go('dashboard');
      } else {
        hideLoading();
        alert('数据导入失败，请刷新页面重试');
      }
    } catch (err) {
      // 防御：初始化任何意外异常都不能导致整页永久空白且无提示
      console.error('应用初始化失败:', err);
      hideLoading();
      try { this.go('dashboard'); } catch (e2) { /* 渲染兜底也失败则仅提示 */ }
      alert('初始化出现异常，已尝试继续加载；如仍空白请刷新重试。\n' + (err && err.message ? err.message : err));
    }
  },

  // ===== 主题切换 =====
  initTheme() {
    const saved = localStorage.getItem('theme');
    const html = document.documentElement;
    const btn = document.getElementById('themeToggle');
    if (saved === 'dark') { html.setAttribute('data-theme', 'dark'); if (btn) btn.textContent = '☀️'; }
    else { html.setAttribute('data-theme', 'light'); if (btn) btn.textContent = '🌙'; }
    if (!btn) return;
    btn.addEventListener('click', () => {
      const isDark = html.getAttribute('data-theme') === 'dark';
      if (isDark) {
        html.setAttribute('data-theme', 'light'); btn.textContent = '🌙';
        localStorage.setItem('theme', 'light');
      } else {
        html.setAttribute('data-theme', 'dark'); btn.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
      }
    });
  },

  // ===== 边栏收起/展开 =====
  bindSidebarToggle() {
    const btn = document.getElementById('sidebarToggleBtn');
    const panel = document.getElementById('sidebarPanel');
    btn.addEventListener('click', () => {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      panel.classList.toggle('collapsed', this.sidebarCollapsed);
      localStorage.setItem('sidebarCollapsed', this.sidebarCollapsed ? '1' : '0');
      // 更新 tooltip
      this.updateSidebarTooltips();
    });
  },

  initSidebarState() {
    const saved = localStorage.getItem('sidebarCollapsed');
    if (saved === '1') {
      this.sidebarCollapsed = true;
      document.getElementById('sidebarPanel').classList.add('collapsed');
      this.updateSidebarTooltips();
    }
  },

  // 给收起态的 sidebar item 添加 data-tooltip
  updateSidebarTooltips() {
    document.querySelectorAll('.sidebar-item[data-module]').forEach(item => {
      const textEl = item.querySelector('.item-text');
      if (textEl) {
        item.setAttribute('data-tooltip', textEl.textContent.trim());
      }
    });
  },

  // ===== 汉堡菜单（移动端） =====
  bindHamburger() {
    const btn = document.getElementById('hamburgerBtn');
    const overlay = document.getElementById('sidebarOverlay');
    const panel = document.getElementById('sidebarPanel');

    btn.addEventListener('click', () => {
      this.sidebarOpen = !this.sidebarOpen;
      overlay.classList.toggle('show', this.sidebarOpen);
      panel.classList.toggle('show', this.sidebarOpen);
    });
    overlay.addEventListener('click', () => this.closeMobileSidebar());
  },

  closeMobileSidebar() {
    this.sidebarOpen = false;
    document.getElementById('sidebarOverlay').classList.remove('show');
    document.getElementById('sidebarPanel').classList.remove('show');
  },

  // ===== 侧边栏导航 =====
  bindSidebarNav() {
    document.querySelectorAll('.sidebar-item[data-module]').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        const module = item.getAttribute('data-module');
        this.closeMobileSidebar();
        this.go(module);
      });
    });
  },

  // ===== 头像/名称/心情自定义 =====
  initSidebarCustomizations() {
    this.initAvatar();
    this.initTitleEdit();
    this.initMoodInput();
  },

  initAvatar() {
    const avatar = document.getElementById('sidebarAvatar');
    const saved = localStorage.getItem('sidebarAvatar');
    if (saved) {
      if (saved.startsWith('data:') || saved.startsWith('http')) {
        avatar.innerHTML = `<img src="${saved}" alt="头像">`;
      } else {
        avatar.textContent = saved;
      }
    }

    avatar.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target.result;
          avatar.innerHTML = `<img src="${dataUrl}" alt="头像">`;
          localStorage.setItem('sidebarAvatar', dataUrl);
        };
        reader.readAsDataURL(file);
      };
      input.click();
    });
  },

  initTitleEdit() {
    const title = document.getElementById('sidebarTitle');
    const saved = localStorage.getItem('sidebarTitle');
    if (saved) title.textContent = saved;

    title.addEventListener('click', () => {
      const current = title.textContent;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current;
      input.maxLength = 20;
      input.style.cssText = 'width:100%;border:1px solid var(--primary);border-radius:6px;padding:2px 6px;font-size:14px;font-weight:600;color:var(--text-main);background:var(--card-bg);outline:none;';
      title.replaceWith(input);
      input.focus();
      input.select();

      const save = () => {
        const val = input.value.trim() || '库管工作台';
        title.textContent = val;
        localStorage.setItem('sidebarTitle', val);
        input.replaceWith(title);
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); } });
    });
  },

  initMoodInput() {
    const mood = document.getElementById('sidebarMood');
    const saved = localStorage.getItem('sidebarMood');
    if (saved) mood.value = saved;

    mood.addEventListener('blur', () => {
      localStorage.setItem('sidebarMood', mood.value.trim());
    });
    mood.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { mood.blur(); }
    });
  },

  // ===== 设置抽屉 =====
  initSettingsDrawer() {
    const btn = document.getElementById('sidebarSettingsBtn');
    btn.addEventListener('click', () => this.openSettingsDrawer());
  },

  openSettingsDrawer() {
    document.getElementById('panelTitle').textContent = '设置';
    const body = document.getElementById('panelBody');
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    body.innerHTML = `
      <div style="max-width:400px;">
        <div style="margin-bottom:20px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">主题设置</h4>
          <div style="display:flex;gap:12px;">
            <button onclick="document.documentElement.setAttribute('data-theme','light');localStorage.setItem('theme','light');document.getElementById('themeToggle').textContent='🌙';" 
              class="${!isDark ? 'btn-primary' : 'btn-secondary'}" style="flex:1;">☀️ 明亮模式</button>
            <button onclick="document.documentElement.setAttribute('data-theme','dark');localStorage.setItem('theme','dark');document.getElementById('themeToggle').textContent='☀️';" 
              class="${isDark ? 'btn-primary' : 'btn-secondary'}" style="flex:1;">🌙 暗黑模式</button>
          </div>
        </div>

        <div style="margin-bottom:20px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">边栏设置</h4>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;color:var(--text-body);">
            <input type="checkbox" id="settingsSidebarCollapsed" ${this.sidebarCollapsed ? 'checked' : ''} onchange="App.toggleSidebarFromSettings(this.checked)">
            默认收起边栏
          </label>
        </div>

        <div style="margin-bottom:20px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">数据管理</h4>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button onclick="App.closePanel();SyncManager.showConfigDialog();" class="btn-secondary" style="justify-content:flex-start;">☁️ 云端同步配置</button>
            <button onclick="App.closePanel();DataLoader.reimport();" class="btn-secondary" style="justify-content:flex-start;">🔄 重新导入数据</button>
            <button onclick="App.closePanel();DataLoader.restoreBuiltIn();" class="btn-secondary" style="justify-content:flex-start;">♻️ 恢复原始内置数据</button>
          </div>
        </div>

        <div style="margin-bottom:20px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">自定义</h4>
          <button onclick="App.resetCustomizations()" class="btn-secondary" style="justify-content:flex-start;">🗑️ 重置头像/名称/心情</button>
        </div>
      </div>
    `;

    document.getElementById('panelOverlay').classList.add('show');
    document.getElementById('panelDialog').classList.add('show');
  },

  toggleSidebarFromSettings(collapsed) {
    this.sidebarCollapsed = collapsed;
    document.getElementById('sidebarPanel').classList.toggle('collapsed', collapsed);
    localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
    this.updateSidebarTooltips();
  },

  resetCustomizations() {
    localStorage.removeItem('sidebarAvatar');
    localStorage.removeItem('sidebarTitle');
    localStorage.removeItem('sidebarMood');
    document.getElementById('sidebarAvatar').textContent = '库';
    document.getElementById('sidebarTitle').textContent = '库管工作台';
    document.getElementById('sidebarMood').value = '';
  },

  // ===== 全屏磨砂弹窗 =====
  bindPanel() {
    document.getElementById('panelClose').addEventListener('click', () => this.closePanel());
    document.getElementById('panelOverlay').addEventListener('click', () => this.closePanel());
  },

  openPanel(moduleName) {
    if (!this.modules[moduleName]) return;
    const meta = this.modules[moduleName];
    document.getElementById('panelTitle').textContent = meta.title;
    document.getElementById('panelBody').innerHTML = '<div class="loading-spinner" style="margin:60px auto;"></div>';
    document.getElementById('panelOverlay').classList.add('show');
    document.getElementById('panelDialog').classList.add('show');
    this.closeSearchPanel();
    this.renderModuleInPanel(moduleName);
  },

  async renderModuleInPanel(moduleName) {
    const meta = this.modules[moduleName];
    const panelBody = document.getElementById('panelBody');
    const originalGetElementById = document.getElementById.bind(document);
    document.getElementById = function(id) {
      if (id === 'contentArea') return panelBody;
      return originalGetElementById(id);
    };
    try {
      await meta.instance.render();
    } catch (err) {
      console.error(`${moduleName} render error:`, err);
      panelBody.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载出错: ${err.message}</div></div>`;
    } finally {
      document.getElementById = originalGetElementById;
    }
  },

  closePanel() {
    document.getElementById('panelOverlay').classList.remove('show');
    document.getElementById('panelDialog').classList.remove('show');
  },

  // ===== 模块切换 =====
  async go(moduleName) {
    if (!this.modules[moduleName]) return;
    // 🟡 渲染令牌（M5）：快速切换模块时，丢弃过期 render 的后续副作用，避免竞态与 DOM 互相覆盖
    const token = (this._goToken = (this._goToken || 0) + 1);
    this.currentModule = moduleName;
    document.querySelectorAll('.sidebar-item[data-module]').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-module') === moduleName);
    });
    // 更新顶部标题为当前模块名称
    const titleEl = document.querySelector('.top-bar-left strong');
    if (titleEl) titleEl.textContent = this.modules[moduleName].title || '库管工作台';
    const meta = this.modules[moduleName];
    try {
      await meta.instance.render();
      if (token !== this._goToken) return; // 已被更新的模块切换打断，丢弃过期操作
      // 出库模块：检查是否有从列表页跳转过来的待加载单号
      if (moduleName === 'outbound' && typeof OutboundListModule !== 'undefined') {
        setTimeout(() => OutboundListModule.checkPendingLoad(), 300);
      }
      hideLoading(); // 确保加载遮罩在模块渲染后关闭
    } catch (err) {
      console.error(`${moduleName} render error:`, err);
      const area = document.getElementById('contentArea');
      if (area) area.innerHTML =
        `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载出错: ${esc(err.message || err)}</div></div>`;
      hideLoading();
    }
  },

  // ===== 时钟 =====
  startClock() {
    const update = () => {
      const el = document.getElementById('currentTime');
      if (el) {
        const now = new Date();
        el.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      }
    };
    update();
    setInterval(update, 30000);
  },

  // ===== 全局搜索 =====
  bindGlobalSearch() {
    const input = document.getElementById('globalSearch');
    if (!input) return;
    let timer;
    input.addEventListener('input', e => {
      clearTimeout(timer);
      const kw = e.target.value.trim();
      if (!kw) { this.closeSearchPanel(); return; }
      timer = setTimeout(() => this.showSearchResults(kw), 300);
    });
    input.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', e => {
      const panel = document.getElementById('globalSearchPanel');
      if (!panel) return;
      if (panel.contains(e.target) || input.contains(e.target)) return;
      this.closeSearchPanel();
    });
  },

  async showSearchResults(kw) {
    // 竞态保护：只展示最新一次搜索的结果
    const seq = (this._searchSeq = (this._searchSeq || 0) + 1);
    const results = await DataStore.globalSearch(kw);
    if (seq !== this._searchSeq) return; // 已有更新的搜索，丢弃本次
    const total = results.suppliers.length + results.orders.length + results.inbound.length + results.stock.length;
    if (total === 0) { this.closeSearchPanel(); return; }
    let panel = document.getElementById('globalSearchPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'globalSearchPanel';
      panel.className = 'search-panel';
      panel.addEventListener('mousedown', e => e.stopPropagation());
      const topBar = document.querySelector('.top-bar');
      if (!topBar) return;
      topBar.appendChild(panel);
    }
    panel.innerHTML = `
      <div style="margin-bottom:8px;font-size:12px;color:var(--text-muted);">"${esc(kw)}" 的搜索结果 (${total}条)</div>
      ${results.suppliers.length > 0 ? this.buildSearchGroup('🏭 供应商', results.suppliers.slice(0, 3), 'supplier', s => `${esc(s.供应商)} · ${esc(s.类型 || '')}`) : ''}
      ${results.orders.length > 0 ? this.buildSearchGroup('📝 订单', results.orders.slice(0, 3), 'orders', o => `${esc(o.订单编号)} - ${esc(o.供应商)} · ${esc(o.存货名称)}`) : ''}
      ${results.inbound.length > 0 ? this.buildSearchGroup('📥 入库', results.inbound.slice(0, 3), 'inbound', i => `${esc(i.入库单号)} - ${esc(i.供应商)} · ${esc(i.存货名称)}`) : ''}
      ${results.stock.length > 0 ? this.buildSearchGroup('📦 现存', results.stock.slice(0, 3), 'stock', s => `${esc(s.存货名称)} · ${esc(s.规格型号 || '')}`) : ''}
    `;
  },

  buildSearchGroup(title, items, module, formatter) {
    return `<div style="margin-bottom:8px;">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-secondary);">${title} (${items.length})</div>
      ${items.map(item => `
        <div style="padding:8px 10px;border-radius:8px;cursor:pointer;font-size:12px;color:var(--text-primary);"
             onmousedown="event.preventDefault();App.openPanel('${module}');App.closeSearchPanel();"
             onmouseover="this.style.background='rgba(122,156,165,0.08)'"
             onmouseout="this.style.background=''">
          ${formatter(item)}
        </div>
      `).join('')}
    </div>`;
  },

  closeSearchPanel() {
    const panel = document.getElementById('globalSearchPanel');
    if (panel) panel.remove();
  },

  bindModal() {
    document.getElementById('modalClose').addEventListener('click', () => {
      document.getElementById('modalOverlay').classList.remove('show');
    });
    document.getElementById('modalOverlay').addEventListener('click', e => {
      if (e.target.id === 'modalOverlay') {
        document.getElementById('modalOverlay').classList.remove('show');
      }
    });
  }
};

// 启动
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
