// ============================================
// IndexedDB 数据层 - 使用 Dexie.js
// ============================================

const DB_NAME = 'WarehouseWorkbench';
const DB_VERSION = 5;  // v5: 日期时区修复——旧数据日期少一天，强制重建库重新导入

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
    if (oldDB && typeof oldDB.version === 'number' && oldDB.version > 0 && oldDB.version < DB_VERSION) {
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
db.version(DB_VERSION).stores({
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
  // 材料分类
  materialClass: '++id, 存货编码',
  // 统计数据（月度汇总）
  monthlyStats: '++id, 年份, 月份',
  // 应用元数据
  meta: 'key'
});

// 不在定义时自动打开——由 App.init() 中 cleanOldDB() 之后手动调用 db.open()
// 这样可以确保旧版本数据库先被清理

// ============================================
// 通用数据操作接口
// ============================================

const DataStore = {
  // 检查是否已导入数据
  async isDataImported() {
    const meta = await db.meta.get('dataImported');
    return meta && meta.value === true;
  },

  // 标记数据已导入
  async markDataImported() {
    await db.meta.put({ key: 'dataImported', value: true, time: new Date().toISOString() });
  },

  // 获取导入时间
  async getImportTime() {
    const meta = await db.meta.get('dataImported');
    return meta ? meta.time : null;
  },

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
    await db.materialClass.clear();
    await db.monthlyStats.clear();
    await db.meta.delete('dataImported');
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
    const all = await db.suppliers.toArray();
    return [...new Set(all.map(s => s.类型).filter(Boolean))];
  },

  async getSupplierDepartments() {
    const all = await db.suppliers.toArray();
    return [...new Set(all.map(s => s.招采部门).filter(Boolean))];
  },

  // ===== 订单列表 =====
  async getOrders(filter = {}, page = 1, pageSize = 50) {
    let query = db.orders.toCollection();
    if (filter.供应商) query = query.filter(o => o.供应商 === filter.供应商);
    if (filter.项目名称) query = query.filter(o => o.项目名称 === filter.项目名称);
    if (filter.审批状态) query = query.filter(o => o.审批状态 === filter.审批状态);
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase();
      query = query.filter(o => (o.订单编号 && o.订单编号.toLowerCase().includes(kw)) ||
                                 (o.供应商 && o.供应商.toLowerCase().includes(kw)) ||
                                 (o.存货名称 && o.存货名称.toLowerCase().includes(kw)) ||
                                 (o.项目名称 && o.项目名称.toLowerCase().includes(kw)));
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
    const items = await query.offset((page - 1) * pageSize).limit(pageSize).toArray();
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  },

  async getOrderSuppliers() {
    const all = await db.orders.toArray();
    return [...new Set(all.map(o => o.供应商).filter(Boolean))];
  },

  async getOrderProjects() {
    const all = await db.orders.toArray();
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
      query = query.filter(i => (i.入库单号 && i.入库单号.toLowerCase().includes(kw)) ||
                                 (i.供应商 && i.供应商.toLowerCase().includes(kw)) ||
                                 (i.存货名称 && i.存货名称.toLowerCase().includes(kw)));
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
    const all = await db.inventoryAlerts.toArray();
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
    const all = await db.pricing.toArray();
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
    const items = await query.offset((page - 1) * pageSize).limit(pageSize).toArray();
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  },

  async getOutboundProjects() {
    const all = await db.outbound.toArray();
    return [...new Set(all.map(o => o.项目名称).filter(Boolean))];
  },

  // ===== 仪表盘统计 =====
  async getDashboardStats() {
    const [suppliers, orders, inbound, stock, alerts, lowTurnover] = await Promise.all([
      db.suppliers.count(),
      db.orders.count(),
      db.inbound.count(),
      db.stock.count(),
      db.inventoryAlerts.toArray(),
      db.lowTurnover.count()
    ]);

    // 补货值统一处理在现存量交叉补全之后进行（见下方）

    // 从 stock 表交叉获取真实现存量（与 inventory-alert 模块保持一致）
    try {
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

    const ordersAll = await db.orders.toArray();
    const totalOrderAmount = ordersAll.reduce((sum, o) => sum + (parseFloat(o.原币价税合计) || 0), 0);

    const pendingInbound = ordersAll.filter(o => parseFloat(o.未入库量) > 0).length;

    // 合同到期预警（30天内）
    const now = new Date();
    const contractWarnings = await db.suppliers.toArray().then(arr =>
      arr.filter(s => {
        if (!s.年度合同到期时间) return false;
        const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
        return days <= 30 && days >= 0;
      }).length
    );

    return {
      supplierCount: suppliers,
      orderCount: orders,
      inboundCount: inbound,
      stockCount: stock,
      needRestockCount,
      needRestockQty: Math.round(needRestockQty * 100) / 100,
      contractWarnings,
      totalOrderAmount: Math.round(totalOrderAmount * 100) / 100,
      pendingInbound,
      lowTurnoverCount: lowTurnover
    };
  },

  // ===== 全局搜索 =====
  async globalSearch(keyword) {
    if (!keyword || keyword.trim().length < 1) return { suppliers: [], orders: [], inbound: [], stock: [] };
    const kw = keyword.trim().toLowerCase();

    const [suppliers, orders, inbound, stock] = await Promise.all([
      db.suppliers.filter(s => (s.供应商 && s.供应商.toLowerCase().includes(kw)) ||
                               (s.类型 && s.类型.toLowerCase().includes(kw))).limit(10).toArray(),
      db.orders.filter(o => (o.订单编号 && o.订单编号.toLowerCase().includes(kw)) ||
                            (o.供应商 && o.供应商.toLowerCase().includes(kw)) ||
                            (o.存货名称 && o.存货名称.toLowerCase().includes(kw))).limit(10).toArray(),
      db.inbound.filter(i => (i.入库单号 && i.入库单号.toLowerCase().includes(kw)) ||
                             (i.供应商 && i.供应商.toLowerCase().includes(kw)) ||
                             (i.存货名称 && i.存货名称.toLowerCase().includes(kw))).limit(10).toArray(),
      db.stock.filter(s => (s.存货编码 && s.存货编码.toLowerCase().includes(kw)) ||
                           (s.存货名称 && s.存货名称.toLowerCase().includes(kw))).limit(10).toArray()
    ]);

    return { suppliers, orders, inbound, stock };
  }
};
