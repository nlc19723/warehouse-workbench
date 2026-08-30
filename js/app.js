// ============================================
// 主应用入口 V3 - 固定边栏 · 头像/名称/心情 · 设置抽屉
// ============================================

const App = {
  currentModule: 'dashboard',
  sidebarOpen: false,
  sidebarCollapsed: false,
  // 实体档案导航栈：解决跨实体跳转后返回 pendingEntity 丢失导致空白的问题
  _navStack: [],
  // 模块切换状态记忆：搜索/筛选/分页/页大小/tab 等，页面刷新后清空
  moduleState: {},

  // 模块映射表
  modules: {
    dashboard: { title: '首页仪表盘', instance: DashboardModule },
    supplier: { title: '供应商管理', instance: SupplierModule },
    query: { title: '查询系统', instance: QueryModule },
    reconciliation: { title: '对账功能', instance: ReconciliationModule },
    orderTrack: { title: '订单跟踪', instance: OrderTrackModule },
    orderCheck: { title: '订货核对', instance: OrderCheckModule },
    inventoryAlert: { title: '库存预警', instance: InventoryAlertModule },
    orders: { title: '订单列表', instance: OrdersModule },
    inbound: { title: '入库列表', instance: InboundModule },
    stock: { title: '现存量', instance: StockModule },
    pricing: { title: '合同价格', instance: PricingModule },
    lowTurnover: { title: '低周转材料', instance: LowTurnoverModule },
    breach: { title: '违约台账', instance: BreachModule },
    outbound: { title: '出库', instance: OutboundModule },
    outboundList: { title: '出库列表', instance: OutboundListModule },
    // 实体 360 档案（仅作链接跳转目标，不在侧边栏出现）
    'stock-detail': { title: '存货档案', instance: StockDetailModule },
    'supplier-detail': { title: '供应商档案', instance: SupplierDetailModule },
    'order-detail': { title: '订单档案', instance: OrderDetailModule }
  },

  async init() {
    // 🟢 v149：进入工作台 / 刷新工作台时重置所有表头筛选记忆（列宽、对齐、草稿保留）。
    //   放在最前，确保所有模块渲染前筛选状态已是干净状态。
    if (typeof TablePrefs !== 'undefined' && TablePrefs.clearFilters) {
      try { TablePrefs.clearFilters(); } catch (e) { /* 清筛选失败不应阻断初始化 */ }
    }

    this.bindSidebarToggle();
    this.bindSidebarNav();
    this.bindHamburger();
    this.bindPanel();
    this.bindModal();
    this.bindGlobalSearch();
    this.startClock();
    this.initTheme();
    // 🟢 v159：配色引擎注入分组变量（确保模块 render 内 _paintCells 加的类能读到变量）
    if (typeof ColorTheme !== 'undefined') { try { ColorTheme.applyGroupVars(ColorTheme.loadConfig()); } catch (e) {
    console.warn('[app.js:53] 异常(已忽略):', e);
  } }
    this.initSidebarState();
    this.initSidebarCustomizations();

    // 🟢 v188：版本号动态同步——从 CSS 资源 URL 的 ?v= 参数自动派生，
    // 免去每次发版手动改 config.js 字符串；bump CSS 版本即全链路（徽章+控制台）自动更新。
    this.syncVersionFromCss();
    // 🟢 v206：新版本检测——比对服务器 index.html 上的 CSS ?v= 版本号与当前页面。
    // 背景：SPA 切模块不刷新页面，Service Worker 缓存的旧 CSS 会一直生效，
    // 用户「发版了但看不到变化」。这里定期探测一次，发现新版本即提示刷新。
    this.startVersionWatch();
    // 渲染当前版本号徽章（用户可见的版本号标识）
    const _badge = document.getElementById('appVersionBadge');
    if (_badge) _badge.textContent = ((typeof AppConfig !== 'undefined' && AppConfig.app && AppConfig.app.version) || 'v???');
    this.initSettingsDrawer();
    this.initColumnResizeObserver();
    this.initMobileDragGuard();

    // 先清理旧版本数据库
    showLoading('正在准备数据库...');
    await cleanOldDB();
    await db.open();
    console.log('IndexedDB opened, version:', db.verno);

    // v164：云端设置数据初始化（连接 + 恢复搜索历史/出库列表跨设备记忆）
    if (typeof SyncManager !== 'undefined') {
      try { SyncManager.init(); } catch (e) { console.warn('SyncManager init 失败:', e); }
    }
    if (typeof DataStore !== 'undefined') {
      try {
        await DataStore.migrateSearchHistoryToCloud();
        await DataStore.restoreOutboundFromSettings();
      } catch (e) { console.warn('设置数据恢复失败:', e); }
    }

    try {
      const imported = await DataLoader.init();
      if (imported) {
        hideLoading(); // 先关闭加载遮罩，再渲染模块
        this.go('dashboard');
      } else {
        // 🟢 M7：无可用数据时不弹裸 alert，改为显示空状态引导（从云端同步 / 上传 Excel）
        this.showEmptyState();
      }
    } catch (err) {
      // 防御：初始化任何意外异常都不能导致整页永久空白且无提示
      console.error('应用初始化失败:', err);
      hideLoading();
      try { this.go('dashboard'); } catch (e2) { /* 渲染兜底也失败则仅提示 */ }
      WBModal.alert('初始化出现异常，已尝试继续加载；如仍空白请刷新重试。\n' + (err && err.message ? err.message : err));
    }
  },

  // 🟢 M7：无可用数据时的空状态引导页（新链接 / 清空本地后首屏）
  showEmptyState() {
    hideLoading();
    const area = document.getElementById('contentArea');
    if (!area) return;
    this.currentModule = 'dashboard';
    document.querySelectorAll('.sidebar-item[data-module]').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-module') === 'dashboard');
    });
    const titleEl = document.querySelector('.top-bar-left strong');
    if (titleEl) titleEl.textContent = '库管工作台';
    area.innerHTML = `
      <div class="empty-state" style="padding:56px 20px;text-align:center;">
        <div class="empty-icon" style="font-size:56px;margin-bottom:14px;">📦</div>
        <div style="font-size:18px;font-weight:600;color:var(--text-primary);margin-bottom:8px;">欢迎使用库管工作台</div>
        <div style="font-size:13.5px;color:var(--text-secondary);line-height:1.6;max-width:440px;margin:0 auto 26px;">
          这是新部署的链接，本地还没有数据。你可以从云端同步之前备份的数据，或上传 Excel 文件导入。
        </div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          <button class="btn-primary" onclick="App._onEmptySync()">☁️ 从云端同步数据</button>
          <button class="btn-secondary" onclick="DataLoader.reimport()">📤 上传 Excel 导入</button>
        </div>
      </div>`;
  },

  // 空状态「从云端同步」按钮回调：同步成功则进入仪表盘
  async _onEmptySync() {
    const ok = await DataLoader.forceSyncFromCloud();
    if (ok) this.go('dashboard');
  },

  // ===== 模块切换状态记忆 =====
  // 保存模块实例的搜索/筛选/分页/tab 等状态；页面刷新后 moduleState 为空，自动重置
  saveModuleState(inst, key) {
    if (!inst || !key) return;
    const state = {};
    const fields = ['currentFilter', 'searchKW', 'currentPage', 'page', 'pageSize', 'currentTab', 'startDate', 'endDate'];
    fields.forEach(f => {
      if (inst[f] !== undefined) {
        try {
          // 深拷贝对象，避免恢复前被污染
          state[f] = typeof inst[f] === 'object' && inst[f] !== null
            ? JSON.parse(JSON.stringify(inst[f]))
            : inst[f];
        } catch (e) {
          state[f] = inst[f];
        }
      }
    });
    this.moduleState[key] = state;
  },

  // 恢复模块实例状态；恢复后不清除缓存，允许反复切换回来都保持同一状态
  restoreModuleState(inst, key) {
    if (!inst || !key) return;
    const state = this.moduleState[key];
    if (!state) return;
    Object.keys(state).forEach(f => {
      if (inst[f] !== undefined) {
        try {
          inst[f] = typeof state[f] === 'object' && state[f] !== null
            ? JSON.parse(JSON.stringify(state[f]))
            : state[f];
        } catch (e) {
    /* 忽略结构不兼容的恢复 */ console.warn('[app.js:169] 异常(已忽略):', e);
  }
      }
    });
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

    // 🟢 v197：顶部扫一扫图标按钮（WebRTC + jsQR → 识别存货编码 → 直达档案页）
    const qrBtn = document.getElementById('topbarQrScanBtn');
    if (qrBtn) qrBtn.addEventListener('click', () => { if (window.QRScan) QRScan.open(); });
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
      // 去掉默认锚点，避免切换模块时浏览器左下角闪现 #module URL
      item.setAttribute('href', 'javascript:void(0)');
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
        // 🟢 v207 AUDIT-203：属性值转义，防止 `data:x" onerror=...` 逃逸出 src 属性
        avatar.innerHTML = `<img src="${escAttr(saved)}" alt="头像">`;
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

  // 🟢 v188：从 CSS 资源 URL 的 ?v= 参数自动派生版本号（如 style.css?v=188 → v188）
  // 发版时只需 bump index.html 里 style.css 的版本查询参数，徽章与控制台水印即自动同步。
  // 🟢 v206：新版本检测 + 刷新提示（解决「发版了但移动端看不到变化」）
  //   每 5 分钟（以及从后台切回前台时）拉一次 index.html，解析其中 style.css 的 ?v= 版本号，
  //   与当前页面不一致即弹提示条，用户点「刷新」即 location.reload(true)。
  startVersionWatch() {
    try {
      const currentV = (() => {
        const link = document.querySelector('link[rel="stylesheet"][href*="style.css"]');
        const m = link && (link.getAttribute('href') || '').match(/[?&]v=(\d+)/);
        return m ? parseInt(m[1], 10) : null;
      })();
      if (!currentV) return;
      let prompted = false;
      const check = async () => {
        if (document.hidden || prompted) return;
        try {
          const res = await fetch('index.html?_vchk=' + Date.now(), { cache: 'no-store' });
          if (!res.ok) return;
          const html = await res.text();
          const m = html.match(/style\.css\?v=(\d+)/);
          const latestV = m ? parseInt(m[1], 10) : null;
          if (latestV && latestV > currentV) { prompted = true; this._showUpdateBar(currentV, latestV); }
        } catch (e) {
    /* 离线/失败静默，不打扰用户 */ console.warn('[app.js:371] 异常(已忽略):', e);
  }
      };
      setTimeout(check, 15000);                       // 启动 15s 后首次探测
      setInterval(check, 5 * 60 * 1000);              // 之后每 5 分钟
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    } catch (e) {
    /* 探测失败不影响主流程 */ console.warn('[app.js:376] 异常(已忽略):', e);
  }
  },

  // 顶部滑入提示条：有新版本，点击即刷新
  _showUpdateBar(fromV, toV) {
    try {
      if (document.getElementById('__updateBar')) return;
      const bar = document.createElement('div');
      bar.id = '__updateBar';
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;background:#2f6fb0;color:#fff;'
        + 'padding:10px 14px;font-size:13px;display:flex;align-items:center;justify-content:space-between;'
        + 'gap:10px;box-shadow:0 2px 10px rgba(0,0,0,.25);';
      bar.innerHTML = `<span>🆕 有新版本（v${fromV} → v${toV}），刷新后生效</span>`
        + `<button id="__updateBtn" style="flex:0 0 auto;background:#fff;color:#2f6fb0;border:none;`
        + `border-radius:6px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;">刷新</button>`;
      document.body.appendChild(bar);
      const btn = bar.querySelector('#__updateBtn');
      if (btn) btn.addEventListener('click', () => {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
        }
        setTimeout(() => location.reload(true), 150);
      });
    } catch (e) {
    /* 提示条失败不影响使用 */ console.warn('[app.js:399] 异常(已忽略):', e);
  }
  },

  syncVersionFromCss() {
    try {
      const link = document.querySelector('link[rel="stylesheet"][href*="style.css"]');
      const href = link && link.getAttribute('href') || '';
      const m = href.match(/[?&]v=(\d+)/);
      const v = m ? parseInt(m[1], 10) : null;
      if (v && typeof AppConfig !== 'undefined' && AppConfig.app) {
        AppConfig.app.version = 'v' + v;
      }
    } catch (e) {
    /* 出错则保留 config.js 中写死的版本 */ console.warn('[app.js:411] 异常(已忽略):', e);
  }
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
            <button onclick="App.closePanel();SyncManager.showConfigDialog();" class="btn-secondary" style="justify-content:flex-start;">☁️ 云端同步</button>
            <button onclick="App.closePanel();DataLoader.reimport();" class="btn-secondary" style="justify-content:flex-start;">🔄 数据导入</button>
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
      panelBody.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载出错: ${esc(err.message)}</div></div>`;
    } finally {
      document.getElementById = originalGetElementById;
    }
  },

  closePanel() {
    document.getElementById('panelOverlay').classList.remove('show');
    document.getElementById('panelDialog').classList.remove('show');
  },

  // ===== 模块切换 =====
  // 轻量顶栏进度条（仅慢加载可见，非阻塞、不遮挡内容）
  _ensureSwitchBar() {
    if (!this._switchBar) {
      const bar = document.createElement('div');
      bar.className = 'switch-bar';
      document.body.appendChild(bar);
      this._switchBar = bar;
    }
    return this._switchBar;
  },

  // ===== 模块切换（v213 优化：离屏双缓冲 + 去全屏遮罩闪跳）=====
  // 轻量顶栏进度条（仅慢加载可见，非阻塞、不遮挡内容）
  _ensureSwitchBar() {
    if (!this._switchBar) {
      const bar = document.createElement('div');
      bar.className = 'switch-bar';
      document.body.appendChild(bar);
      this._switchBar = bar;
    }
    return this._switchBar;
  },

  // ===== 模块切换（v213 优化：去全屏遮罩闪跳 + 轻量进度条 + 平滑淡入）=====
  async go(moduleName, params) {
    if (!this.modules[moduleName]) return;
    // 🟢 v173：切换前关闭表格列筛选弹窗（挂在 body 上、不随模块 DOM 销毁）
    if (typeof TableUtils !== 'undefined' && typeof TableUtils._hideFilterPopup === 'function') {
      TableUtils._hideFilterPopup();
    }
    const switching = !!(this.currentModule && this.currentModule !== moduleName);
    const targetMeta = this.modules[moduleName];

    // 🟡 M7：离开上一模块前调用 onLeave 清理钩子（停止定时器 / 销毁图表实例），避免资源泄漏
    if (switching) {
      const prev = this.modules[this.currentModule];
      if (prev && prev.instance) {
        this.saveModuleState(prev.instance, this.currentModule);
        if (typeof prev.instance.onLeave === 'function') {
          try { prev.instance.onLeave(); } catch (e) { console.error('[onLeave]', e); }
        }
      }
    }
    // 🟢 v134：切换前统一卸载挂在 document.body 上的移动端浮层，防止旧浮层残留
    if (typeof TableStickyOverlay !== 'undefined' && TableStickyOverlay.uninstallAll) {
      try { TableStickyOverlay.uninstallAll(); } catch (e) { console.error('[uninstallAll]', e); }
    }
    this.restoreModuleState(targetMeta.instance, moduleName);
    if (params && targetMeta.instance) {
      const inst = targetMeta.instance;
      if (inst.currentFilter && params.filter) Object.assign(inst.currentFilter, params.filter);
      if (params.preset) Object.assign(inst, params.preset);
      if (typeof inst.onPreset === 'function') { try { inst.onPreset(params); } catch (e) { console.warn('[onPreset] 异常(已忽略):', e); } }
    }

    const token = (this._goToken = (this._goToken || 0) + 1);
    this.currentModule = moduleName;
    document.querySelectorAll('.sidebar-item[data-module]').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-module') === moduleName);
    });
    const titleEl = document.querySelector('.top-bar-left strong');
    if (titleEl) titleEl.textContent = targetMeta.title || '库管工作台';

    // 🟢 v213 优化：不再使用全屏遮罩（消除「全屏空白闪烁 + 卡顿」观感）。
    // 旧内容保留可见，渲染完成后再平滑淡入新内容；仅慢加载时显示轻量顶栏进度条。
    const realArea = document.getElementById('contentArea');
    const bar = this._ensureSwitchBar();
    bar.classList.remove('switch-bar--done');
    bar.style.opacity = '0';
    bar.style.width = '0%';
    let barShown = false;
    const barTimer = setTimeout(() => {
      if (token === App._goToken) { barShown = true; bar.style.opacity = '1'; bar.style.width = '35%'; }
    }, 140);

    // 先让浏览器绘制一帧（旧内容 + 进度条），再做可能较重的渲染，降低首帧卡顿感
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    let renderErr = null;
    try {
      await targetMeta.instance.render(token);
    } catch (err) {
      renderErr = err;
      console.error(`${moduleName} render error:`, err);
    } finally {
      clearTimeout(barTimer);
    }

    if (token !== this._goToken) return; // 被更新的模块切换打断，丢弃过期结果

    if (renderErr) {
      if (realArea) realArea.innerHTML =
        '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载出错: ' +
        esc(renderErr.message || renderErr) + '</div></div>';
    } else if (realArea) {
      // 平滑淡入，弱化「清空 → 出现数据」的突兀感
      realArea.classList.remove('content-fade');
      void realArea.offsetWidth; // 触发重排以重启动画
      realArea.classList.add('content-fade');
    }

    if (moduleName === 'outbound' && typeof OutboundListModule !== 'undefined') {
      OutboundListModule.checkPendingLoad();
    }
    if (typeof ColorTheme !== 'undefined') { try { ColorTheme.repaintAll(); } catch (e) { console.warn('[repaintAll] 异常(已忽略):', e); } }

    // 进度条收尾（仅慢加载时可见）
    if (barShown) {
      bar.style.width = '100%';
      bar.style.opacity = '1';
      setTimeout(() => { bar.classList.add('switch-bar--done'); bar.style.opacity = '0'; bar.style.width = '0%'; }, 180);
    } else {
      bar.style.opacity = '0';
      bar.style.width = '0%';
    }
  },

  // ===== 实体档案跳转（打通模块关联）=====
  // type: 'stock' | 'supplier' | 'order'；key: 实体主键
  openEntity(type, key) {
    const def = (typeof EntityLinks !== 'undefined') && EntityLinks[type];
    if (!def) { console.warn('[openEntity] 未登记的实体类型:', type); return; }
    key = (key == null ? '' : String(key)).trim();
    if (!key) return;
    // 🟢 v173：打开实体档案前，先关闭可能存在的列筛选弹窗（否则残留于新页面之上）
    if (typeof TableUtils !== 'undefined' && typeof TableUtils._hideFilterPopup === 'function') {
      TableUtils._hideFilterPopup();
    }
    // 跳转前保存当前视图状态，供返回时还原 pendingEntity（避免返回后空白）
    this._navStack.push({ module: this.currentModule || 'dashboard', pendingEntity: this.pendingEntity });
    this.pendingEntity = { type, key };
    this._returnModule = this.currentModule || 'dashboard';
    this.pushRecent(type, key);
    this.go(def.detailModule);
  },

  // 详情页返回：弹栈并还原上一个 pendingEntity，再 go 回上一个模块
  back() {
    const prev = this._navStack.pop();
    if (prev && prev.module) {
      this.pendingEntity = prev.pendingEntity || null;
      this._returnModule = prev.module;
      this.go(prev.module);
    } else {
      // 栈空时回首页
      this.pendingEntity = null;
      this._returnModule = 'dashboard';
      this.go('dashboard');
    }
  },

  // 最近浏览栈（去重、限长）
  pushRecent(type, key) {
    if (!this.recentEntities) this.recentEntities = [];
    const label = (typeof EntityLinks !== 'undefined') ? EntityLinks.labelOf(type, { [EntityLinks[type].keyField]: key }) : key;
    const entry = { type, key, label };
    this.recentEntities = this.recentEntities.filter(e => !(e.type === type && e.key === key));
    this.recentEntities.push(entry);
    if (this.recentEntities.length > 8) this.recentEntities = this.recentEntities.slice(-8);
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
    // 按实体聚合（同一实体跨模块合并，点击直达对应档案）
    let codeMap = null;
    if (typeof DataLoader !== 'undefined' && typeof DataLoader.getStockNameSpecCodeMap === 'function') {
      try { codeMap = await DataLoader.getStockNameSpecCodeMap(); } catch (e) { codeMap = null; }
    }
    const entities = this.aggregateSearchEntities(results, codeMap);
    panel.innerHTML = `
      <div style="margin-bottom:8px;font-size:12px;color:var(--text-muted);">"${esc(kw)}" 的实体结果 (${entities.length}个)</div>
      ${entities.length ? entities.map(e => this.renderSearchEntity(e)).join('') : '<div style="font-size:12px;color:var(--text-muted);padding:8px;">未匹配到实体</div>'}
    `;
  },

  // 将全局搜索结果聚合为「实体」：同一实体跨模块合并，标注命中的模块，点击直达档案
  // codeMap: 名称|规格 → 存货编码，用于把订单/入库关联到存货实体
  aggregateSearchEntities(results, codeMap) {
    const map = new Map();
    const add = (type, key, label, module) => {
      key = (key == null ? '' : String(key)).trim();
      if (!key) return;
      const k = type + '|' + key;
      if (!map.has(k)) map.set(k, { type, key, label: label || key, modules: [] });
      const ent = map.get(k);
      if (!ent.modules.includes(module)) ent.modules.push(module);
      if (label && !ent.label) ent.label = label;
    };
    const stockCodeOf = (o) => {
      // F4：优先用 codeMap 将(名称|规格)归一化为存货编码，避免「存货编号」与「存货编码」两套编码并存时
      // 把同一存货拆成两个实体、或点击后按存货编号查不到存货档案（开空白）
      if (codeMap && o.存货名称) {
        const k = (o.存货名称 + '|' + (o.规格型号 || '')).replace(/\s+/g, '');
        const c = codeMap.get(k);
        if (c) return c;
      }
      const on = o.存货编号 != null ? String(o.存货编号).trim() : '';
      return on;
    };
    (results.suppliers || []).forEach(s => add('supplier', s.供应商, s.供应商, '供应商管理'));
    (results.stock || []).forEach(s => add('stock', s.存货编码, (s.存货名称 || '') + (s.规格型号 ? '(' + s.规格型号 + ')' : ''), '现存量'));
    (results.orders || []).forEach(o => {
      add('order', o.订单编号, o.订单编号, '订单');
      if (o.供应商) add('supplier', o.供应商, o.供应商, '订单');
      const sc = stockCodeOf(o);
      if (sc) add('stock', sc, o.存货名称 || sc, '订单');
    });
    (results.inbound || []).forEach(i => {
      if (i.供应商) add('supplier', i.供应商, i.供应商, '入库');
      if (i.存货编码) add('stock', i.存货编码, i.存货名称 || i.存货编码, '入库');
    });
    return [...map.values()];
  },

  // 渲染单个聚合实体：图标 + 名称 + 命中模块徽章，点击打开档案
  renderSearchEntity(e) {
    const icon = e.type === 'stock' ? '📦' : e.type === 'supplier' ? '🏭' : e.type === 'order' ? '📝' : '🔗';
    const mods = e.modules.map(m => `<span class="search-mod">${esc(m)}</span>`).join('');
    const open = `App.openEntity('${escAttr(e.type)}','${escAttr(e.key)}');App.closeSearchPanel();`;
    return `<div class="search-entity" onmousedown="event.preventDefault();${open}">
      <span class="search-entity-icon">${icon}</span>
      <span class="search-entity-label">${esc(e.label)}</span>
      <span class="search-entity-mods">${mods}</span>
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
  },

  // ===== 列宽拖拽：自动为 #contentArea 内所有 .data-table 初始化拖拽手柄 =====
  // 用 MutationObserver 监听 DOM 变化（模块切换/筛选/分页/增删行都会重渲染表格），
  // 批量渲染时防抖一次，确保任意模块、任意时机出现的表格都能手动调列宽，无需逐模块改代码
  initColumnResizeObserver() {
    const area = document.getElementById('contentArea');
    if (!area) return;
    let rafId = null;
    const schedule = () => {
      if (rafId) return;
      // 🟢 v146：用 rAF 替代 60ms setTimeout——下一帧时浏览器已完成 innerHTML 后的首次 layout，
      //   th.offsetWidth > 0 成立，可立即锁定列宽；省去 60ms 闪烁窗口。
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (typeof TableUtils !== 'undefined' && TableUtils.initColumnResizers) {
          TableUtils.initColumnResizers(area);
        }
        // 🟢 v113：自动为任何「未挂过 ▼」的 .data-table 挂筛选键 + 对齐按钮（通过 data-table-key 识别）
        if (typeof TableUtils !== 'undefined' && TableUtils.initSortableHeadersAuto) {
          TableUtils.initSortableHeadersAuto(area);
        }
      });
    };
    const obs = new MutationObserver(schedule);
    obs.observe(area, { childList: true, subtree: true });
    // 首屏立即处理一次（dashboard 可能已渲染）
    schedule();
  },

  /**
   * 🟢 v135：iOS 14+ 默认开启 Web Drag，长按/划过文本会触发系统级蓝色拖拽卡片
   *   场景：用户在 oc-code-input 等输入框上向右滑时，键盘上方出现 "PE结水管 20*16" 那种浮卡
   *   兜底：body 监听 dragstart + selectstart，命中 autocomplete 下拉/表格文本就 preventDefault
   *   注：<input> 默认有内置 select 行为，不会被父级 user-select:none 影响，可继续编辑
   */
  initMobileDragGuard() {
    if (window.innerWidth > 768) return; // 只在窄屏启用
    const isTextTarget = (el) => {
      if (!el || el === document.body) return false;
      // <input>/<textarea>/<select> 永远允许（让用户能选中文本/编辑光标）
      if (el.closest && (el.closest('input, textarea, select'))) return false;
      return !!(el.closest && el.closest(
        '.autocomplete-dropdown, .autocomplete-item, .data-table'
      ));
    };
    const guard = (e) => {
      if (isTextTarget(e.target)) {
        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}
      }
    };
    // 用 capture 阶段拦截，确保在 iOS WebKit 派发 drag preview 之前截掉
    document.addEventListener('dragstart', guard, true);
    document.addEventListener('selectstart', guard, true);
    // 🟢 v139：移除 touchstart 上的 preventDefault——它会掐断滚动手势，
    //   正是「移动端表格滑不动」的根因。selection/callout 已由 CSS
    //   (user-select:none / -webkit-touch-callout:none / -webkit-user-drag:none)
    //   与上面的 dragstart/selectstart 守卫兜底，无需在 touchstart 层兜底。
  }
};

// 启动
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
