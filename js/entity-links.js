// ============================================
// 实体档案跳转映射（EntityLinks）—— 完整实现
// tables：实体 → { 表名: 关联字段 }，仅列出 db.js schema 中已建立索引的字段
//         （queryByEntity 会跳过未建索引的键，避免 Dexie 抛错；order 关联入库
//          因 表体订单号/来源订单号 无索引，改由 OrderDetailModule 全扫描处理）
// ============================================================

window.EntityLinks = {
  stock: {
    detailModule: 'stock-detail',
    keyField: '存货编码',
    tables: {
      stock: '存货编码',
      inbound: '存货编码',
      // 注意：订单表持久化字段为「存货编号」而非「存货编码」，且需按名称+规格兜底，
      // 故不在此扇出（queryByEntity 按 存货编码 查订单必为空）；
      // stock-detail 改用 DataStore.getOrdersForStock() 做反向联动。
      inventoryAlerts: '存货编码',
      pricing: '存货编码',
      lowTurnover: '存货编码'
    }
  },
  supplier: {
    detailModule: 'supplier-detail',
    keyField: '供应商',
    tables: {
      suppliers: '供应商',
      orders: '供应商',
      inbound: '供应商',
      pricing: '供应商',
      breach: '公司名称' // 注意：breach 按 公司名称 关联，queryByEntity 内已做软匹配兜底
    }
  },
  order: {
    detailModule: 'order-detail',
    keyField: '订单编号',
    tables: {
      orders: '订单编号'
    }
  },
  labelOf(type, obj) {
    const def = this[type];
    if (!def) return '';
    const v = obj && obj[def.keyField];
    return v != null ? String(v) : '';
  }
};
