// ============================================
// IndexedDB 数据层 - 使用 Dexie.js
// ============================================

const DB_NAME = 'WarehouseWorkbench';
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
    if (this._tableCache[table]) return this._tableCache[table];
    const rows = await db[table].toArray();
    this._tableCache[table] = rows;
    return rows;
  },
  invalidate(table) { if (this._tableCache) delete this._tableCache[table]; },
  invalidateAll() { this._tableCache = {}; },

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
  async clearAll() {
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
    this.invalidateAll();
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
  // 启动恢复：用云端设置里的出库列表覆盖本地（若有且更新）
  async restoreOutboundFromSettings() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const rows = await SyncManager.getSetting('outbound_list');
      if (Array.isArray(rows) && rows.length) {
        await db.outbound.clear();
        await db.outbound.bulkPut(rows);
        console.log(`[设置] 已从云端恢复出库列表 ${rows.length} 条`);
        return true;
      }
    } catch (e) { console.warn('出库恢复失败:', e); }
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
  async getSuppliers(filter = {}) {
    let query = db.suppliers.toCollection();
    if (filter.类型) query = query.filter(s => s.类型 === filter.类型);
    if (filter.招采部门) query = query.filter(s => s.招采部门 === filter.招采部门);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(s => (s.供应商 && s.供应商.toLowerCase().includes(kw)) ||
                                 (s.类型 && s.类型.toLowerCase().includes(kw)));
    }
    return query.toArray();
  },

  async getSupplierTypes() {
    const all = await this.getRows('suppliers');
    return [...new Set(all.map(s => s.类型).filter(Boolean))];
  },

  async getSupplierDepartments() {
    const all = await this.getRows('suppliers');    return [...new Set(all.map(s => s.招采部门).filter(Boolean))];
  },

  // ===== 订单列表 =====
  async getOrders(filter = {}, page = 1, pageSize = 50) {
    let query = db.orders.toCollection();
    if (filter.供应商) query = query.filter(o => o.供应商 === filter.供应商);
    if (filter.项目名称) query = query.filter(o => o.项目名称 === filter.项目名称);
    if (filter.审批状态) query = query.filter(o => o.审批状态 === filter.审批状态);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(o => (o.订单编号 && String(o.订单编号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                                 (o.供应商 && o.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                                 (o.存货名称 && o.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                                 (o.项目名称 && o.项目名称.replace(/\s+/g, '').toLowerCase().includes(kw)));
    }
    if (filter.startDate || filter.endDate) {
      query = query.filter(o => {
        if (!o.日期) return false;
        if (filter.startDate && o.日期 < filter.startDate) return false;
        if (filter.endDate && o.日期 > filter.endDate) return false;
        return true;
      });
    }
    const total = await query.count();
    if (pageSize === 'all') {
      const items = await query.toArray();
      return { items, total, page: 1, pageSize: 'all', totalPages: 1 };
    }
    const items = await query.offset((page - 1) * pageSize).limit(pageSize).toArray();
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
  async getInbound(filter = {}, page = 1, pageSize = 50) {
    let query = db.inbound.toCollection();
    if (filter.供应商) query = query.filter(i => i.供应商 === filter.供应商);
    if (filter.项目名称) query = query.filter(i => i.项目名称 === filter.项目名称);
    if (filter.仓库) query = query.filter(i => i.仓库 === filter.仓库);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(i => (i.入库单号 && String(i.入库单号).replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                                 (i.供应商 && i.供应商.replace(/\s+/g, '').toLowerCase().includes(kw)) ||
                                 (i.存货名称 && i.存货名称.replace(/\s+/g, '').toLowerCase().includes(kw)));
    }
    if (filter.startDate || filter.endDate) {
      query = query.filter(i => {
        if (!i.入库日期) return false;
        if (filter.startDate && i.入库日期 < filter.startDate) return false;
        if (filter.endDate && i.入库日期 > filter.endDate) return false;
        return true;
      });
    }
    const total = await query.count();
    if (pageSize === 'all') {
      const items = await query.toArray();
      return { items, total, page: 1, pageSize: 'all', totalPages: 1 };
    }
    const items = await query.offset((page - 1) * pageSize).limit(pageSize).toArray();
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  },

  // ===== 现存量 =====
  async getStock(filter = {}) {
    let query = db.stock.toCollection();
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(s => (s.存货编码 && s.存货编码.toLowerCase().includes(kw)) ||
                                 (s.存货名称 && s.存货名称.toLowerCase().includes(kw)) ||
                                 (s.规格型号 && s.规格型号.toLowerCase().includes(kw)));
    }
    return query.toArray();
  },

  // ===== 库存预警 =====
  async getInventoryAlerts(filter = {}) {
    let query = db.inventoryAlerts.toCollection();
    if (filter.补货值 !== undefined) {
      query = query.filter(a => (filter.补货值 ? (a.补货值 && a.补货值 > 0) : (!a.补货值 || a.补货值 <= 0)));
    }
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(a => (a.存货名称 && a.存货名称.toLowerCase().includes(kw)) ||
                                 (a.存货编码 && a.存货编码.toLowerCase().includes(kw)));
    }
    return query.toArray();
  },

  async getAlertStats() {
    const all = await this.getRows('inventoryAlerts');
    const needRestock = all.filter(a => a.补货值 && a.补货值 > 0).length;
    const total = all.length;
    return { needRestock, total };
  },

  // ===== 订货核对 =====
  async getOrderChecks(filter = {}) {
    let query = db.orderChecks.toCollection();
    if (filter.分类) query = query.filter(o => o.分类 === filter.分类);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(o => (o.存货名称 && o.存货名称.toLowerCase().includes(kw)));
    }
    return query.toArray();
  },

  // ===== 合同价格 =====
  async getPricing(filter = {}) {
    let query = db.pricing.toCollection();
    if (filter.供应商) query = query.filter(p => p.供应商 === filter.供应商);
    if (filter.类型) query = query.filter(p => p.类型 === filter.类型);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(p => (p.存货名称 && p.存货名称.toLowerCase().includes(kw)) ||
                                 (p.供应商 && p.供应商.toLowerCase().includes(kw)));
    }
    return query.toArray();
  },

  async getPricingTypes() {
    const all = await this.getRows('pricing');
    return [...new Set(all.map(p => p.类型).filter(Boolean))];
  },

  // ===== 低周转 =====
  async getLowTurnover(filter = {}) {
    let query = db.lowTurnover.toCollection();
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(l => (l.存货名称 && l.存货名称.toLowerCase().includes(kw)));
    }
    return query.toArray();
  },

  // ===== 违约台账 =====
  async getBreachRecords(filter = {}) {
    let query = db.breach.toCollection();
    if (filter.公司名称) query = query.filter(b => b.公司名称 === filter.公司名称);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(b => (b.公司名称 && b.公司名称.toLowerCase().includes(kw)));
    }
    return query.toArray();
  },

  // ===== 出库管理 =====
  async getOutbound(filter = {}, page = 1, pageSize = 20) {
    let query = db.outbound.toCollection();
    if (filter.出库单号) query = query.filter(o => o.出库单号 === filter.出库单号);
    if (filter.项目名称) query = query.filter(o => o.项目名称 === filter.项目名称);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(o => (o.出库单号 && o.出库单号.toLowerCase().includes(kw)) ||
                                 (o.存货编码 && o.存货编码.toLowerCase().includes(kw)) ||
                                 (o.存货名称 && o.存货名称.toLowerCase().includes(kw)) ||
                                 (o.领用人员 && o.领用人员.toLowerCase().includes(kw)));
    }
    if (filter.startDate || filter.endDate) {
      query = query.filter(o => {
        if (!o.出库时间) return false;
        if (filter.startDate && o.出库时间 < filter.startDate) return false;
        if (filter.endDate && o.出库时间 > filter.endDate) return false;
        return true;
      });
    }
    const total = await query.count();
    if (pageSize === 'all') {
      const items = await query.toArray();
      return { items, total, page: 1, pageSize: 'all', totalPages: 1 };
    }
    const items = await query.offset((page - 1) * pageSize).limit(pageSize).toArray();
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
    } catch(e) { /* ignore */ }

    const needRestock = alerts.filter(a => a.补货值 && a.补货值 > 0);
    const needRestockCount = needRestock.length;
    const needRestockQty = needRestock.reduce((sum, a) => sum + (parseFloat(a.在途订单) || 0), 0);

    const ordersAll = await this.getRows('orders');
    const totalOrderAmount = ordersAll.reduce((sum, o) => sum + (parseFloat(o.原币价税合计) || 0), 0);

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
    const yearInboundAmount = (await this.getRows('inbound'))
      .filter(i => i.入库日期 && new Date(i.入库日期).getFullYear() === y)
      .reduce((sum, i) => sum + (parseFloat(i.原币价税合计) || 0), 0);

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
      }).toArray();
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
          }).toArray();
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
  }
};
