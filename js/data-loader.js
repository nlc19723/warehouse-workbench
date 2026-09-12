// ============================================
// Excel 数据导入 - 使用 SheetJS
// ============================================

// 🟢 v208 AUDIT-303：云端同步「乐观锁基准」的存储键。
// 记录本机最后一次与云端对齐的 savedAt（拉取或推送成功时更新）。
// 推送前比对云端 savedAt：不一致说明云端已被其它设备改动 → 中止，避免静默覆盖。
const CLOUD_BASE_KEY = 'wb_cloud_base_savedAt';

const DataLoader = {
  // Excel 源文件相对路径（与 config.js 中的 app.dataPath 保持一致，避免两处硬编码不同步）
  filePath: (typeof AppConfig !== 'undefined' && AppConfig.app && AppConfig.app.dataPath) || '',

  // 读取/写入乐观锁基准（localStorage 不可用时退化为内存变量）
  _cloudBase() {
    try { return localStorage.getItem(CLOUD_BASE_KEY) || null; }
    catch (e) { return this._cloudBaseMem || null; }
  },
  _setCloudBase(v) {
    try { localStorage.setItem(CLOUD_BASE_KEY, v || ''); }
    catch (e) { this._cloudBaseMem = v || ''; }
  },

  // 参与云端同步的数据表（meta 是元数据表，单独处理）
  // 注：materialClass / monthlyStats 自 v1 起从未被任何 loader 写入，属死代码，已从同步范围移除
  TABLES: ['suppliers', 'orders', 'inbound', 'stock', 'inventoryAlerts', 'orderChecks', 'pricing', 'lowTurnover', 'breach', 'outbound', 'tempOutbound'],

  // 🔵 数据包边界（v227.97 关键约束）：
  //   · 出库单 outbound / 临时出库 tempOutbound 归「设置数据包」settings.json 管理
  //     （对应字段 outbound_list / temp_outbound_list），上传与恢复都只走这一条通道。
  //   · 它们【绝不】进入「工作数据包」data.json，避免出现「一份数据落在两个包」造成污染。
  //   · 工作包（data.json / base.json）及其还原(loadBundleFromCloud)、推送(pushAllToCloud)
  //     只操作下方 WORK_TABLES，永不触碰 SETTING_TABLES。
  SETTING_TABLES: ['outbound', 'tempOutbound'],
  get WORK_TABLES() {
    return this.TABLES.filter(t => this.SETTING_TABLES.indexOf(t) < 0);
  },

  // 核心必填表（用于"完整性校验"）：这些表为空会直接导致页面/模块空白，必须非空。
  // breach / outbound / materialClass / monthlyStats 可能合法为空（无违约记录、尚未录入出库单等），
  // 不应作为强制条件，否则会误判"数据不完整"→ 每次刷新都强制重导、反复闪屏。
  REQUIRED_TABLES: ['suppliers', 'orders', 'inbound', 'stock', 'inventoryAlerts', 'orderChecks', 'pricing', 'lowTurnover'],

  // 主入口：检查并导入数据（本地优先，云端异步）
  init() {
    // 🔴 重入保护（S2）：防止启动竞态或快速点击下 init 被并发调用，
    // 导致重复清空+导入（数据清空风险）。单飞锁确保同一时刻仅执行一次。
    if (this._initPromise) return this._initPromise;
    this._aborted = false;
    this._booting = true;
    this._done = false;
    let resolveOuter, rejectOuter;
    const outer = new Promise((res, rej) => { resolveOuter = res; rejectOuter = rej; });
    this._forceResolve = resolveOuter;
    this._initPromise = outer;

    // 🟢 v228.22 B-1：看门狗——防止任意内部步骤（云端拉取 / 基准垫底 / Excel 导入）永久挂起，
    //   导致加载遮罩永远不消失、用户被锁死在空白页。超时后强制隐藏遮罩并进入空状态引导。
    if (typeof LoadingHUD !== 'undefined') LoadingHUD._onSkip = () => this._userSkip();
    this._watchdog = setTimeout(() => {
      if (this._done) return;
      console.warn('[data-loader] 启动加载超过 15s 未结束，强制恢复界面（B-1 看门狗）');
      this._aborted = true;
      this._finishBoot(false);
    }, 15000);

    (async () => {
      try {
        const r = await this._doInit();
        this._finishBoot(r);
      } catch (err) {
        console.error('[data-loader] init 异常:', err);
        this._finishBoot(false);
      }
    })();
    return this._initPromise;
  },

  // 🟢 v228.22：统一收尾（正常结束 / 超时 / 用户跳过都走这里），保证看门狗 Timer 与单飞 Promise 正确落定
  _finishBoot(result) {
    if (this._done) return;
    this._done = true;
    this._booting = false;
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    if (this._forceResolve) this._forceResolve(result);
  },

  // 🟢 v228.22 B-1：用户点击「跳过并进入工作台」——立即隐藏遮罩、中止启动加载、进入空状态
  _userSkip() {
    if (this._done) return;
    this._aborted = true;
    hideLoading();
    this._finishBoot(false);
  },

  // 🟢 v228.22 B-3：标记「当前数据为内置示例数据」。仅在自动垫底（Excel / 云端基准）成功时置位；
  //   用户真实导入 / 云端同步成功时清除。供界面顶部横幅提示「当前为示例数据」，避免与真实数据混淆。
  async _markBuiltinSeeded() {
    try { await db.meta.put({ key: 'builtinSeeded', value: true, time: new Date().toISOString() }); } catch (e) { /* 非关键标记，失败不阻断 */ }
  },
  async isBuiltinSeeded() {
    try { const m = await db.meta.get('builtinSeeded'); return !!(m && m.value); } catch (e) { return false; }
  },

  async _doInit() {
    // 先初始化云端连接（仅"手动保存过配置"的用户才会 isOnline=true，
    // 详见 SyncManager.init：内置共享配置不再自动上线，未连接用户不会碰云端）
    try {
      if (typeof SyncManager !== 'undefined') SyncManager.init();
    } catch (e) {
    /* ignore */ console.warn('[data-loader.js:47] 异常(已忽略):', e);
  }

    // 🟢 v228.22 B-1：启动加载期间若用户点了「跳过」，本助手函数静默跳过 showLoading，
    //   避免遮罩在后台任务仍运行时被重新点亮，让用户再次被困。
    const sl = (t, o) => { if (!this._aborted) showLoading(t, o); };

    // 1) 本地已有完整数据 → 立即显示（首屏不阻塞），后台静默从云端拉取并按"云端优先覆盖本地"策略同步
    const imported = await DataStore.isDataImported();
    if (imported) {
      const localComplete = await this._allCoreTablesPopulated();
      if (localComplete) {
        console.log('[同步] 本地有完整数据，立即显示；后台静默执行：云端→本地（云端不一致则覆盖本地）');
        hideLoading();
        this._syncFromCloudInBackground();  // 云端优先覆盖本地，不阻塞首屏
        return true;
      }
      console.warn('[data-loader] 本地数据不完整（缺表），放弃本地缓存改从云端/Excel 导入');
    }

    // 2) 本地无完整数据：已连接云端则先拉云端工作数据；否则直接 Excel 兜底
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
      sl('正在从云端同步数据...', { variant:'capsule' });
      try {
        const bundle = await this._pullWithTimeout(8000);
        // 校验云端 bundle 完整性：9 张核心表必须都存在且有数据（避免残缺 bundle 覆盖本地）
        if (bundle && bundle.tables && this._isBundleComplete(bundle)) {
          sl('正在从云端同步最新数据...', { variant:'capsule' });
          await this.loadBundleFromCloud(bundle);
          if (this._aborted) return false;   // 🟢 v228.22：用户已跳过，立即收尾
          const restored = await this._allCoreTablesPopulated();
          hideLoading();
          if (restored) {
            console.log('[同步] 已从云端拉取工作数据并覆盖本地');
            return true;
          }
          console.warn('[data-loader] 云端还原后仍缺核心表，尝试基准/Excel 兜底');
        } else {
          console.warn('[data-loader] 云端工作数据缺失/不完整/超时，尝试基准/Excel 兜底');
        }
      } catch (e) {
        console.warn('云端工作数据拉取失败:', e.message || e);
      }
      // 🟢 基准数据自动垫底：工作数据缺失或还原不完整时，用云端 base.json 铺一套系统底账
      try {
        const baseBundle = await this._pullBaseWithTimeout(8000);
        if (baseBundle && baseBundle.tables && this._isBundleComplete(baseBundle)) {
          await DataStore.clearWorkTables();   // 🔵 v227.97：仅清工作表，保留设置包(outbound)数据
          await new Promise(r => setTimeout(r, 300));
          // 🟢 v228.22 B-1：打底提示补「通常 3-5 秒」说明 + 立即可跳过的逃生按钮（8s 后自动亮出）
          sl('正在以云端基准数据打底...', {
            variant: 'capsule',
            sub: '正在同步云端基准数据，通常 3-5 秒完成；若长时间无变化可点下方按钮跳过',
            skippable: true,
            timeout: 8000
          });
          await this.seedFromBase(baseBundle);
          if (this._aborted) return false;   // 🟢 v228.22：用户已跳过，立即收尾
          hideLoading();
          if (await this._allCoreTablesPopulated()) {
            console.log('本地空库，已用云端基准数据垫底');
            await this._markBuiltinSeeded();   // 🟢 v228.22 B-3：示例数据标记，供顶部横幅提示
            return true;
          }
          console.warn('[data-loader] 云端基准数据还原后仍缺核心表，改从内置 Excel 导入兜底');
        }
      } catch (e) {
        console.warn('云端基准拉取失败:', e.message || e);
      }
    }

    // 3) 都没有，读取内置 Excel 兜底（用户已跳过则不再尝试，直接进入空状态）
    if (this._aborted) return false;
    const seeded = await this.importFromExcel();
    if (seeded) await this._markBuiltinSeeded();   // 🟢 v228.22 B-3：示例数据标记，供顶部横幅提示
    return seeded;
  },

  // 校验云端 bundle 结构完整性（v227.2.1 放宽）
  // 仅校验"8 张核心表全部存在且为数组"；不再强制 length>0，
  // 避免"pricing/lowTurnover 等业务表合法为空"被误判为"数据不完整"。
  // 真正的"残缺"判定：tables 缺失、某核心表不是数组、元数据缺失（savedAt）。
  _isBundleComplete(bundle) {
    if (!bundle || !bundle.tables || typeof bundle.tables !== 'object' || !bundle.savedAt) return false;
    const coreTables = this.REQUIRED_TABLES;
    return coreTables.every(t => Array.isArray(bundle.tables[t]));
  },

  // 统计 bundle 中"非空核心表 / 核心表总数"（用于给用户友好提示：哪些表为空属正常）
  _bundleStats(bundle) {
    if (!bundle || !bundle.tables) return { populated: 0, total: 0, emptyTables: [] };
    const coreTables = this.REQUIRED_TABLES;
    const emptyTables = coreTables.filter(t => !bundle.tables[t] || bundle.tables[t].length === 0);
    return {
      populated: coreTables.length - emptyTables.length,
      total: coreTables.length,
      emptyTables
    };
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

  // 后台静默同步（云端优先覆盖本地；本地已有数据立即显示，不阻塞首屏）
  // 策略：
  //   1. 仅在已连接云端（SyncManager.isOnline）时执行；未连接直接返回
  //   2. 拉取云端工作数据；与本地时间戳比对，**不一致就云端覆盖本地**（云端优先）
  //   3. 一致则跳过，保持现状
  //   4. 用户后续操作（如"上传并导入"或数据更改）走 pushAllToCloud 实时回写云端
  async _syncFromCloudInBackground() {
    try {
      if (typeof SyncManager !== 'undefined') SyncManager.init();
    } catch (e) { return; }
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      console.log('[同步] 未连接云端，跳过后台同步');
      return;
    }

    // 显示同步中状态
    const stEl = document.getElementById('syncStatusText');
    const scEl = document.getElementById('syncStatus');
    if (stEl) { stEl.textContent = '同步中…'; stEl.style.color = '#0284c7'; }
    if (scEl) { scEl.classList.remove('online'); scEl.style.background = 'linear-gradient(135deg,rgba(2,132,199,0.12),rgba(14,165,233,0.08))'; }

    try {
      const bundle = await this._pullWithTimeout(8000);
      // 仅处理云端 bundle 完整的情况；残缺/缺失直接跳过（绝不用残缺数据覆盖本地）
      if (bundle && bundle.tables && bundle.savedAt && this._isBundleComplete(bundle)) {
        const localTime = await DataStore.getImportTime();
        // 云端优先：云端与本地不一致（云端更新或本地无时间戳）→ 用云端覆盖本地
        const cloudNewerOrLocalUnknown = !localTime || bundle.savedAt !== localTime;
        if (cloudNewerOrLocalUnknown) {
          console.log('[同步] 云端与本地不一致（云端 savedAt=' + bundle.savedAt + ', 本地=' + localTime + '），执行云端→本地覆盖');
          if (stEl) stEl.textContent = '云端更新中…';
          await this.loadBundleFromCloud(bundle);
          console.log('[同步] 云端数据已覆盖本地');
          // 仅当没有打开的弹窗/侧边面板时才重渲染当前模块，避免打断用户操作
          const modalOpen = document.getElementById('modalOverlay') && document.getElementById('modalOverlay').classList.contains('show');
          const panelOpen = document.getElementById('panelOverlay') && document.getElementById('panelOverlay').classList.contains('show');
          if (!modalOpen && !panelOpen && typeof App !== 'undefined' && App.currentModule) {
            App.go(App.currentModule);
          } else {
            console.log('[同步] 后台覆盖完成，但检测到有打开的弹窗/面板，跳过重渲染');
          }
        } else {
          console.log('[同步] 云端与本地一致，无需覆盖（本地=' + localTime + '）');
        }
      } else {
        console.log('[同步] 云端数据不可用（缺失/不完整/超时），保持本地数据');
      }
    } catch (e) {
      console.warn('[同步] 后台同步失败:', e.message || e);
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

  // 带超时的云端「基准」拉取
  _pullBaseWithTimeout(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { resolve(null); }, ms);
      SyncManager.pullBase().then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(() => { clearTimeout(timer); resolve(null); });
    });
  },

  // 通用超时包装（M7）：防止任何云端请求无响应时永久卡住初始化/推送
  _withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error((label || 'request') + ' 超时(' + ms + 'ms)'));
      }, ms);
      Promise.resolve(promise).then(res => { clearTimeout(timer); resolve(res); })
        .catch(err => { clearTimeout(timer); reject(err); });
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
    // 🟢 v209 AUDIT-205：结构非法直接拒绝，绝不以畸形数据覆盖本地
    const v = this._validateBundle(bundle);
    if (!v.ok) {
      console.error('[data-loader] 云端 bundle 结构非法，拒绝还原:', v.reason);
      throw new Error('云端数据格式异常，已拒绝覆盖本地（' + v.reason + '）');
    }
    // 🟢 v208 AUDIT-303：云端→本地是「同步基准」的更新点。记下云端 savedAt，
    //   作为下次推送时的乐观锁基准；否则本机会以为自己站在最新数据上，把他人改动覆盖掉。
    if (bundle.savedAt) this._setCloudBase(bundle.savedAt);
    const tables = bundle.tables || {};
    // 🔵 v227.97：工作包还原只清/写 WORK_TABLES（不含 outbound/tempOutbound），
    //    绝不触碰设置包表，避免工作包还原把用户从 settings 恢复出来的出库单冲掉（各包各管、互不污染）。
    const workTables = this.WORK_TABLES;
    const allNames = workTables.concat(['meta']);
    // 🟢 v209 AUDIT-304：清空 + 写入同事务，中途失败整体回滚（不再「全库清空」半截）
    await db.transaction('rw', allNames, async () => {
      // 同事务内只清空工作表（不再清全部，保护设置包数据）
      for (const name of workTables) { if (db[name]) await db[name].clear(); }
      await db.meta.delete('dataImported');
      for (const name of workTables) {
        const rows = Array.isArray(tables[name]) ? tables[name] : [];
        if (rows.length) {
          try {
            await this.bulkAddSafe(db[name], rows);
            console.log(`云端数据还原 ${name}: ${rows.length} 条`);
          } catch (e) {
            console.error(`还原 ${name} 失败:`, e);
            throw e; // 让事务整体回滚，避免留半截数据
          }
        }
      }
      await DataStore.markDataImported();
    });
    return true;
  },

  // 把云端「基准数据」(base.json) 垫底写入本地（不清空现有工作数据）
  // 用于：本地为空时先铺一套系统底账，后续再叠加工作数据
  async seedFromBase(baseBundle) {
    if (!baseBundle || !baseBundle.tables) return false;
    const tables = baseBundle.tables || {};
    let wrote = 0;
    // 🔵 v227.97：基准也只写 WORK_TABLES，出库单不进基准包（只走 settings）
    for (const name of this.WORK_TABLES) {
      const rows = Array.isArray(tables[name]) ? tables[name] : [];
      if (rows.length) {
        try {
          await this.bulkAddSafe(db[name], rows);
          wrote += rows.length;
        } catch (e) { console.error(`基准垫底 ${name} 失败:`, e); }
      }
    }
    if (wrote > 0) await DataStore.markDataImported();
    console.log(`基准数据已垫底写入本地（共 ${wrote} 条）`);
    return wrote > 0;
  },

  // 打包全量数据并推送到云端（覆盖式），导入/重新导入后自动调用
  // v164+：内置双版本滚动——推送前把云端现有 bundle 的 tables 存为 prevWork（上一份）
  async pushAllToCloud() {
    this._lastPushReason = null;
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) { this._lastPushReason = 'offline'; return false; }
    // 防御：仅当 9 张核心表全部有数据时才推送，绝不把残缺 bundle 推到云端
    // （防止分享链接变空白）。manualPush / pushOutboundToCloud 兜底都走这里，统一拦截。
    const allPopulated = await this._allCoreTablesPopulated();
    if (!allPopulated) {
      console.warn('[data-loader] 本地存在空表，已跳过云端推送以避免污染分享链接');
      this._lastPushReason = 'incomplete';
      return false;
    }
    try {
      const tables = {};
      // 🔵 v227.97：工作包只收集 WORK_TABLES，出库单(outbound/tempOutbound)不进 data.json
      for (const name of this.WORK_TABLES) {
        tables[name] = await db[name].toArray();
      }
      // 双版本滚动：把云端现有 bundle 的 tables 降级为 prevWork（上一份）
      let prevWork = null;
      let existing = null;   // 🟢 v208：提到 try 外，供下方乐观锁复用（避免二次网络往返）
      try {
        existing = await SyncManager.pullDataPrivate();
        if (existing && existing.tables && Object.keys(existing.tables).length) {
          prevWork = { savedAt: existing.savedAt || null, tables: existing.tables };
        }
      } catch (e) {
    /* 首次推送无 existing，忽略 */ console.warn('[data-loader.js:309] 异常(已忽略):', e);
  }
      const bundle = {
        version: DB_VERSION,
        savedAt: new Date().toISOString(),
        tables,
        prevWork
      };
      // 🟢 v208 AUDIT-303：带乐观锁推送。existing 已在上一步拉取，直接复用避免二次往返。
      const ok = await this._withTimeout(
        SyncManager.pushData(bundle, { expectedSavedAt: this._cloudBase(), _existing: existing }),
        25000, 'pushData'
      );
      if (ok === 'conflict') {
        // 云端已被其它设备改动 → 坚决不覆盖，让用户先拉取再推
        console.warn('[乐观锁] 云端数据已被其它设备更新，本次推送已中止');
        this._lastPushReason = 'conflict';
        if (typeof WBModal !== 'undefined') {
          try {
            WBModal.alert(
              '⚠ 云端数据已被其它设备更新，本次推送已中止，避免覆盖他人改动。\n请先点「同步」拉取最新数据，确认后再推送。',
              { title: '同步冲突' }
            );
          } catch (e) {
    /* 弹窗不可用时忽略 */ console.warn('[data-loader.js:331] 异常(已忽略):', e);
  }
        }
        return false;
      }
      if (ok) {
        this._setCloudBase(bundle.savedAt);   // 推送成功 → 基准推进到本次
        console.log('已推送到云端（双版本滚动已生效）');
        return ok;
      }
      this._lastPushReason = 'upload';
      return false;
    } catch (e) {
      console.error('打包推送失败:', e);
      this._lastPushReason = 'upload';
      return false;
    }
  },

  // 恢复上一份工作数据：把云端 bundle.prevWork.tables 提为当前 tables，prevWork 清空
  // 返回 true 表示成功恢复；false 表示无上一份数据
  async restorePrevWork() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      WBModal.alert('请先连接云端后再恢复上一份数据');
      return false;
    }
    const bundle = await SyncManager.pullDataPrivate();
    if (!bundle || !bundle.prevWork || !bundle.prevWork.tables) {
      WBModal.alert('云端暂无可恢复的上一份数据。\n仅「两次及以上导入/上传」后才存在上一份；若已恢复过则不可再恢复。\n需回到更早数据，请用「🔄 重新导入基准」。');
      return false;
    }
    try {
      showLoading('正在恢复上一份工作数据...', { variant:'capsule' });
      // 把 prevWork 提为当前，prevWork 清空（原 v2 被丢弃，符合"最新+上一份"两份约定）
      const restored = {
        version: DB_VERSION,
        savedAt: new Date().toISOString(),
        tables: bundle.prevWork.tables,
        prevWork: null
      };
      const ok = await SyncManager.pushData(restored);
      if (!ok) { WBModal.alert('恢复失败：云端写入异常'); return false; }
      // 拉取回本地，覆盖当前工作数据
      await this._applyBundleToLocal(restored);
      hideLoading();
      WBModal.alert('✅ 已恢复上一份工作数据（' + (bundle.prevWork.savedAt ? new Date(bundle.prevWork.savedAt).toLocaleString('zh-CN') : '未知时间') + '）');
      if (typeof App !== 'undefined' && App.currentModule) App.go(App.currentModule);
      return true;
    } catch (e) {
      hideLoading();
      console.error('恢复上一份失败:', e);
      WBModal.alert('恢复失败：' + (e.message || e));
      return false;
    }
  },

  // 把云端 bundle 写入本地 IndexedDB（恢复/初始化共用）
  async _applyBundleToLocal(bundle) {
    if (!bundle || !bundle.tables) return false;
    for (const name of Object.keys(bundle.tables)) {
      if (db[name]) {
        await db[name].clear();
        if (bundle.tables[name] && bundle.tables[name].length) await db[name].bulkPut(bundle.tables[name]);
      }
    }
    return true;
  },

  // 把当前本地全量数据"标记为基准"并单独推送到云端 base.json
  // 与 data.json（工作数据）分离，作为系统固定底账
  async markCurrentAsBase() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      WBModal.alert('请先连接云端后再标记基准数据');
      return false;
    }
    if (!(await this._allCoreTablesPopulated())) {
      WBModal.alert('当前存在空表，无法标记为基准（基准必须完整）');
      return false;
    }
    let ok = false;
    try {
      showLoading('正在打包基准数据并上传到云端...', { variant:'truck' });
      const tables = {};
      // 🔵 v227.97：基准包只收 WORK_TABLES，出库单不进 base.json（只走 settings 包）
      for (const name of this.WORK_TABLES) {
        tables[name] = await db[name].toArray();
      }
      const bundle = {
        version: DB_VERSION,
        savedAt: new Date().toISOString(),
        type: 'base',
        source: AppConfig.supabase.baseSource || '',
        tables
      };
      ok = await SyncManager.pushBase(bundle);
    } catch (e) {
      console.error('标记基准失败:', e);
      WBModal.alert('标记基准失败：' + (e.message || e));
      return false;
    } finally {
      hideLoading();
    }
    if (ok) {
      const savedAt = new Date().toLocaleString('zh-CN');
      WBModal.alert('✅ 基准数据已备份到云端（base.json）\n时间：' + savedAt + '\n仅复制一份作为系统底账，本地数据不受影响；空库/新设备打开时自动以此打底。');
    } else {
      WBModal.alert('❌ 基准数据上传失败\n\n请检查网络连接或 Supabase 存储桶权限（需开启 anon 可写）。');
    }
    return ok;
  },

  // 🔵 v227.97：出库单「只走设置数据包」settings.json（outbound_list），绝不写工作包 data.json。
  //   旧的增量写 data.json 实现会与「工作包还原 / 全量推送」冲突造成跨包污染，已废弃重写。
  //   本函数现统一委托 DataStore.syncOutboundToSettings（同名语义：把本地出库单同步到 settings 包）。
  async pushOutboundToCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    if (typeof DataStore !== 'undefined' && typeof DataStore.syncOutboundToSettings === 'function') {
      return DataStore.syncOutboundToSettings();
    }
    return false;
  },

  // 🟢 v227.77：仅增量推送「临时出库」表到云端（独立 bundle key 'tempOutbound'，
  //   不与中心库房出库单列表的 'outbound' 互相覆盖）。临时出库和正式出库各走各的云端数据包。
  async pushTempOutboundToCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const rows = await db.tempOutbound.toArray();
      const existing = await SyncManager.pullData().catch(() => null);
      if (existing && existing.tables) {
        const bundle = {
          ...existing,
          version: DB_VERSION,
          savedAt: new Date().toISOString(),
          tables: { ...existing.tables, tempOutbound: rows }
        };
        const ok = await SyncManager.pushData(bundle);
        if (ok) console.log(`✅ [临时出库] 已单独同步 tempOutbound 表到云端（${rows.length} 条）`);
        return ok;
      }
      console.warn('[data-loader] 云端拉取失败，改为推送本地全量以避免残缺覆盖');
      return await this.pushAllToCloud();
    } catch (e) {
      console.error('临时出库单独推送失败:', e);
      return false;
    }
  },

  // 从 Excel 文件导入数据（首次启动，读取内置文件或用户替换的文件）
  async importFromExcel() {
    showLoading('正在读取 Excel 数据...', { variant:'truck' });
    try {
      let arrayBuffer;

      // 🟢 健壮性(M7)：dataPath 为空时（config.js 已注释"无内置数据文件"），
      // 立即返回 false 走空状态引导，避免 fetch('') 把首页 HTML 当 Excel 解析并空转数十秒。
      if (!this.filePath) {
        console.warn('[data-loader] dataPath 为空，无内置数据文件，直接进入空状态引导');
        return false;
      }

      // 回退到原始内置文件（v111 起「导入替换内置工作簿」入口已移除，customWorkbook 不复存在，O2）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(this.filePath, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error('无法读取 Excel 文件');
      arrayBuffer = await response.arrayBuffer();

      return await this.importFromArrayBuffer(arrayBuffer, '首次导入');
    } catch (err) {
      console.error('数据导入失败:', err);
      hideLoading();
      // 🟡 M6：首次启动无数据兜底 —— 给出明确引导而非静默 alert
      WBModal.alert('数据导入失败：' + err.message + '\n\n请先通过「导入 Excel」上传数据文件，或在设置中配置云端同步（Supabase）后再试。');
      return false;
    }
  },

  // 🟢 M7：手动触发「从云端同步」（空状态引导按钮调用）。
  // 依次尝试 data.json → base.json，完整则落库；都不完整给出明确提示，绝不卡住 spinner。
  async forceSyncFromCloud() {
    try {
      if (typeof SyncManager !== 'undefined') SyncManager.init();
      if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
        WBModal.alert('云端未连接：请先在「设置」中配置 Supabase 同步，或改用「上传 Excel 导入」。');
        return false;
      }
      showLoading('正在从云端同步数据...', { variant:'capsule' });
      let bundle = await this._pullWithTimeout(8000, 'pullData');
      if (bundle && bundle.tables && this._isBundleComplete(bundle)) {
        await this.loadBundleFromCloud(bundle);
        await DataStore.markDataImported();
        try { await db.meta.delete('builtinSeeded'); } catch (e) {}  // 🟢 v228.22 B-3：用户显式同步云端 → 非示例数据
        hideLoading();
        console.log('[data-loader] 已从云端同步工作数据');
        return true;
      }
      let baseBundle = await this._pullBaseWithTimeout(8000);
      if (baseBundle && baseBundle.tables && this._isBundleComplete(baseBundle)) {
          // 🟢 v209 AUDIT-304：清空 + 垫底写入同事务（中途失败整体回滚，不残留半截基准）
          await db.transaction('rw', this.TABLES.concat(['meta']), async () => {
            await DataStore.clearWorkTables();   // 🔵 v227.97：仅清工作表，保留设置包(outbound)
            await this.seedFromBase(baseBundle);
            try { await db.meta.delete('builtinSeeded'); } catch (e) {}  // 🟢 v228.22 B-3
          });
        hideLoading();
        console.log('[data-loader] 已用云端基准数据垫底');
        return true;
      }
      hideLoading();
      WBModal.alert('云端暂无可用的完整数据（data.json / base.json 均缺失或不完整）。\n请改用「上传 Excel 导入」，或先在别的设备把数据「同步到云端」。');
      return false;
    } catch (e) {
      hideLoading();
      console.error('[data-loader] forceSyncFromCloud 失败:', e);
      WBModal.alert('从云端同步失败：' + (e && e.message ? e.message : e));
      return false;
    }
  },

  // 核心导入逻辑：解析 arrayBuffer 并写入数据库
  async importFromArrayBuffer(arrayBuffer, label = '导入') {
    // 🔴 重入保护（S2）：防止"重新导入"/"恢复内置"/"导入替换"并发调用导致重复清空+导入
    if (this._importing) { console.warn('[data-loader] 已有导入进行中，忽略重复调用'); return false; }
    this._importing = true;
    DataStore.invalidateAll();   // 🟢 v227.52 P0：导入前清空会话表缓存，杜绝"导入中读取到旧/半截快照"的边缘情况
    try { await db.meta.delete('builtinSeeded'); } catch (e) {}  // 🟢 v228.22 B-3：真实导入即清除示例标记
    try {
      // 🔴 失效存货编码缓存（M3）：重新导入后，旧映射已失效，否则新数据下编码错乱
      this._stockNameSpecCodeMap = null;
      showLoading('正在解析数据...', { variant:'truck' });
    let workbook;
    try {
      // 🟢 AUDIT-308：大文件解析移至 Web Worker，避免主线程阻塞（不支持 Worker 时回退同步解析）
      workbook = await this._parseWorkbookAsync(arrayBuffer);
    } catch (err) {
      throw new Error('文件解析失败，请确认是有效的 .xlsx / .xls 文件');
    }
    // 🟢 v228.08：XLSX 已改为按需加载。Worker 解析不会把 XLSX 暴露给主线程，
    //   而下方 _estimateRowCount / parseSheet / loadBreach 等会同步调用 XLSX.utils.*，
    //   故需在此处（进入同步解析流程前）确保主线程 XLSX 已就绪。
    await LazyLib.xlsx();

    // 🟢 v209 AUDIT-204：①中和 Excel 公式注入（以 = + - @ 开头的单元格会被表格软件当公式执行）；
    //                        ②超限防护（文件过大 / 行数过多时提前拒绝，避免主线程长时间卡死）
    this._neutralizeFormulaInjection(workbook);
    const sizeMB = (arrayBuffer && arrayBuffer.byteLength || 0) / (1024 * 1024);
    if (sizeMB > 60) throw new Error(`文件过大（约 ${sizeMB.toFixed(1)}MB），请拆分后导入（上限 60MB）`);
    const estRows = this._estimateRowCount(workbook);
    if (estRows > 200000) throw new Error(`数据量过大（约 ${estRows} 行），请拆分文件后导入（上限 20 万行）`);

    // 🟢 v209 AUDIT-304：清空 + 导入放入同一事务，原子提交。
    // 中途刷新/崩溃 → 事务回滚 → 本地恢复到「导入前」状态，不再出现「全库清空」半截数据。
    // 事务范围含全部 11 张表（clearAll 会清 outbound/meta，必须纳入，否则 Dexie 报事务越界）。
    const ALL_TABLES = ['suppliers','orders','inbound','stock','inventoryAlerts','orderChecks','pricing','lowTurnover','breach','outbound','tempOutbound','meta'];
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
    let importErrors = [];
    await db.transaction('rw', ALL_TABLES, async () => {
      // 🔵 v227.97：全量 Excel 导入只清空「工作表」，保留 outbound/tempOutbound（归设置包），避免跨包污染
      for (const name of this.WORK_TABLES) { if (db[name]) await db[name].clear(); }
      await db.meta.delete('dataImported');
      for (const task of tasks) {
        try {
          showLoading(`正在导入${task.name}数据...`, { variant:'fluid' });
          await task.fn();
        } catch (err) {
          importErrors.push({ name: task.name, err });
          console.error(`${task.name}数据${label}失败:`, err);
          // 继续导入其他数据，不中断整体流程（事务内异常会被捕获，最终统一回滚）
        }
      }
      // 任一表失败则整体回滚：抛出异常使 Dexie 丢弃本事务内所有写入
      if (importErrors.length > 0) {
        throw new Error(`导入未完成（${importErrors.length} 张表失败），已回滚本次导入以保证数据一致`);
      }
    });

    await DataStore.markDataImported();

    // 🟢 AUDIT-004：导入成功后推送云端（若已连接）。pushAllToCloud 内部已校验完整性，残缺时不推送。
    //   原先失败仅 console.warn → 本地已存、云端未同步却无感知；现显式提示用户。
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
      try {
        const pushed = await this.pushAllToCloud();
        const reason = this._lastPushReason;
        // conflict 已在 pushAllToCloud 内弹窗，此处不再重复提示
        if (reason === 'conflict') {
          /* 已弹窗，跳过 */
        } else if (pushed !== true) {
          // 其余失败按原因给精简提示
          if (typeof Toast !== 'undefined') {
            if (reason === 'incomplete') {
              Toast.warn('已导入本地；Excel 缺少必需表，云端未同步，请补全表头后重传。');
            } else {
              Toast.warn('已导入本地，云端同步失败，可稍后在「云端同步 → 上传工作数据」重试。');
            }
          } else {
            console.warn('云端推送失败（本地数据已导入），建议手动重试');
          }
        }
      } catch (e) {
        if (typeof Toast !== 'undefined') Toast.error('云端同步失败：' + (e && e.message ? e.message : e));
        else console.warn('云端推送失败（本地数据已导入）:', e);
      }
    }

    hideLoading();
    return true;
    } finally {
      this._importing = false;
    }
  },

  // 🟢 AUDIT-308：Web Worker 解析 XLSX。
  //   不支持 Worker / 创建失败 / 解析异常时回退主线程同步解析，保证行为与旧版完全一致。
  // 🟢 v228.08 性能优化：XLSX 改为按需加载（LazyLib），不再由 index.html 预载。
  //   Worker 路径由 Worker 内部 importScripts 自行加载 XLSX，主线程无需持有；
  //   仅当「不支持 Worker」或「Worker 创建失败」时才在主线程加载 XLSX 兜底。
  //   ⚠️ 原实现在此处 `typeof XLSX === 'undefined'` 时仍会调用 XLSX.read → 崩溃，
  //      移除预载后必须改成先 await 加载再用，否则导入功能直接报错。
  async _parseWorkbookAsync(arrayBuffer) {
    if (typeof Worker === 'undefined') {
      // 无 Worker → 主线程兜底：先加载 XLSX 再解析（行为与旧版一致）
      const XLSX = await LazyLib.xlsx();
      return XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    }
    // 解析 XLSX 组件地址（与 LazyLib 中 lib/xlsx.full.min.js 同源），供 Worker importScripts
    const xlsxUrl = new URL('lib/xlsx.full.min.js', location.href).href;
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker('js/import-worker.js');
      } catch (e) {
        // Worker 不可用 → 主线程兜底：加载 XLSX 后解析，行为不变
        LazyLib.xlsx().then(function (X) {
          try { resolve(X.read(arrayBuffer, { type: 'array', cellDates: true })); }
          catch (err) { reject(err); }
        }).catch(reject);
        return;
      }
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        try { worker.terminate(); } catch (_) {}
        fn();
      };
      worker.onmessage = (e) => {
        const d = e.data || {};
        if (d.type === 'result') finish(() => resolve(d.workbook));
        else if (d.type === 'error') finish(() => reject(new Error('文件解析失败，请确认是有效的 .xlsx / .xls 文件')));
      };
      worker.onerror = () => finish(() => reject(new Error('文件解析失败，请确认是有效的 .xlsx / .xls 文件')));
      worker.postMessage({ type: 'parse', arrayBuffer: arrayBuffer, xlsxUrl: xlsxUrl });
    });
  },

  // 数据导入：支持上传 .xlsx / .xls 文件，或从云端重新导入基准数据
  reimport() {
    // 若已有模态框打开则先关闭
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.classList.remove('show');

    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    if (!modalBody || !modalTitle) return;

    // 根据云端连接状态，动态调整按钮文案与提示（让用户明确按钮会做什么）
    const cloudOnline = (typeof SyncManager !== 'undefined') && !!SyncManager.isOnline;
    const btnIcon  = cloudOnline ? '📤' : '📥';
    const btnText  = cloudOnline ? '导入数据' : '仅导入本地';
    const btnTitle = cloudOnline
      ? '将本次导入数据同步到云端（覆盖云端工作数据）'
      : '云端未连接，本次仅导入到本地数据库';

    modalTitle.textContent = '数据导入';
    modalBody.innerHTML = `
      <div style="width:100%;">
        <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px;line-height:1.5;">
          支持 <b>.xlsx</b>、<b>.xls</b> 与 <b>.xlsm</b> 格式。可上传新的数据文件覆盖当前数据，或从云端重新导入「基准数据」。
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
        <div id="reimportCloudHint" style="font-size:11.5px;text-align:center;margin-bottom:12px;padding:6px 10px;border-radius:6px;${
          cloudOnline
            ? 'background:#ecfdf5;color:#15803d;border:1px solid #bbf7d0;'
            : 'background:#fffbeb;color:#b45309;border:1px solid #fde68a;'
        }">
          ${cloudOnline
            ? '● 云端已连接 — 导入将自动同步到云端（覆盖云端工作数据）'
            : '● 云端未连接 — 仅导入到本地。如需同步到云端，请先在「⚙ 云配置」中连接。'
          }
        </div>
        <div class="btn-group" style="border-top:none;margin-top:6px;padding-top:0;display:flex;flex-wrap:wrap;gap:10px;justify-content:center;">
          <button onclick="DataLoader.reimportFromBase()" class="btn--ghost" style="flex:0 0 calc(33.333% - 7px);max-width:200px;padding:9px 0;font-size:12.5px;">🔄 导入基准</button>
          <button onclick="DataLoader.showCloudRestoreChooser()" class="btn--ghost" title="查看云端备份（最新+上一份）并选择恢复哪一份" style="flex:0 0 calc(33.333% - 7px);max-width:200px;padding:9px 0;font-size:12.5px;">☁️ 云端恢复</button>
          <button onclick="DataLoader.reimportFromFile()" id="reimportUploadBtn" class="btn--primary" title="${btnTitle}" style="flex:0 0 calc(33.333% - 7px);max-width:200px;padding:9px 0;font-size:12.5px;">${btnIcon} ${btnText}</button>
        </div>
      </div>
    `;
    // 使用紧凑弹窗宽度
    document.getElementById('modal').classList.add('modal-compact');
    modalOverlay.classList.add('show');
  },

  // 从云端工作数据（data.json）直接恢复本地——绕过 base.json 污染风险
  // 与"重新导入基准"不同：这里拉的是最新工作数据（含 prevWork 滚动链），不是基准底账
  async restoreFromCloudWork() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      WBModal.alert('请先连接云端后再恢复工作数据');
      return false;
    }
    try {
      showLoading('正在从云端拉取工作数据...', { variant:'capsule' });
      const bundle = await SyncManager.pullData();
      if (!bundle || !bundle.tables) {
        hideLoading();
        WBModal.alert('云端暂无工作数据（data.json 不存在）。\n请先在别的设备把数据「同步到云端」，或改用「📤 上传 Excel 导入」。');
        return false;
      }
      if (!this._isBundleComplete(bundle)) {
        hideLoading();
        WBModal.alert('云端工作数据缺失或不完整，无法恢复。\n请改用「📤 上传 Excel 导入」或「🔄 重新导入基准」。');
        return false;
      }
      // v227.2.1：分级提示——核心表全部存在但部分为空时，给出友好提示而非弹错误
      const stats = this._bundleStats(bundle);
      const supplierCnt = (bundle.tables.suppliers || []).length;
      // 🟢 v227.2.1：云端核心表全部为空 + 本地已有数据时，阻断"清空本地→变空"误操作
      if (stats.populated === 0) {
        hideLoading();
        try {
          const localSupplierCount = await db.suppliers.count();
          if (localSupplierCount > 0) {
            WBModal.alert('云端核心表全部为空（无任何工作数据），恢复无意义。\n请先在别的设备「📤 上传 Excel 导入」或同步数据到云端后，再恢复。');
            return false;
          }
        } catch (e) { /* 本地查询失败时继续走 confirm */ }
      }
      const hint = stats.emptyTables.length > 0
        ? `\n\n📋 说明：云端 ${stats.populated}/${stats.total} 张核心表有数据，` +
          `空表：${stats.emptyTables.join('、')}（属正常，可正常使用）。`
        : '';
      if (!await WBModal.confirm(
        `⚠ 此操作将「清空本地全部工作数据」，并用云端最新工作数据（${supplierCnt} 家供应商）完全替换。${hint}\n\n确定要继续吗？`,
        { title: '⚠ 危险操作' }
      )) {
        hideLoading();
        return false;
      }
      // loadBundleFromCloud 内部已用事务原子执行「清空 + 还原」，此处无需再清（避免事务外冗余清空）
      await this.loadBundleFromCloud(bundle);
      hideLoading();
      WBModal.alert('✅ 已用云端工作数据替换本地（共 ' + supplierCnt + ' 家供应商）。');
      if (typeof App !== 'undefined' && App.currentModule) App.go(App.currentModule);
      return true;
    } catch (err) {
      hideLoading();
      console.error('从云端恢复工作数据失败:', err);
      WBModal.alert('恢复失败: ' + (err.message || err));
      return false;
    }
  },

  // 🟢 v227.96：进入工作台「静默自动同步」——等价于「云端恢复（最新）」但不弹危险确认框。
  // 仅当云端工作包比本机上次同步基线（_cloudBase）更新时才覆盖本地，避免误清本地未上传的改动。
  // 满足"每次进入即拉取最新云端工作数据"的预期；GitHub 等全新设备（无基线）首次进入即自动拉满。
  async autoSyncFromCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const bundle = await SyncManager.pullDataPrivate();
      if (!bundle || !bundle.tables || !this._isBundleComplete(bundle)) return false;
      const cloudTs = bundle.savedAt || null;
      const base = this._cloudBase();
      // 云端不比本地基线更新 → 不覆盖（保护本机刚推送或尚未上传的改动）
      if (base && cloudTs && new Date(cloudTs) <= new Date(base)) return false;
      // 云端核心表全空且本地已有数据 → 跳过，避免把本地清空成空
      const stats = this._bundleStats ? this._bundleStats(bundle) : null;
      if (stats && stats.populated === 0) {
        const localCnt = await db.suppliers.count().catch(() => 0);
        if (localCnt > 0) return false;
      }
      await this.loadBundleFromCloud(bundle); // 事务内清空+还原，静默无确认（内部已推进 _cloudBase）
      console.log('[autoSync] 已从云端自动同步最新工作数据（savedAt=' + cloudTs + '）');
      return true;
    } catch (e) {
      console.warn('[autoSync] 自动同步失败(已忽略):', e && e.message);
      return false;
    }
  },

  // 🟢 v227.95：☁️ 云端恢复选择器——合并「云端恢复（最新）」与「恢复上一份」为单一入口
  // 云端 bundle 本就是双版本滚动（tables=最新，prevWork=上一份），此处只做"列表+分发"，
  // 恢复逻辑复用 restoreFromCloudWork() / restorePrevWork()（均已验证），不重写。
  async showCloudRestoreChooser() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      WBModal.alert('请先连接云端后再使用「云端恢复」。\n在「⚙ 云配置」中连接 Supabase 后即可查看并恢复云端备份。');
      return;
    }
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    if (!modalBody || !modalTitle) return;
    let bundle = null;
    try {
      showLoading('正在拉取云端备份列表...', { variant: 'capsule' });
      bundle = await SyncManager.pullDataPrivate();
      hideLoading();
    } catch (e) {
      hideLoading();
      WBModal.alert('拉取云端备份失败：' + (e.message || e));
      return;
    }
    const latest = (bundle && bundle.tables) ? bundle : null;
    const prev = (bundle && bundle.prevWork && bundle.prevWork.tables) ? bundle.prevWork : null;
    const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-CN') : '未知时间';
    const latestCnt = latest ? (latest.tables.suppliers || []).length : 0;
    const prevCnt = prev ? (prev.tables.suppliers || []).length : 0;
    modalTitle.textContent = '☁️ 云端恢复 · 选择备份';
    // 无可用备份：引导去上传/基准
    if (!latest && !prev) {
      modalBody.innerHTML = `
        <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;text-align:center;padding:10px 0;">
          云端暂无可用备份。<br>请先在其它设备「上传并导入」或「同步到云端」后再恢复。
        </div>
        <div class="btn-group" style="border-top:none;margin-top:14px;display:flex;justify-content:center;">
          <button onclick="DataLoader.reimport()" class="btn--ghost" style="flex:0 0 calc(50% - 5px);max-width:180px;padding:9px 0;font-size:12.5px;">← 返回</button>
        </div>`;
      document.getElementById('modal').classList.add('modal-compact');
      const ov = document.getElementById('modalOverlay'); if (ov) ov.classList.add('show');
      return;
    }
    modalBody.innerHTML = `
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 12px;line-height:1.5;">
        云端保留最近 <b>2 份</b>备份（最新 + 上一份）。新增备份会顶替旧时间那份。<br>点击任意一份，将其恢复为本地当前数据。
      </p>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:600;">🟢 最新备份</span>
            <span style="font-size:11.5px;color:var(--text-secondary);">${fmt(latest ? latest.savedAt : null)}</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:10px;">供应商 ${latestCnt} 家</div>
          <button onclick="DataLoader._cloudRestorePick('latest')" class="btn--primary" style="width:100%;padding:9px 0;font-size:12.5px;">恢复此份</button>
        </div>
        ${prev ? `
        <div style="border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:600;">🟡 上一份</span>
            <span style="font-size:11.5px;color:var(--text-secondary);">${fmt(prev.savedAt)}</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-secondary);margin-bottom:10px;">供应商 ${prevCnt} 家</div>
          <button onclick="DataLoader._cloudRestorePick('prev')" class="btn--ghost" style="width:100%;padding:9px 0;font-size:12.5px;">恢复此份</button>
        </div>` : `
        <div style="border:1px dashed var(--border,#e5e7eb);border-radius:10px;padding:12px 14px;text-align:center;">
          <span style="font-size:12px;color:var(--text-secondary);">🟡 上一份 · 暂无（需两次及以上备份才生成）</span>
        </div>`}
      </div>
      <div class="btn-group" style="border-top:none;margin-top:14px;display:flex;justify-content:center;">
        <button onclick="DataLoader.reimport()" class="btn--ghost" style="flex:0 0 calc(50% - 5px);max-width:180px;padding:9px 0;font-size:12.5px;">← 返回</button>
      </div>`;
    document.getElementById('modal').classList.add('modal-compact');
    const ov = document.getElementById('modalOverlay'); if (ov) ov.classList.add('show');
  },

  // 选择器分发：latest → 云端恢复（最新）；prev → 恢复上一份
  async _cloudRestorePick(which) {
    const ov = document.getElementById('modalOverlay'); if (ov) ov.classList.remove('show');
    if (which === 'latest') return this.restoreFromCloudWork();
    return this.restorePrevWork();
  },

  // 从上传的文件导入
  async reimportFromFile() {
    const fileInput = document.getElementById('reimportFile');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      WBModal.alert('请先选择一个 .xlsx、.xls 或 .xlsm 文件');
      return;
    }
    const file = fileInput.files[0];
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.xlsm')) {
      WBModal.alert('仅支持 .xlsx、.xls 或 .xlsm 格式的文件');
      return;
    }
    // 云端连接状态——按钮行为完全以此为准：未连接→仅本地导入；已连接→导入+上传
    const cloudOnline = (typeof SyncManager !== 'undefined') && !!SyncManager.isOnline;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ok = await this.importFromArrayBuffer(arrayBuffer, '文件导入');
      if (ok) {
        document.getElementById('modalOverlay').classList.remove('show');
        // 反馈：与按钮文案保持一致，让用户清楚本次到底做了什么
        if (cloudOnline) {
          WBModal.alert('数据导入成功，并已同步到云端。');
        } else {
          WBModal.alert('数据已导入到本地。\n当前云端未连接，本次未上传。连接云端后点工作条「↥ 上传」即可分享给同事。');
        }
        // 刷新当前视图
        if (typeof App !== 'undefined' && App.currentModule) {
          App.go(App.currentModule);
        }
      }
    } catch (err) {
      console.error('文件导入失败:', err);
      hideLoading();
      WBModal.alert('导入失败: ' + err.message);
    }
  },

  // 重新导入基准：从云端拉取 base.json 覆盖本地（作为系统底账）
  async reimportFromBase() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      WBModal.alert('请先连接云端后再重新导入基准');
      return false;
    }
    try {
      showLoading('正在从云端拉取基准数据...', { variant:'capsule' });
      const bundle = await SyncManager.pullBase();
      if (!bundle || !bundle.tables) {
        hideLoading();
        WBModal.alert('云端暂无基准数据，请先「标记为基准」生成基准。');
        return false;
      }
      // 破坏性操作确认：导入基准会清空本地全部工作数据，并替换为云端基准
      const supplierCnt = (bundle.tables.suppliers || []).length;
      const confirmMsg = '⚠ 此操作将「清空本地全部工作数据」，并用云端基准（' + supplierCnt + ' 家供应商）完全替换。\n\n确定要继续吗？';
      if (!await WBModal.confirm(confirmMsg, { title: '⚠ 危险操作' })) {
        hideLoading();
        return false;
      }
      // 🟢 v209 AUDIT-304：清空 + 基准写入同事务（中途失败整体回滚）
      await db.transaction('rw', this.TABLES.concat(['meta']), async () => {
        await DataStore.clearWorkTables();   // 🔵 v227.97：仅清工作表，保留设置包(outbound)
        await this.seedFromBase(bundle);
      });
      hideLoading();
      WBModal.alert('✅ 已用云端基准数据替换本地工作数据（共 ' + supplierCnt + ' 家供应商）。\n本地原有数据已被覆盖，如需恢复可重新导入 Excel 或上传工作数据。');
      if (typeof App !== 'undefined' && App.currentModule) {
        App.go(App.currentModule);
      }
      return true;
    } catch (err) {
      console.error('从云端导入基准失败:', err);
      hideLoading();
      WBModal.alert('导入基准失败: ' + (err.message || err));
      return false;
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
          // 🟢 v227.19 修复：原写 `obj[h] = this.recoverExcelDate(val)` 会把所有列值送进日期识别器，
          //   导致像 22172 这种落在 20000~80000 的数字被识别成 Excel 序列号 → 转成日期字符串 →
          //   下游 parseFloat 拿到年号「1960」，含税单价/不含税单价等纯数字列全部错位。
          //   修复：通用赋值只处理已是 Date 对象的情况；兜底序列号识别留到具体 loader 中显式调用，
          //   不在 parseSheet 通用赋值里越权转换。
          if (val instanceof Date) {
            obj[h] = this.recoverExcelDate(val);
          } else {
            obj[h] = val;
          }
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
    showLoading('正在导入供应商数据...', { variant:'fluid' });
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
    showLoading('正在导入订单数据...', { variant:'fluid' });
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
    showLoading('正在导入入库数据...', { variant:'fluid' });
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
    showLoading('正在导入库存数据...', { variant:'fluid' });
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
    showLoading('正在导入库存预警数据...', { variant:'fluid' });

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
    showLoading('正在导入订货数据...', { variant:'fluid' });
    const rows = this.parseSheet(workbook, '订货', 2);
    // 🟢 v227.20：订货表的现存量列名带日期前缀（如「2026-09-04现存量」），随文件变化，
    //   写死 r['2026-08-03现存量'] 会读不到 → 现存量全为 0。改用与库存预警一致的 stockKey 智能匹配。
    const _ocKeys = Object.keys(rows[0] || {});
    const _ocStockKey = _ocKeys.find(k => {
      const ck = String(k).replace(/\n/g, '').replace(/[\u200B-\u200D\uFEFF\u00A0\u3000]/g, '').replace(/\s+/g, ' ');
      return ck.includes('现存量') && !ck.includes('预警') && !ck.includes('最低');
    }) || '2026-09-04现存量';
    const clean = rows.map(r => ({
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      主计量: r['主计量'] || '',
      数量: this.parseNum(r['数量']),
      现存量: this.parseNum(r[_ocStockKey] || r['现存量'] || r['现存数量']),
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
    showLoading('正在导入价格数据...', { variant:'fluid' });
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
      // 🟢 v227.18：源表头列为「不含税单价」(不是「单价」)；之前写成 r['单价'] 永远拿不到，
      //   导致工作台「不含税单价」列一直为 ¥0.00；与「含税单价」列对账时也错位。
      单价: this.parseNum(r['不含税单价']),
      类型: r['类型'] || ''
    })).filter(r => r.供应商 && r.存货名称);

    await this.bulkAddSafe(db.pricing, clean);
    console.log(`价格数据导入完成: ${clean.length} 条`);
  },

  // 8. 低周转材料 (headerRow=2)
  async loadLowTurnover(workbook) {
    showLoading('正在导入低周转数据...', { variant:'fluid' });
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
    showLoading('正在导入违约数据...', { variant:'fluid' });

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

  // 🟢 v209 AUDIT-204：中和 Excel 公式注入（CSV / 公式注入防护）。
  // 以 = + - @ 开头的单元格在表格软件里会被当作公式，可能触发 DDE / 外部命令执行。
  // 此处于导入前统一给这类字符串前置一个空格（Excel 中和标准写法），
  // 既阻断公式执行，又保留原始文本可读；公式单元格直接清空（不执行也不保留公式串）。
  _neutralizeFormulaInjection(workbook) {
    if (!workbook || !workbook.Sheets) return;
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      if (!ws) continue;
      for (const key of Object.keys(ws)) {
        if (key[0] === '!') continue; // 跳过 !ref / !margins 等元数据
        const cell = ws[key];
        if (!cell) continue;
        if (cell.f) { cell.v = ''; continue; } // 公式单元格：清空，绝不执行
        if (typeof cell.v === 'string') {
          const t = cell.v.replace(/^\s+/, '');
          if (t && '=+-@\t\r'.includes(t[0])) cell.v = ' ' + cell.v;
        }
      }
    }
  },

  // 🟢 v209 AUDIT-204：估算工作簿总行数（用于超限防护），空表 / 无 !ref 跳过
  _estimateRowCount(workbook) {
    if (!workbook || !workbook.Sheets) return 0;
    let total = 0;
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      if (!ws || !ws['!ref']) continue;
      try { total += XLSX.utils.decode_range(ws['!ref']).e.r + 1; } catch (e) {
    /* 忽略畸形 ref */ console.warn('[data-loader.js:1317] 异常(已忽略):', e);
  }
    }
    return total;
  },

  // 🟢 v209 AUDIT-205：校验云端 bundle 结构合法性，避免畸形数据直接覆盖本地。
  // 来源可信性由 Supabase 鉴权（JWT）在传输层保证；此处只做结构完整性校验。
  _validateBundle(bundle) {
    if (typeof bundle !== 'object' || !bundle) return { ok: false, reason: '非对象' };
    if (!bundle.tables || typeof bundle.tables !== 'object') return { ok: false, reason: '缺少 tables' };
    for (const name of this.WORK_TABLES) {
      const rows = bundle.tables[name];
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) return { ok: false, reason: `${name} 非数组` };
    }
    // 🟢 v225：savedAt 全链路统一为 ISO 字符串（写入端用 new Date().toISOString()；
    //   乐观锁 pushData 用字符串相等比较；_setCloudBase 也原样存）。
    //   旧校验误判"必须是 number"，导致只要云端有 bundle 就 100% 失败，恢复功能完全走不通。
    //   这里改成：要么是有限数字（毫秒时间戳），要么是合法 ISO 字符串（能被 Date.parse 解析）。
    if (bundle.savedAt !== undefined && bundle.savedAt !== null && bundle.savedAt !== '') {
      if (typeof bundle.savedAt === 'number') {
        if (!isFinite(bundle.savedAt)) return { ok: false, reason: 'savedAt 非法' };
      } else if (typeof bundle.savedAt === 'string') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(bundle.savedAt)
            || isNaN(Date.parse(bundle.savedAt))) {
          return { ok: false, reason: 'savedAt 非法' };
        }
      } else {
        return { ok: false, reason: 'savedAt 非法' };
      }
    }
    return { ok: true };
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

  // 🟢 v147：双路取码填入 _存货编码（解决「订单用存货编号 / 现存+入库用存货编码」两套并存时丢码）。
  //   ① 记录自身的直接字段：优先 存货编码（入库/现存自带），其次 存货编号（订单 Excel 导入字段）；
  //   ② 若两者皆空，按 (存货名称+规格型号) 经现存量 codeMap 匹配兜底。
  //   就地修改 record._存货编码，不返回值。
  fillStockCode(record, codeMap) {
    if (!record) return;
    const directEnc = record.存货编码 != null ? String(record.存货编码).trim() : '';
    const directNo  = record.存货编号 != null ? String(record.存货编号).trim() : '';
    const direct = directEnc || directNo;
    if (direct) { record._存货编码 = direct; return; }
    if (codeMap && record.存货名称) {
      const key = TableUtils.buildStockKey(record.存货名称, record.规格型号);
      record._存货编码 = codeMap.get(key) || '';
    } else {
      record._存货编码 = '';
    }
  },

  // 工具方法：从 Excel 单元格值还原正确的日期字符串
  // 🟢 v210 AUDIT-602：原注释曾称「差 1 天」，经核查当前实现已用 UTC 方法
  //   （getUTCFullYear/Month/Date）+ Math.round 将时序偏移舍入回 UTC 午夜，
  //   结果正确、无真实 1 天误差；时间魔法数字已抽为 DAY_MS / EXCEL_EPOCH_DAYS。
  // ⚠️ 重要：只处理 Date 对象！普通数字、字符串等必须原样返回，
  //   否则金额/数量等数值会被误判为日期序列号而破坏。
  recoverExcelDate(val) {
    // 仅处理 Date 对象（SheetJS {cellDates:true} 已将日期序列号转为 Date）
    if (val instanceof Date) {
      const approxSerial = (val.getTime() / DAY_MS) + EXCEL_EPOCH_DAYS;
      const serial = Math.round(approxSerial);
      const correct = new Date((serial - EXCEL_EPOCH_DAYS) * DAY_MS); // UTC 午夜
      return `${correct.getUTCFullYear()}-${String(correct.getUTCMonth() + 1).padStart(2, '0')}-${String(correct.getUTCDate()).padStart(2, '0')}`;
    }
    // 🟢 v195：兜底识别"未被 SheetJS 解析为 Date 的 Excel 数字序列号"——某些列（如「实际到货日期」）
    //   在 Excel 里被存为文本/常规格式，cellDates 拿不到 Date 对象；按合理区间（20000~80000
    //   约 1954-10 ~ 2118-12）识别为日期序列号并转 YYYY-MM-DD；区间外或非数字保持原样。
    if (typeof val === 'number' && val >= 20000 && val <= 80000 && Number.isFinite(val)) {
      const correct = new Date(Math.round((val - EXCEL_EPOCH_DAYS) * DAY_MS));
      if (!isNaN(correct.getTime())) {
        return `${correct.getUTCFullYear()}-${String(correct.getUTCMonth() + 1).padStart(2, '0')}-${String(correct.getUTCDate()).padStart(2, '0')}`;
      }
    }
    // 其他类型（字符串、空值等）→ 原样返回
    return val;
  }
};

// 暴露到 window，使配置弹窗的内联 onclick 能访问到
window.DataLoader = DataLoader;

// ====================================================================
// 加载遮罩 HUD —— 按场景分形态
//   variant: 'truck'   货车进度条  (打包下载 / Excel / 云端上传, 有精确百分比)
//            'capsule' 胶囊波      (云端同步 / 拉取 / 打底 / 恢复, 不确定进度自走)
//            'fluid'   粒子流体    (各表批量导入, 不确定进度自走)
//            undefined 经典 spinner (模块加载 / 档案加载, 不改动)
// 用法:
//   showLoading('加载中...')                              → 经典 spinner
//   showLoading('打包中...', { variant:'truck', progress:42 })
//   showLoading('同步中...', { variant:'capsule' })       → 不确定进度自走
//   showLoading('导入中...', { variant:'fluid' })         → 不确定进度自走
//   hideLoading()                                         → 隐藏并复位
// ====================================================================
const LoadingHUD = (function () {
  const VARIANTS = ['truck', 'capsule', 'fluid'];
  let capsuleIdx = 0, capsuleTimer = null, fluidRAF = null, fluidState = null, fluidProg = 0;
  let subTimer = null;   // 🟢 v228.22：打底/同步超时后自动亮出「跳过」按钮的计时器

  function els() {
    return {
      overlay: document.getElementById('loadingOverlay'),
      text: document.getElementById('loadingText'),
      spinner: document.getElementById('loadingSpinner'),
      sub: document.getElementById('loadingSub'),
      actions: document.getElementById('loadingActions'),
      skipBtn: document.getElementById('loadingSkipBtn'),
      truckWrap: document.getElementById('loadingTruckWrap'),
      truck: document.getElementById('loadingTruck'),
      seg: document.getElementById('loadingSeg'),
      pct: document.getElementById('loadingPct'),
      capsWrap: document.getElementById('loadingCapsWrap'),
      caps: document.getElementById('loadingCaps'),
      fluidWrap: document.getElementById('loadingFluidWrap'),
      fluidBase: document.getElementById('loadingFluidBase'),
      fluidCanvas: document.getElementById('loadingFluidCanvas')
    };
  }

  // 隐藏全部形态节点, 复位经典 spinner
  function reset(e) {
    if (e.spinner) e.spinner.style.display = '';
    if (e.text) e.text.style.marginTop = '';
    if (e.truckWrap) { e.truckWrap.hidden = true; e.truckWrap.style.display = 'none'; }
    if (e.capsWrap) { e.capsWrap.hidden = true; e.capsWrap.style.display = 'none'; }
    if (e.fluidWrap) { e.fluidWrap.hidden = true; e.fluidWrap.style.display = 'none'; }
    if (capsuleTimer) { clearInterval(capsuleTimer); capsuleTimer = null; }
    if (fluidRAF) { cancelAnimationFrame(fluidRAF); fluidRAF = null; }
    if (e.caps) e.caps.innerHTML = '';
    if (e.fluidBase) e.fluidBase.style.width = '0%';
    // 🟢 v228.22：复位副文案 / 跳过按钮 / 超时计时器
    if (subTimer) { clearTimeout(subTimer); subTimer = null; }
    if (e.sub) { e.sub.hidden = true; e.sub.textContent = ''; }
    if (e.actions) e.actions.hidden = true;
  }

  function showVariant(e, variant) {
    if (e.spinner) e.spinner.style.display = 'none';
    if (e.text) e.text.style.marginTop = '0';
    if (variant === 'truck' && e.truckWrap) { e.truckWrap.hidden = false; e.truckWrap.style.display = 'flex'; }
    if (variant === 'capsule' && e.capsWrap) { e.capsWrap.hidden = false; e.capsWrap.style.display = 'flex'; }
    if (variant === 'fluid' && e.fluidWrap) { e.fluidWrap.hidden = false; e.fluidWrap.style.display = 'flex'; }
  }

  // 货车: 车尾对齐进度点, p=0 尾贴左端, p=100 头贴右端
  function setTruck(truck, seg, p) {
    if (!truck || !seg) return;
    const W = seg.clientWidth || 360, TW = truck.offsetWidth || 64;
    const x = (p / 100) * (W - TW);
    truck.style.left = x + 'px';
  }

  // 胶囊波: 不确定进度 → 持续向右推进再循环
  function startCapsule(e) {
    if (!e.caps) return;
    const N = 20;
    e.caps.innerHTML = '';
    const bars = [];
    for (let i = 0; i < N; i++) { const s = document.createElement('span'); e.caps.appendChild(s); bars.push(s); }
    let pos = 0;
    capsuleIdx = 0;
    capsuleTimer = setInterval(() => {
      pos = (pos + 1) % (N + 6);
      bars.forEach((b, i) => {
        b.className = '';
        const h = 8 + (i % 5) * 4;
        b.style.height = h + 'px';
        if (i < pos && i >= pos - N) {
          if (i === pos - 1) b.classList.add('head');
          else b.classList.add('on');
        }
      });
    }, 90);
  }

  // 粒子流体: 不确定进度 → 粒子持续从左汇入
  function startFluid(e) {
    const cv = e.fluidCanvas; if (!cv) return;
    const ctx = cv.getContext('2d');
    const ps = [];
    for (let i = 0; i < 48; i++) ps.push({
      x: Math.random() * cv.width, y: Math.random() * cv.height,
      vx: Math.random() * .6 + .2, vy: (Math.random() - .5) * .4,
      r: Math.random() * 1.4 + .5
    });
    fluidState = { cv, ctx, ps }; fluidProg = 0;
    const loop = () => {
      if (!fluidState) return;
      const { ctx, cv, ps } = fluidState;
      ctx.clearRect(0, 0, cv.width, cv.height);
      const limit = cv.width * 0.96;
      ps.forEach(p => {
        p.x += p.vx; if (p.x > cv.width) p.x = 0;
        p.y += p.vy; if (p.y < 0) p.y = cv.height; if (p.y > cv.height) p.y = 0;
        if (p.x <= limit) {
          ctx.globalAlpha = .85;
          ctx.fillStyle = p.x > limit - 30 ? '#fff' : '#7ec8f0';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
      fluidRAF = requestAnimationFrame(loop);
    };
    loop();
  }

  // 设备判定: 复用工作台约定 innerWidth <= 768 为移动端
  function isMobile() {
    return (window.innerWidth || document.documentElement.clientWidth || 0) <= 768;
  }

  function show(text, opts) {
    const e = els();
    if (!e.overlay) return;
    e.overlay.style.display = 'flex';
    if (e.text) e.text.textContent = text || '加载中...';
    reset(e);

    // 🟢 v228.22：副文案 / 跳过按钮（B-1 修复）
    if (opts && opts.sub) { e.sub.hidden = false; e.sub.textContent = opts.sub; }
    const revealSkip = () => {
      if (!e.actions) return;
      e.actions.hidden = false;
      if (e.skipBtn) e.skipBtn.onclick = () => { if (typeof LoadingHUD._onSkip === 'function') LoadingHUD._onSkip(); };
      if (!opts || !opts.sub) { e.sub.hidden = false; e.sub.textContent = '加载较慢，可点下方按钮跳过'; }
      else if (e.sub && e.sub.textContent.indexOf('加载较慢') === -1) { e.sub.textContent = e.sub.textContent + '（加载较慢时可点下方按钮跳过）'; }
    };
    if (opts && opts.skippable) revealSkip();
    if (opts && opts.timeout) subTimer = setTimeout(revealSkip, opts.timeout);

    const explicit = opts && VARIANTS.includes(opts.variant) ? opts.variant : null;
    // 未显式指定形态时: 移动端默认粒子流体, 桌面端保持经典 spinner
    const variant = explicit || (isMobile() ? 'fluid' : null);
    const progress = opts && typeof opts.progress === 'number' ? Math.max(0, Math.min(100, opts.progress)) : null;

    if (variant === 'truck') {
      showVariant(e, 'truck');
      const p = progress === null ? 0 : progress;
      setTruck(e.truck, e.seg, p);
      if (e.pct) e.pct.textContent = Math.round(p) + '%';
    } else if (variant === 'capsule') {
      showVariant(e, 'capsule');
      startCapsule(e);
    } else if (variant === 'fluid') {
      showVariant(e, 'fluid');
      startFluid(e);
    } else {
      // 经典 spinner (含只传 progress 但无 variant 的情况 → 仍走经典)
      if (e.spinner) e.spinner.style.display = '';
      if (e.text) e.text.style.marginTop = '';
    }
  }

  function hide() {
    const e = els();
    if (e.overlay) e.overlay.style.display = 'none';
    reset(e);
  }

  return { show, hide, setTruck };
})();

// 对外接口(向后兼容旧调用 showLoading(text) / hideLoading())
function showLoading(text, opts) { LoadingHUD.show(text, opts); }
function hideLoading() { LoadingHUD.hide(); }