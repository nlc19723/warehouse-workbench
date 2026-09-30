// ============================================
// 库存预警派生规则引擎 v229.00
// 全部列值按规则运行时派生，不读导入的分类/月均/补货值列：
//   ① 分类快照：入库列表 inbound 聚合（窗口截止=数据内最新入库日，导入刷新即重算）
//   ② 在途拆分：订单列表 orders（未入库量>0 且非行关闭行；无项目名称→仓库 / 有→项目）
//   ③ 补货值：中库存±触发带（STOCK_LEVELS 常量水位）+ 箱/根取整
//   ④ 状态：带下方→急；带内→需补货；其余/最高≤0→正常
// 依赖：window.StockAlertConfig（js/stock-alert-config.js）
// ============================================

const StockAlertRules = {

  _snapCache: null,   // 分类快照缓存：{ key, snap: Map(code -> {cat, K}) }

  /** 分类快照：从入库列表聚合派生（v229.00）
   *  E=窗口内表体订单号去重数 F=数量合计 G=金额合计；H=E/12 J=G/E K=F/12 L=G/12
   *  窗口 = (最新入库日-365天, 最新入库日]；导入新数据后自动重算（等价季度快照） */
  computeClassificationSnapshot(inboundRows) {
    const cfg = window.StockAlertConfig.CLASSIFY;
    // 找最新入库日期（字符串 YYYY-MM-DD 可直接比较）
    let maxDate = '';
    for (let i = 0; i < inboundRows.length; i++) {
      const d = String(inboundRows[i].入库日期 || '');
      if (d > maxDate) maxDate = d;
    }
    const key = inboundRows.length + '|' + maxDate;
    if (this._snapCache && this._snapCache.key === key) return this._snapCache.snap;

    const snap = new Map();
    if (!maxDate) { this._snapCache = { key, snap }; return snap; }
    // 窗口起点：截止日 - 365 天
    const cut = new Date(maxDate + 'T00:00:00');
    const start = new Date(cut.getTime() - 365 * 86400000);
    const startStr = start.toISOString().slice(0, 10);

    const agg = new Map();  // code -> {orders:Set, qty, amt}
    for (let i = 0; i < inboundRows.length; i++) {
      const r = inboundRows[i];
      const d = String(r.入库日期 || '');
      if (d <= startStr || d > maxDate) continue;
      const code = String(r.存货编码 || '').trim();
      if (!code) continue;
      let a = agg.get(code);
      if (!a) { a = { orders: new Set(), qty: 0, amt: 0 }; agg.set(code, a); }
      if (r.表体订单号) a.orders.add(String(r.表体订单号).trim());
      a.qty += parseFloat(r.数量) || 0;
      a.amt += parseFloat(r.原币价税合计) || 0;
    }

    agg.forEach((a, code) => {
      const E = a.orders.size;
      const cat = this.classify(E, a.qty, a.amt, cfg);
      snap.set(code, { cat: cat, K: E > 0 ? this.round2(a.qty / 12) : 0 });
    });
    this._snapCache = { key: key, snap: snap };
    return snap;
  },

  /** 修订版分类判定（v229.00：工程类只判金额、B 类无金额上限、新增 D 类） */
  classify(E, F, G, cfg) {
    if (E <= 0) return '未使用类';
    const H = E / 12, J = G / E, K = F / 12, L = G / 12;
    if (J > cfg.ENG_AMT) return H > 1 ? 'A工程类' : 'C工程类';
    if ((H >= cfg.A_H && K >= cfg.A_K) || (H > cfg.A2_H && K > cfg.A2_K && L > cfg.A2_L)) return 'A';
    if (H >= cfg.B_H) return 'B';
    if (H < cfg.D_H) return 'D';
    return 'C';
  },

  round2(x) { return Math.round(x * 100) / 100; },

  /** 触发带：返回 {T, w}；最高库存≤0 或跨度<0 时返回 null（不自动补） */
  band(minS, maxS) {
    const P = window.StockAlertConfig.RULE_PARAMS;
    if (!(maxS > 0)) return null;
    const S = Math.max(0, maxS - minS);
    const M = (minS + maxS) / 2;
    const d = Math.min(P.R * S, P.C * M);
    return { T: M - d, w: Math.max(P.Q * S, 0.05 * maxS) };
  },

  /** 按名称关键字查管材根长 */
  pipeLength(name) {
    const map = window.StockAlertConfig.PIPE_LENGTH;
    for (const kw in map) { if (name && name.indexOf(kw) !== -1) return map[kw]; }
    return 0;
  },

  /** 补货值 + 状态（v229.00）
   *  返回 { value:number(折合基础量), status:'急'|'需补货'|'正常' }
   *  取整优先级：螺栓整箱 > 管材整根 > 原值；镀锌管不入 PIPE_LENGTH → 原值 */
  computeRestock(code, name, minS, maxS, onhand) {
    const bd = this.band(minS, maxS);
    if (!bd) return { value: 0, status: '正常' };
    if (onhand > bd.T + bd.w) return { value: 0, status: '正常' };
    const need = Math.max(0, maxS - onhand);
    let value = need;
    const box = window.StockAlertConfig.BOX_PACK[String(code).trim()];
    if (box > 0) {
      value = Math.ceil(need / box) * box;
    } else {
      const len = this.pipeLength(name);
      if (len > 0) value = Math.ceil(need / len) * len;
    }
    return { value: this.round2(value), status: (onhand < bd.T - bd.w) ? '急' : '需补货' };
  },

  /** 在途拆分（v229.00）：口径与订单跟踪一致——未入库量>0 且排除行关闭行
   *  返回 Map(code -> {all, wh, proj})：all=全部未入库量；wh=无项目名称；proj=有项目名称 */
  computeOrdersSplit(orderRows) {
    const map = new Map();
    for (let i = 0; i < orderRows.length; i++) {
      const o = orderRows[i];
      const qty = parseFloat(o.未入库量) || 0;
      if (!(qty > 0)) continue;
      if (o.行关闭人 && String(o.行关闭人).trim()) continue;
      const code = String(o.存货编号 || o.存货编码 || '').trim();
      if (!code) continue;
      let m = map.get(code);
      if (!m) { m = { all: 0, wh: 0, proj: 0 }; map.set(code, m); }
      m.all += qty;
      if (o.项目名称 && String(o.项目名称).trim()) m.proj += qty; else m.wh += qty;
    }
    return map;
  }
};

window.StockAlertRules = StockAlertRules;
