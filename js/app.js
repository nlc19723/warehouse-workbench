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
    outbound: { title: '临时出库', instance: OutboundModule },
    outboundList: { title: '中心出库列表', instance: OutboundListModule },
    // 扫码盘点（v215 新增 · 脚本先于 app.js 加载，引用安全）
    stocktake: { title: '盘点', instance: StocktakeModule },
    stocktakeBatch: { title: '盘点批次汇总', instance: StocktakeBatchModule },
    stocktakeRecord: { title: '盘点记录列表', instance: StocktakeRecordModule },
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
    this.bindMobileTabbar();   // 🟢 v227.33：移动端底部 Tab（查询 / 盘点）
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
    this.renderAccountBar();   // 🟢 v216：侧边栏账号状态条（库管员登录态）
    this._wireTopbarAccount();      // 🟢 v227.41：顶部账号胶囊点击 → 切换/退出
    this._renderTopbarAccount();    // 🟢 v227.41：把当前账号写进顶部胶囊
    this._applyEntryVisibility();   // 🟢 v227.37：4 个系统入口按权限显隐
    this._wireEntryGuards();         // 🟢 v227.37：入口 onclick 加守卫

    // 先清理旧版本数据库
    showLoading('正在准备数据库...');
    await cleanOldDB();
    await db.open();
    console.log('IndexedDB opened, version:', db.verno);

    // v164：云端设置数据初始化（连接 + 恢复搜索历史/出库列表跨设备记忆）
    // 🟢 v226-fix：必须 await init() 完成（连接探测是异步的），否则 restoreOutboundFromSettings()
    //   会在 isOnline 仍为 false 时同步 return，导致另一台设备刷新后拉不到出库列表。
    if (typeof SyncManager !== 'undefined') {
      try { await SyncManager.init(); } catch (e) { console.warn('SyncManager init 失败:', e); }
    }
    // 🟢 v227.37：首次启动若 SyncManager 离线且云端 settings.cloudConfig 有值 → 自动填 + 自动连
    //   （管理员保存凭证时已下发；新设备/清缓存设备首次打开即默认连云端，无需手动配）
    if (typeof SyncManager !== 'undefined' && !SyncManager.isOnline && typeof AppConfig !== 'undefined' && typeof AppConfig.pullCloudConfigFromCloud === 'function') {
      try { await AppConfig.pullCloudConfigFromCloud(); } catch (e) { console.warn('[cloudConfig] 启动自动拉取失败(已忽略):', e && e.message); }
    }
    if (typeof DataStore !== 'undefined') {
      try {
        // 🟢 v227.96：已连云端 → 进入即自动同步最新「工作/设置/盘点」三包（静默、时间戳门控，不弹确认）
        if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
          if (typeof DataLoader !== 'undefined' && typeof DataLoader.autoSyncFromCloud === 'function') {
            await DataLoader.autoSyncFromCloud().catch(e => console.warn('[autoSync] 失败(已忽略):', e && e.message));
          }
          if (typeof StocktakeModule !== 'undefined' && typeof StocktakeModule.pullCloudRecords === 'function') {
            await StocktakeModule.pullCloudRecords().catch(e => console.warn('[stocktake] 自动同步失败(已忽略):', e && e.message));
          }
        }
        await DataStore.migrateSearchHistoryToCloud();
        await DataStore.restoreOutboundFromSettings();
        // 🟢 v227.77：临时出库独立云端数据包，启动时一并恢复
        await DataStore.restoreTemporaryOutboundFromSettings();
      } catch (e) { console.warn('设置数据恢复失败:', e); }
    }

    try {
      const imported = await DataLoader.init();
      if (imported) {
        hideLoading(); // 先关闭加载遮罩，再渲染模块
        this.go('dashboard');
      } else {
        // 🟢 v227.36：未登录优先显示「请先登录」占位页（模块已按权限隐藏）；已登录但无数据才显示空状态引导
        if (typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn && !AppConfig.isLoggedIn()) {
          this.showNotLoggedInState();
        } else {
          this.showEmptyState();
        }
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
          <button class="btn--primary" onclick="App._onEmptySync()">☁️ 从云端同步数据</button>
          <button class="btn--ghost" onclick="DataLoader.reimport()">📤 上传 Excel 导入</button>
        </div>
      </div>`;
  },

  // 空状态「从云端同步」按钮回调：同步成功则进入仪表盘
  async _onEmptySync() {
    const ok = await DataLoader.forceSyncFromCloud();
    if (ok) this.go('dashboard');
  },

  // 🟢 v227.36：未登录占位页（侧边栏模块已按权限隐藏）
  // 🟢 v227.38：占位页与登录表单合并为整页式登录界面（showLoginView），此处仅做转发
  showNotLoggedInState() {
    hideLoading();
    this.currentModule = '';
    document.querySelectorAll('.sidebar-item[data-module]').forEach(item => item.classList.remove('active'));
    this.showLoginView();
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
    const overlay = document.getElementById('sidebarOverlay');
    btn.addEventListener('click', () => {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      panel.classList.toggle('collapsed', this.sidebarCollapsed);
      // 🟢 v227.35：移动端收起 = 固定左侧图标栏（与 PC 一致），并关闭抽屉浮层、主内容右移
      const isMobile = window.innerWidth <= 768;
      if (isMobile) {
        if (this.sidebarCollapsed) {
          this.sidebarOpen = false;
          if (overlay) overlay.classList.remove('show');
          panel.classList.remove('show');
          document.body.classList.add('sidebar-rail');
        } else {
          document.body.classList.remove('sidebar-rail');
        }
      }
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
      // 🟢 v227.35：移动端恢复收起态时同步图标栏 + 主内容让位
      if (window.innerWidth <= 768) document.body.classList.add('sidebar-rail');
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
      // 🟢 v227.35：打开全宽抽屉时清除图标栏态，避免二者样式叠加
      if (this.sidebarOpen) {
        this.sidebarCollapsed = false;
        panel.classList.remove('collapsed');
        document.body.classList.remove('sidebar-rail');
      }
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

  // ===== 🟢 v227.33：移动端底部 Tab 栏（查询 / 盘点）=====
  bindMobileTabbar() {
    document.querySelectorAll('.mtab-item[data-tab-module]').forEach(item => {
      item.addEventListener('click', () => {
        const module = item.getAttribute('data-tab-module');
        // 若抽屉开着先收起，避免视觉重叠
        if (this.sidebarOpen && typeof this.closeMobileSidebar === 'function') {
          this.closeMobileSidebar();
        }
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
    // 🟢 v227.42：侧栏标题改为登录账号名 + 点击切换账号/退出（替代原编辑名称）
    const title = document.getElementById('sidebarTitle');
    if (!title) return;
    this._refreshSidebarTitle(title);
    // 清理老版本残留
    try { localStorage.removeItem('sidebarTitle'); } catch (e) {}
    title.addEventListener('click', () => {
      this._openAccountMenu(title);
    });
  },

  // 🟢 v227.42：刷新侧栏标题 = 当前登录账号名（未登录 → 登录）
  // 🟢 v227.44：账号显示名（侧栏标题 / 顶部胶囊 / 账号弹窗共用一处逻辑，避免三处漂移）
  //   管理员特权 + 库管员作业身份并存时显示「管理员 · 张三」，否则显示当前账号名。
  _accountLabel() {
    const cfg = (typeof AppConfig !== 'undefined') ? AppConfig : null;
    const u = (cfg && cfg.getCurrentUser) ? cfg.getCurrentUser() : null;
    if (!u || !u.username) return '';
    const admin = (cfg && cfg.getAdminSession) ? cfg.getAdminSession() : null;
    const isAdminPriv = !!(admin && admin.role === 'admin');
    if (!isAdminPriv) return u.username;
    // 旧写法在此处会拼出悬空的「管理员 · 」（作业身份本身就是管理员时）
    return (u.username !== '管理员') ? '管理员 · ' + u.username : '管理员';
  },

  _refreshSidebarTitle(title) {
    if (!title) title = document.getElementById('sidebarTitle');
    if (!title) return;
    const label = this._accountLabel();
    if (label) {
      title.textContent = label;
      title.title = '点击切换账号 / 退出登录';
      title.style.cursor = 'pointer';
    } else {
      title.textContent = '未登录';
      title.title = '点击登录';
      title.style.cursor = 'pointer';
    }
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
    // 🟢 v227.35：设置入口纳入管理员权限（非管理员需先校验管理员密码）
    // 🟢 v227.37：改为走 entry 权限门（管理员默认全开；keeper 可被单独勾选）
    btn.addEventListener('click', () => this.openSettingsEntry());
  },

  // 🟢 v188：从 CSS 资源 URL 的 ?v= 参数自动派生版本号（如 style.css?v=188 → v188）
  // 🟢 v227.21：版本自检改为读取 releases/app-manifest.json 的权威 version（每次发版必 bump），
  //   不再依赖某个具体文件的 ?v= 戳 —— 避免「只改了 stocktake.js/config.js 但 style.css ?v= 没变，
  //   导致更新提示条永不触发」的同类缓存陷阱。
  startVersionWatch() {
    try {
      const norm = (s) => { const m = String(s || '').match(/(\d+(?:\.\d+)*)/); return m ? parseFloat(m[1]) : 0; };
      const currentV = norm((typeof AppConfig !== 'undefined' && AppConfig.app && AppConfig.app.version) || '');
      if (!currentV) return;
      let prompted = false;
      const check = async () => {
        if (document.hidden || prompted) return;
        try {
          const res = await fetch('releases/app-manifest.json?_vchk=' + Date.now(), { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json().catch(() => null);
          const latestV = norm(data && data.version);
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
  // 🟢 v227.71：改为冰川蓝品牌渐变 + 滑入动画 + 点击后「正在刷新…」渐出。
  //   让版本切换不再是「页面突然白一下」，而是一个看得见、有反馈的动作
  //   （顺带缓解旧版缓存导致「链接打不开」时用户无从判断的体感）。
  _showUpdateBar(fromV, toV) {
    try {
      if (document.getElementById('__updateBar')) return;
      const bar = document.createElement('div');
      bar.id = '__updateBar';
      bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99999;color:#fff;'
        + 'padding:11px 16px;font-size:13px;display:flex;align-items:center;justify-content:space-between;'
        + 'gap:12px;box-shadow:0 4px 18px rgba(15,23,42,.28);'
        + 'background:linear-gradient(135deg,#3B82C4,#5B9BD5 55%,#6DBF9F);'
        + 'transform:translateY(-100%);opacity:0;'
        + 'transition:transform .42s cubic-bezier(.22,1,.36,1),opacity .42s ease-out;';
      bar.innerHTML = `<span id="__updateMsg">🆕 有新版本（v${fromV} → v${toV}），刷新后生效</span>`
        + `<button id="__updateBtn" style="flex:0 0 auto;background:#fff;color:#2f6fb0;border:none;`
        + `border-radius:10px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;`
        + `transition:opacity .2s;">刷新</button>`;
      document.body.appendChild(bar);
      // 双 rAF：等元素挂上并具备 transition 后再放开 transform，否则动画不播
      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.style.transform = 'translateY(0)';
        bar.style.opacity = '1';
      }));
      const btn = bar.querySelector('#__updateBtn');
      if (btn) btn.addEventListener('click', () => {
        // 点击反馈：禁用 + 文案改「正在刷新…」+ 整条渐出，避免「点了没反应」的错觉
        btn.disabled = true;
        btn.style.opacity = '.7';
        btn.style.cursor = 'default';
        const msg = bar.querySelector('#__updateMsg');
        if (msg) msg.textContent = '⏳ 正在刷新，请稍候…';
        bar.style.transform = 'translateY(-100%)';
        bar.style.opacity = '0';
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
        }
        setTimeout(() => location.reload(true), 420);
      });
    } catch (e) {
      /* 提示条失败不影响使用 */ console.warn('[app.js:399] 异常(已忽略):', e);
  }
  },

  // 🟢 v227.21：版本号统一以 releases/app-manifest.json 的 version 为准（每次发版必 bump）。
  //   旧实现从 style.css ?v= 读版本并覆盖 AppConfig.app.version —— 但 style.css ?v= 常漏 bump，
  //   会把 config.js 里正确的 v227.21 反向覆盖回旧的 v227.20，造成「刷新还是旧版本号」的假象。
  //   改为异步读取权威 manifest，避免被未 bump 的 style.css 戳带偏。
  syncVersionFromCss() {
    try {
      fetch('releases/app-manifest.json?_vchk=' + Date.now(), { cache: 'no-store' })
        .then(r => (r && r.ok ? r.json() : null))
        .then(d => {
          const v = d && d.version;
          if (v && typeof AppConfig !== 'undefined' && AppConfig.app) AppConfig.app.version = v;
        })
        .catch(() => { /* 保留 config.js 中写死的版本 */ });
    } catch (e) {
      /* 出错则保留 config.js 中写死的版本 */ console.warn('[app.js:411] 异常(已忽略):', e);
    }
  },

  openSettingsDrawer() {
    this._pauseDashboard();   // v222：抽屉是 overlay，不会触发 dashboard.onLeave()
    document.getElementById('panelTitle').textContent = '设置';
    const body = document.getElementById('panelBody');
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    body.innerHTML = `
      <div style="max-width:400px;">
        <div style="margin-bottom:20px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">主题设置</h4>
          <div style="display:flex;gap:12px;">
            <button onclick="document.documentElement.setAttribute('data-theme','light');localStorage.setItem('theme','light');document.getElementById('themeToggle').textContent='🌙';" 
              class="${!isDark ? 'btn--primary' : 'btn--ghost'}" style="flex:1;">☀️ 明亮模式</button>
            <button onclick="document.documentElement.setAttribute('data-theme','dark');localStorage.setItem('theme','dark');document.getElementById('themeToggle').textContent='☀️';" 
              class="${isDark ? 'btn--primary' : 'btn--ghost'}" style="flex:1;">🌙 暗黑模式</button>
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
            <button onclick="App.openCloudEntry()" class="btn--ghost" style="justify-content:flex-start;">☁️ 云端同步</button>
            <button onclick="App.openImportEntry()" class="btn--ghost" style="justify-content:flex-start;">🔄 数据导入</button>
          </div>
        </div>

        <div style="margin-bottom:20px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">权限</h4>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button onclick="App.openAdminAuth()" class="btn--ghost" style="justify-content:flex-start;">🔐 管理员权限</button>
          </div>
        </div>

        <div style="margin-bottom:20px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">自定义</h4>
          <button onclick="App.resetCustomizations()" class="btn--ghost" style="justify-content:flex-start;">🗑️ 重置头像/名称/心情</button>
        </div>
      </div>
    `;

    document.getElementById('panelOverlay').classList.add('show');
    document.getElementById('panelDialog').classList.add('show');
  },

  // 🔐 v214：管理员权限入口——弹出管理员密码校验
  // v222：已具备管理员特权时直接进面板，不再重复输密码（此前每次点进来都要重输一遍）
  openAdminAuth() {
    if (typeof AppConfig !== 'undefined' && typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin()) {
      this.openAdminPanel();
      return;
    }
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!overlay || !title || !body) return;
    title.textContent = '管理员验证';
    body.innerHTML = `
      <div style="max-width:320px;">
        <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;">请输入管理员密码以进入权限设置。</p>
        <input type="password" id="adminPwdInput" placeholder="管理员密码" style="width:100%;height:36px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:14px;">
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button onclick="document.getElementById('modalOverlay').classList.remove('show');" class="btn--ghost" style="padding:8px 16px;">取消</button>
          <button onclick="App._verifyAdminAndOpen()" class="btn--primary" style="padding:8px 16px;">进入</button>
        </div>
      </div>`;
    document.getElementById('modal').classList.add('modal-compact');
    overlay.classList.add('show');
    const inp = document.getElementById('adminPwdInput');
    if (inp) {
      inp.focus();
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') App._verifyAdminAndOpen(); });
    }
  },

  // 校验管理员密码，通过则进入权限设置面板（或执行待办回调）
  _verifyAdminAndOpen() {
    const el = document.getElementById('adminPwdInput');
    const pwd = el ? el.value.trim() : '';
    if (!pwd) { WBModal.alert('请输入管理员密码'); return; }
    const hash = (typeof sha256Hex === 'function') ? sha256Hex(pwd) : pwd;
    if (hash !== AppConfig.getAdminPwdHash()) {
      WBModal.alert('管理员密码错误');
      return;
    }
    const overlay = document.getElementById('modalOverlay');
    if (overlay) overlay.classList.remove('show');
    // v222：写独立的管理员特权会话（不再只写 wb_current_keeper），
    // 这样之后再登录库管员只会切换「作业身份」，管理员特权与模块权限不会丢。
    if (typeof AppConfig !== 'undefined' && AppConfig.setAdminSession) {
      const cur = AppConfig.getCurrentUser();
      AppConfig.setAdminSession();
      // 🟢 v222 归属保护：只有当「当前无人作业」时才把作业身份设为管理员。
      //   若已有库管员在作业（很可能正盘点一半），绝不能把他顶掉——否则他保存盘点时
      //   盘点人会变成「管理员」，记录归属错乱。
      //   管理员要以自己身份作业，用侧边栏状态条的「切换 → 以管理员身份作业」。
      if (!cur || !cur.username) {
        try { localStorage.setItem('wb_current_keeper', JSON.stringify({ username: '管理员', role: 'admin', loginAt: new Date().toISOString() })); } catch (e) {}
      }
    }
    this.renderAccountBar();
    // 🟢 v227.35：管理员验证成功后，优先执行「待办动作」（数据导入 / 设置 / 源码 等受管理员权限保护的入口）；
    //   无待办时才进入权限设置面板。
    const pending = this._adminPending;
    this._adminPending = null;
    if (typeof pending === 'function') { pending(); return; }
    this.openAdminPanel();
  },

  // 🟢 v227.35：受管理员权限保护的动作入口。已登录管理员直接执行；否则弹管理员密码校验，通过后再执行。
  requireAdmin(cb) {
    if (typeof AppConfig !== 'undefined' && typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin()) {
      if (typeof cb === 'function') cb();
      return;
    }
    this._adminPending = cb;
    this.openAdminAuth();
  },

  // 权限设置面板：①云端凭证（Administrator 可覆盖内置 URL/Key）②库管员账号（v216+）
  openAdminPanel() {
    const body = document.getElementById('panelBody');
    const title = document.getElementById('panelTitle');
    if (title) title.textContent = '权限设置';
    if (!body) return;
    const eff = (typeof AppConfig !== 'undefined' && AppConfig.getEffectiveSupabase)
      ? AppConfig.getEffectiveSupabase() : { url: '', key: '' };
    body.innerHTML = `
      <div style="max-width:420px;">
        <button onclick="App.openSettingsDrawer()" class="btn--ghost" style="margin-bottom:16px;justify-content:flex-start;">← 返回设置</button>

        <div style="margin-bottom:10px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">☁️ 云端凭证（Supabase）</h4>
          <label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:3px;">Project URL</label>
          <input type="text" id="admSbUrl" value="${typeof escAttr === 'function' ? escAttr(eff.url || '') : (eff.url || '')}" style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:8px;">
          <label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:3px;">Anon Key</label>
          <input type="password" id="admSbKey" value="${typeof escAttr === 'function' ? escAttr(eff.key || '') : (eff.key || '')}" style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:8px;">
          <button onclick="App._saveSupabaseOverride()" class="btn--primary" style="width:100%;">保存云端凭证（自动下发给所有 keeper 设备）</button>
        </div>

        <div style="margin-bottom:10px;">
          <h4 style="font-size:14px;color:var(--text-main);margin-bottom:10px;">👥 库管员账号</h4>
          <div id="keeperList"></div>
          <div style="margin-top:8px;">
            <button onclick="App.openKeeperEditor()" class="btn--primary" style="width:100%;padding:8px 14px;">+ 新增库管员账号（可勾选模块权限）</button>
          </div>
          <p style="font-size:11.5px;color:var(--text-secondary);margin-top:6px;line-height:1.5;">用户名创建后不可改（盘点记录按名字归属）；删除 = 禁用（历史记录可查）。账号自动同步云端。新账号默认授予「盘点岗」权限（盘点 / 盘点记录列表 / 查询 / 出库列表）；系统入口（云端同步 / 数据导入 / 设置 / 源码）需在编辑权限时单独勾选。</p>
        </div>
      </div>`;
    const overlay = document.getElementById('panelOverlay');
    const dialog = document.getElementById('panelDialog');
    if (overlay) overlay.classList.add('show');
    if (dialog) dialog.classList.add('show');
    this.renderKeeperList();
  },

  // 🟢 v227.37：保存云端凭证（同时下发给云端供其他设备拉取）
  _saveSupabaseOverride() {
    const u = document.getElementById('admSbUrl');
    const k = document.getElementById('admSbKey');
    if (!u || !k) return;
    if (!u.value.trim() || !k.value.trim()) { WBModal.alert('URL 与 Key 均需填写'); return; }
    AppConfig.setSupabaseOverride(u.value.trim(), k.value.trim());
    // 下发到云端 settings.cloudConfig
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof AppConfig.syncCloudConfig === 'function') {
      AppConfig.syncCloudConfig();
    }
    WBModal.alert('云端凭证已更新并下发给所有 keeper 设备');
  },

  // 保存云端凭证覆盖（换 Supabase 项目）
  _saveSupabaseOverride() {
    const u = document.getElementById('admSbUrl');
    const k = document.getElementById('admSbKey');
    if (!u || !k) return;
    if (!u.value.trim() || !k.value.trim()) { WBModal.alert('URL 与 Key 均需填写'); return; }
    AppConfig.setSupabaseOverride(u.value.trim(), k.value.trim());
    WBModal.alert('云端凭证已更新');
  },

  // ===== 库管员账号体系（v216 Step 5）=====

  // 🟢 v227.43：侧边栏账号状态条已删除（账号入口统一为「侧栏标题 + 顶部胶囊」）
  //   这里保留函数名，因为退出/切换/登录等 8 处调用都依赖它做全局状态同步。
  renderAccountBar() {
    // 🟢 v227.41：顶部账号入口同步（替换原搜索框位置）
    this._renderTopbarAccount();
    this._refreshSidebarTitle();        // 🟢 v227.42：侧栏标题同步为当前账号名
    this._applySidebarVisibility();   // v217：登录态变化后重渲侧边栏可见模块
    this._applyEntryVisibility();      // 🟢 v227.37：系统入口按登录态重渲
    this._wireEntryGuards();           // 🟢 v227.37：入口守卫重绑
  },

  // 🟢 v227.41：顶部账号胶囊点击 → 弹出切换/退出菜单
  _wireTopbarAccount() {
    if (this._topbarAccountBound) return;
    this._topbarAccountBound = true;
    const btn = document.getElementById('topbarAccountBtn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._openAccountMenu(btn);
    });
  },

  // 🟢 v227.41：顶部栏账号胶囊（占据原搜索框位置；点击下拉切换/退出）
  _renderTopbarAccount() {
    const btn = document.getElementById('topbarAccountBtn');
    if (!btn) return;
    const cfg = (typeof AppConfig !== 'undefined') ? AppConfig : null;
    const u = (cfg && cfg.getCurrentUser) ? cfg.getCurrentUser() : null;
    const escN = (n) => (typeof esc === 'function' ? esc(n) : String(n || ''));
    const label = this._accountLabel();
    if (label) {
      btn.innerHTML = '<span class="topbar-account-avatar"></span>' +
                      '<span class="topbar-account-name">' + escN(label) + '</span>' +
                      '<span class="topbar-account-caret">▾</span>';
      btn.dataset.state = 'logged';
      btn.disabled = false;
      btn.title = '点击切换账号 / 退出登录';
    } else {
      btn.innerHTML = '<span class="topbar-account-name">登录</span>';
      btn.dataset.state = 'guest';
      btn.disabled = false;
      btn.title = '点击登录';
    }
  },

  // 🟢 v227.43：点击账号名 → 弹窗提示「是否退出」，并提供 切换账号 / 确认退出 / 取消
  //   旧版把 HTML 塞进 WBModal.confirm 的第二个参数（opts），导致 body 只显示标题、
  //   内联 onclick 按钮被当纯文本渲染 —— 弹窗等于失效。这里改用 Promise 化 API。
  _openAccountMenu(btn) {
    if (typeof WBModal === 'undefined') return;
    const cfg = (typeof AppConfig !== 'undefined') ? AppConfig : null;
    const u = (cfg && cfg.getCurrentUser) ? cfg.getCurrentUser() : null;
    const escN = (n) => (typeof esc === 'function' ? esc(n) : String(n || ''));

    // 未登录：直接引导登录
    if (!u || !u.username) {
      WBModal.confirm('您当前未登录，是否立即登录？', { title: '账号', okText: '立即登录', cancelText: '取消' })
        .then(ok => { if (ok) this.showLoginView(); });
      return;
    }

    const display = this._accountLabel() || u.username;
    const admin = (cfg && cfg.getAdminSession) ? cfg.getAdminSession() : null;
    const isAdminPriv = !!(admin && admin.role === 'admin');

    // 用 DOM 构造 body（WBModal 对 HTMLElement 走 appendChild，不会转义）
    const box = document.createElement('div');
    box.style.cssText = 'text-align:left;line-height:1.7;';
    box.innerHTML =
      '<div style="font-size:12.5px;color:var(--text-secondary);">当前账号</div>' +
      '<div style="font-size:15px;font-weight:700;color:var(--text-main);margin:2px 0 8px;">🔐 ' + escN(display) + '</div>' +
      '<div style="font-size:13.5px;color:var(--text-main);">是否退出当前账号？</div>';

    if (typeof WBModal.choice !== 'function') { this._confirmLogout(u.username); return; }
    // 🟢 v227.45：账号弹窗不再提供「取消」—— 点遮罩或按 Esc 即可关闭
    // 🟢 v227.47：非管理员身份隐藏「切换账号」按钮（普通 keeper 看不到该入口）
    const buttons = [];
    if (isAdminPriv) buttons.push({ text: '切换账号', value: 'switch', primary: false });
    buttons.push({ text: '确认退出', value: 'logout', primary: true });
    WBModal.choice(box, {
      title: '退出登录',
      buttons
    }).then(v => {
      if (v === 'switch') this.openIdentitySwitcher();
      else if (v === 'logout') this._confirmLogout(u.username);
    });
  },

  // 🟢 v227.43：退出二次确认（点侧栏标题 / 顶部胶囊 / 弹窗「确认退出」均走这里）
  _confirmLogout(username) {
    const cfg = (typeof AppConfig !== 'undefined') ? AppConfig : null;
    const u = (cfg && cfg.getCurrentUser) ? cfg.getCurrentUser() : null;
    const name = username || (u && u.username) || '';
    if (!name) { this.logoutKeeper(); return; }
    WBModal.confirm('是否退出当前账号「' + (typeof esc === 'function' ? esc(name) : name) + '」？', {
      title: '退出确认', okText: '确认退出', cancelText: '取消', type: 'warn'
    }).then(ok => { if (ok) this.logoutKeeper(); });
  },

  // 🟢 v227.38：对外入口（替代原 modalOverlay 弹窗）——
  //   旧名 openLoginDialog 保留作别名，所有调用点（账号条「登录」、身份切换器、测试）无需改动
  openLoginDialog() { this.showLoginView(); },

  // 🟢 v227.38：沉浸式整页登录界面（占位页 + 登录表单二合一，取消弹窗）
  showLoginView() {
    // 已登录则不渲染（避免重复遮罩）
    if (typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn && AppConfig.isLoggedIn()) { this._enterWorkbench(); return; }
    let screen = document.getElementById('loginScreen');
    if (!screen) {
      screen = document.createElement('div');
      screen.id = 'loginScreen';
      screen.className = 'login-screen';
      document.body.appendChild(screen);
    }
    const online = (typeof SyncManager !== 'undefined') ? SyncManager.isOnline : false;
    // 🟢 v227.40：背景图（本地 SVG，缺图自动回退极光渐变），选择持久化到 localStorage
    const bgMap = {
      warehouse: 'assets/login-bg/warehouse.svg',
      abstract: 'assets/login-bg/abstract.svg',
      sunset:   'assets/login-bg/sunset.svg'
    };
    let savedBg = 'warehouse';
    try { savedBg = localStorage.getItem('wb_login_bg') || 'warehouse'; } catch (e) {}
    const photoUrl = bgMap[savedBg] || bgMap.warehouse;
    screen.innerHTML =
      '<div class="login-bg">' +
        '<div class="login-orb login-orb--1"></div>' +
        '<div class="login-orb login-orb--2"></div>' +
        '<div class="login-orb login-orb--3"></div>' +
      '</div>' +
      '<div class="login-photo" id="loginPhoto" style="background-image:url(\'' + photoUrl + '\')"></div>' +
      '<div class="login-bg-switch" id="loginBgSwitch">' +
        '<span class="login-bg-dot' + (savedBg === 'warehouse' ? ' is-active' : '') + '" data-bg="warehouse"></span>' +
        '<span class="login-bg-dot' + (savedBg === 'abstract' ? ' is-active' : '') + '" data-bg="abstract"></span>' +
        '<span class="login-bg-dot' + (savedBg === 'sunset' ? ' is-active' : '') + '" data-bg="sunset"></span>' +
      '</div>' +
      '<div class="login-card">' +
        '<div class="login-brand">' +
          '<div class="login-brand-logo">' +
            '<svg width="24" height="24" viewBox="0 0 512 512" fill="none">' +
              '<g stroke="#0F172A" stroke-width="44" stroke-linejoin="round" stroke-linecap="round" fill="none">' +
                '<path d="M192 224 L256 144 L320 224"/>' +
                '<rect x="208" y="208" width="96" height="120" rx="14"/>' +
                '<path d="M248 328 L248 272 L264 272 L264 328"/>' +
              '</g>' +
              '<rect x="218" y="232" width="18" height="18" rx="4" fill="#0F172A"/>' +
              '<rect x="276" y="232" width="18" height="18" rx="4" fill="#0F172A"/>' +
            '</svg>' +
          '</div>' +
          '<div class="login-brand-text"><h1>StockHub</h1><p>智能仓储 · 一体化管理</p></div>' +
        '</div>' +
        '<h2 class="login-heading">账号密码登录</h2>' +
        '<p class="login-subhead">欢迎回来，请登录以继续工作</p>' +
        '<div class="login-form">' +
          '<label class="login-field"><span class="login-field-label">用户名</span>' +
            '<input id="keeperLoginName" type="text" autocomplete="username" placeholder="库管员账号 / 管理员" /></label>' +
          '<label class="login-field"><span class="login-field-label">密码</span>' +
            '<div class="login-pwd-wrap"><input id="keeperLoginPwd" type="password" autocomplete="current-password" placeholder="请输入密码" />' +
            '<button type="button" class="login-eye" id="loginEye" aria-label="显示密码">👁️</button></div></label>' +
          '<div class="login-error" id="loginErr"></div>' +
          '<div class="login-remember-row">' +
            '<label class="login-remember"><input type="checkbox" id="loginRemember" /> 记住我</label>' +
            '<span class="login-forgot" id="loginForgot">忘记密码？</span>' +
          '</div>' +
          '<button type="button" class="login-submit" id="loginSubmit">登 录</button>' +
        '</div>' +
        '<div class="login-footer">' +
          '<span class="login-cloud' + (online ? ' online' : '') + '" id="loginCloud"><span class="dot"></span>' + (online ? '云端已同步' : '云端未连接') + '</span>' +
          '<span class="login-ver">' + ((typeof AppConfig !== 'undefined' && AppConfig.app && AppConfig.app.version) || '') + '</span>' +
        '</div>' +
      '</div>';

    // 绑定交互
    const nEl = document.getElementById('keeperLoginName');
    const pEl = document.getElementById('keeperLoginPwd');
    const submit = document.getElementById('loginSubmit');
    const eye = document.getElementById('loginEye');
    const errEl = document.getElementById('loginErr');
    // 🟢 v227.41：记住我（有效期内回填用户名并勾选）
    const remEl0 = document.getElementById('loginRemember');
    const ru0 = (() => { try { return parseInt(localStorage.getItem('wb_remember_until') || '0', 10); } catch (e) { return 0; } })();
    if (ru0 && ru0 > Date.now() && remEl0) {
      remEl0.checked = true;
      let rn = ''; try { rn = localStorage.getItem('wb_remember_name') || ''; } catch (e) {}
      if (rn && nEl) nEl.value = rn;
    }
    if (nEl) setTimeout(() => { try { nEl.focus(); } catch (e) {} }, 60);
    const doSubmit = () => this._doLogin();
    if (submit) submit.addEventListener('click', doSubmit);
    if (nEl) nEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { if (pEl) pEl.focus(); } });
    if (pEl) pEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });
    if (eye && pEl) eye.addEventListener('click', () => {
      pEl.type = (pEl.type === 'password') ? 'text' : 'password';
      eye.textContent = (pEl.type === 'password') ? '👁️' : '🙈';
    });
    // 忘记密码
    const forgot = document.getElementById('loginForgot');
    if (forgot) forgot.addEventListener('click', () => {
      if (typeof WBModal !== 'undefined' && WBModal.alert) WBModal.alert('密码忘记？请联系系统管理员重置密码。');
    });
    // 背景切换
    const bgSwitch = document.getElementById('loginBgSwitch');
    if (bgSwitch) bgSwitch.querySelectorAll('.login-bg-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        const key = dot.getAttribute('data-bg');
        bgSwitch.querySelectorAll('.login-bg-dot').forEach(d => d.classList.toggle('is-active', d === dot));
        const photo = document.getElementById('loginPhoto');
        if (photo) photo.style.backgroundImage = "url('" + (bgMap[key] || bgMap.warehouse) + "')";
        try { localStorage.setItem('wb_login_bg', key); } catch (e) {}
      });
    });
  },

  // 🟢 v227.38：整页登录的提交逻辑（UI 无关校验走 attemptLogin）
  _doLogin() {
    const n = document.getElementById('keeperLoginName');
    const p = document.getElementById('keeperLoginPwd');
    const name = n ? n.value.trim() : '';
    const pwd = p ? p.value : '';
    const errEl = document.getElementById('loginErr');
    if (errEl) errEl.classList.remove('show');
    this.attemptLogin(name, pwd).then(r => {
      if (!r.ok) { this._showLoginError(r.msg); return; }
      // 🟢 v227.40：记住我（7 天）→ 仅记住用户名，密码不落地
      const rem = document.getElementById('loginRemember');
      try {
        if (rem && rem.checked) {
          localStorage.setItem('wb_remember_until', String(Date.now() + 7 * 24 * 3600 * 1000));
          localStorage.setItem('wb_remember_name', name);
        } else {
          localStorage.removeItem('wb_remember_until');
          localStorage.removeItem('wb_remember_name');
        }
      } catch (e) {}
      this._enterWorkbench();
    });
  },

  _showLoginError(msg) {
    const errEl = document.getElementById('loginErr');
    if (!errEl) return;
    errEl.textContent = msg || '登录失败';
    // 重新触发抖动动画
    errEl.classList.remove('show');
    void errEl.offsetWidth;
    errEl.classList.add('show');
  },

  // 🟢 v227.38：登录成功 → 整页淡出后进入工作台
  _enterWorkbench() {
    const screen = document.getElementById('loginScreen');
    if (screen) {
      screen.classList.add('login-screen--out');
      setTimeout(() => { try { screen.remove(); } catch (e) {} }, 360);
    }
    this.renderAccountBar();
    this._applySidebarVisibility();
    this._applyEntryVisibility();
    this._wireEntryGuards();
    const ov = document.getElementById('modalOverlay'); if (ov) ov.classList.remove('show');
    const first = this._firstAllowedModule();
    this.go(first || 'dashboard');
  },

  // 🟢 v227.38：UI 无关的登录校验（库管员 + 管理员，含 v227.36 在线首验/离线复用门禁）
  //   成功返回 {ok:true, role, name}；失败返回 {ok:false, msg}
  async attemptLogin(name, pwd) {
    if (!name || !pwd) return { ok: false, msg: '请输入用户名和密码' };
    if (typeof AppConfig === 'undefined' || !AppConfig.login) return { ok: false, msg: '账号模块未就绪' };

    // 管理员路径：本地哈希校验 + 建立特权会话（不依赖云端）
    if (name === '管理员') {
      const hash = (typeof sha256Hex === 'function') ? sha256Hex(pwd) : pwd;
      if (hash !== AppConfig.getAdminPwdHash()) return { ok: false, msg: '管理员密码错误' };
      AppConfig.setAdminSession();
      const cur = AppConfig.getCurrentUser();
      if (!cur || !cur.username) {
        try { localStorage.setItem('wb_current_keeper', JSON.stringify({ username: '管理员', role: 'admin', loginAt: new Date().toISOString() })); } catch (e) {}
      }
      return { ok: true, role: 'admin', name: '管理员' };
    }

    // 库管员路径（首次联网验证 + 之后离线复用）
    const online = (typeof SyncManager !== 'undefined' && SyncManager.isOnline);
    let res = null;
    if (online) {
      try { await AppConfig.pullKeepersFromCloud(); } catch (e) { console.warn('[keepers] 拉取失败(已忽略):', e && e.message); }
      res = AppConfig.login(name, pwd);
      if (res && res.ok) AppConfig.markKeeperVerified(name);
    } else if (AppConfig.isKeeperVerified(name)) {
      res = AppConfig.login(name, pwd);
    } else if (AppConfig.getKeepers().some(k => k.username === name)) {
      // 无云端环境：本地已预置该账号 → 允许首次本地登录并打标记（降级，避免无云被卡死）
      res = AppConfig.login(name, pwd);
      if (res && res.ok) AppConfig.markKeeperVerified(name);
    } else {
      return { ok: false, msg: '首次登录需联网验证：请连接网络后重试。' };
    }
    if (!res || !res.ok) return { ok: false, msg: (res && res.msg) || '登录失败' };
    return { ok: true, role: 'keeper', name: name };
  },

  // 🟢 v227.38：兼容旧调用（测试 / 身份切换器）——委托 attemptLogin，成功走 _enterWorkbench 老式弹窗提示清理
  _doKeeperLogin() {
    const n = document.getElementById('keeperLoginName');
    const p = document.getElementById('keeperLoginPwd');
    const name = n ? n.value.trim() : '';
    const pwd = p ? p.value : '';
    this.attemptLogin(name, pwd).then(r => {
      if (!r.ok) { WBModal.alert(r.msg); return; }
      const overlay = document.getElementById('modalOverlay'); if (overlay) overlay.classList.remove('show');
      this.renderAccountBar();
      // v217：登录后若当前停留的模块无权访问，跳第一个有权限模块
      if (this.currentModule && !this._canAccessModule(this.currentModule)) {
        const alt = this._firstAllowedModule();
        if (alt) this.go(alt);
      }
      WBModal.alert('登录成功：' + r.name);
    });
  },

  // v222：身份切换器 —— 作业身份决定盘点记录归属给谁，需能显式切换
  // 🟢 v227.44：改用 WBModal.choice（按钮由弹窗 footer 统一绑定，样式与账号弹窗一致）。
  //   同时修复死路：旧版「登录库管员账号」调 showLoginView()，而已登录时该函数直接
  //   _enterWorkbench() 返回 —— 用户点了毫无反应，无法真正换成另一个账号。
  // 🟢 v227.46：管理员特权在场时，把所有 keeper 账号名字直接列在弹窗里，点哪个就
  //   切到哪个身份（保留管理员特权）。普通 keeper 仍是旧的两按钮选择（切账号 / 取消）。
  openIdentitySwitcher() {
    if (typeof WBModal === 'undefined') return;
    const cfg = (typeof AppConfig !== 'undefined') ? AppConfig : null;
    const u = (cfg && cfg.getCurrentUser) ? cfg.getCurrentUser() : null;
    const cur = (u && u.username) || '未登录';
    const hasAdmin = !!(cfg && cfg.getAdminSession && cfg.getAdminSession());
    const escN = (n) => (typeof esc === 'function' ? esc(n) : String(n || ''));

    // 管理员特权在场：直接列出所有 keeper，点击即切
    if (hasAdmin && typeof WBModal.choiceList === 'function') {
      const keepers = (cfg && cfg.getKeepers) ? cfg.getKeepers() : [];
      const intro = document.createElement('div');
      intro.style.cssText = 'text-align:left;line-height:1.6;';
      intro.innerHTML =
        '<div style="font-size:12.5px;color:var(--text-secondary);">当前作业身份</div>' +
        '<div style="font-size:15px;font-weight:700;color:var(--text-main);margin:2px 0 4px;">🔐 ' + escN(cur) + '</div>' +
        '<div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:6px;">管理员可直接切换到下列库管员身份：</div>';
      const items = [];
      // 当前身份放第一个（高亮禁用）
      const curDisabled = { text: '🔐 ' + cur, value: '::current::', disabled: true, hint: '当前' };
      if (cur !== '管理员') curDisabled.text = '👤 ' + cur + '（当前）';
      items.push(curDisabled);
      // 「以管理员身份作业」
      if (cur !== '管理员') items.push({ text: '🔐 以管理员身份作业', value: '管理员', hint: '全权限' });
      // 所有 keeper（去重、过滤当前）
      const seen = new Set([cur]);
      keepers.forEach(k => {
        const name = String(k && k.username || '').trim();
        if (!name || name === '管理员' || seen.has(name)) return;
        seen.add(name);
        items.push({ text: '👤 ' + escN(name), value: name });
      });
      // 兜底：登录其他账号（本地没有的账号）
      items.push({ text: '📋 登录其他账号…', value: '__other__', hint: '重新登录' });
      WBModal.choiceList(intro, { title: '切换账号', items, cancelText: '取消' }).then(v => {
        if (!v || v === '::current::') return;
        if (v === '__other__') this._switchAccount();
        else this._switchIdentity(v);
      });
      return;
    }

    // 普通 keeper：保持原有选择（登录其他账号 / 取消）
    if (typeof WBModal.choice !== 'function') return;
    const box = document.createElement('div');
    box.style.cssText = 'text-align:left;line-height:1.7;';
    box.innerHTML =
      '<div style="font-size:12.5px;color:var(--text-secondary);">当前作业身份</div>' +
      '<div style="font-size:15px;font-weight:700;color:var(--text-main);margin:2px 0 6px;">🔐 ' + escN(cur) + '</div>' +
      '<div style="font-size:12.5px;color:var(--text-secondary);">作业身份决定盘点记录归属给谁，请选择要切换到的账号：</div>';
    WBModal.choice(box, {
      title: '切换账号',
      buttons: [
        { text: '👤 登录其他账号', value: '__other__', primary: true },
        { text: '取消', value: null, primary: false }
      ]
    }).then(v => {
      if (!v) return;
      if (v === '__other__') this._switchAccount();
    });
  },

  // 🟢 v227.44：换一个账号登录 —— 二次确认后清空会话，回到整页登录界面
  _switchAccount() {
    WBModal.confirm('将退出当前账号并返回登录界面，是否继续？', {
      title: '切换账号', okText: '继续', cancelText: '取消', type: 'warn'
    }).then(ok => {
      if (!ok) return;
      if (typeof AppConfig !== 'undefined') {
        if (AppConfig.logoutAll) AppConfig.logoutAll();
        else if (AppConfig.logout) AppConfig.logout();
      }
      this.currentModule = '';
      document.querySelectorAll('.sidebar-item[data-module]').forEach(i => i.classList.remove('active'));
      this.renderAccountBar();
      if (typeof StocktakeModule !== 'undefined' && typeof StocktakeModule.refreshCounter === 'function') {
        try { StocktakeModule.refreshCounter(); } catch (e) {}
      }
      this.showLoginView();
    });
  },

  _switchIdentity(username) {
    const name = String(username || '').trim();
    if (!name) return;
    // 切到管理员必须先有特权会话，防止绕过密码冒名
    if (name === '管理员' && !(typeof AppConfig !== 'undefined' && AppConfig.getAdminSession && AppConfig.getAdminSession())) {
      WBModal.alert('请先通过管理员密码验证');
      return;
    }
    const role = (name === '管理员') ? 'admin' : 'keeper';
    try { localStorage.setItem('wb_current_keeper', JSON.stringify({ username: name, role: role, loginAt: new Date().toISOString() })); } catch (e) {}
    this.renderAccountBar();
    if (typeof StocktakeModule !== 'undefined' && typeof StocktakeModule.refreshCounter === 'function') {
      try { StocktakeModule.refreshCounter(); } catch (e) {}   // 盘点人跟着刷新
    }
    WBModal.alert('作业身份已切换为：' + name);
  },

  // v222：退出分两种——
  //   ① 当前就是管理员身份 → 连同特权一起退（logoutAll）
  //   ② 已登录库管员但管理员特权仍在 → 只退作业身份，回落到管理员（logout）
  logoutKeeper() {
    if (typeof AppConfig === 'undefined') return;
    const admin = AppConfig.getAdminSession ? AppConfig.getAdminSession() : null;
    const u = AppConfig.getCurrentUser ? AppConfig.getCurrentUser() : null;
    const hasPriv = !!(admin && admin.role === 'admin');
    let msg = '已退出登录';
    let fullyOut = false;   // 是否完全退出（无作业身份且无管理员特权）
    if (hasPriv && (!u || !u.username || u.username === '管理员')) {
      if (AppConfig.logoutAll) AppConfig.logoutAll(); else AppConfig.logout();
      msg = '已退出管理员登录';
      fullyOut = true;
    } else if (hasPriv) {
      AppConfig.logout();
      msg = '已退出「' + (u && u.username) + '」，当前以管理员身份继续（全权限）';
      fullyOut = false;
    } else {
      AppConfig.logout();
      fullyOut = true;
    }
    this.renderAccountBar();
    if (typeof StocktakeModule !== 'undefined' && typeof StocktakeModule.refreshCounter === 'function') {
      try { StocktakeModule.refreshCounter(); } catch (e) {}
    }
    // 🟢 v227.38：完全退出 → 直接回到整页登录界面（不再停留工作台）；回落管理员不算退出，保留提示
    if (fullyOut) {
      this.currentModule = '';
      document.querySelectorAll('.sidebar-item[data-module]').forEach(item => item.classList.remove('active'));
      this.showLoginView();
    } else {
      WBModal.alert(msg);
    }
  },

  // 管理员面板：渲染库管员账号列表
  renderKeeperList() {
    const el = document.getElementById('keeperList');
    if (!el) return;
    if (typeof AppConfig === 'undefined' || !AppConfig.getKeepers) { el.innerHTML = ''; return; }
    const list = AppConfig.getKeepers();
    if (!list.length) { el.innerHTML = '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">暂无账号，请在下方新增。</div>'; return; }
    el.innerHTML = list.map(k => {
      const disabled = k.disabled ? '（已禁用）' : '';
      const style = k.disabled ? 'opacity:.55;' : '';
      const un = (typeof escAttr === 'function' ? escAttr(k.username) : k.username);
      const dn = (typeof esc === 'function' ? esc(k.username) : k.username);
      return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;' + style + 'border-bottom:1px dashed var(--border-color,#eee);">' +
        '<span style="font-size:13px;color:var(--text-main);min-width:90px;">' + dn + '</span>' +
        '<span style="font-size:11px;color:var(--text-secondary);">' + disabled + '</span>' +
        '<span style="font-size:11px;color:var(--text-secondary);margin-right:6px;">' + (Array.isArray(k.modules) ? ('授权 ' + k.modules.length + ' 项') : '全权') + '</span>' +
        '<span style="margin-left:auto;display:flex;gap:6px;">' +
        '<button onclick="App.openKeeperEditor(\'' + un + '\')" class="btn--sm btn--ghost">权限</button>' +
        '<button onclick="App.changeKeeperPwd(\'' + un + '\')" class="btn--sm btn--ghost">改密</button>' +
        '<button onclick="App.toggleKeeper(\'' + un + '\', ' + (k.disabled ? 0 : 1) + ')" class="btn--sm btn--ghost">' + (k.disabled ? '启用' : '禁用') + '</button>' +
        (un === '管理员' ? '' :
          '<button onclick="App.deleteKeeper(\'' + un + '\')" class="btn--sm btn--danger">删除</button>') +
        '</span></div>';
    }).join('');
  },

  addKeeper() {
    const n = document.getElementById('newKeeperName');
    const p = document.getElementById('newKeeperPwd');
    const name = n ? n.value.trim() : '';
    const pwd = p ? p.value : '';
    if (!name || !pwd) { WBModal.alert('用户名和初始密码均不能为空'); return; }
    if (typeof AppConfig === 'undefined' || !AppConfig.upsertKeeper) { WBModal.alert('账号模块未就绪'); return; }
    const res = AppConfig.upsertKeeper(name, pwd);
    if (!res.ok) { WBModal.alert(res.msg || '新增失败'); return; }
    if (n) n.value = ''; if (p) p.value = '';
    this.renderKeeperList();
    WBModal.alert('已新增账号：' + name);
  },

  toggleKeeper(username, disabled) {
    if (typeof AppConfig === 'undefined' || !AppConfig.disableKeeper) return;
    AppConfig.disableKeeper(username, disabled);
    this.renderKeeperList();
    WBModal.alert(disabled ? ('已禁用：' + username) : ('已启用：' + username));
  },

  // v222：删除库管员账号（用户反馈原来只有「权限/改密/禁用」，没法删）
  // 历史盘点记录按用户名归属，删账号不影响已产生的记录，仍可查。
  async deleteKeeper(username) {
    if (typeof AppConfig === 'undefined' || !AppConfig.removeKeeper) { WBModal.alert('账号模块未就绪'); return; }
    let ok = false;
    try {
      ok = await WBModal.confirm(
        '确定删除账号「' + username + '」吗？\n\n删除后该账号将无法登录。已产生的盘点记录按名字保留，历史数据仍可查询。',
        { title: '删除库管员账号' }
      );
    } catch (e) { ok = false; }
    if (!ok) return;
    const res = AppConfig.removeKeeper(username);
    if (!res.ok) { WBModal.alert(res.msg || '删除失败'); return; }
    this.renderAccountBar();
    this.renderKeeperList();
    // 删的正是当前作业身份 → 已回落（可能是管理员或未登录），检查当前模块是否还有权访问
    if (this.currentModule && !this._canAccessModule(this.currentModule)) {
      const alt = this._firstAllowedModule();
      if (alt) this.go(alt);
    }
    WBModal.alert('已删除账号：' + username);
  },

  changeKeeperPwd(username) {
    WBModal.prompt('为「' + username + '」设置新密码：', { title: '修改密码' }).then(np => {
      if (np === null || np === undefined) return;
      if (!np) { WBModal.alert('密码不能为空'); return; }
      if (typeof AppConfig === 'undefined' || !AppConfig.upsertKeeper) return;
      AppConfig.upsertKeeper(username, np);
      WBModal.alert('「' + username + '」密码已更新');
    });
  },

  // ===== v217 库管员模块权限编辑器（新增 / 编辑共用）=====
  openKeeperEditor(name) {
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!overlay || !title || !body || typeof AppConfig === 'undefined') return;
    const editing = !!name;
    const cur = editing ? AppConfig.getKeeperModules(name) : null;
    const curMods = (editing && Array.isArray(cur)) ? cur : (editing ? AppConfig.KEEPER_PRESETS.admin : AppConfig.KEEPER_PRESETS.stocktake);
    // 🟢 v227.37：当前账号的「系统入口权限」（云端/导入/设置/源码）；老 keeper 无字段默认全开
    const kRec = editing ? (AppConfig.getKeepers().find(x => x.username === name) || {}) : null;
    const curEntries = (kRec && Array.isArray(kRec.entries)) ? kRec.entries : AppConfig.ENTRY_MODULES.map(x => x.key);
    title.textContent = editing ? ('编辑权限：' + name) : '新增库管员账号';
    body.setAttribute('data-editor-name', editing ? name : '');   // 用 dataset 传参，避开引号转义
    const groups = {};
    // v224：把子权限（如 stocktakeAssign）也拼进「盘点核心」分组一起渲染，库管员能看到这个独立勾选
    const allMods = AppConfig.MODULES.concat(AppConfig.STOCKTAKE_SUB_MODULES || []);
    // 🟢 v227.37：把 4 个系统入口也合并进分组渲染
    const allModsWithEntries = allMods.concat(AppConfig.ENTRY_MODULES || []);
    allModsWithEntries.forEach(function (m) { (groups[m.group] = groups[m.group] || []).push(m); });
    let html = '<div style="max-width:360px;">';
    if (!editing) {
      html += '<input type="text" id="keName" placeholder="用户名（创建后不可改）" style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:8px;">';
    } else {
      html += '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">账号：<b>' + (typeof esc === 'function' ? esc(name) : name) + '</b></div>';
    }
    html += '<input type="password" id="kePwd" placeholder="' + (editing ? '留空 = 不改密码' : '初始密码') + '" style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:10px;">';
    html += '<label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:4px;">预设（选预设会自动勾选，选「自定义」可手动勾）</label>';
    html += '<select id="kePreset" onchange="App._applyPreset(this.value)" style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 8px;font-size:13px;margin-bottom:10px;">' +
            '<option value="">自定义</option><option value="stocktake">盘点岗（盘点+记录+查询+出库列表）</option><option value="admin">全业务（全部 18 项）</option></select>';
    html += '<div style="max-height:240px;overflow:auto;border:1px solid var(--border-color);border-radius:8px;padding:8px;margin-bottom:12px;">';
    Object.keys(groups).forEach(function (g) {
      html += '<div style="font-size:11.5px;color:var(--text-secondary);margin:6px 0 4px;">' + g + '</div>';
      groups[g].forEach(function (m) {
        // 🟢 v227.37：系统入口走 curEntries；业务模块走 curMods
        const isEntry = (AppConfig.ENTRY_MODULES || []).some(function (e) { return e.key === m.key; });
        const checked = (isEntry ? curEntries : curMods).indexOf(m.key) !== -1 ? 'checked' : '';
        const cls = isEntry ? 'ke-entry' : 'ke-mod';
        html += '<label style="display:flex;align-items:center;gap:6px;font-size:13px;padding:2px 0;cursor:pointer;"><input type="checkbox" class="' + cls + '" value="' + m.key + '" ' + checked + '> <span>' + m.icon + ' ' + m.label + (isEntry ? ' <span style="font-size:10.5px;color:#94a3b8;">(系统)</span>' : '') + '</span></label>';
      });
    });
    html += '</div>';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;"><button onclick="document.getElementById(\'modalOverlay\').classList.remove(\'show\');" class="btn--ghost" style="padding:8px 16px;">取消</button><button onclick="App._saveKeeperEditor()" class="btn--primary" style="padding:8px 16px;">保存</button></div>';
    html += '</div>';
    body.innerHTML = html;
    const m = document.getElementById('modal'); if (m) m.classList.remove('modal-compact');
    overlay.classList.add('show');
  },
  // 预设下拉变化 → 自动勾选对应模块
  _applyPreset(preset) {
    const set = (preset && typeof AppConfig !== 'undefined' && AppConfig.KEEPER_PRESETS[preset]) ? AppConfig.KEEPER_PRESETS[preset] : null;
    try {
      document.querySelectorAll('.ke-mod, .ke-entry').forEach(function (b) { if (set) b.checked = set.indexOf(b.value) !== -1; });
    } catch (e) {}
  },
  // 从编辑器表单保存（新增/编辑）
  _saveKeeperEditor() {
    const body = document.getElementById('modalBody');
    const editingName = body ? (body.getAttribute('data-editor-name') || '') : '';
    const nEl = document.getElementById('keName');
    const pEl = document.getElementById('kePwd');
    const presetEl = document.getElementById('kePreset');
    const editing = !!editingName;
    const uname = editing ? editingName : (nEl ? nEl.value.trim() : '');
    const pwd = pEl ? pEl.value : '';
    if (!uname) { WBModal.alert('用户名不能为空'); return; }
    if (!editing && !pwd) { WBModal.alert('请设置初始密码'); return; }
    let modules, entries;
    const preset = presetEl ? presetEl.value : '';
    if (preset && typeof AppConfig !== 'undefined' && AppConfig.KEEPER_PRESETS[preset]) {
      const all = AppConfig.KEEPER_PRESETS[preset].slice();
      const entryKeys = (AppConfig.ENTRY_MODULES || []).map(function (e) { return e.key; });
      modules = all.filter(function (k) { return entryKeys.indexOf(k) === -1; });
      entries = all.filter(function (k) { return entryKeys.indexOf(k) !== -1; });
    } else {
      modules = [];
      entries = [];
      try {
        document.querySelectorAll('.ke-mod:checked').forEach(function (b) { modules.push(b.value); });
        document.querySelectorAll('.ke-entry:checked').forEach(function (b) { entries.push(b.value); });
      } catch (e) {}
    }
    const res = AppConfig.upsertKeeper(uname, pwd || undefined, { modules: modules, entries: entries });
    if (!res.ok) { WBModal.alert(res.msg || '保存失败'); return; }
    const overlay = document.getElementById('modalOverlay'); if (overlay) overlay.classList.remove('show');
    this.renderKeeperList();
    this.renderAccountBar();
    WBModal.alert((editing ? '已更新权限：' : '已新增账号：') + uname);
  },

  // ===== v217 模块权限（侧边栏显隐 / 路由拦截 / 落地页）=====
  // 当前登录账号是否可访问某模块（未登录/管理员/老账号 → 全开）
  _canAccessModule(moduleName) {
    if (typeof AppConfig === 'undefined' || !AppConfig.getKeepers) return true;
    // v222：管理员特权会话一旦建立就长期有效，不因后续登录库管员而失效
    // （修复「同时登录两个账号后，管理员就没其他模块权限了」）
    if (typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin()) return true;
    const u = AppConfig.getCurrentUser();
    // 🟢 v227.36：未登录 → 不显示任何业务模块（登录后才按权限显隐），仅保留账号条登录入口
    if (!u || !u.username) return false;
    // 🟢 v227.47：实体档案（stock-detail / supplier-detail / order-detail）是关联跳转的
    //   落地页，不在侧边栏显隐、不计入模块授权 —— 所有已登录账号都允许访问。
    //   这是修 v227.36 之后普通 keeper 在「现存量」里点不开「存货档案」的回归：
    //   旧版靠 mods.indexOf('stock-detail') 兜底，新版用 modules 数组显式收口后丢了。
    if (typeof moduleName === 'string' && moduleName.indexOf('-detail') !== -1) return true;
    const mods = AppConfig.getKeeperModules(u.username);
    if (!mods) return true;                              // 非库管员账号（管理员会话）→ 全开
    return mods.indexOf(moduleName) !== -1;
  },
  // 第一个有权限模块（按 MODULES 顺序），落地页用
  _firstAllowedModule() {
    if (typeof AppConfig === 'undefined' || !AppConfig.MODULES) return 'dashboard';
    for (let i = 0; i < AppConfig.MODULES.length; i++) {
      if (this._canAccessModule(AppConfig.MODULES[i].key)) return AppConfig.MODULES[i].key;
    }
    return 'dashboard';
  },
  // 按权限显隐侧边栏项（不带 data-module 的通用入口始终可见）
  _applySidebarVisibility() {
    try {
      const items = document.querySelectorAll('.sidebar-item[data-module]');
      const self = this;
      items.forEach(function (el) {
        const mod = el.getAttribute('data-module');
        el.style.display = self._canAccessModule(mod) ? '' : 'none';
      });
    } catch (e) {}
  },

  // 🟢 v227.37：4 个系统入口（云端同步 / 数据导入 / 设置 / 源码）按权限显隐
  //   - 管理员默认全开；老 keeper（无 entries 字段）默认全开（向后兼容）
  //   - 无权限：DOM display:none + onclick 已被 _wireEntryGuards 改写为空操作
  _applyEntryVisibility() {
    try {
      const items = document.querySelectorAll('.sidebar-item[data-entry]');
      const self = this;
      const user = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? AppConfig.getCurrentUser() : null;
      const name = user && user.username;
      items.forEach(function (el) {
        const key = el.getAttribute('data-entry');
        const allowed = AppConfig.canAccessEntry(name, key);
        el.style.display = allowed ? '' : 'none';
      });
    } catch (e) {}
  },

  // 🟢 v227.37：系统入口的统一守卫 —— DOM 隐藏的同时，把 onclick 临时改写为「无权限提示」
  _wireEntryGuards() {
    const self = this;
    document.querySelectorAll('.sidebar-item[data-entry]').forEach(function (el) {
      const key = el.getAttribute('data-entry');
      const allowed = AppConfig.canAccessEntry(
        (typeof AppConfig.getCurrentUser === 'function') ? (AppConfig.getCurrentUser() || {}).username : '',
        key
      );
      // 用属性 data-real-onclick 缓存原 onclick，便于恢复（避免多次重绑丢失）
      if (!el.hasAttribute('data-real-onclick')) el.setAttribute('data-real-onclick', el.getAttribute('onclick') || '');
      if (!allowed) {
        el.setAttribute('onclick', "WBModal && WBModal.alert && WBModal.alert('无权限：请联系管理员在「权限设置 → 编辑权限」中勾选此项'); return false;");
      } else {
        el.setAttribute('onclick', el.getAttribute('data-real-onclick') || '');
      }
    });
  },

  // 🟢 v227.37：4 个系统入口的对外方法（index.html onclick 直接调用；内部已自带权限判断）
  openCloudEntry() {
    if (!AppConfig.canAccessEntry(this._currentUserName(), 'cloud')) { WBModal.alert('无权限：请联系管理员在「权限设置 → 编辑权限」中勾选「云端同步」'); return; }
    if (typeof SyncManager !== 'undefined') SyncManager.showConfigDialog();
  },
  openImportEntry() {
    if (!AppConfig.canAccessEntry(this._currentUserName(), 'import')) { WBModal.alert('无权限：请联系管理员在「权限设置 → 编辑权限」中勾选「数据导入」'); return; }
    if (typeof DataLoader !== 'undefined') DataLoader.reimport();
  },
  // 设置与源码入口已有 initSettingsDrawer / sourceDownloadBtn 处理，这里只补权限门
  openSettingsEntry() {
    if (!AppConfig.canAccessEntry(this._currentUserName(), 'settings')) { WBModal.alert('无权限：请联系管理员在「权限设置 → 编辑权限」中勾选「设置」'); return; }
    this.openSettingsDrawer();
  },
  openSourceEntry() {
    if (!AppConfig.canAccessEntry(this._currentUserName(), 'source')) { WBModal.alert('无权限：请联系管理员在「权限设置 → 编辑权限」中勾选「源码」'); return; }
    if (typeof window.__startSourceDownload === 'function') window.__startSourceDownload();
  },
  _currentUserName() {
    try { const u = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? AppConfig.getCurrentUser() : null; return u ? u.username : ''; }
    catch (e) { return ''; }
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
    this._refreshSidebarTitle(document.getElementById('sidebarTitle'));
    document.getElementById('sidebarMood').value = '';
  },

  // ===== 全屏磨砂弹窗 =====
  bindPanel() {
    document.getElementById('panelClose').addEventListener('click', () => this.closePanel());
    document.getElementById('panelOverlay').addEventListener('click', () => this.closePanel());
    this._bindOverlayDashboardPause();
  },

  // v222：弹层打开期间暂停仪表盘轮播，全部关闭后恢复。
  // modal 的关闭路径分散在各处，用 overlay 的 class 变化统一兜底，比逐个补钩子可靠。
  _bindOverlayDashboardPause() {
    if (typeof MutationObserver === 'undefined') return;
    const self = this;
    const obs = new MutationObserver(() => {
      const modalOpen = document.getElementById('modalOverlay')?.classList.contains('show');
      const panelOpen = document.getElementById('panelOverlay')?.classList.contains('show');
      if (!modalOpen && !panelOpen) self._resumeDashboard();
    });
    ['modalOverlay', 'panelOverlay'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
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
    this._resumeDashboard();   // v222：面板/弹窗关完 → 恢复仪表盘轮播
  },

  // ===== v222 弹层期间暂停仪表盘动画 =====
  // 设置抽屉是覆盖在当前模块之上的 overlay，不走 App.go()，因此 dashboard 的
  // onLeave() 不会被触发——轮播会在弹窗背后持续重排 12 张 3D 卡片，白占合成开销。
  _pauseDashboard() {
    try {
      if (typeof DashboardModule !== 'undefined' && DashboardModule.stopAutoCoverflow) DashboardModule.stopAutoCoverflow();
    } catch (e) {}
  },
  _resumeDashboard() {
    try {
      // 仅当仍停留在仪表盘且轮播已初始化时才恢复，避免在别的模块把定时器重新拉起来
      if (this.currentModule !== 'dashboard') return;
      if (typeof DashboardModule === 'undefined' || !DashboardModule.startAutoCoverflow) return;
      if (!DashboardModule.coverflowItems || !DashboardModule.coverflowItems.length) return;
      if (document.getElementById('modalOverlay')?.classList.contains('show')) return;  // 还有弹窗开着
      DashboardModule.startAutoCoverflow();
    } catch (e) {}
  },

  // ===== 模块切换 =====
  // 轻量顶栏进度条（仅慢加载可见，非阻塞、不遮挡内容）
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

  // 🟢 v227.25：切模块骨架 overlay（独立于 contentArea，不会被 render 的 innerHTML 清空）
  _showSwitchSkeleton() {
    const host = document.querySelector('.main-content');
    if (!host) return;
    let sk = document.getElementById('switchSkeleton');
    if (!sk) {
      sk = document.createElement('div');
      sk.id = 'switchSkeleton';
      sk.className = 'switch-skeleton';
      sk.setAttribute('aria-busy', 'true');
      sk.innerHTML =
        '<div class="skeleton-bar skeleton-bar-1"></div>' +
        '<div class="skeleton-bar skeleton-bar-2"></div>' +
        '<div class="skeleton-bar skeleton-bar-3"></div>' +
        '<div class="skeleton-bar skeleton-bar-4"></div>';
      host.appendChild(sk);
    }
    // 强制重排以便 transition 生效，然后显示
    void sk.offsetWidth;
    sk.classList.add('show');
  },
  _hideSwitchSkeleton() {
    const sk = document.getElementById('switchSkeleton');
    if (sk) sk.classList.remove('show');
  },

  // ===== 模块切换（v213 优化：去全屏遮罩闪跳 + 轻量进度条 + 平滑淡入）=====
  async go(moduleName, params) {
    if (!this.modules[moduleName]) return;
    // v217 模块权限拦截：无权限账号禁止进入，并落地到第一个有权限模块
    if (!this._canAccessModule(moduleName)) {
      // 🟢 v227.36：未登录 → 显示「请先登录」占位（不弹空白/不告警），账号条提供登录入口
      const loggedIn = (typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn && AppConfig.isLoggedIn());
      if (!loggedIn) { this.showNotLoggedInState(); return; }
      const label = (window.AppConfig && AppConfig.MODULES_MAP && AppConfig.MODULES_MAP[moduleName]) || moduleName;
      if (moduleName === 'dashboard') {
        const alt = this._firstAllowedModule();
        if (alt && alt !== 'dashboard') { this.go(alt); return; }
      }
      if (typeof WBModal !== 'undefined' && WBModal.alert) WBModal.alert('当前账号无权限访问「' + label + '」模块');
      return;
    }
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
    // 🟢 v227.33：同步移动端底部 Tab 高亮（仅 query / stocktake 两个一级入口；
    //   切到抽屉里的其他模块时，两个 Tab 都不高亮——这是预期行为）
    document.querySelectorAll('.mtab-item[data-tab-module]').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-tab-module') === moduleName);
    });
    const titleEl = document.querySelector('.top-bar-left strong');
    if (titleEl) titleEl.textContent = targetMeta.title || '库管工作台';

    // 🟢 v213 优化：不再使用全屏遮罩（消除「全屏空白闪烁 + 卡顿」观感）。
    // 旧内容保留可见，渲染完成后再平滑淡入新内容；仅慢加载时显示轻量顶栏进度条。
    // 🟢 v227.25：切模块时挂一个独立骨架 overlay（覆盖在内容区之上，不随 innerHTML 清空），
    //   消除「卡片消失→出现」的空白期观感；同时旧内容半透明作为视觉衔接。
    const realArea = document.getElementById('contentArea');
    this._showSwitchSkeleton();
    if (realArea) realArea.classList.add('content-switching');
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
      if (realArea) {
        realArea.querySelector('.module-skeleton')?.remove();
        realArea.classList.remove('content-switching');
        this._hideSwitchSkeleton();
        realArea.innerHTML =
          '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载出错: ' +
          esc(renderErr.message || renderErr) + '</div></div>';
      }
    } else if (realArea) {
      // 🟢 v227.25：render 完成后立刻清掉骨架、淡入新内容（避免骨架-数据双层闪烁）
      this._hideSwitchSkeleton();
      realArea.classList.remove('content-switching');
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
  // 🟢 v227.41：顶部搜索框已替换为账号胶囊，全局搜索功能下线入口；保留方法以避免外部调用报错
  bindGlobalSearch() {
    /* noop — 顶部搜索框已被账号胶囊替代，全局搜索入口移除 */
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
