/**
 * 🟢 v229.77：盘点差异「参谋」引擎 —— 纯函数、零 DOM 依赖，可单测。
 *
 * 职责：给定一批已定稿的差异行 + 库存派生快照，为每一笔输出
 *       { diff, tips:[{t,a}], acts:[[label,id]] } 的专业核查建议。
 *
 * 设计纪律：
 *   ① 只谈「差异本身」——补货、在途、水位等与盘点差异无关的信息一律不产出（用户明确要求）。
 *   ② 互串预警只在【存货名称相同 + 规格邻近 + 差异方向相反】时给出，绝不跨名称误报。
 *   ③ 分类核查力度由【分类 × 月均入库分级】共同决定，不是套模板。
 *   ④ 所有结论必须能追溯到传入数据，不臆造存货、不举假例子。
 *
 * window.StocktakeAdvisor
 *   .advise(items, idx, alertMap)  → { diff, tips, acts }
 *   .priority(item)                → 'P1' | 'P2' | 'P3'
 *   .kTier(k)                      → 'high' | 'mid' | 'low'
 */
(function (global) {
  'use strict';

  /* ── 数值工具 ── */
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const fmt = n => {
    const v = parseFloat(n);
    if (!Number.isFinite(v)) return '0';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  };

  /* ── 规格型号解析：「63*45」→ [63,45]；「40」→ [40] ── */
  function dims(spec) {
    return String(spec || '').match(/\d+(\.\d+)?/g)?.map(Number).filter(n => n > 0) || [];
  }

  /* 标准管径档位：用于判定「邻近规格」（63*45 ↔ 63*32 / 50*90 ↔ 63*90） */
  const STEPS = [15, 20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400];
  function near(a, b) {
    if (a === b) return true;
    const ia = STEPS.indexOf(a), ib = STEPS.indexOf(b);
    if (ia >= 0 && ib >= 0) return Math.abs(ia - ib) === 1;         // 标准档位相邻
    if (ia >= 0 || ib >= 0) return false;                            // 标准 ↔ 非标：不认邻近
    const rel = Math.abs(a - b) / Math.max(a, b);
    return rel <= 0.06;                                              // 非标：相对差 ≤6%（40↔45 为 11%，不算）
  }

  /**
   * 同名 + 邻近规格的兄弟项（用户明确约束：必须存货名称相同）。
   * 单↔单：数值相同或档位相邻；单↔双：仅认完全相同的规格数字；双↔双：同左邻近右 或 同右邻近左。
   */
  function specSiblings(items, it) {
    const A = dims(it.spec);
    const same = items.filter(o => o !== it && o.name === it.name);  // ← 同名约束（用户明确要求）
    if (!A.length) return [];
    const main = x => dims(x.spec)[0] || 0;

    /* ① 业务邻近：同名存货按主尺寸排序后**序位相邻**者 —— 衬管只有 65/80 两个规格时它们就是邻近，
          比绝对数值比例更贴合实际（65 与 80 数值差 19%，但确实是相邻规格）。 */
    const sorted = [it].concat(same).sort((x, y) => main(x) - main(y));   // 含自身，否则定位不到
    const idx = sorted.findIndex(o => o === it);
    const neigh = [];
    if (idx >= 0) {
      if (sorted[idx - 1]) neigh.push(sorted[idx - 1]);
      if (sorted[idx + 1]) neigh.push(sorted[idx + 1]);
    }
    /* ② 规格邻近：完全相同的规格数字 / 标准档位相邻（63*45 ↔ 63*32） */
    const extra = same.filter(o => {
      const B = dims(o.spec);
      if (!B.length) return false;
      if (A.length === 1 && B.length === 1) return A[0] === B[0] || near(A[0], B[0]);
      if (A.length === 1 || B.length === 1) return A.some(x => B.some(y => y === x));
      return (A[0] === B[0] && near(A[1], B[1])) || (A[1] === B[1] && near(A[0], B[0]));
    });
    return Array.from(new Set(neigh.concat(extra)));
  }

  /* ── 月均入库分级（高频≥100 / 中频20-100 / 低频<20） ── */
  function kTier(k) { return k >= 100 ? 'high' : k >= 20 ? 'mid' : 'low'; }
  const TIER_TXT = { high: '高频周转', mid: '中频周转', low: '低频周转' };

  /* ── 分类核查力度（真实枚举：A工程类/A/B/C/C工程类/D/未使用类） ── */
  const CLS_LABEL = {
    'A工程类': 'A工程类', 'A': 'A类', 'B': 'B类', 'C': 'C类', 'C工程类': 'C工程类', 'D': 'D类', '未使用类': '未使用类'
  };

  /**
   * 建议主入口
   * @param {Array} items  差异行（含 name/spec/cls/type/k/book/real）
   * @param {number} idx   当前行下标
   * @param {Map} alertMap 可选：存货编码 → 库存派生快照（提供时覆盖 cls/k/type）
   */
  function advise(items, idx, alertMap) {
    const it = items[idx] || {};
    const base = (alertMap && alertMap.get(it.code)) || null;
    const cls = (base && base.分类) || it.cls || '未使用类';
    const k = num((base && base['近一年月均入库量']) != null ? base['近一年月均入库量'] : it.k);
    const type = (base && base.类型) || it.type || '';
    const book = num(it.book), real = num(it.real);
    const diff = Math.round((real - book) * 100) / 100;
    const ctx = Object.assign({}, it, { cls, k, type, book, real });

    const tips = [], acts = [];

    /* ① 连续盘亏 —— 强信号，最优先 */
    if (/累计盘亏|连续两期|连续盘亏/.test(String(it.note || '')))
      tips.push({ t: '该物料处于<b>连续盘亏</b>状态，建议本期做库位复盘并在备注留痕', a: 1 });

    /* ② 同名 + 邻近规格 + 方向相反 → 点破疑似互串（引用真实存货，不举假例子） */
    /* 注意用 items[idx] 原对象（而非 ctx 副本）—— 邻近判定依赖对象身份排序 */
    const sib = specSiblings(items, items[idx]);
    if (sib.length) {
      const opp = sib.find(o => (num(o.real) - num(o.book)) * diff < 0);
      if (opp && diff !== 0) {
        const od = Math.round((num(opp.real) - num(opp.book)) * 100) / 100;
        tips.push({
          t: '同为「<b>' + it.name + '</b>」且规格邻近的「<b>' + opp.spec + '</b>」本期为' +
             (od > 0 ? '盘盈' : '盘亏') + ' <b>' + fmt(Math.abs(od)) + '</b>，与本笔' +
             (diff < 0 ? '盘亏' : '盘盈') + '方向相反，高度疑似<b>两笔互串</b>，建议同库位对点实物',
          a: 1
        });
        acts.push(['核对实物规格', 'spec']);
      } else if (diff !== 0) {
        tips.push({
          t: '邻近规格有 ' + sib.slice(0, 2).map(o => '「' + o.name + ' ' + o.spec + '」').join('、') +
             '，收发时易<b>串号错记</b>，先核对实物规格与账面是否一致'
        });
      }
    }

    /* ③ 差异成因推断（多元，按数据特征触发） */
    if (diff === 0) {
      tips.push({ t: '账实相符，可直接通过' });
    } else if (diff > 0) {
      if (book === 0) {
        tips.push({ t: '账面为零但实物有货，优先查是否<b>入库漏账</b>（新到货未上账 / 退库未销）' });
        acts.push(['查入库流水', 'inbound']);
      } else {
        tips.push({ t: '盘盈 <b>' + fmt(diff) + '</b>，重点查是否<b>入库漏账或退库未销</b>' });
        acts.push(['查入库流水', 'inbound']);
      }
    } else {
      const hasDecimal = Math.abs(book) % 1 > 0 || Math.abs(real) % 1 > 0;
      if (hasDecimal) {
        tips.push({ t: '账面或实盘带小数，先确认是否<b>计量尾差</b>（按米/公斤折算的取整口径不一致）' });
        acts.push(['核对计量口径', 'unit']);
      } else if (kTier(k) === 'high') {
        tips.push({ t: '该物料月均入库 <b>' + fmt(k) + '</b> 属高频周转，差异更可能是<b>记账时点差</b>（单据跨期未同步），核对近 7 天单据即可定论' });
        acts.push(['查近7天出入库', 'ledger']);
      } else if (kTier(k) === 'low') {
        tips.push({ t: '低频物资，差异多为<b>报废/损耗未走单</b>或上期盘点遗漏，查报废单与调拨单' });
        acts.push(['查调拨/报废单', 'scrap']);
      } else {
        tips.push({ t: '中频周转件，建议抽查库位后核对<b>本月领用单</b>锁定差异来源' });
        acts.push(['查本月领用单', 'issue']);
      }
    }

    /* ④ 分类 × 频次 → 核查力度 */
    if (cls === 'A工程类' || cls === 'A') {
      tips.push({ t: '<b>' + (CLS_LABEL[cls] || cls) + '</b>工程关键物资（' + TIER_TXT[kTier(k)] + '，月均入库 ' + fmt(k) + '），建议逐笔核对近 30 天出入库流水后再确认' });
      acts.push(['查出入库流水', 'ledger']);
    } else if (cls === 'B') {
      tips.push({ t: '<b>B类</b>常规重点物资（' + TIER_TXT[kTier(k)] + '），核对本月领用单即可锁定差异来源' });
      acts.push(['查本月领用单', 'issue']);
    } else if (cls === 'C' || cls === 'C工程类') {
      tips.push({ t: '<b>' + (CLS_LABEL[cls] || cls) + '</b>低值周转件，抽查复核该库位后可快速确认，不必逐笔追单' });
    } else if (cls === 'D' || cls === '未使用类') {
      tips.push({ t: '<b>' + (CLS_LABEL[cls] || cls) + '</b>低频/呆滞物资，差异影响小，可直接确认' });
    }

    /* ⑤ 类型 → 计量口径（钢管双单位是高频错因） */
    if (type === '钢管') {
      tips.push({ t: '钢管存在「根 / 米」双单位口径，确认本次实盘与账面使用的是<b>同一口径</b>' });
      acts.push(['核对计量口径', 'unit']);
    }

    /* ⑥ 差异量 ↔ 消耗节奏换算（专业量化，不做幼稚类比） */
    if (diff < 0 && k > 0) {
      const days = Math.round(-diff / (k / 30));
      if (days >= 1)
        tips.push({ t: '盘亏 <b>' + fmt(-diff) + '</b> ≈ <b>' + days + ' 天</b>的正常消耗量，' +
                       (days <= 3 ? '量级在正常损耗区间，可放心核对' : '量级偏大，建议升级复核') });
    }

    /* 去重 + 控量：建议最多 4 条，动作最多 3 个 */
    const uniq = [], seenTxt = new Set();
    tips.forEach(t => { if (!seenTxt.has(t.t)) { seenTxt.add(t.t); uniq.push(t); } });
    const seenAct = new Set();
    const uacts = acts.filter(a => !seenAct.has(a[1]) && seenAct.add(a[1])).slice(0, 3);

    return { diff, tips: uniq.slice(0, 4).sort((a, b) => (b.a || 0) - (a.a || 0)), acts: uacts };
  }

  /* 优先级：分类权重 × 差异占比 */
  function priority(it) {
    const diff = Math.abs(num(it.real) - num(it.book));
    let s = ({ 'A工程类': 34, 'A': 30, 'B': 24, 'C工程类': 20, 'C': 16, 'D': 8, '未使用类': 6 })[it.cls] || 10;
    const book = Math.abs(num(it.book));
    if (book > 0) s += Math.min(24, (diff / book) * 45);
    else if (diff > 0) s += 18;
    return s >= 46 ? 'P1' : s >= 32 ? 'P2' : 'P3';
  }

  global.StocktakeAdvisor = { advise, priority, kTier, dims, near, specSiblings, fmt, TIER_TXT, CLS_LABEL };
})(typeof window !== 'undefined' ? window : this);
