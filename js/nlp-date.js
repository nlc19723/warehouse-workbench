/* ============================================================
 * nlp-date.js  🟢 v229.75
 * 中文自然语言日期 / 时间解析（纯函数，零依赖，无 DOM）
 *
 * 对外：window.NLPDate.parse(text, nowDate) →
 *   { date, allDay, matched:[{text,type,start,end}], rest, confidence }
 *   NLPDate.label(res) → "10月15日 周四 10:30"
 *
 * 设计要点：
 *  1. 识别与「标题剥离」共用同一份 matched 区间（单一事实源），
 *     杜绝「识别对了但标题漏字 / 残留『下』」这类旧 bug。
 *  2. 多阶段按优先级消费，互不重叠：绝对日期 > 年月 > 月日 > 周 >
 *     相对日 > 周后/月后 > 日历词(月底…) > 时间。
 *  3. 裸「周X」保持既有语义（滚动 7 天：今天的周X=今天，已过的取下一轮）。
 *  4. 时段词（下午/晚上…）做 12h→24h 转换；中文数字补到「二十三」。
 * ============================================================ */
(function (global) {
  'use strict';

  // ---------- 基础日期工具 ----------
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function addMonths(d, n) {
    const y = d.getFullYear(), m = d.getMonth() + n, day = d.getDate();
    const last = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(day, last));
  }
  // 本周一（周一为一周起点，getDay: 日0…六6）
  function mondayOf(d) { return addDays(startOfDay(d), -((d.getDay() + 6) % 7)); }

  // ---------- 中文数字 ----------
  const CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  const WEEK_CHAR = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 };

  // 小时：支持阿拉伯 0-23 + 中文 一~二十三
  function cnHour(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (/^\d{1,2}$/.test(s)) { const n = +s; return n <= 23 ? n : null; }
    if (s === '十') return 10;
    if (s.length === 2 && s[0] === '十') { const u = CN_DIGIT[s[1]]; return u === undefined ? null : 10 + u; }
    if (s === '二十') return 20;
    if (s.length === 3 && s[0] === '二' && s[1] === '十') { const u = CN_DIGIT[s[2]]; return u === undefined ? null : 20 + u; }
    const d = CN_DIGIT[s]; return d === undefined ? null : d;
  }

  // 计数（天/周/月倍数）：支持阿拉伯 + 中文一~二十 + 半(→0.5)
  function cnCount(s) {
    if (s == null) return null;
    s = String(s).trim();
    if (/^\d{1,3}$/.test(s)) return +s;
    if (s === '半') return 0.5;
    if (s === '十') return 10;
    if (s.length === 2 && s[0] === '十') return 10 + (CN_DIGIT[s[1]] || 0);
    if (s.length === 2 && s[1] === '十') return (CN_DIGIT[s[0]] || 0) * 10;
    if (s === '二十') return 20;
    if (s.length === 3 && s[0] === '二' && s[1] === '十') return 20 + (CN_DIGIT[s[2]] || 0);
    const d = CN_DIGIT[s]; return d === undefined ? null : d;
  }

  // 时段词 → 小时变换
  const PERIOD = {
    '凌晨': { keep: true }, '早晨': { keep: true }, '早上': { keep: true }, '上午': { keep: true },
    '中午': { noon: true },
    '下午': { add: 12 }, '傍晚': { add: 12 }, '晚上': { add: 12, mid: true },
    '夜里': { add: 12, mid: true }, '半夜': { mid: true }
  };
  function applyPeriod(h, name) {
    if (!name) return h;
    const p = PERIOD[name];
    if (!p) return h;
    if (p.noon) return 12;
    if (p.mid) return h === 12 ? 0 : (h % 12) + 12; // 晚上12点=0点
    if (p.add) return h === 12 ? 12 : (h % 12) + 12;
    return h; // 凌晨/早上/上午 原值
  }

  const WEEK_RE = /(下下|下|本|这|大)?\s*(周|星期|礼拜)\s*([一二三四五六日天1-6])/;
  const DAYWORD = { '今天': 0, '大前天': -3, '前天': -2, '前日': -2, '昨天': -1, '昨日': -1, '明天': 1, '明日': 1, '后天': 2, '大后天': 3 };
  const CAL = { '月底': 'monthEnd', '月末': 'monthEnd', '月初': 'monthStart', '月中': 'midMonth', '周末': 'weekend', '星期尾': 'weekend' };
  // 🟢 中文小时必须用显式 alternation：裸字符类会贪婪吞成「五十」导致整体不识别
  const HOUR = '((?:[0-2]?[0-9])|二十[一二三]?|十[一二]?|[一二两三四五六七八九]|两)';
  const TIME_RE = new RegExp('((?:凌晨|早晨|早上|上午|中午|下午|傍晚|晚上|夜里|半夜))?\\s*' + HOUR + '\\s*[点點]\\s*((?:半|一刻|三刻)|([0-5]?[0-9])\\s*分?)?');
  const NUM = '(?:\\d{1,3}|[零〇一两二三四五六七八九十半]{1,3})';

  function parse(text, nowDate) {
    const now = nowDate || new Date();
    text = String(text == null ? '' : text).trim();

    const used = [];      // 已消费区间 {s,e}
    const matched = [];
    const overlaps = (s, e) => used.some(u => s < u.e && e > u.s);
    function find(re) {
      // 用全局副本：非全局正则的 exec 不推进 lastIndex，会死循环
      const reG = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      reG.lastIndex = 0; let m;
      while ((m = reG.exec(text))) {
        if (m[0].length === 0) { reG.lastIndex++; continue; }
        const s = m.index, e = s + m[0].length;
        if (!overlaps(s, e)) return m;
        reG.lastIndex = e; // 跳过重叠段继续找
      }
      return null;
    }
    function take(m, type) { used.push({ s: m.index, e: m.index + m[0].length }); matched.push({ text: m[0], type, start: m.index, end: m.index + m[0].length }); }

    let base = null;      // 日期锚点（午夜）
    let allDay = true;
    let pendingPeriod = null; // 「明早/明晚/今晚」预挂的时段，供后续时间阶段使用

    // ── 绝对日期（最高优先级）──
    let m;
    if ((m = find(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
      base = new Date(+m[1], +m[2] - 1, +m[3]); take(m, 'date');
    } else if ((m = find(/(\d{2,4})年\s*(\d{1,2})月\s*(\d{1,2})[日号]?/))) {
      let y = +m[1]; if (y < 100) y += 2000;
      base = new Date(y, +m[2] - 1, +m[3]); take(m, 'date');
    } else if ((m = find(/(\d{1,2})月\s*(\d{1,2})[日号]?/))) {
      base = new Date(now.getFullYear(), +m[1] - 1, +m[2]); take(m, 'date');
    }

    // ── 周（含前缀 下/下下/本/这，裸周X 保持滚动语义）──
    if (!base && (m = find(WEEK_RE))) {
      const w = WEEK_CHAR[m[3]] != null ? WEEK_CHAR[m[3]] : 0;
      const mi = (w + 6) % 7;          // 转成「周一为0」偏移，否则周四会算成周五
      const mon = mondayOf(now);
      let d;
      if (m[1] === '下下') d = addDays(mon, 14 + mi);
      else if (m[1] === '下') d = addDays(mon, 7 + mi);
      else if (m[1] === '本' || m[1] === '这') d = addDays(mon, mi); // 本周（可为过去）
      else d = addDays(startOfDay(now), (w - now.getDay() + 7) % 7);  // 滚动：今天=今天，已过的取下一轮
      base = d; take(m, 'week');
    }

    // ── 相对日词 ──
    if (!base && (m = find(/(今天|大前天|前天|前日|昨天|昨日|明天|明日|后天|大后天)/))) {
      base = addDays(startOfDay(now), DAYWORD[m[0]]); take(m, 'day');
    }

    // ── 复合词：明早/明晚/今晚（日偏移 + 预挂时段，时间阶段消费）──
    if (!base && (m = find(/(明早|明晚|今晚)/))) {
      base = addDays(startOfDay(now), m[0] === '今晚' ? 0 : 1);
      pendingPeriod = m[0] === '明早' ? '早上' : '晚上';
      take(m, 'day');
    }

    // ── X天后 / X周后 / X个月后（含 两周后、半个月后）──
    if (!base) {
      if ((m = find(new RegExp('(' + NUM + ')\\s*天[后後]')))) {
        const c = cnCount(m[1]); const days = Math.round(c == null ? 0 : (c === 0.5 ? 15 : c));
        base = addDays(startOfDay(now), days); take(m, 'day');
      } else if ((m = find(new RegExp('(' + NUM + ')\\s*周[后後]')))) {
        base = addDays(startOfDay(now), (cnCount(m[1]) || 0) * 7); take(m, 'week');
      } else if ((m = find(new RegExp('(' + NUM + ')\\s*个?月[后後]')))) {
        const c = cnCount(m[1]);
        base = c === 0.5 ? addDays(startOfDay(now), 15) : addMonths(startOfDay(now), c || 0); // 半(月)→15天，不走 addMonths（会截断）
        take(m, 'month');
      }
    }

    // ── 相对月 + 日历词（月底/月初/月中 + 下个/上个 前缀；周末）──
    if (!base) {
      if ((m = find(/(下个|上个|这个)?\s*月(初|中|底|末)/))) {
        const off = m[1] === '下个' ? 1 : m[1] === '上个' ? -1 : 0;
        const bm = addMonths(new Date(now.getFullYear(), now.getMonth(), 1), off);
        if (m[2] === '初') base = new Date(bm.getFullYear(), bm.getMonth(), 1);
        else if (m[2] === '中') base = new Date(bm.getFullYear(), bm.getMonth(), 15);
        else base = new Date(bm.getFullYear(), bm.getMonth() + 1, 0); // 底/末 = 月末
        take(m, 'cal');
      } else if ((m = find(/(下个|上个)\s*月/))) {
        base = addMonths(new Date(now.getFullYear(), now.getMonth(), 1), m[1] === '下个' ? 1 : -1);
        take(m, 'month');
      } else if ((m = find(/(周末|星期尾)/))) {
        let k = (6 - now.getDay() + 7) % 7; if (k === 0) k = 7;       // 最近未来的周六
        base = addDays(startOfDay(now), k); take(m, 'cal');
      }
    }

    if (!base) base = startOfDay(now); // 未识别任何日期 → 默认今天

    // ── 锚点词（下班前/午饭后…），置于时间前，显式时刻可覆盖 ──
    const ANCHOR = { '下班前': [17, 30], '上班前': [9, 0], '午饭前': [12, 0], '午饭': [12, 0], '午饭后': [13, 0] };
    if ((m = find(/(下班前|上班前|午饭后|午饭前|午饭)/))) { // 🟢 长匹配优先：否则「午饭后」会被「午饭」截断成 12:00
      const t = ANCHOR[m[0]];
      base = new Date(base.getFullYear(), base.getMonth(), base.getDate(), t[0], t[1], 0);
      allDay = false; take(m, 'time');
    }

    // ── 时间（叠加在已得锚点上）──
    const tm = find(TIME_RE);
    if (tm) {
      const h0 = cnHour(tm[2]);
      if (h0 != null && h0 <= 23) {
        let h = applyPeriod(h0, tm[1] || pendingPeriod); // 明早/明晚 预挂时段兜底
        let mm = 0;
        if (tm[3] === '半') mm = 30; else if (tm[3] === '一刻') mm = 15; else if (tm[3] === '三刻') mm = 45;
        else if (tm[4] != null) mm = +tm[4];
        let date2 = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mm, 0);
        // 晚上/夜里/半夜 十二点 = 跨日 0 点
        if (h0 === 12 && tm[1] && (tm[1] === '晚上' || tm[1] === '夜里' || tm[1] === '半夜')) date2 = addDays(date2, 1);
        base = date2; allDay = false; take(tm, 'time');
      }
    }

    // ── 标题剥离（移除全部 consumed 区间，仅清理边缘标点/虚词）──
    const spans = used.slice().sort((a, b) => a.s - b.s);
    let rest = '', last = 0;
    for (const u of spans) { rest += text.slice(last, u.s); last = u.e; }
    rest += text.slice(last);
    rest = rest.replace(/\s+/g, ' ').trim();
    rest = rest.replace(/^[的\s、，。·,.\-—]+/, '').replace(/[的\s、，。·,.\-—]+$/, '');
    rest = rest.replace(/^去(?=\S)/, ''); // 常见冗余前缀（「下周四去开会」→「开会」）

    return {
      date: base,
      allDay: allDay,
      matched: matched,
      rest: rest,
      confidence: matched.length ? 'high' : 'none'
    };
  }

  const WN = ['日', '一', '二', '三', '四', '五', '六'];
  function label(res) {
    if (!res || !res.date) return '';
    const d = res.date, p2 = (n) => String(n).padStart(2, '0');
    let s = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WN[d.getDay()];
    if (!res.allDay) s += ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    return s;
  }

  global.NLPDate = { parse: parse, label: label, _t: { cnHour: cnHour, cnCount: cnCount, applyPeriod: applyPeriod } };
})(typeof window !== 'undefined' ? window : this);
