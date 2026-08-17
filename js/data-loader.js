// ============================================
// Excel 数据导入 - 使用 SheetJS
// ============================================

const DataLoader = {
  // Excel 源文件相对路径（与 config.js 中的 app.dataPath 保持一致，避免两处硬编码不同步）
  filePath: (typeof AppConfig !== 'undefined' && AppConfig.app && AppConfig.app.dataPath) || 'data/库管系统.xlsx',

  // 参与云端同步的数据表（meta 是元数据表，单独处理）
  // 注：materialClass / monthlyStats 自 v1 起从未被任何 loader 写入，属死代码，已从同步范围移除
  TABLES: ['suppliers', 'orders', 'inbound', 'stock', 'inventoryAlerts', 'orderChecks', 'pricing', 'lowTurnover', 'breach', 'outbound'],

  // 核心必填表（用于"完整性校验"）：这些表为空会直接导致页面/模块空白，必须非空。
  // breach / outbound / materialClass / monthlyStats 可能合法为空（无违约记录、尚未录入出库单等），
  // 不应作为强制条件，否则会误判"数据不完整"→ 每次刷新都强制重导、反复闪屏。
  REQUIRED_TABLES: ['suppliers', 'orders', 'inbound', 'stock', 'inventoryAlerts', 'orderChecks', 'pricing', 'lowTurnover'],

  // 主入口：检查并导入数据（本地优先，云端异步）
  async init() {
    // 🔴 重入保护（S2）：防止启动竞态或快速点击下 init 被并发调用，
    // 导致重复清空+导入（数据清空风险）。单飞锁确保同一时刻仅执行一次。
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().catch(err => { this._initPromise = null; throw err; });
    return this._initPromise;
  },

  async _doInit() {
    // 1) 本地已有数据 → 立即显示，后台静默尝试云端同步
    const imported = await DataStore.isDataImported();
    if (imported) {
      // 校验本地核心表是否完整；历史上出现过“标记已导入但部分表为空”导致整页空白，
      // 因此不完整时必须放弃本地缓存，改从云端/Excel 重新导入。
      const localComplete = await this._allCoreTablesPopulated();
      if (localComplete) {
        console.log('本地数据已存在，直接使用');
        // 后台尝试从云端拉取更新（不阻塞页面）
        this._syncFromCloudInBackground();
        return true;
      }
      console.warn('[data-loader] 本地数据不完整（缺表），放弃本地缓存改从云端/Excel 导入');
    }

    // 2) 无本地数据，尝试从云端拉取（8 秒超时）
    try {
      if (typeof SyncManager !== 'undefined') SyncManager.init();
    } catch (e) { /* ignore */ }

    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
      try {
        const bundle = await this._pullWithTimeout(8000);
        // ⚠️ 校验云端 bundle 完整性：9 张核心表必须都存在且有数据。
        // 历史上曾因导入 bug 把残缺 bundle 推到云端，导致新用户只拿到部分表 → 全表空白。
        // 若 bundle 不完整，回退到内置 Excel 导入（导入后会覆盖云端残缺 bundle）。
        if (bundle && bundle.tables && this._isBundleComplete(bundle)) {
          showLoading('正在从云端同步最新数据...');
          await this.loadBundleFromCloud(bundle);
          // 防御性校验：云端还原后实际落库的核心表可能仍缺（网络返回了部分响应等），
          // 若任一核心表为空，判定还原不完整，继续走 Excel 导入兜底。
          const restored = await this._allCoreTablesPopulated();
          hideLoading();
          if (restored) {
            console.log('已从云端同步数据');
            return true;
          }
          console.warn('[data-loader] 云端还原后仍缺核心表，改从内置 Excel 导入兜底');
        }
        if (bundle && bundle.tables && !this._isBundleComplete(bundle)) {
          console.warn('[data-loader] 云端 bundle 不完整（缺表或空表），改从内置 Excel 导入以修复');
        }
      } catch (e) {
        console.warn('云端拉取失败:', e.message || e);
      }
    }

    // 3) 都没有，读取内置 Excel
    return await this.importFromExcel();
  },

  // 校验云端 bundle 是否包含全部 9 张核心表且都有数据
  // 任一张缺失或为空 → 视为不完整，避免用残缺数据覆盖内置 Excel 的权威数据
  _isBundleComplete(bundle) {
    const coreTables = this.REQUIRED_TABLES;
    return coreTables.every(t => Array.isArray(bundle.tables[t]) && bundle.tables[t].length > 0);
  },

  // 校验本地库 9 张核心表是否都已有数据（防御云端部分还原）
  async _allCoreTablesPopulated() {
    try {
      const coreTables = this.REQUIRED_TABLES;
      for (const t of coreTables) {
        const cnt = await db[t].count();
        if (!cnt) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  },

  // 后台静默从云端拉取更新（不阻塞页面）
  async _syncFromCloudInBackground() {
    try {
      if (typeof SyncManager !== 'undefined') SyncManager.init();
    } catch (e) { return; }
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    // 显示同步中状态
    const stEl = document.getElementById('syncStatusText');
    const scEl = document.getElementById('syncStatus');
    if (stEl) { stEl.textContent = '同步中…'; stEl.style.color = '#0284c7'; }
    if (scEl) { scEl.classList.remove('online'); scEl.style.background = 'linear-gradient(135deg,rgba(2,132,199,0.12),rgba(14,165,233,0.08))'; }
    try {
      const bundle = await this._pullWithTimeout(8000);
      // 仅当云端 bundle 完整时才覆盖本地，避免用残缺数据污染本地
      if (bundle && bundle.tables && bundle.savedAt && this._isBundleComplete(bundle)) {
        const localTime = await DataStore.getImportTime();
        if (!localTime || bundle.savedAt > localTime) {
          console.log('云端有更新，自动同步中...');
          if (stEl) stEl.textContent = '更新中…';
          await this.loadBundleFromCloud(bundle);
          console.log('云端数据已更新，刷新视图');
          // 仅当没有打开的弹窗/侧边面板时才重渲染当前模块，
          // 避免后台同步把用户正在操作的对话框/抽屉"顶掉"或打断录入。
          const modalOpen = document.getElementById('modalOverlay') && document.getElementById('modalOverlay').classList.contains('show');
          const panelOpen = document.getElementById('panelOverlay') && document.getElementById('panelOverlay').classList.contains('show');
          if (!modalOpen && !panelOpen && typeof App !== 'undefined' && App.currentModule) {
            App.go(App.currentModule);
          } else {
            console.log('后台同步已完成，但检测到有打开的弹窗/面板，跳过强制重渲染以避免打断操作');
          }
        } else {
          console.log('本地已是最新，无需更新');
        }
      }
    } catch (e) {
      console.warn('后台同步失败:', e.message || e);
    }
    // 恢复正常状态
    if (typeof SyncManager !== 'undefined') SyncManager.updateUI();
    if (scEl) scEl.style.background = '';
  },

  // 带超时的云端拉取（防止网络请求卡死整个初始化）
  _pullWithTimeout(ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn('云端拉取超时(' + ms + 'ms)，回退本地');
        resolve(null); // 超时返回 null，走本地回退
      }, ms);
      SyncManager.pullData().then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  },

  // 分批写入辅助函数 - 避免 IndexedDB 事务超时
  async bulkAddSafe(table, rows, batchSize = 200) {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await table.bulkAdd(batch);
    }
  },

  // 从云端 bundle 还原数据（清空后批量写入），使分享链接自动拿到最新数据
  async loadBundleFromCloud(bundle) {
    if (!bundle || !bundle.tables) return false;
    await DataStore.clearAll();
    await new Promise(r => setTimeout(r, 300));

    const tables = bundle.tables || {};
    for (const name of this.TABLES) {
      const rows = Array.isArray(tables[name]) ? tables[name] : [];
      if (rows.length) {
        try {
          await this.bulkAddSafe(db[name], rows);
          console.log(`云端数据还原 ${name}: ${rows.length} 条`);
        } catch (e) {
          console.error(`还原 ${name} 失败:`, e);
        }
      }
    }
    await DataStore.markDataImported();
    return true;
  },

  // 打包全量数据并推送到云端（覆盖式），导入/重新导入后自动调用
  async pushAllToCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    // 防御：仅当 9 张核心表全部有数据时才推送，绝不把残缺 bundle 推到云端
    // （防止分享链接变空白）。manualPush / pushOutboundToCloud 兜底都走这里，统一拦截。
    const allPopulated = await this._allCoreTablesPopulated();
    if (!allPopulated) {
      console.warn('[data-loader] 本地存在空表，已跳过云端推送以避免污染分享链接');
      return false;
    }
    try {
      const tables = {};
      for (const name of this.TABLES) {
        tables[name] = await db[name].toArray();
      }
      const bundle = {
        version: DB_VERSION,
        savedAt: new Date().toISOString(),
        tables
      };
      const ok = await SyncManager.pushData(bundle);
      if (ok) console.log('已推送到云端，分享链接将自动更新');
      return ok;
    } catch (e) {
      console.error('打包推送失败:', e);
      return false;
    }
  },

  // 仅增量推送「出库」表到云端（不覆盖其他表）
  // 用于出库单录入/删除后实时同步，分享链接打开即可看到最新出库数据
  async pushOutboundToCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      // 取本地最新 outbound
      const outboundRows = await db.outbound.toArray();

      // 从云端拉取现有 bundle（保留其他表的数据）
      const existing = await SyncManager.pullData().catch(() => null);
      if (existing && existing.tables) {
        // 云端 bundle 可读：仅增量更新 outbound，保留其余表，节省带宽
        const bundle = {
          ...existing,
          version: DB_VERSION,
          savedAt: new Date().toISOString(),
          tables: { ...existing.tables, outbound: outboundRows }
        };
        const ok = await SyncManager.pushData(bundle);
        if (ok) console.log(`✅ [出库] 已单独同步 outbound 表到云端（${outboundRows.length} 条）`);
        return ok;
      }

      // 云端拉取失败/不存在：绝不用“仅 outbound”的残缺 bundle 覆盖云端，
      // 改为推送本地全量（完整），避免污染分享链接导致他人空白。
      console.warn('[data-loader] 云端拉取失败，改为推送本地全量以避免残缺覆盖');
      return await this.pushAllToCloud();
    } catch (e) {
      console.error('出库单独推送失败:', e);
      return false;
    }
  },

  // 从 Excel 文件导入数据（首次启动，读取内置文件或用户替换的文件）
  async importFromExcel() {
    showLoading('正在读取 Excel 数据...');
    try {
      let arrayBuffer;

      // 优先使用用户替换的内置工作簿
      const custom = await DataStore.getCustomWorkbook();
      if (custom) {
        arrayBuffer = custom;
        console.log('[data-loader] 使用替换后的内置工作簿');
      } else {
        // 回退到原始内置文件
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        const response = await fetch(this.filePath, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) throw new Error('无法读取 Excel 文件');
        arrayBuffer = await response.arrayBuffer();
      }

      return await this.importFromArrayBuffer(arrayBuffer, '首次导入');
    } catch (err) {
      console.error('数据导入失败:', err);
      hideLoading();
      alert('数据导入失败: ' + err.message);
      return false;
    }
  },

  // 核心导入逻辑：解析 arrayBuffer 并写入数据库
  async importFromArrayBuffer(arrayBuffer, label = '导入') {
    // 🔴 重入保护（S2）：防止"重新导入"/"恢复内置"/"导入替换"并发调用导致重复清空+导入
    if (this._importing) { console.warn('[data-loader] 已有导入进行中，忽略重复调用'); return false; }
    this._importing = true;
    try {
      // 🔴 失效存货编码缓存（M3）：重新导入后，旧映射已失效，否则新数据下编码错乱
      this._stockNameSpecCodeMap = null;
      showLoading('正在解析数据...');
    let workbook;
    try {
      workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    } catch (err) {
      throw new Error('文件解析失败，请确认是有效的 .xlsx / .xls 文件');
    }

    // 清空旧数据（等待事务完成）
    await DataStore.clearAll();
    await new Promise(r => setTimeout(r, 300));

    // 逐个导入工作表 - 每个独立 try-catch，失败不阻塞后续
    const tasks = [
      { name: '供应商', fn: () => this.loadSuppliers(workbook) },
      { name: '订单', fn: () => this.loadOrders(workbook) },
      { name: '入库', fn: () => this.loadInbound(workbook) },
      { name: '库存', fn: () => this.loadStock(workbook) },
      { name: '库存预警', fn: () => this.loadInventoryAlerts(workbook) },
      { name: '订货', fn: () => this.loadOrderChecks(workbook) },
      { name: '价格', fn: () => this.loadPricing(workbook) },
      { name: '低周转', fn: () => this.loadLowTurnover(workbook) },
      { name: '违约', fn: () => this.loadBreach(workbook) }
    ];

    for (const task of tasks) {
      try {
        showLoading(`正在导入${task.name}数据...`);
        await task.fn();
      } catch (err) {
        console.error(`${task.name}数据${label}失败:`, err);
        // 继续导入其他数据，不中断整体流程
      }
    }

    await DataStore.markDataImported();

    // 导入成功后推送云端（若已连接）。pushAllToCloud 内部已校验完整性，残缺时不推送。
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
      try {
        await this.pushAllToCloud();
      } catch (e) {
        console.warn('云端推送失败（本地数据已导入）:', e);
      }
    }

    hideLoading();
    return true;
    } finally {
      this._importing = false;
    }
  },

  // 重新导入数据：支持上传 .xlsx / .xls 文件，或重新导入内置数据
  reimport() {
    // 若已有模态框打开则先关闭
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.classList.remove('show');

    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    if (!modalBody || !modalTitle) return;

    modalTitle.textContent = '重新导入数据';
    modalBody.innerHTML = `
      <div style="width:100%;">
        <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px;line-height:1.5;">
          支持 <b>.xlsx</b>、<b>.xls</b> 与 <b>.xlsm</b> 格式。可上传新的数据文件覆盖当前数据，或重新导入系统内置的数据。
        </p>
        <div style="margin-bottom:18px;display:flex;justify-content:center;">
          <div style="display:flex;flex-direction:column;align-items:center;">
            <label style="font-size:11.5px;color:var(--text-secondary);margin-bottom:6px;">上传 Excel 文件（.xlsx / .xls / .xlsm）</label>
            <div class="file-input-wrapper" style="justify-content:center;">
              <input type="file" id="reimportFile" accept=".xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.ms-excel.sheet.macroEnabled.12"
                onchange="document.getElementById('reimportFileName').textContent=this.files[0]?this.files[0].name:'未选择文件'">
              <label for="reimportFile" class="file-input-label">📁 选择文件</label>
              <span id="reimportFileName" class="file-input-name">未选择文件</span>
            </div>
          </div>
        </div>
        <div class="btn-group" style="border-top:none;margin-top:14px;padding-top:0;display:flex;gap:10px;justify-content:center;">
          <button onclick="DataLoader.reimportFromDefault()" class="btn-secondary" style="flex:1;max-width:150px;padding:9px 0;font-size:12.5px;">🔄 重新导入内置</button>
          <button onclick="DataLoader.replaceAndImportBuiltIn()" class="btn-primary" style="flex:1;max-width:150px;padding:9px 0;font-size:12.5px;">📥 导入替换内置</button>
          <button onclick="DataLoader.reimportFromFile()" class="btn-primary" style="flex:1;max-width:150px;padding:9px 0;font-size:12.5px;">📤 上传并导入</button>
        </div>
      </div>
    `;
    // 使用紧凑弹窗宽度
    document.getElementById('modal').classList.add('modal-compact');
    modalOverlay.classList.add('show');
  },

  // 从上传的文件导入
  async reimportFromFile() {
    const fileInput = document.getElementById('reimportFile');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      alert('请先选择一个 .xlsx、.xls 或 .xlsm 文件');
      return;
    }
    const file = fileInput.files[0];
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.xlsm')) {
      alert('仅支持 .xlsx、.xls 或 .xlsm 格式的文件');
      return;
    }
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ok = await this.importFromArrayBuffer(arrayBuffer, '文件导入');
      if (ok) {
        document.getElementById('modalOverlay').classList.remove('show');
        alert('数据导入成功！');
        // 刷新当前视图
        if (typeof App !== 'undefined' && App.currentModule) {
          App.go(App.currentModule);
        }
      }
    } catch (err) {
      console.error('文件导入失败:', err);
      hideLoading();
      alert('导入失败: ' + err.message);
    }
  },

  // 重新导入内置 Excel
  async reimportFromDefault() {
    try {
      const ok = await this.importFromExcel();
      if (ok) {
        document.getElementById('modalOverlay').classList.remove('show');
        alert('内置数据已重新导入！');
        if (typeof App !== 'undefined' && App.currentModule) {
          App.go(App.currentModule);
        }
      }
    } catch (err) {
      console.error('内置数据导入失败:', err);
      hideLoading();
      alert('导入失败: ' + err.message);
    }
  },

  // 导入替换内置数据：上传新 Excel → 存为新的内置工作簿 → 立即导入
  async replaceAndImportBuiltIn() {
    const fileInput = document.getElementById('reimportFile');
    if (!fileInput || !fileInput.files || !fileInput.files.length) {
      alert('请先选择一个 Excel 文件作为替换的内置数据源');
      return;
    }
    const file = fileInput.files[0];
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.xlsm')) {
      alert('仅支持 .xlsx、.xls 或 .xlsm 格式');
      return;
    }

    try {
      showLoading('正在读取并存储替换工作簿...');
      const arrayBuffer = await file.arrayBuffer();

      // 1) 先校验文件能否正常解析（避免存入损坏文件）
      XLSX.read(arrayBuffer, { type: 'array', cellDates: true });

      // 2) 存储到 IndexedDB 作为新的"内置数据"
      await DataStore.saveCustomWorkbook(arrayBuffer);
      console.log('[data-loader] 替换工作簿已保存 (' + (arrayBuffer.byteLength / 1024 / 1024).toFixed(1) + ' MB)');

      // 3) 立即从该文件导入
      showLoading('正在从替换工作簿导入数据...');
      const ok = await this.importFromArrayBuffer(arrayBuffer, '替换导入');

      if (ok) {
        document.getElementById('modalOverlay').classList.remove('show');
        alert('✅ 内置数据已替换并导入成功！\n后续"重新导入内置"将使用此新文件。\n如需恢复原始文件，可在设置中清除。');
        if (typeof App !== 'undefined' && App.currentModule) {
          App.go(App.currentModule);
        }
      }
    } catch (err) {
      console.error('替换导入失败:', err);
      hideLoading();
      if (err.message.includes('解析失败') || err.message.includes('不支持')) {
        alert('文件解析失败，请确认是有效的 .xlsx / .xls / .xlsm 文件');
      } else {
        alert('替换导入失败: ' + err.message);
      }
    }
  },

  // 恢复原始内置数据：清除用户替换的工作簿后，重新导入系统内置文件
  // （importFromExcel 会先检查替换工作簿，清除后自动回退到原始内置文件）
  async restoreBuiltIn() {
    try {
      showLoading('正在恢复原始内置数据...');
      await DataStore.clearCustomWorkbook();
      const ok = await this.importFromExcel();
      if (ok) {
        const modalOverlay = document.getElementById('modalOverlay');
        if (modalOverlay) modalOverlay.classList.remove('show');
        alert('✅ 已恢复为原始内置数据！');
        if (typeof App !== 'undefined' && App.currentModule) {
          App.go(App.currentModule);
        }
      }
    } catch (err) {
      console.error('恢复原始内置数据失败:', err);
      hideLoading();
      alert('恢复失败: ' + err.message);
    }
  },

  // 各工作表表头的"标志性列名"——用于自动探测表头行，避免硬编码行号
  // 背景：SheetJS 解析时会剥离顶部连续空行，而内置 Excel 的第1行常带隐藏格式残留
  // （合并单元格/打印区域等），导致"同一 Excel 行号"在解析数组中错位一格。
  // 纯复制粘贴（无格式）的 Excel 没有这行残留，被多剥一行 → 表头错位 → 列名匹配失败 → 整表 0 导入。
  // 改用特征列名自动探测，彻底兼容两种文件。
  HEADER_SIGNATURES: {
    '供应商管理': ['供应商', '年度合同金额', '签订次数', '第一年度生效时间'],
    '采购订单列表': ['订单编号', '未入库量', '原币价税合计'],
    '供货2023.9.1-新入库': ['入库单号', '表体订单号', '原币价税合计'],
    '中心库房现存量': ['存货编码', '仓库名称', '现存数量'],
    // 注意：该表在第3行(Excel)有一行"工具栏/分组表头"(含 最低库存预警/是否需补货/最高库存/涉及订单号 等字样)，
    // 容易被误判为表头。真正的表头(第5行)独有 "仓库名称" 与 "近一年月均入库量" 两列，工具栏行不含，
    // 因此用这两个特征列 + 最低库存预警 来唯一定位真实表头，避免命中毒工具栏。
    '库存预警数量': ['仓库名称', '近一年月均入库量', '最低库存预警'],
    '订货': ['存货编码', '主计量', '在途订单', '低周转'],
    '供应商价格': ['供应商', '存货编码', '含税单价', '生效日期'],
    '低周转材料': ['存货编码', '现存数量', '暂无法使用量']
  },

  // 在前若干行内自动探测"含标志性列名最多的那一行"作为表头行
  detectHeaderRow(json, sheetName, fallbackRow) {
    const sigs = this.HEADER_SIGNATURES[sheetName];
    if (!sigs || !json || json.length === 0) return fallbackRow;
    let best = -1, bestHit = 0;
    const maxScan = Math.min(6, json.length);
    for (let i = 0; i < maxScan; i++) {
      const row = (json[i] || []).map(c => String(c == null ? '' : c).trim());
      if (row.every(c => c === '')) continue; // 跳过纯空行
      const hit = sigs.filter(s => row.some(c => c.includes(s))).length;
      if (hit > bestHit) { bestHit = hit; best = i; }
    }
    // 仅在至少命中 2 个特征列（排除元数据误命中）且优于回退行时采用；否则保持旧行为
    if (best >= 0 && bestHit >= 2) {
      if (best !== fallbackRow) {
        console.log(`[data-loader] 自动探测表头: ${sheetName} 表头行 → json[${best}] (原硬编码 json[${fallbackRow}])`);
      }
      return best;
    }
    return fallbackRow;
  },

  // 解析工作表为对象数组（精确指定表头行）
  parseSheet(workbook, sheetName, headerRow = 1) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      console.warn(`工作表 ${sheetName} 不存在`);
      return [];
    }

    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    // 自动探测真实表头行（兼容无格式/带格式两种 Excel，纠正空行剥离导致的错位）
    headerRow = this.detectHeaderRow(json, sheetName, headerRow);
    if (json.length <= headerRow + 1) return [];

    const headers = json[headerRow].map(h => String(h || '').trim().replace(/\n/g, ''));
    const rows = [];

    for (let i = headerRow + 1; i < json.length; i++) {
      const row = json[i];
      if (!row || row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

      const obj = {};
      headers.forEach((h, idx) => {
        if (h) {
          const val = row[idx];
          // 统一用 recoverExcelDate 处理日期（修复少一天/差43秒问题）
          obj[h] = this.recoverExcelDate(val);
        }
      });

      // 只保留有有效数据的行
      const hasData = Object.values(obj).some(v => v !== '' && v !== null && v !== undefined);
      if (hasData) rows.push(obj);
    }

    return rows;
  },

  // 1. 供应商管理 (headerRow=1) — 已入库金额多源匹配
  async loadSuppliers(workbook) {
    showLoading('正在导入供应商数据...');
    const rows = this.parseSheet(workbook, '供应商管理', 1);

    // 智能匹配已入库金额列名（Excel 可能含各种日期前缀）
    const sampleRow = rows[0] || {};
    const inboundAmountKey = Object.keys(sampleRow).find(k =>
      k.includes('已供入库金额') && !k.includes('占比')
    ) || '年度合同生效时间至2026-7-31已供入库金额';

    // 匹配已入库金额占比
    const inboundRatioKey = Object.keys(sampleRow).find(k =>
      k.includes('已供入库金额') && k.includes('占比')
    ) || '年度已供入库金额占比';

    const clean = rows.map(r => ({
      类型: r['类型'] || '',
      供应商: r['供应商'] || '',
      第一年度生效时间: this.recoverExcelDate(r['第一年度生效时间']),
      第二年度生效时间: this.recoverExcelDate(r['第二年度生效时间']),
      第三年度生效时间: this.recoverExcelDate(r['第三年度生效时间']),
      签订次数: this.parseNum(r['签订次数']),
      合同年限: this.parseNum(r['合同年限']),
      年度合同到期时间: this.recoverExcelDate(r['年度合同到期时间']),
      年度合同剩余时间: this.parseNum(r['年度合同剩余时间']),
      最终到期时间: this.recoverExcelDate(r['最终到期时间']),
      年度合同金额: this.parseNum(r['年度合同金额']),
      年度已供入库金额: this.parseNum(r[inboundAmountKey] || r['年度已供入库金额']),
      年度已供入库金额占比: this.parseNum(r[inboundRatioKey] || r['年度已供入库金额占比']),
      合同: r['合同'] || '',
      生产厂址: r['生产厂址'] || '',
      地址: r['地址'] || '',
      招采部门: r['招采部门'] || '',
      询价反馈时间: this.recoverExcelDate(r['询价反馈时间']),
      未入库金额: this.parseNum(r['未入库金额'])
    })).filter(r => r.供应商).map(r => this._cleanRecord(r));

    // 若已入库金额全为0，从入库表按供应商汇总补全
    const allZeroInbound = clean.length > 0 && clean.every(s => !s.年度已供入库金额 || s.年度已供入库金额 === 0);
    if (allZeroInbound) {
      console.log('[data-loader] 供应商已入库金额全0，尝试从入库表汇总补全...');
      try {
        const inboundRows = await db.inbound.toArray();
        const supplierInboundMap = new Map();
        inboundRows.forEach(row => {
          const sup = row.供应商;
          if (!sup) return;
          const amount = parseFloat(row.原币价税合计) || 0;
          supplierInboundMap.set(sup, (supplierInboundMap.get(sup) || 0) + amount);
        });
        let fixed = 0;
        clean.forEach(s => {
          if (supplierInboundMap.has(s.供应商)) {
            s.年度已供入库金额 = supplierInboundMap.get(s.供应商);
            // 自动计算占比
            if (s.年度合同金额 > 0) {
              s.年度已供入库金额占比 = s.年度已供入库金额 / s.年度合同金额;
            }
            fixed++;
          }
        });
        console.log(`[data-loader] 从入库表补全 ${fixed}/${clean.length} 条供应商已入库金额`);
      } catch(e) { console.warn('[data-loader] 入库表补全失败:', e); }
    }

    await this.bulkAddSafe(db.suppliers, clean);
    console.log(`供应商数据导入完成: ${clean.length} 条`);
  },

  // 2. 采购订单列表 (headerRow=1)
  async loadOrders(workbook) {
    showLoading('正在导入订单数据...');
    const rows = this.parseSheet(workbook, '采购订单列表', 1);
    const clean = rows.map(r => ({
      序号: this.parseNum(r['序号']),
      订单编号: r['订单编号'] ? String(r['订单编号']) : '',
      日期: this.recoverExcelDate(r['日期']),
      项目名称: r['项目名称'] || '',
      供应商: r['供应商'] || '',
      存货编号: r['存货编号'] ? String(r['存货编号']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      数量: this.parseNum(r['数量']),
      未入库量: this.parseNum(r['未入库量']),
      累计入库数量: this.parseNum(r['累计入库数量']),
      原币含税单价: this.parseNum(r['原币含税单价']),
      原币价税合计: this.parseNum(r['原币价税合计']),
      项目大类名称: r['项目大类名称'] || '',
      制单人: r['制单人'] || '',
      行关闭人: r['行关闭人'] || '',
      审批状态: r['审批状态'] || '',
      来源订单号: r['来源订单号'] ? String(r['来源订单号']) : '',
      审核人: r['审核人'] || '',
      已下单时间: (r['已下单时间'] && r['已下单时间'] !== '0') ? this.recoverExcelDate(r['已下单时间']) : '',
      未入总金额: this.parseNum(r['未入总金额'])
    })).filter(r => r.订单编号).map(r => this._cleanRecord(r));

    await this.bulkAddSafe(db.orders, clean);
    console.log(`订单数据导入完成: ${clean.length} 条`);
  },

  // 3. 入库列表 (headerRow=1)
  async loadInbound(workbook) {
    showLoading('正在导入入库数据...');
    const rows = this.parseSheet(workbook, '供货2023.9.1-新入库', 1);
    const clean = rows.map(r => ({
      序号: this.parseNum(r['序号']),
      表体订单号: r['表体订单号'] ? String(r['表体订单号']) : '',
      仓库: r['仓库'] || '',
      入库日期: this.recoverExcelDate(r['入库日期']),
      审核人: r['审核人'] || '',
      项目名称: r['项目名称'] || '',
      入库单号: r['入库单号'] ? String(r['入库单号']) : '',
      供应商: r['供应商'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      数量: this.parseNum(r['数量']),
      累计出库数量: this.parseNum(r['累计出库数量']),
      原币含税单价: this.parseNum(r['原币含税单价']),
      原币价税合计: this.parseNum(r['原币价税合计']),
      原币金额: this.parseNum(r['原币金额']),
      原币税额: this.parseNum(r['原币税额']),
      税率: this.parseNum(r['税率']),
      实际到货日期: this.recoverExcelDate(r['实际到货日期'])
    })).filter(r => r.入库单号 || r.存货名称).map(r => this._cleanRecord(r));

    await this.bulkAddSafe(db.inbound, clean);
    console.log(`入库数据导入完成: ${clean.length} 条`);
  },

  // 4. 现存量 (headerRow=1)
  async loadStock(workbook) {
    showLoading('正在导入库存数据...');
    const rows = this.parseSheet(workbook, '中心库房现存量', 1);
    const clean = rows.map(r => ({
      仓库名称: r['仓库名称'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      现存数量: this.parseNum(r['现存数量']),
      数据更新时间: this.recoverExcelDate(r['数据更新时间']) || '2026-08-03'
    })).filter(r => r.存货编码 || r.存货名称).map(r => this._cleanRecord(r));

    await this.bulkAddSafe(db.stock, clean);
    console.log(`库存数据导入完成: ${clean.length} 条`);
  },

  // 5. 库存预警 — 补货值取J列"是否需补货"原始数值（按位置硬编码，不依赖名称匹配）
  async loadInventoryAlerts(workbook) {
    showLoading('正在导入库存预警数据...');

    const sheet = workbook.Sheets['库存预警数量'];
    if (!sheet) { console.warn('[data-loader] ⚠️ 工作表"库存预警数量"不存在！可用工作表:', Object.keys(workbook.Sheets)); return; }

    // 用 parseSheet 解析（headerRow=4 → 第5行=表头）
    const rows = this.parseSheet(workbook, '库存预警数量', 4);
    if (rows.length === 0) { console.warn('[data-loader] 库存预警数量表解析后无数据'); return; }

    const sampleRow = rows[0] || {};
    const allKeys = Object.keys(sampleRow);
    console.log(`[data-loader] 库存预警: 解析出 ${allKeys.length} 个列`);

    // ===== 现存量列 =====
    const stockKey = allKeys.find((k, i) => {
      const ck = String(k).trim().replace(/[\u200B-\u200D\uFEFF\u00A0\u3000]/g, '');
      return ck.includes('现存量') && !ck.includes('预警') && !ck.includes('最低');
    }) || allKeys.find((k, i) => {
      const ck = String(k).trim().replace(/[\u200B-\u200D\uFEFF\u00A0\u3000]/g, '');
      return ck.includes('现存量');
    }) || '2026-08-03现存量';

    // ===== 补货值列：按位置硬编码 J列(index=9) + 名称匹配双重保险 =====
    let restockKey = null;

    // 方法A：名称匹配（清理不可见字符后）
    for (let i = 0; i < allKeys.length; i++) {
      const ck = String(allKeys[i]).trim()
        .replace(/[\u200B-\u200D\uFEFF\u00A0\u3000]/g, '').replace(/\s+/g, ' ');
      if (ck.includes('补货') || ck.includes('需补') || ck === '是否需补货' || ck === '补货值') {
        restockKey = allKeys[i];
        break;
      }
    }

    // 方法B：如果名称匹配失败，强制用第10列(J列, index=9)
    if (!restockKey && allKeys.length >= 10) {
      restockKey = allKeys[9];
    }

    const clean = rows.map(r => {
      const 现存量 = this.parseNum(r[stockKey] || r['现存量'] || r['现存数量']);
      const 最低库存预警 = this.parseNum(r['最低库存预警']);
      const 最高库存 = this.parseNum(r['最高库存']);
      const 在途订单 = this.parseNum(r['在途订单']);
      // 补货值：直接取源数据J列原始数值，不做任何计算
      let 补货值 = 0;
      if (restockKey) {
        补货值 = this.parseNum(r[restockKey]);
      }
      return {
        序号: this.parseNum(r['序号']),
        仓库名称: r['仓库名称'] || '',
        存货编码: r['存货编码'] ? String(r['存货编码']) : '',
        存货名称: r['存货名称'] || '',
        规格型号: r['规格型号'] ? String(r['规格型号']) : '',
        近一年月均入库量: this.parseNum(r['近一年月均入库量']),
        最低库存预警,
        最高库存: this.parseNum(r['最高库存']),
        现存量,
        补货值,
        在途订单,
        所上或库房: String(r['所上或库房'] || ''),
        工程项目: String(r['工程项目'] || ''),
        分类: r['分类'] || '',
        涉及订单号: r['涉及订单号'] ? String(r['涉及订单号']) : ''
      };
    }).filter(r => r.存货编码 || r.存货名称);

    // ===== 补货值统计（汇总）=====
    const withRestock = clean.filter(r => r.补货值 > 0);
    console.log(`[data-loader] 库存预警: 总 ${clean.length} 条, 补货值>0 的有 ${withRestock.length} 条`);

    // 若现存量仍全为0，从库存表(中心库房现存量)交叉补全
    const allZero = clean.length > 0 && clean.every(r => !r.现存量 || r.现存量 === 0);
    if (allZero) {
      console.log('[data-loader] 库存预警现存量全0，尝试从库存表交叉补全...');
      try {
        const stockRows = await db.stock.toArray();
        const stockMap = new Map();
        stockRows.forEach(s => {
          const key = s.存货编码 || s.存货名称;
          if (key) stockMap.set(key, s.现存数量);
        });
        let fixed = 0;
        clean.forEach(item => {
          const key = item.存货编码 || item.存货名称;
          if (key && stockMap.has(key)) {
            item.现存量 = stockMap.get(key);
            fixed++;
          }
        });
        console.log(`[data-loader] 从库存表补全 ${fixed}/${clean.length} 条现存量`);
      } catch(e) { console.warn('[data-loader] 库存表补全失败:', e); }
    }

    await this.bulkAddSafe(db.inventoryAlerts, clean);
    const restockPositive = clean.filter(r => r.补货值 > 0);
    console.log(`库存预警数据导入完成: 总 ${clean.length} 条, 补货值>0 的有 ${restockPositive.length} 条`);
    if (restockPositive.length === 0) {
      console.warn('[data-loader] ⚠️ 补货值全部为0！请检查源数据"是否需补货"列');
    }
  },

  // 6. 订货核对 (headerRow=2)
  async loadOrderChecks(workbook) {
    showLoading('正在导入订货数据...');
    const rows = this.parseSheet(workbook, '订货', 2);
    const clean = rows.map(r => ({
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      主计量: r['主计量'] || '',
      数量: this.parseNum(r['数量']),
      现存量: this.parseNum(r['2026-08-03现存量'] || r['现存量']),
      在途订单: this.parseNum(r['在途订单']),
      所上或库房: String(r['所上或库房'] || ''),
      工程项目: String(r['工程项目'] || ''),
      分类: r['分类'] || '',
      低周转: r['低周转'] || ''
    })).filter(r => r.存货编码 || r.存货名称);

    await this.bulkAddSafe(db.orderChecks, clean);
    console.log(`订货数据导入完成: ${clean.length} 条`);
  },

  // 7. 供应商价格 (headerRow=1)
  async loadPricing(workbook) {
    showLoading('正在导入价格数据...');
    const rows = this.parseSheet(workbook, '供应商价格', 1);
    const clean = rows.map(r => ({
      序号: this.parseNum(r['序号']),
      选择: r['选择'] || '',
      价格标识: r['价格标识'] || '',
      供应商: r['供应商'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      主计量: r['主计量'] || '',
      生效日期: this.recoverExcelDate(r['生效日期']),
      失效日期: this.recoverExcelDate(r['失效日期']),
      币种: r['币种'] || '',
      含税单价: this.parseNum(r['含税单价']),
      税率: this.parseNum(r['税率']),
      单价: this.parseNum(r['单价']),
      类型: r['类型'] || ''
    })).filter(r => r.供应商 && r.存货名称);

    await this.bulkAddSafe(db.pricing, clean);
    console.log(`价格数据导入完成: ${clean.length} 条`);
  },

  // 8. 低周转材料 (headerRow=2)
  async loadLowTurnover(workbook) {
    showLoading('正在导入低周转数据...');
    const rows = this.parseSheet(workbook, '低周转材料', 2);
    const clean = rows.map(r => ({
      仓库名称: r['仓库名称'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      现存数量: this.parseNum(r['现存数量']),
      暂无法使用量: this.parseNum(r['暂无法使用量'])
    })).filter(r => r.存货编码 || r.存货名称);

    await this.bulkAddSafe(db.lowTurnover, clean);
    console.log(`低周转数据导入完成: ${clean.length} 条`);
  },

  // 9. 违约台账 — 精确定位"延迟天数"列序号取值（不依赖名字匹配/猜列号）
  async loadBreach(workbook) {
    showLoading('正在导入违约数据...');

    const sheet = workbook.Sheets['违约台账'];
    const raw2d = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    // 1) 找表头行（含"延迟天数"的那一行）
    let headerRowIdx = -1;
    for (let ri = 0; ri < Math.min(10, raw2d.length); ri++) {
      if (raw2d[ri] && raw2d[ri].some(c => String(c || '').includes('延迟天数'))) {
        headerRowIdx = ri; break;
      }
    }
    if (headerRowIdx < 0) { headerRowIdx = 2; }
    const headerCells = (raw2d[headerRowIdx] || []).map(c => String(c || '').trim());

    // 2) 在表头里精确定位"延迟天数"的列序号
    const delayColIdx = headerCells.findIndex(h => h.includes('延迟天数'));
    console.log(`[违约台账] 表头行=row[${headerRowIdx}], 延迟天数列序号=${delayColIdx} (0-based)`);
    console.log(`[违约台账] 表头: ${headerCells.join(' | ')}`);

    // 3) 直接按列序号从数据行取值，避免列错位
    const clean = [];
    for (let ri = headerRowIdx + 1; ri < raw2d.length; ri++) {
      const row = raw2d[ri];
      if (!row || row.every(c => c === '' || c === null || c === undefined)) continue;
      const get = (i) => (i >= 0 && i < row.length) ? row[i] : '';
      const companyName = get(headerCells.findIndex(h => h.includes('公司名称')));
      if (!companyName) continue;

      const delayVal = delayColIdx >= 0 ? this.parseNum(get(delayColIdx)) : 0;
      console.log(`[违约台账] 数据行[${ri}] 延迟天数(raw[${delayColIdx}])=${delayVal}`);

      clean.push({
        公司名称: companyName,
        涉及订单号: String(get(headerCells.findIndex(h => h.includes('涉及订单号'))) || ''),
        存货编码: String(get(headerCells.findIndex(h => h.includes('存货编码'))) || ''),
        存货名称: get(headerCells.findIndex(h => h.includes('存货名称'))) || '',
        规格型号: String(get(headerCells.findIndex(h => h.includes('规格型号'))) || ''),
        单价: this.parseNum(get(headerCells.findIndex(h => h.includes('单价')))),
        数量: this.parseNum(get(headerCells.findIndex(h => h.includes('数量')))),
        到货时间: this.recoverExcelDate(get(headerCells.findIndex(h => h.includes('到货时间')))),
        延迟天数: delayVal,
        扣款金额: this.parseNum(get(headerCells.findIndex(h => h.includes('扣款金额')))),
        备注: get(headerCells.findIndex(h => h.includes('备注'))) || ''
      });
    }

    // 计算扣款比例（按延迟天数查规则表）与违约次数（按公司名称聚合的违约记录数）
    clean.forEach(r => this._cleanRecord(r));
    const companyCountMap = new Map();
    clean.forEach(r => {
      if (r.公司名称) companyCountMap.set(r.公司名称, (companyCountMap.get(r.公司名称) || 0) + 1);
    });
    clean.forEach(r => {
      r.扣款比例 = this._calcBreachRatio(r.延迟天数);
      r.违约次数 = companyCountMap.get(r.公司名称) || 0;
    });

    await this.bulkAddSafe(db.breach, clean);
    console.log(`违约数据导入完成: ${clean.length} 条, 首条延迟天数=${clean.length > 0 ? clean[0].延迟天数 : '无'}`);
  },

  // 工具方法：解析数值
  parseNum(val) {
    if (val === '' || val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    const parsed = parseFloat(String(val).replace(/,/g, ''));
    return isNaN(parsed) ? 0 : parsed;
  },

  // 违约扣款比例计算：按延迟天数查规则表
  // 规则：不满2天按2天计算(5%)；大于2天不满4天按4天(10%)；
  //      大于4天不满6天按6天(15%)；大于6天不满8天按8天(20%)；8天及以上20%
  _calcBreachRatio(delayDays) {
    const d = this.parseNum(delayDays);
    if (!d || d <= 0) return 0;
    // 向上取整到最近的偶数（2/4/6/8），并封顶 8 天
    let bucket = Math.ceil(d / 2) * 2;
    bucket = Math.min(bucket, 8);
    const ratioMap = { 2: 5, 4: 10, 6: 15, 8: 20 };
    return ratioMap[bucket] || 0;
  },

  // 统一值清洗：去除所有空白字符（含不可见字符、全角/半角空格）+ trim
  // 解决 Excel 导入值含空格导致搜索"兴乐"匹配失败的问题
  _cleanVal(v) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'string') return v;
    return v.replace(/[\s\u200B-\u200D\uFEFF\u00A0\u1680\u180E\u2000-\u200A\u2028-\u2029\u202F\u205F\u3000]+/g, '').trim();
  },

  // 清洗记录中所有字符串字段（在 import map 后统一调用）
  _cleanRecord(rec) {
    if (!rec || typeof rec !== 'object') return rec;
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      if (typeof v === 'string') rec[key] = this._cleanVal(v);
    }
    return rec;
  },

  // ============================================
  // 存货编码查找工具（基于现存量基础档案）
  // ============================================
  // 缓存：(存货名称|规格型号) → 存货编码 的映射 Map
  _stockNameSpecCodeMap: null,

  // 构建/获取映射（懒加载，首次调用时从 db.stock 构建）
  async getStockNameSpecCodeMap() {
    if (this._stockNameSpecCodeMap) return this._stockNameSpecCodeMap;
    const rows = await db.stock.toArray();
    const map = new Map();
    rows.forEach(s => {
      if (s.存货名称) {
        const key = TableUtils.buildStockKey(s.存货名称, s.规格型号);
        if (key && s.存货编码) map.set(key, String(s.存货编码));
      }
    });
    this._stockNameSpecCodeMap = map;
    console.log('[DataLoader] 存货编码映射构建完成: ' + map.size + ' 条');
    return map;
  },

  // 便捷查询：根据存货名称+规格型号返回存货编码
  // 用于订单跟踪、订单列表等没有原生存货编码字段的模块
  async getStockCode(存货名称, 规格型号) {
    const map = await this.getStockNameSpecCodeMap();
    const key = TableUtils.buildStockKey(存货名称, 规格型号);
    return map.get(key) || '';
  },

  // 批量填充：对一组记录数组，按(存货名称+规格型号)查表填入 _存货编码 字段
  // 返回原数组引用（就地修改，不创建新数组）
  async enrichWithStockCode(records) {
    const map = await this.getStockNameSpecCodeMap();
    records.forEach(r => {
      if (r.存货名称) {
        const key = TableUtils.buildStockKey(r.存货名称, r.规格型号);
        r._存货编码 = map.get(key) || '';
      }
    });
    return records;
  },

  // 工具方法：从 Excel 单元格值还原正确的日期字符串
  // ⚠️ 根因（关键！）：
  //   SheetJS 用 {cellDates:true} 把 Excel 日期序列号转成 JS Date 时，会引入
  //   时区 + epoch 误差（实测：源 2026/6/1 被解析成 2026-05-31 23:59:17，差 1 天还差 43 秒）。
  //   无论用 .toISOString()(UTC) 还是 getFullYear/getMonth/getDate()(本地)，
  //   由于 Date 对象本身已错位，结果都会是"少一天"。
  // ✅ 正确做法：从（可能错位的）Date 反推 Excel 序列号，再按标准 1900 日期系统
  //   以 UTC 午夜重新换算，得到与源数据完全一致的日期。
  // ⚠️ 重要：只处理 Date 对象！普通数字、字符串等必须原样返回，
  //   否则金额/数量等数值会被误判为日期序列号而破坏。
  recoverExcelDate(val) {
    // 仅处理 Date 对象（SheetJS {cellDates:true} 已将日期序列号转为 Date）
    if (val instanceof Date) {
      const approxSerial = (val.getTime() / 86400000) + 25569;
      const serial = Math.round(approxSerial);
      const correct = new Date((serial - 25569) * 86400000); // UTC 午夜
      return `${correct.getUTCFullYear()}-${String(correct.getUTCMonth() + 1).padStart(2, '0')}-${String(correct.getUTCDate()).padStart(2, '0')}`;
    }
    // 非日期值（数字、字符串、空值等）→ 原样返回，绝不转换
    return val;
  }
};

// 加载遮罩工具函数
function showLoading(text) {
  const overlay = document.getElementById('loadingOverlay');
  const textEl = document.getElementById('loadingText');
  if (overlay) overlay.style.display = 'flex';
  if (textEl) textEl.textContent = text || '加载中...';
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = 'none';
}