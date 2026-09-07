// ============================================
// IndexedDB 数据层 - 使用 Dexie.js
// ============================================

const DB_NAME = 'WarehouseWorkbench';
// ⚠️ DB_VERSION 是「旧库清理阈值」，不是当前 schema 版本号（当前 schema 见文件末尾 db.version(8)）。
//    cleanOldDB() 的删除条件是 version < DB_VERSION - 1（即 <6，仅清理 v1–v5 这些索引爆炸的旧库）。
//    【切勿把这里改成 8】一旦改成 8，条件变为 version < 7，会把 v6 用户的库当作旧库删除 → 数据全丢。
//    保持 7：v6/v7 用户的库一律走 Dexie 平滑升级（含 7→8 新增盘点表），数据完整保留。
const DB_VERSION = 7;  // v7: 订单索引由死字段 存货编码（订单从不存该字段）改为真实持久化字段 存货编号（M5 洁癖）。Dexie 平滑升级、不丢数据

// 先删除旧版本数据库（v1/v2 有大量索引导致写入卡死）
// 必须在 db.open() 之前完成，否则 Dexie 实例会绑定到旧版本
async function cleanOldDB() {
  // 仅在检测到「真正旧版本」(version < DB_VERSION) 时才删除并重导，
  // 以避免每次刷新都清空当前版本库——那会导致“刷新就空白 / 长时间转圈”的顽疾。
  // 注意：indexedDB.databases() 返回的 version 在部分环境下不可靠，
  // 因此只凭“严格小于当前版本”判断，绝不在相等 / 大于 / 未知时删除。
  try {
    if (typeof indexedDB.databases !== 'function') {
      // 老浏览器不支持探测：交给 Dexie 的 onupgradeneeded 自动升级，不主动删除
      return;
    }
    const dbs = await indexedDB.databases();
    const oldDB = dbs.find(d => d.name === DB_NAME);
    // 仅删除「当前版本的前一个版本及更早」的旧库（如 v1–v4）；
    // 当前版本(6)的前一版本(5)已完成日期时区修复且数据正确，走 Dexie 平滑升级、不清空。
    if (oldDB && typeof oldDB.version === 'number' && oldDB.version > 0 && oldDB.version < DB_VERSION - 1) {
      console.log('检测到旧版本数据库 v' + oldDB.version + '，正在清理（避免旧 schema 写入卡死）...');
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => { console.log('旧数据库已清理'); resolve(); };
        req.onerror = () => resolve();
        req.onblocked = () => { console.warn('数据库删除被阻塞，强制继续'); resolve(); };
      });
    }
    // 当前版本 / 无版本信息 / 探测异常：保留本地数据，不删除
  } catch (e) {
    console.warn('版本检测失败（保留本地数据，不删除）:', e.message);
  }
}

const db = new Dexie(DB_NAME);

// 注意：只保留查询必需的索引字段，减少 IndexedDB 索引维护开销
// 23674 条入库数据，原 18 个索引 → 3 个索引，导入从 3 分钟降至 10 秒内
// v5 schema（历史版本，仅用于从旧库平滑升级、保留已导入数据）
db.version(5).stores({
  // 供应商管理 - 按供应商名、类型查询
  suppliers: '++id, 供应商, 类型',
  // 采购订单列表 - 按订单号、供应商、存货编码查询
  orders: '++id, 订单编号, 供应商, 存货编码',
  // 入库列表 - 按入库单号、存货编码查询
  inbound: '++id, 入库单号, 存货编码, 供应商',
  // 现存量 - 按存货编码查询
  stock: '++id, 存货编码, 存货名称',
  // 库存预警 - 按补货值、存货编码查询
  inventoryAlerts: '++id, 补货值, 存货编码',
  // 订货核对 - 按存货编码查询
  orderChecks: '++id, 存货编码',
  // 供应商价格 - 按供应商、存货编码查询
  pricing: '++id, 供应商, 存货编码',
  // 低周转材料 - 按存货编码查询
  lowTurnover: '++id, 存货编码',
  // 违约台账 - 按公司名称查询
  breach: '++id, 公司名称',
  // 出库管理 - 独立临时表，便于后续删除
  outbound: '++id, 出库单号, 存货编码, 出库时间',
  // 材料分类（v6 起移除：自 v1 起从未被任何 loader 写入）
  materialClass: '++id, 存货编码',
  // 统计数据（月度汇总）（v6 起移除：自 v1 起从未被任何 loader 写入）
  monthlyStats: '++id, 年份, 月份',
  // 应用元数据
  meta: 'key'
});

// v6 schema（当前版本）：移除从未被任何 loader 写入的死表 materialClass / monthlyStats
db.version(6).stores({
  // 供应商管理 - 按供应商名、类型查询
  suppliers: '++id, 供应商, 类型',
  // 采购订单列表 - 按订单号、供应商、存货编码查询
  orders: '++id, 订单编号, 供应商, 存货编码',
  // 入库列表 - 按入库单号、存货编码查询
  inbound: '++id, 入库单号, 存货编码, 供应商',
  // 现存量 - 按存货编码查询
  stock: '++id, 存货编码, 存货名称',
  // 库存预警 - 按补货值、存货编码查询
  inventoryAlerts: '++id, 补货值, 存货编码',
  // 订货核对 - 按存货编码查询
  orderChecks: '++id, 存货编码',
  // 供应商价格 - 按供应商、存货编码查询
  pricing: '++id, 供应商, 存货编码',
  // 低周转材料 - 按存货编码查询
  lowTurnover: '++id, 存货编码',
  // 违约台账 - 按公司名称查询
  breach: '++id, 公司名称',
  // 出库管理 - 独立临时表，便于后续删除
  outbound: '++id, 出库单号, 存货编码, 出库时间',
  // 应用元数据
  meta: 'key'
});

// v7 schema（当前版本）：订单索引 存货编码 → 存货编号（订单实际持久化字段，原 存货编码 为永不命中的死索引）
db.version(7).stores({
  // 供应商管理 - 按供应商名、类型查询
  suppliers: '++id, 供应商, 类型',
  // 采购订单列表 - 按订单号、供应商、存货编号查询（M5：存货编号 为真实字段）
  orders: '++id, 订单编号, 供应商, 存货编号',
  // 入库列表 - 按入库单号、存货编码查询
  inbound: '++id, 入库单号, 存货编码, 供应商',
  // 现存量 - 按存货编码查询
  stock: '++id, 存货编码, 存货名称',
  // 库存预警 - 按补货值、存货编码查询
  inventoryAlerts: '++id, 补货值, 存货编码',
  // 订货核对 - 按存货编码查询
  orderChecks: '++id, 存货编码',
  // 供应商价格 - 按供应商、存货编码查询
  pricing: '++id, 供应商, 存货编码',
  // 低周转材料 - 按存货编码查询
  lowTurnover: '++id, 存货编码',
  // 违约台账 - 按公司名称查询
  breach: '++id, 公司名称',
  // 出库管理 - 独立临时表，便于后续删除
  outbound: '++id, 出库单号, 存货编码, 出库时间',
  // 应用元数据
  meta: 'key'
});

// v8 schema（当前版本）：新增「盘点记录」独立表 stocktake_records（v215）
//   · 该表刻意不进云同步的 10 表 bundle（DataLoader.TABLES）与 clearAll()，
//     → 盘点记录既不会被推送覆盖，也不会在「重新导入」时被误清空。
//   · recId = crypto.randomUUID() 全局唯一，作为跨设备追加合并的去重键。
//   · 未给 inbound 增加「入库日期」索引：实测全表扫描 24405 行 <100ms 已足够；
//     且 db.js:42 注释载明索引是导入性能瓶颈（18→3 索引带来 3分钟→10秒），
//     为不影响现有导入速度，此处保持 3 索引不变。
db.version(8).stores({
  suppliers: '++id, 供应商, 类型',
  orders: '++id, 订单编号, 供应商, 存货编号',
  inbound: '++id, 入库单号, 存货编码, 供应商',
  stock: '++id, 存货编码, 存货名称',
  inventoryAlerts: '++id, 补货值, 存货编码',
  orderChecks: '++id, 存货编码',
  pricing: '++id, 供应商, 存货编码',
  lowTurnover: '++id, 存货编码',
  breach: '++id, 公司名称',
  outbound: '++id, 出库单号, 存货编码, 出库时间',
  // 盘点记录（v215 新增）：recId 唯一去重；按存货编码/盘点人/日期/类别查询
  stocktake_records: '++id, recId, 存货编码, 盘点人, 盘点日期, 盘点类别',
  meta: 'key'
});

// v9 schema（v227.77 新增）：临时出库独立 store（与「中心库房出库单列表」物理隔离）
//   · 老版 outbound（中心库房出库单列表）继续保留，OutboundListModule 照常读它；
//   · 新版 OutboundModule（侧边栏改名为「临时出库」）全部走 tempOutbound：
//     录入/翻页/搜索/删除 都不再触碰 outbound 表；
//   · 索引与 outbound 保持一致（出库单号/存货编码/出库时间），保证 getAllOrderNos/搜索/翻页
//     等代码 0 改动即可迁移。
db.version(9).stores({
  // 🟢 v227.77：临时出库（侧边栏「临时出库」模块专用）
  tempOutbound: '++id, 出库单号, 存货编码, 出库时间'
});

// 不在定义时自动打开——由 App.init() 中 cleanOldDB() 之后手动调用 db.open()
// 这样可以确保旧版本数据库先被清理

// ============================================
// 通用数据操作接口
// ============================================

const DataStore = {
  // 🟢 v194：表级读取缓存。切换模块/刷新时无需反复从 IndexedDB 全量 toArray，
  // 仅在「导入/清空」数据后才失效（见 clearAll / markDataImported）。
  // 命中缓存返回的是同一数组引用，调用方只读不写即可（filter/slice 安全）。
  _tableCache: {},
  _cacheReady: false,

  // 取得某表的全部行（带缓存）。写入/清空数据后需调用 invalidate 失效。
  async getRows(table) {
    // 🟢 v207 AUDIT-101：改用 hasOwnProperty 判定而非真值判定。
    // 旧写法 `if (this._tableCache[table])` 对空数组 [] 也为假 → 空库每次回查 IndexedDB，
    // 而一旦写入首条数据又被永久缓存、写后不失效（见下方 write()）。
    if (Object.prototype.hasOwnProperty.call(this._tableCache, table)) {
      return this._tableCache[table];
    }
    const rows = await db[table].toArray();
    this._tableCache[table] = rows;
    return rows;
  },
  invalidate(table) { if (this._tableCache) delete this._tableCache[table]; },
  invalidateAll() { this._tableCache = {}; },

  // 🟢 v207 AUDIT-101：统一写入口 —— 业务层禁止直接 db.xxx.bulkAdd/bulkDelete，
  // 一律经本方法，写后自动失效表缓存，杜绝「读到进入模块时的旧快照」。
  // 用法：await DataStore.write('orderChecks', () => db.orderChecks.bulkAdd(rows));
  async write(table, fn) {
    const ret = await fn();
    this.invalidate(table);
    return ret;
  },

  // 检查是否已导入数据
  async isDataImported() {
    const meta = await db.meta.get('dataImported');
    return meta && meta.value === true;
  },

  // 标记数据已导入
  async markDataImported() {
    await db.meta.put({ key: 'dataImported', value: true, time: new Date().toISOString() });
    this.invalidateAll();
  },

  // 获取导入时间
  async getImportTime() {
    const meta = await db.meta.get('dataImported');
    return meta ? meta.time : null;
  },

  // ─── 替换内置工作簿存储：v111 已删除「导入替换内置工作簿」UI 入口，相关 save/clear/get 方法一并移除（O2）──

  // 清空所有数据（重新导入时使用）
  // 🟢 AUDIT-002：原实现为顺序 12 条独立 clear()，中途某张表抛错会导致「半清库」（部分已清、部分未清）。
  //   现用 Dexie 事务包裹全部 11 张表，要么全部清空、要么全部回滚；失败显式抛出，让重导流程感知而非静默继续。
  async clearAll() {
    try {
      await db.transaction('rw',
        db.suppliers, db.orders, db.inbound, db.stock, db.inventoryAlerts,
        db.orderChecks, db.pricing, db.lowTurnover, db.breach, db.outbound, db.meta,
        async () => {
          await db.suppliers.clear();
          await db.orders.clear();
          await db.inbound.clear();
          await db.stock.clear();
          await db.inventoryAlerts.clear();
          await db.orderChecks.clear();
          await db.pricing.clear();
          await db.lowTurnover.clear();
          await db.breach.clear();
          await db.outbound.clear();
          await db.meta.delete('dataImported');
        });
      this.invalidateAll();
    } catch (e) {
      // 事务失败（如存储配额/并发写入）：异常上浮，避免「半清库」后继续导入造成数据口径不一致。
      console.error('[clearAll] 事务清空失败（已回滚）：', e);
      throw e;
    }
  },

  // ===== 设置数据层（云端 settings.json，用户长期偏好 / 非导入数据）=====
  // 读取单项设置
  async getSetting(key) {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return undefined;
    return SyncManager.getSetting(key);
  },
  // 写入单项设置（合并式）
  async setSetting(key, value) {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    return SyncManager.setSetting(key, value);
  },
  // 出库列表：录入/删除后实时同步到设置数据（跨设备长期记忆）
  async syncOutboundToSettings() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    const rows = await this.getRows('outbound');
    return SyncManager.setSetting('outbound_list', rows);
  },
  // 🟢 v227.77：临时出库（侧边栏「临时出库」模块）独立云端同步 key
  async syncTemporaryOutboundToSettings() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    const rows = await this.getRows('tempOutbound');
    return SyncManager.setSetting('temp_outbound_list', rows);
  },
  // 启动恢复：用云端设置里的出库列表覆盖本地（若有且更新）
  async restoreOutboundFromSettings() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const rows = await SyncManager.getSetting('outbound_list');
      if (Array.isArray(rows) && rows.length) {
        // 🟢 v207 AUDIT-101：覆盖写本地后必须失效缓存，否则本次会话内 getRows
        // 仍返回覆盖前的旧快照，界面与库内容不一致。
        await this.write('outbound', async () => {
          await db.outbound.clear();
          await db.outbound.bulkPut(rows);
        });
        console.log(`[设置] 已从云端恢复出库列表 ${rows.length} 条`);
        return true;
      }
    } catch (e) { console.warn('出库恢复失败:', e); }
    return false;
  },
  // 🟢 v227.77：临时出库（独立 store 独立云端 key 'temp_outbound_list'）
  async restoreTemporaryOutboundFromSettings() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const rows = await SyncManager.getSetting('temp_outbound_list');
      if (Array.isArray(rows) && rows.length) {
        await this.write('tempOutbound', async () => {
          await db.tempOutbound.clear();
          await db.tempOutbound.bulkPut(rows);
        });
        console.log(`[设置] 已从云端恢复临时出库 ${rows.length} 条`);
        return true;
      }
    } catch (e) { console.warn('临时出库恢复失败:', e); }
    return false;
  },
  // 搜索历史：从 v163 localStorage 一次性迁移到云端设置
  async migrateSearchHistoryToCloud() {
    try {
      const local = JSON.parse(localStorage.getItem('wb_query_search_history') || '[]');
      if (!Array.isArray(local) || !local.length) return false;
      if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
      const cloud = await SyncManager.getSetting('search_history_query');
      if (Array.isArray(cloud) && cloud.length) return false; // 云端已有则不覆盖
      await SyncManager.setSetting('search_history_query', local.slice(0, 5));
      localStorage.setItem('wb_query_search_history_migrated', '1');
      return true;
    } catch (e) { return false; }
  },

  // ===== 供应商管理 =====
  // 🟢 v227.52 P0：改走 getRows() 内存缓存，避免每次从 IndexedDB 全量序列化（24k 行级开销）
  async getSuppliers(filter = {}) {
    let list = await this.getRows('suppliers');
    if (filter.类型) list = list.filter(s => s.类型 === filter.类型);
    if (filter.招采部门) list = list.filter(s => s.招采部门 === filter.招采部门);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(s => (s.供应商 && s.供应商.toLowerCase().includes(kw)) ||
                              (s.类型 && s.类型.toLowerCase().includes(kw)));
    }
    return list;
  },

  async getSupplierTypes() {
    const all = await this.getRows('suppliers');
    return [...new Set(all.map(s => s.类型).filter(Boolean))];
  },

  async getSupplierDepartments() {
    const all = await this.getRows('suppliers');    return [...new Set(all.map(s => s.招采部门).filter(Boolean))];
  },

  // ===== 订单列表 =====
  // 🟢 v227.52 P0：走 getRows() 缓存 + 内存分页（slice），消除每页两次全表扫描
  async getOrders(filter = {}, page = 1, pageSize = 50) {
    let list = await this.getRows('orders');
    if (filter.供应商) list = list.filter(o => o.供应商 === filter.供应商);
    if (filter.项目名称) list = list.filter(o => o.项目名称 === filter.项目名称);
    if (filter.审批状态) list = list.filter(o => o.审批状态 === filter.审批状态);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(o => (o.订单编号 && String(o.订单编号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                              (o.供应商 && o.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                              (o.存货名称 && o.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                              (o.项目名称 && o.项目名称.replace(/\s+/g, '').toLowerCase().includes(kw)));
    }
    if (filter.startDate || filter.endDate) {
      list = list.filter(o => {
        if (!o.日期) return false;
        if (filter.startDate && o.日期 < filter.startDate) return false;
        if (filter.endDate && o.日期 > filter.endDate) return false;
        return true;
      });
    }
    const total = list.length;
    if (pageSize === 'all') return { items: list, total, page: 1, pageSize: 'all', totalPages: 1 };
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  },

  async getOrderSuppliers() {
    const all = await this.getRows('orders');
    return [...new Set(all.map(o => o.供应商).filter(Boolean))];
  },

  async getOrderProjects() {
    const all = await this.getRows('orders');
    return [...new Set(all.map(o => o.项目名称).filter(Boolean))];
  },

  // ===== 入库列表 =====
  // 🟢 v227.52 P0：走 getRows() 缓存 + 内存分页（slice）
  async getInbound(filter = {}, page = 1, pageSize = 50) {
    let list = await this.getRows('inbound');
    if (filter.供应商) list = list.filter(i => i.供应商 === filter.供应商);
    if (filter.项目名称) list = list.filter(i => i.项目名称 === filter.项目名称);
    if (filter.仓库) list = list.filter(i => i.仓库 === filter.仓库);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(i => (i.入库单号 && String(i.入库单号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                              (i.供应商 && i.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                              (i.存货名称 && i.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw)));
    }
    if (filter.startDate || filter.endDate) {
      list = list.filter(i => {
        if (!i.入库日期) return false;
        if (filter.startDate && i.入库日期 < filter.startDate) return false;
        if (filter.endDate && i.入库日期 > filter.endDate) return false;
        return true;
      });
    }
    const total = list.length;
    if (pageSize === 'all') return { items: list, total, page: 1, pageSize: 'all', totalPages: 1 };
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  },

  // ===== 现存量 =====
  // 🟢 v227.52 P0：走 getRows() 缓存
  async getStock(filter = {}) {
    let list = await this.getRows('stock');
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(s => (s.存货编码 && s.存货编码.toLowerCase().includes(kw)) ||
                              (s.存货名称 && s.存货名称.toLowerCase().includes(kw)) ||
                              (s.规格型号 && s.规格型号.toLowerCase().includes(kw)));
    }
    return list;
  },

  // ===== 库存预警 =====
  // 🟢 v227.52 P0：走 getRows() 缓存
  async getInventoryAlerts(filter = {}) {
    let list = await this.getRows('inventoryAlerts');
    if (filter.补货值 !== undefined) {
      list = list.filter(a => (filter.补货值 ? (a.补货值 && a.补货值 > 0) : (!a.补货值 || a.补货值 <= 0)));
    }
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(a => (a.存货名称 && a.存货名称.toLowerCase().includes(kw)) ||
                              (a.存货编码 && a.存货编码.toLowerCase().includes(kw)));
    }
    return list;
  },

  async getAlertStats() {
    const all = await this.getRows('inventoryAlerts');
    const needRestock = all.filter(a => a.补货值 && a.补货值 > 0).length;
    const total = all.length;
    return { needRestock, total };
  },

  // ===== 订货核对 =====

  // ===== 合同价格 =====
  // 🟢 v227.52 P0：走 getRows() 缓存
  async getPricing(filter = {}) {
    let list = await this.getRows('pricing');
    if (filter.供应商) list = list.filter(p => p.供应商 === filter.供应商);
    if (filter.类型) list = list.filter(p => p.类型 === filter.类型);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(p => (p.存货名称 && p.存货名称.toLowerCase().includes(kw)) ||
                              (p.供应商 && p.供应商.toLowerCase().includes(kw)));
    }
    return list;
  },

  async getPricingTypes() {
    const all = await this.getRows('pricing');
    return [...new Set(all.map(p => p.类型).filter(Boolean))];
  },

  // ===== 低周转 =====
  // 🟢 v227.52 P0：走 getRows() 缓存
  async getLowTurnover(filter = {}) {
    let list = await this.getRows('lowTurnover');
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(l => (l.存货名称 && l.存货名称.toLowerCase().includes(kw)));
    }
    return list;
  },

  // ===== 违约台账 =====
  // 🟢 v227.52 P0：走 getRows() 缓存
  async getBreachRecords(filter = {}) {
    let list = await this.getRows('breach');
    if (filter.公司名称) list = list.filter(b => b.公司名称 === filter.公司名称);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(b => (b.公司名称 && b.公司名称.toLowerCase().includes(kw)));
    }
    return list;
  },

  // ===== 出库管理 =====
  // 🟢 v227.52 P0：走 getRows() 缓存 + 内存分页（slice）
  async getOutbound(filter = {}, page = 1, pageSize = 20) {
    let list = await this.getRows('outbound');
    if (filter.出库单号) list = list.filter(o => o.出库单号 === filter.出库单号);
    if (filter.项目名称) list = list.filter(o => o.项目名称 === filter.项目名称);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      list = list.filter(o => (o.出库单号 && o.出库单号.toLowerCase().includes(kw)) ||
                              (o.存货编码 && o.存货编码.toLowerCase().includes(kw)) ||
                              (o.存货名称 && o.存货名称.toLowerCase().includes(kw)) ||
                              (o.项目名称 && o.项目名称.toLowerCase().includes(kw)));
    }
    if (filter.startDate || filter.endDate) {
      list = list.filter(o => {
        if (!o.出库时间) return false;
        if (filter.startDate && o.出库时间 < filter.startDate) return false;
        if (filter.endDate && o.出库时间 > filter.endDate) return false;
        return true;
      });
    }
    const total = list.length;
    if (pageSize === 'all') return { items: list, total, page: 1, pageSize: 'all', totalPages: 1 };
    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  },

  async getOutboundProjects() {
    const all = await this.getRows('outbound');
    return [...new Set(all.map(o => o.项目名称).filter(Boolean))];
  },

  // ===== 仪表盘统计 =====
  async getDashboardStats() {
    const [suppliers, orders, inbound, stock, alerts, lowTurnover] = await Promise.all([
      db.suppliers.count(),
      db.orders.count(),
      db.inbound.count(),
      db.stock.count(),
      this.getRows('inventoryAlerts'),
      db.lowTurnover.count()
    ]);

    // 补货值统一处理在现存量交叉补全之后进行（见下方）

    // 从 stock 表交叉获取真实现存量（与 inventory-alert 模块保持一致）
    try {
      const stockRows = await this.getRows('stock');
      const stockByCode = new Map();
      const stockByNameSpec = new Map();
      stockRows.forEach(s => {
        if (s.存货编码) stockByCode.set(String(s.存货编码), s.现存数量);
        if (s.存货名称) {
          const key = TableUtils.buildStockKey(s.存货名称, s.规格型号);
          stockByNameSpec.set(key, s.现存数量);
        }
      });
      alerts.forEach(a => {
        if (!a.现存量 || a.现存量 === 0) {
          if (a.存货编码 && stockByCode.has(String(a.存货编码))) a.现存量 = stockByCode.get(String(a.存货编码));
          else if (a.存货名称) {
            const key = (a.存货名称 + '|' + (a.规格型号 || '')).replace(/\s+/g, '');
            if (stockByNameSpec.has(key)) a.现存量 = stockByNameSpec.get(key);
            else for (const [k, v] of stockByNameSpec) { if (k.startsWith((a.存货名称 || '').replace(/\s+/g, ''))) { a.现存量 = v; break; } }
          }
        }
        // 补货值：直接使用导入时从源数据"是否需补货"(J列)读取的原始数值，不做回退计算
        const rv = parseFloat(a.补货值);
        a.补货值 = isNaN(rv) ? 0 : rv;
      });
    } catch(e) {
    /* ignore */ console.warn('[db.js:485] 异常(已忽略):', e);
  }

    const needRestock = alerts.filter(a => a.补货值 && a.补货值 > 0);
    const needRestockCount = needRestock.length;
    const needRestockQty = needRestock.reduce((sum, a) => sum + (parseFloat(a.在途订单) || 0), 0);

    const ordersAll = await this.getRows('orders');
    const totalOrderAmount = TableUtils.sumMoney(ordersAll, '原币价税合计'); // 🟢 AUDIT-003 整数分聚合

    const pendingInbound = ordersAll.filter(o => parseFloat(o.未入库量) > 0).length;

    // 未审批通过订单（与订单列表模块逻辑一致：有审批状态且 ≠ '审批通过'，按订单编号去重）
    const unapprovedOrders = ordersAll.filter(o => o.审批状态 && o.审批状态 !== '审批通过');
    const pendingApproval = new Set(unapprovedOrders.map(o => o.订单编号).filter(Boolean)).size;

    // 订单状态分布（按订单编号去重计数，与订单列表模块口径一致）
    // 待审：有审批状态且 ≠ 审批通过；已审：审批通过；在途：未入库量 > 0（未完全入库）
    const orderNos = ordersAll.map(o => o.订单编号).filter(Boolean);
    const uniqOrderNos = [...new Set(orderNos)];
    const dedupByNo = (pred) => new Set(ordersAll.filter(pred).map(o => o.订单编号).filter(Boolean)).size;
    const pendingReview = dedupByNo(o => o.审批状态 && o.审批状态 !== '审批通过');
    const approved = dedupByNo(o => o.审批状态 === '审批通过');
    const inTransit = dedupByNo(o => parseFloat(o.未入库量) > 0);

    // 临近到期供应商（30-90天）
    const now = new Date();
    const contractExpiringSoon = await this.getRows('suppliers').then(arr =>
      arr.filter(s => {
        if (!s.年度合同到期时间) return false;
        const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
        return days > 30 && days <= 90;
      }).length
    );

    // 在供供应商数（排除已过期的：合同到期时间 < 今天）
    const activeSupplierCount = await this.getRows('suppliers').then(arr =>
      arr.filter(s => !s.年度合同到期时间 || new Date(s.年度合同到期时间) >= now).length
    );

    // 年度供货总金额（当年入库记录的 原币价税合计 求和）
    const y = now.getFullYear();
    const yearInboundAmount = TableUtils.sumMoney(
      (await this.getRows('inbound')).filter(i => i.入库日期 && new Date(i.入库日期).getFullYear() === y),
      '原币价税合计'
    ); // 🟢 AUDIT-003 整数分聚合

    return {
      supplierCount: suppliers,
      activeSupplierCount,
      orderCount: orders,
      inboundCount: inbound,
      stockCount: stock,
      needRestockCount,
      needRestockQty: Math.round(needRestockQty * 100) / 100,
      contractExpiringSoon,
      totalOrderAmount: Math.round(totalOrderAmount * 100) / 100,
      pendingInbound,
      pendingApproval,
      pendingReview,
      approved,
      inTransit,
      lowTurnoverCount: lowTurnover,
      yearInboundAmount: Math.round(yearInboundAmount * 100) / 100
    };
  },

  // ===== 实体关联聚合（打通模块）=====
  // 按 EntityLinks[type].tables 扇出查询：返回该实体在各表中的关联行
  // 供应商→违约台账用「公司名称」且键不统一：先精确匹配，再包含匹配兜底
  async queryByEntity(type, key) {
    if (typeof EntityLinks === 'undefined' || !EntityLinks[type]) return {};
    key = String(key ?? '').trim();
    if (!key) return {};
    const tables = EntityLinks[type].tables;
    const out = {};
    for (const [table, field] of Object.entries(tables)) {
      try {
        if (!db[table]) { out[table] = []; continue; }
        // 防御：若关联字段未建索引（如历史遗留的未索引键），跳过该表的扇出，
        // 避免 Dexie 抛 "KeyPath ... is not indexed" 导致整段聚合中断（F1/F3）
        const idxByKeyPath = db[table].schema && db[table].schema.indexesByKeyPath;
        if (idxByKeyPath && !idxByKeyPath.has(field)) { out[table] = []; continue; }
        let rows = await db[table].where(field).equals(key).toArray();
        // 违约台账软匹配：精确未命中时，用「公司名称 包含 供应商」兜底
        if (type === 'supplier' && table === 'breach' && rows.length === 0) {
          const all = await this.getRows('breach');
          rows = all.filter(b => b.公司名称 && b.公司名称.includes(key));
          out._breachSoft = true; // 标记为软匹配，UI 标注
        }
        out[table] = rows;
      } catch (e) {
        console.warn('[queryByEntity]', table, e.message);
        out[table] = [];
      }
    }
    return out;
  },

  // 订单与存货的关联键不统一：订单用「存货编号」，现存/入库/出库/价格用「存货编码」
  // 且订单可能缺编码、仅有名称 → 以 (存货编号==code) 或 (名称+规格 经 codeMap 匹配) 双路命中
  // 用于存货档案的「关联订单」反向联动（全表扫描，用户点击时一次性执行，可接受）
  async getOrdersForStock(code, name, spec) {
    code = String(code == null ? '' : code).trim();
    name = String(name == null ? '' : name).trim();
    spec = String(spec == null ? '' : spec).trim();
    if (!code && !name) return [];
    let codeMap = null;
    if (typeof DataLoader !== 'undefined' && typeof DataLoader.getStockNameSpecCodeMap === 'function') {
      try { codeMap = await DataLoader.getStockNameSpecCodeMap(); } catch (e) { codeMap = null; }
    }
    const nameKey = name ? (name + '|' + spec).replace(/\s+/g, '') : null;
    const normCode = (codeMap && nameKey) ? codeMap.get(nameKey) : null;
    const codes = new Set([code, normCode].filter(Boolean).map(String));
    try {
      const rows = await db.orders.filter(o => {
        const on = o.存货编号 != null ? String(o.存货编号).trim() : '';
        if (on && codes.has(on)) return true;
        if (nameKey) {
          const oname = String(o.存货名称 || '').trim();
          const ospec = String(o.规格型号 || '').trim();
          if (oname && (oname + '|' + ospec).replace(/\s+/g, '') === nameKey) return true;
        }
        return false;
      }).limit(31).toArray();
      // 🟢 v201 + O8：编码/规格双路均未命中时，按「存货名称」精确兜底（编码或规格缺失场景仍能关联）
      //   🐛 修复：兜底**必须要求订单的「存货编号」为空**——否则会把"有编号 + 名称相同但规格不同"
      //         的不同物料（如同名不同规格的"三通 100" / "三通 80"）误关到本档案。
      //   修复后兜底仅在"订单完全缺编号"场景生效，主路已经覆盖了"有编号+有名称有规格"的关联。
      let matched = rows;
      if (matched.length === 0 && name) {
        const n = name.replace(/\s+/g, '');
        if (n) {
          matched = await db.orders.filter(o => {
            const oname = String(o.存货名称 || '').replace(/\s+/g, '');
            const onum  = o.存货编号 == null ? '' : String(o.存货编号).trim();
            // v201 修复：必须有"名称完全相等" + "存货编号为空" 才兜底
            return oname && oname === n && !onum;
          }).limit(31).toArray();
        }
      }
      return matched.slice(0, 30);
    } catch (e) {
      console.warn('[getOrdersForStock]', e.message);
      return [];
    }
  },

  // ===== 全局搜索 =====
  async globalSearch(keyword) {
    if (!keyword || keyword.trim().length < 1) return { suppliers: [], orders: [], inbound: [], stock: [] };
    const kw = keyword.trim().replace(/\s+/g, '').toLowerCase();

    const [suppliers, orders, inbound, stock] = await Promise.all([
      db.suppliers.filter(s => (s.供应商 && s.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                               (s.类型 && s.类型.replace(/\s+/g, '').toLowerCase().includes(kw))).limit(10).toArray(),
      db.orders.filter(o => (o.订单编号 && String(o.订单编号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                            (o.供应商 && o.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                            (o.存货名称 && o.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw))).limit(10).toArray(),
      db.inbound.filter(i => (i.入库单号 && String(i.入库单号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                             (i.供应商 && i.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                             (i.存货名称 && i.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw))).limit(10).toArray(),
      db.stock.filter(s => (s.存货编码 && String(s.存货编码).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                           (s.存货名称 && s.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw))).limit(10).toArray()
    ]);

    return { suppliers, orders, inbound, stock };
  },

  // ===== 关联完整性看板（打通模块 · 反向利用已建立的关系发现数据孤岛）=====
  // 计算五类「孤岛」指标，返回各集合（去重后的存货编码/供应商名/订单行）供下钻
  async getCompletenessStats() {
    const [stockRows, inboundRows, ordersRows, supplierRows, pricingRows] = await Promise.all([
      this.getRows('stock'), this.getRows('inbound'), this.getRows('orders'), this.getRows('suppliers'), this.getRows('pricing')
    ]);

    const norm = (v) => (v == null ? '' : String(v).trim());

    // 已入库的存货编码集合
    const inbCodes = new Set(inboundRows.map(r => norm(r.存货编码)).filter(Boolean));
    // 供应商集合
    const supplierSet = new Set(supplierRows.map(r => norm(r.供应商)).filter(Boolean));
    const inbSup = new Set(inboundRows.map(r => norm(r.供应商)).filter(Boolean));
    const priceSup = new Set(pricingRows.map(r => norm(r.供应商)).filter(Boolean));

    // 订单关联的存货编码：经「存货编号」+ (名称|规格 → codeMap) 双路取码
    let codeMap = null;
    if (typeof DataLoader !== 'undefined' && typeof DataLoader.getStockNameSpecCodeMap === 'function') {
      try { codeMap = await DataLoader.getStockNameSpecCodeMap(); } catch (e) { codeMap = null; }
    }
    const ordCodes = new Set();
    ordersRows.forEach(o => {
      const on = norm(o.存货编号);
      if (on) { ordCodes.add(on); return; }
      if (codeMap && o.存货名称) {
        const k = (o.存货名称 + '|' + (o.规格型号 || '')).replace(/\s+/g, '');
        const c = codeMap.get(k);
        if (c) ordCodes.add(c);
      }
    });

    const stockCodes = new Set(stockRows.map(r => norm(r.存货编码)).filter(Boolean));
    const stockNoInbound = [...stockCodes].filter(c => !inbCodes.has(c));
    const stockNoOrder = [...stockCodes].filter(c => !ordCodes.has(c));
    const supNoPrice = [...supplierSet].filter(s => !priceSup.has(s));
    const supNoInbound = [...supplierSet].filter(s => !inbSup.has(s));
    const ordersNoInbound = ordersRows.filter(o => parseFloat(o.未入库量) > 0);

    return {
      stockNoInbound, stockNoOrder, supNoPrice, supNoInbound, ordersNoInbound,
      counts: {
        stockNoInbound: stockNoInbound.length,
        stockNoOrder: stockNoOrder.length,
        supNoPrice: supNoPrice.length,
        supNoInbound: supNoInbound.length,
        ordersNoInbound: ordersNoInbound.length
      },
      totals: { stock: stockRows.length, supplier: supplierRows.length, order: ordersRows.length },
      _stockRows: stockRows, _supplierRows: supplierRows
    };
  },

  // ===== 盘点记录数据层（v215 新增 · 独立表）=====
  // 说明：stocktake_records 刻意不进 DataLoader.TABLES（云同步 10 表），也不在 clearAll() 清空清单内，
  //      因此「重新导入数据」不会误删盘点记录、云端整包覆盖也不会污染它。
  //      读取走 getRows 表缓存，写入一律经 write() 统一入口以保证缓存失效。

  // 读取全部盘点记录（带缓存）
  async getStocktakeRecords() {
    return (await this.getRows('stocktake_records')) || [];
  },

  // 批量追加盘点记录（返回写入条数）
  async addStocktakeRecords(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    await this.write('stocktake_records', () => db.stocktake_records.bulkAdd(rows));
    return rows.length;
  },

  // 删除单条（按主键 id）
  async deleteStocktakeRecord(id) {
    await this.write('stocktake_records', () => db.stocktake_records.delete(id));
  },

  // v218：放弃盘点 —— 删除指定批次下某盘点人的全部记录（含草稿/补0/实盘），返回删除条数
  async deleteStocktakeRecordsBySheetAndCounter(sheetId, counter) {
    const rows = (await this.getStocktakeRecords()).filter(r =>
      r.sheetId === sheetId && String(r.盘点人 || '').trim() === String(counter).trim());
    const ids = rows.map(r => r.id).filter(x => x != null);
    // 一次性 bulkDelete（经 write 包装，避免逐条 delete 在 Dexie 循环里漏删）
    if (ids.length) await this.write('stocktake_records', () => db.stocktake_records.bulkDelete(ids));
    return ids.length;
  },

  // 局部更新单条（用于「作废/取消作废/修正」；盘点记录是追加型，正常流程不改已存记录）
  async updateStocktakeRecord(id, patch) {
    await this.write('stocktake_records', () => db.stocktake_records.update(id, patch));
  },

  // 清空全部盘点记录（仅供调试/重置，业务层慎用）
  async clearStocktakeRecords() {
    await this.write('stocktake_records', () => db.stocktake_records.clear());
  },

  // 条件查询（内存过滤：盘点记录量级远小于入库表 24405 行，无需额外索引）
  async queryStocktakeRecords(filter = {}) {
    let rows = await this.getStocktakeRecords();
    const eq = (v, t) => String(v == null ? '' : v).trim() === String(t);
    if (filter.存货编码) rows = rows.filter(r => eq(r.存货编码, filter.存货编码));
    if (filter.盘点人) rows = rows.filter(r => eq(r.盘点人, filter.盘点人));
    if (filter.盘点类别) rows = rows.filter(r => r.盘点类别 === filter.盘点类别);
    if (filter.sheetId) rows = rows.filter(r => r.sheetId === filter.sheetId);
    if (filter.voided !== undefined) rows = rows.filter(r => !!r.voided === !!filter.voided);
    return rows;
  },

  // ===== v217 盘点任务分派 / 批次汇总（localStorage 封装，绝不碰 Dexie/DB_VERSION）=====
  _lsGet(key, def) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(def)); } catch (e) { return def; } },
  _lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} },

  // —— 任务分派 ——
  // 🟢 v225.2 墓碑机制：任务由「管理员设备」产生，靠云端 settings 通道同步到「盘点人设备」。
  //   删除必须可传播 —— 否则管理员取消分派后，盘点人设备上的任务永远消不掉（僵尸任务，
  //   pull 只遍历 remote 的 key，本地多出来的那份没人管，用户会看到已被取消的任务还能进）。
  //   故删除不物理删，改为写墓碑 {deleted:true, updatedAt}，随 raw 一起上云。
  //   对外 getStocktakeTasks() 只返回活任务；同步通道一律走 _tasksRaw()（含墓碑）。
  _tasksRaw() {
    const raw = this._lsGet('wb_stocktake_tasks', {});
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  },
  getStocktakeTasks() {
    const raw = this._tasksRaw();
    const out = {};
    Object.keys(raw).forEach(k => {
      const t = raw[k];
      if (!t || typeof t !== 'object') return;
      if (t.deleted) return;          // 墓碑：已删除，对外不可见
      if (!t.taskId) return;
      out[k] = t;
    });
    return out;
  },
  async saveStocktakeTask(task) {
    const all = this._tasksRaw();
    all[task.taskId] = task;
    this._lsSet('wb_stocktake_tasks', all);
    // 云端：复用 settings 通道（与 keepers 同模式；不碰 stocktake.json 的 tasks，避免与结束时的 taskPatch 冲突）
    // v225.2：推 raw（含墓碑），否则本机的删除事实会被抹掉，其他设备上的僵尸任务原地复活。
    await this._pushStocktakeTasksToCloud();
    return task;
  },
  // skipPush=true 供批量删除使用（先逐个写墓碑，最后统一推一次，避免 N 次网络写）
  async deleteStocktakeTask(taskId, opts) {
    const all = this._tasksRaw();
    if (!all[taskId]) return;
    all[taskId] = { taskId: taskId, deleted: true, updatedAt: new Date().toISOString() };
    this._lsSet('wb_stocktake_tasks', all);
    if (!(opts && opts.skipPush)) await this._pushStocktakeTasksToCloud();
  },
  // 统一的任务上云出口（供 save/delete/作废批次/取消分派复用，保证推的一定是含墓碑的 raw）
  async _pushStocktakeTasksToCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      // 🟢 v227.16：离线时入队，联网后由 StocktakeModule._flushCloudQueue 补推（仓库弱网常态）
      try { this._enqueueCloud('stocktakeTasks', this._tasksRaw()); } catch (e) {}
      return false;
    }
    if (typeof SyncManager.setSetting !== 'function') return false;
    // 🟢 v225.2：settings 通道是整包覆盖（见 sync.js AUDIT-303），任一台设备写入都会把
    //   其他设备刚写入的任务整包抹掉 —— 「这边分派那边却看不到」的相悖状态根源之一。
    //   故先拉一次云端合并到本地，再整包推「并集」，写上去的一定是全量而非本机子集。
    //   pull 不调 push（无递归）；合并以 updatedAt 较新者胜，本机刚写的墓碑不会被云端旧活任务误复活。
    try { await this.pullStocktakeTasksFromCloud(); } catch (e) {}
    try { await SyncManager.setSetting('stocktakeTasks', this._tasksRaw()); return true; }
    catch (e) { try { this._enqueueCloud('stocktakeTasks', this._tasksRaw()); } catch (_) {} return false; }
  },
  // 🟢 v227.16：仓库离线容错 —— 跨设备 key-value 推送本地待推队列（与 StocktakeModule 共用 key）
  _enqueueCloud(key, value) {
    try {
      const q = JSON.parse(localStorage.getItem('wb_stocktake_cloud_q') || '[]') || [];
      const i = q.findIndex(x => x.key === key);
      const item = { key, value, ts: Date.now() };
      if (i >= 0) q[i] = item; else q.push(item);
      localStorage.setItem('wb_stocktake_cloud_q', JSON.stringify(q));
    } catch (e) { /* 忽略 */ }
  },
  getTasksBySheet(sheetId) {
    const all = this.getStocktakeTasks();
    return Object.keys(all).map(k => all[k]).filter(t => t.sheetId === sheetId);
  },
  getMyOpenTasks(counter) {
    const c = String(counter || '').trim();
    const all = this.getStocktakeTasks();
    return Object.keys(all).map(k => all[k]).filter(t => t && !t.deleted && String(t.counter || '').trim() === c && t.status === 'open');
  },

  // 从云端 settings 通道拉取他人分派的任务并合并到本地
  // 合并而非覆盖：本地已有的任务以 updatedAt 较新者胜，避免回退刚改的状态（审查 #6 同款风险）
  // 🟢 v225.2：remote 的墓碑会覆盖本地活任务（管理员取消分派 → 盘点人设备同步撤销）；
  //   反向 remote 有更新的活任务时本地墓碑被清（取消后重新分派同一区间 → 正常复活）。
  async pullStocktakeTasksFromCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return 0;
    if (typeof SyncManager.getSetting !== 'function') return 0;
    let remote = null;
    try { remote = await SyncManager.getSetting('stocktakeTasks'); } catch (e) { return 0; }
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return 0;
    const all = this._tasksRaw();
    let changed = 0;
    const ts = (x) => { const d = Date.parse(x && x.updatedAt); return isNaN(d) ? 0 : d; };
    Object.keys(remote).forEach(id => {
      const r = remote[id];
      if (!r || typeof r !== 'object' || !r.taskId || id !== r.taskId) return;
      const old = all[id];
      if (!old) { all[id] = r; changed++; return; }
      if (ts(r) > ts(old)) {
        const merged = Object.assign({}, old, r);
        // remote 未带 deleted 字段 = 活任务 → 清掉本地墓碑，允许重新分派后复活
        if (!('deleted' in r)) delete merged.deleted;
        all[id] = merged; changed++;
      }
    });
    if (changed) this._lsSet('wb_stocktake_tasks', all);
    this._gcTaskTombstones();
    return changed;
  },
  // 墓碑 GC：30 天前的删除标记物理清除，避免 localStorage 无限膨胀
  _gcTaskTombstones() {
    try {
      const all = this._tasksRaw();
      const now = Date.now(), TTL = 30 * 86400000;
      let changed = false;
      Object.keys(all).forEach(id => {
        const t = all[id];
        if (!t || !t.deleted) return;
        const d = Date.parse(t.updatedAt);
        if (isNaN(d) || (now - d > TTL)) { delete all[id]; changed = true; }
      });
      if (changed) this._lsSet('wb_stocktake_tasks', all);
    } catch (e) {}
  },

  // —— 批次汇总快照 ——
  getStocktakeBatches() { return this._lsGet('wb_stocktake_batches', {}); },
  getStocktakeBatch(sheetId) { return this.getStocktakeBatches()[sheetId] || null; },
  addStocktakeBatch(batch) {
    const all = this.getStocktakeBatches();
    all[batch.sheetId] = batch;
    this._lsSet('wb_stocktake_batches', all);
    return batch;
  },

  // v218：放弃盘点 —— 删除某批次的汇总快照（该批次已无其他盘点人记录时调用）
  deleteStocktakeBatch(sheetId) {
    const all = this.getStocktakeBatches();
    delete all[sheetId];
    this._lsSet('wb_stocktake_batches', all);
  },

  // —— 按批次查记录（供汇总聚合，不动 12 列字段）=====
  async getStocktakeRecordsBySheet(sheetId) {
    const rows = await this.getStocktakeRecords();
    return (rows || []).filter(r => r.sheetId === sheetId);
  }
};
