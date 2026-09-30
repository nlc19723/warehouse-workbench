/* ============================================================================
 * 工作任务模块（v229.23 新增）
 * 定位：个人备忘录 + 看进度 + 逾期提醒；既是随手记也是进度台。
 *
 * 核心能力：
 *  🅰 单天日历 / 周视图 / 月视图 + 月历跳转（日视图为默认）
 *  🅱 智能快速捕获（自然语言录入，自动拆时间/日期/标题/工作流）
 *  🅲 业务驱动任务生成（T1①）：首页业务待办一键转任务
 *  🅳 工作流编排（T1②）：识别「新招供应商」→ 读该供应商合同到期日 →
 *     倒推 180/65/15 天生成 3 步计划；订单未批 → 单条常驻任务
 *
 * 存储：DataStore.getSetting/setSetting('workTasks')（settings 通道分键文件），
 *      并集合并（按 id + updatedAt 新者胜），独立不污染工作数据、自动进云端同步。
 *      🟢 v229.39：补 localStorage 镜像兜底 —— 云端未连时不丢；isOverdue 改为全天比日/定时比时刻；
 *      完成=墨水沉入+进度环即时、删除=直接删+6 秒可撤销（替 confirm）。
 *
 * 字段（极简，用户只填标题/备注/截止日，状态自动）：
 *   id / title / note / dueAt(YYYY-MM-DDTHH:mm:ss 本地) / allDay(bool)
 *   / done(bool) / createdAt / updatedAt / type(standalone|flow|flow-step|business)
 *   / parentId / flowKey / stepOrder / anchorDate / sourceRef / sourceLabel
 * ========================================================================== */

const WorkTasksModule = (function () {
  'use strict';


  // ---------- 工作流模板（用户确认：新招 180/65/15 天） ----------
  const WORKFLOW_TEMPLATES = {
    supplier_new: {
      label: '新招供应商跟进',
      anchorField: '最终到期时间',           // 供应商原合同到期日（触发新招）
      steps: [
        { order: 1, lead: -180, title: '联系各部门反馈下轮材料使用意见（是否新增等），提醒技术部编制技术文件' },
        { order: 2, lead: -65,  after: 1,  title: '联系企发部根据上述反馈资料开始询价' },
        { order: 3, lead: -15,  after: 2,  title: '拿到询价后上会供应商招采议题' },
      ],
    },
    order_approve: {
      label: '订单审批提醒',
      single: true,
    },
  };

  // ---------- 日期工具（本地时区，规避 UTC 偏移） ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ymdHms = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const now = () => new Date();

  function parseLocal(s) {
    if (!s) return null;
    // 已是本地无 Z 串
    let m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0);
    // 时间戳
    if (/^\d{10,}$/.test(String(s))) return new Date(+s * (String(s).length === 10 ? 1000 : 1));
    return null;
  }

  const uid = () => 'wt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------- 业务数据源（读本地，不联网） ----------
  async function getSuppliers() {
    try { return await DS.getRows('suppliers'); } catch (e) { return []; }
  }
  async function getOrders() {
    try { return await DS.getRows('orders'); } catch (e) { return []; }
  }

  // ---------- 智能捕获：解析自然语言 → {title, dueAt, allDay, workflow} ----------
  function matchSupplier(text, suppliers) {
    if (!suppliers || !suppliers.length) return null;
    let best = null, bestLen = 0;
    for (const s of suppliers) {
      const nm = (s.供应商 || '').trim();
      if (!nm) continue;
      if (text.indexOf(nm) >= 0 && nm.length > bestLen) { best = s; bestLen = nm.length; }
    }
    return best;
  }

  function resolveCapture(text, suppliers) {
    text = (text || '').trim();
    const res = { title: text, dueAt: null, allDay: false, workflow: null, supplier: null };

    // 工作流识别：新招供应商（合同到期触发重新招采，非续签）
    if (/新招|重新招采|招采.*(供应商)?|供应商.*(招采|新招)/.test(text)) {
      const sup = matchSupplier(text, suppliers);
      if (sup) {
        const anchor = parseLocal(sup[WORKFLOW_TEMPLATES.supplier_new.anchorField]);
        if (anchor) {
          res.workflow = { key: 'supplier_new', supplier: sup, anchor };
          // 标题去掉供应商名 + 触发词，留意图
          res.title = text.replace(sup.供应商, '').replace(/新招|重新招采|招采|供应商/g, '').replace(/\s+/g, ' ').trim() || '新招供应商跟进';
          return res;
        }
      }
    }

    // 日期/时间解析
    let due = null;
    // 绝对日期 yyyy-mm-dd / yyyy/mm/dd
    let m = text.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) due = new Date(+m[1], +m[2] - 1, +m[3]);
    // X月X日
    if (!due) { m = text.match(/(\d{1,2})月(\d{1,2})[日号]?/); if (m) due = new Date(now().getFullYear(), +m[1] - 1, +m[2]); }
    // 周几（本周内最近的那天）
    const wmap = { '周日': 0, '周天': 0, '星期一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6 };
    if (!due) {
      for (const k in wmap) { if (text.indexOf(k) >= 0) { const t = addDays(startOfDay(now()), (wmap[k] - now().getDay() + 7) % 7); due = t; break; } }
    }
    if (!due) { if (/明天/.test(text)) due = addDays(startOfDay(now()), 1); else if (/后天/.test(text)) due = addDays(startOfDay(now()), 2); }
    if (!due) due = startOfDay(now()); // 默认今天

    // 时间 HH点 / HH:mm（含中文数字：十点 / 十一点 / 九点）
    let hh = null, mm = 0;
    m = text.match(/(\d{1,2})[点:：](\d{2})?/);
    if (m) { hh = +m[1]; if (m[2] != null) mm = +m[2]; }
    if (hh == null) {
      const cn = text.match(/(十[一二]?|[一二三四五六七八九])点/);
      if (cn) {
        const CN = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '十一': 11, '十二': 12 };
        hh = CN[cn[1]] || 0;
      }
    }
    if (hh != null) {
      due = new Date(due.getFullYear(), due.getMonth(), due.getDate(), hh, mm, 0);
      res.allDay = false;
    } else {
      res.allDay = true; // 无具体时刻 → 全天
    }
    res.dueAt = ymdHms(due);

    // 标题：去掉已解析的时间/日期 token
    let title = text
      .replace(/(\d{4})[-/]\d{1,2}[-/]\d{1,2}/g, '')
      .replace(/\d{1,2}月\d{1,2}[日号]?/g, '')
      .replace(/周[一二三四五六日天]/g, '')
      .replace(/\d{1,2}[点:：]\d{2}/g, '')
      .replace(/\d{1,2}点/g, '')
      .replace(/(十[一二]?|[一二三四五六七八九])点/g, '')
      .replace(/(明天|后天|今天)/g, '')
      .replace(/\s+/g, ' ').trim();
    res.title = title || '新任务';
    return res;
  }

  // 生成工作流任务（新招供应商 3 步）
  async function buildWorkflowTasks(wf) {
    const tpl = WORKFLOW_TEMPLATES[wf.key];
    const anchor = wf.anchor; // Date
    const children = [];
    for (const step of tpl.steps) {
      const due = addDays(startOfDay(anchor), step.lead); // lead 为负
      children.push({
        id: uid(),
        title: step.title,
        note: '',
        dueAt: ymdHms(due),
        allDay: true,
        done: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        type: 'flow-step',
        flowKey: wf.key,
        stepOrder: step.order,
        anchorDate: ymd(anchor),
        sourceLabel: tpl.label,
        sourceRef: wf.supplier && wf.supplier.供应商,
      });
    }
    const parent = {
      id: uid(),
      title: `${tpl.label}（${wf.supplier.供应商}）`,
      note: `原合同 ${ymd(anchor)} 到期，触发新招；共 ${tpl.steps.length} 步，依次完成。`,
      dueAt: ymdHms(addDays(startOfDay(anchor), tpl.steps[tpl.steps.length - 1].lead)),
      allDay: true,
      done: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      type: 'flow',
      flowKey: wf.key,
      anchorDate: ymd(anchor),
      sourceLabel: tpl.label,
      sourceRef: wf.supplier && wf.supplier.供应商,
      children: children.map((c) => c.id),
    };
    children.forEach((c) => { c.parentId = parent.id; });
    return [parent, ...children];
  }

  // ---------- CRUD ----------
  async function addTask(rec) {
    const arr = await WorkTasksSync.load();
    const full = Object.assign({
      id: uid(), title: '新任务', note: '', dueAt: ymdHms(startOfDay(now())),
      allDay: true, done: false, createdAt: Date.now(), updatedAt: Date.now(), type: 'standalone',
    }, rec);
    arr.push(full);
    await WorkTasksSync.save(arr);
    return full;
  }
  async function updateTask(id, patch) {
    const arr = await WorkTasksSync.load();
    const i = arr.findIndex((t) => t.id === id);
    if (i < 0) return null;
    arr[i] = Object.assign({}, arr[i], patch, { updatedAt: Date.now() });
    await WorkTasksSync.save(arr);
    return arr[i];
  }
  async function removeTask(id) {
    let arr = await WorkTasksSync.load();
    // 删父则连带删 children
    const t = arr.find((x) => x.id === id);
    const toDel = new Set([id]);
    if (t && t.children) t.children.forEach((c) => toDel.add(c));
    arr = arr.filter((x) => !toDel.has(x.id));
    await WorkTasksSync.save(arr);
  }
  async function toggleDone(id) {
    const arr = await WorkTasksSync.load();
    const t = arr.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done; t.updatedAt = Date.now();
    await WorkTasksSync.save(arr);
  }

  // 业务驱动：订单未批 → 单条常驻任务（按订单号去重）
  async function ensureOrderApproveTasks() {
    const orders = await getOrders();
    const arr = await WorkTasksSync.load();
    const exists = new Set(arr.filter((t) => t.type === 'business' && t.flowKey === 'order_approve').map((t) => t.sourceRef));
    const pending = (orders || []).filter((o) => {
      const st = String(o.审批状态 || o.状态 || '').trim();
      const no = o.订单号 || o.单号 || o.编号;
      return no && (st === '' || /未|待/.test(st)) && !exists.has(no);
    });
    if (!pending.length) return 0;
    const ts = Date.now();
    pending.forEach((o) => {
      const no = o.订单号 || o.单号 || o.编号;
      arr.push({
        id: uid(), title: `提醒领导审批订单 ${no}`, note: '订单未批，需领导审批后流程方可继续。',
        dueAt: ymdHms(startOfDay(now())), allDay: true, done: false,
        createdAt: ts, updatedAt: ts, type: 'business', flowKey: 'order_approve', sourceRef: no, sourceLabel: '订单审批提醒',
      });
    });
    await WorkTasksSync.save(arr);
    return pending.length;
  }

  // 业务驱动：首页业务待办一键转任务
  async function addFromBusiness(text, meta) {
    return addTask({ title: text, note: meta ? `[来自${meta}]` : '', dueAt: ymdHms(startOfDay(now())), allDay: true, type: 'business' });
  }

  // ---------- 派生统计 ----------
  async function getStats() {
    const arr = await WorkTasksSync.load();
    const n = now();
    let overdue = 0, today = 0, upcoming = 0, done = 0;
    const t0 = startOfDay(n), t1 = addDays(t0, 1);
    arr.forEach((t) => {
      if (t.done) { done++; return; }
      const d = parseLocal(t.dueAt); if (!d) return;
      if (isOverdueAt(t, n)) overdue++;
      else if (d >= t0 && d < t1) today++;
      else if (d < addDays(t0, 7)) upcoming++;
    });
    return { total: arr.length, overdue, today, upcoming, done };
  }

  // =====================================================================
  // 渲染
  // =====================================================================
  let _cursor = startOfDay(now());   // 当前视图定位日
  let _mode = 'day';                 // day | week | month
  let _monthOpen = false;            // 月历弹层

  // 🟢 v229.39（P0 修复）：全天任务存的是当天 T00:00:00，用「时刻」比较会恒判逾期。
  //   改为：全天比「日」，定时比「时刻」。getStats / 渲染 / 铃铛 / 月历统一走这里。
  function isOverdueAt(t, ref) {
    if (!t || t.done) return false;
    const d = parseLocal(t.dueAt);
    if (!d) return false;
    if (t.allDay) return startOfDay(d).getTime() < startOfDay(ref).getTime();
    return d.getTime() < ref.getTime();
  }
  function isOverdue(t) { return isOverdueAt(t, now()); }

  function dueLabel(t) {
    const d = parseLocal(t.dueAt); if (!d) return '';
    if (t.allDay) return ymd(d).slice(5);
    return `${ymd(d).slice(5)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function eventRow(t, opts = {}) {
    const ov = isOverdue(t);
    const tone = t.done ? 'muted' : (ov ? 'over' : (opts.flow ? 'flow' : 'normal'));
    const cls = ['wt-ev', 'wt-' + tone].join(' ');
    const badge = t.type === 'flow-step' ? '<span class="wt-badge">新招·步' + t.stepOrder + '</span>'
      : t.type === 'flow' ? '<span class="wt-badge wt-badge-flow">新招</span>'
      : t.type === 'business' ? '<span class="wt-badge wt-badge-biz">业务</span>' : '';
    return `<div class="${cls}" data-id="${esc(t.id)}">
        <label class="wt-chk"><input type="checkbox" ${t.done ? 'checked' : ''} onchange="WorkTasksModule.onToggle('${esc(t.id)}')"></label>
        <div class="wt-ev-main">
          <div class="wt-ev-title">${esc(t.title)} ${badge}</div>
          ${t.note ? `<div class="wt-ev-note">${esc(t.note)}</div>` : ''}
        </div>
        <div class="wt-ev-when">${esc(dueLabel(t))}</div>
        <button class="wt-del" title="删除" onclick="WorkTasksModule.onRemove('${esc(t.id)}')">✕</button>
      </div>`;
  }

  function renderDay(arr) {
    const t0 = startOfDay(_cursor), t1 = addDays(t0, 1);
    const dayTasks = arr.filter((t) => { const d = parseLocal(t.dueAt); return d && d >= t0 && d < t1; });
    const timed = dayTasks.filter((t) => !t.allDay).sort((a, b) => parseLocal(a.dueAt) - parseLocal(b.dueAt));
    const allday = dayTasks.filter((t) => t.allDay);
    const overdueAll = arr.filter((t) => isOverdue(t) && !(parseLocal(t.dueAt) >= t0 && parseLocal(t.dueAt) < t1));

    // 进度环
    const total = dayTasks.length, doneCnt = dayTasks.filter((t) => t.done).length;
    const pct = total ? Math.round((doneCnt / total) * 100) : 0;
    const ring = `<div class="wt-ring" style="--p:${pct}"><span>${doneCnt}/${total}</span></div>`;

    let html = '';
    // 逾期红条
    if (overdueAll.length) {
      html += `<div class="wt-overbar">⚠ ${overdueAll.length} 项逾期（不在今日）：${overdueAll.slice(0, 4).map((t) => esc(t.title)).join('、')}${overdueAll.length > 4 ? '…' : ''}</div>`;
    }
    html += `<div class="wt-dayhead"><div class="wt-dh-date">${ymd(_cursor)} 周${WEEK[_cursor.getDay()]}</div>${ring}</div>`;
    // 时间轴
    if (timed.length) {
      html += timed.map((t) => {
        const d = parseLocal(t.dueAt);
        return `<div class="wt-time"><span class="wt-time-h">${pad(d.getHours())}:${pad(d.getMinutes())}</span>${eventRow(t)}</div>`;
      }).join('');
    } else if (!allday.length) {
      html += `<div class="wt-empty">今日暂无定时任务</div>`;
    }
    // 全天分组
    if (allday.length) {
      html += `<div class="wt-allday-h">全天（${allday.length}）</div>` + allday.map((t) => eventRow(t)).join('');
    }
    // 快速新增
    html += `<div class="wt-quick">
        <input id="wtQuickInput" class="wt-qinput" placeholder="快速添加：如「周五十点 复盘库存预警配置」或「王经理 新招供应商」" onkeydown="if(event.key==='Enter')WorkTasksModule.onQuickAdd(this.value)">
        <button class="wt-qbtn" onclick="WorkTasksModule.onQuickAdd(document.getElementById('wtQuickInput').value)">+ 添加</button>
      </div>`;
    return html;
  }

  function renderWeek(arr) {
    const monday = addDays(startOfDay(_cursor), -((_cursor.getDay() + 6) % 7));
    let html = `<div class="wt-week">`;
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      const t0 = startOfDay(day), t1 = addDays(t0, 1);
      const list = arr.filter((t) => { const d = parseLocal(t.dueAt); return d && d >= t0 && d < t1; });
      const isToday = ymd(day) === ymd(now());
      html += `<div class="wt-wcol ${isToday ? 'wt-today' : ''}">
          <div class="wt-whead">周${WEEK[day.getDay()]}<br><b>${pad(day.getDate())}</b></div>
          <div class="wt-wbody">${list.length ? list.sort((a, b) => parseLocal(a.dueAt) - parseLocal(b.dueAt)).map((t) => eventRow(t)).join('') : '<div class="wt-wempty">—</div>'}</div>
        </div>`;
    }
    html += `</div>`;
    return html;
  }

  function renderMonth(arr) {
    const y = _cursor.getFullYear(), m = _cursor.getMonth();
    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7; // 周一起
    const gridStart = addDays(startOfDay(first), -startOffset);
    const byDay = {};
    arr.forEach((t) => { const d = parseLocal(t.dueAt); if (!d) return; (byDay[ymd(d)] = byDay[ymd(d)] || []).push(t); });
    let html = `<div class="wt-month"><div class="wt-mrow wt-mhead">${['一','二','三','四','五','六','日'].map((w) => `<span>${w}</span>`).join('')}</div>`;
    for (let r = 0; r < 6; r++) {
      html += `<div class="wt-mrow">`;
      for (let c = 0; c < 7; c++) {
        const day = addDays(gridStart, r * 7 + c);
        const key = ymd(day);
        const list = byDay[key] || [];
        const ov = list.some((t) => isOverdue(t));
        const isToday = key === ymd(now());
        const otherMonth = day.getMonth() !== m;
        html += `<div class="wt-mcell ${isToday ? 'wt-today' : ''} ${otherMonth ? 'wt-other' : ''} ${ov ? 'wt-mov' : ''}" onclick="WorkTasksModule.goDate('${key}')">
            <div class="wt-mnum">${day.getDate()}${ov ? '<i class="wt-dot"></i>' : ''}</div>
            ${list.slice(0, 2).map((t) => `<div class="wt-mtask ${t.done ? 'wt-done' : ''}">${esc(t.title.length > 6 ? t.title.slice(0, 6) + '…' : t.title)}</div>`).join('')}
            ${list.length > 2 ? `<div class="wt-mmore">+${list.length - 2}</div>` : ''}
          </div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
    return html;
  }

  function renderMonthPicker() {
    const y = _cursor.getFullYear(), m = _cursor.getMonth();
    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const gridStart = addDays(startOfDay(first), -startOffset);
    let html = `<div class="wt-mp"><div class="wt-mp-head">
        <button onclick="WorkTasksModule.shiftMonth(-1)">‹</button><b>${y}年${m + 1}月</b><button onclick="WorkTasksModule.shiftMonth(1)">›</button>
      </div><div class="wt-mp-grid">`;
    for (let i = 0; i < 42; i++) {
      const day = addDays(gridStart, i);
      const has = (window.__wtMonthMap && window.__wtMonthMap[ymd(day)]) || false;
      const ov = window.__wtMonthOver && window.__wtMonthOver[ymd(day)];
      const isToday = ymd(day) === ymd(now());
      html += `<div class="wt-mp-cell ${isToday ? 'wt-today' : ''} ${has ? 'wt-has' : ''} ${ov ? 'wt-mov' : ''}" onclick="WorkTasksModule.goDate('${ymd(day)}');WorkTasksModule.toggleMonth(false)">${day.getDate()}</div>`;
    }
    html += `</div></div>`;
    return html;
  }

  async function render() {
    startSync(); // 进入模块即启动同步分包（进入即拉 + 轻轮询）
    hideUndo(); // 视图重绘 → 之前的撤销浮条作废（避免残留过期提示）
    const content = document.getElementById('contentArea');
    if (!content) return;
    const arr = await WorkTasksSync.load();
    const stats = await getStats();

    // 月历地图（供 picker 标色）
    const mMap = {}, mOver = {};
    arr.forEach((t) => { const d = parseLocal(t.dueAt); if (!d) return; const k = ymd(d); mMap[k] = (mMap[k] || 0) + 1; if (isOverdue(t)) mOver[k] = true; });
    window.__wtMonthMap = mMap; window.__wtMonthOver = mOver;

    const modeBtn = (k, label) => `<button class="wt-mbtn ${_mode === k ? 'on' : ''}" onclick="WorkTasksModule.setMode('${k}')">${label}</button>`;

    let body;
    if (_mode === 'day') body = renderDay(arr);
    else if (_mode === 'week') body = renderWeek(arr);
    else body = renderMonth(arr);

    const navLabel = _mode === 'month' ? `${_cursor.getFullYear()}年${_cursor.getMonth() + 1}月` : `${ymd(_cursor)} 周${WEEK[_cursor.getDay()]}`;

    content.innerHTML = `
      <div class="wt-wrap">
        <div class="wt-toolbar">
          <div class="wt-nav">
            <button class="wt-navbtn" onclick="WorkTasksModule.shiftCursor(-1)">‹</button>
            <button class="wt-today" onclick="WorkTasksModule.goToday()">今天</button>
            <button class="wt-navbtn" onclick="WorkTasksModule.shiftCursor(1)">›</button>
            <span class="wt-navlabel">${navLabel}</span>
            <button class="wt-calbtn" onclick="WorkTasksModule.toggleMonth()">📅 月历</button>
          </div>
          <div class="wt-modes">
            ${modeBtn('day', '日')}${modeBtn('week', '周')}${modeBtn('month', '月')}
          </div>
        </div>
        ${_monthOpen ? `<div class="wt-mp-wrap">${renderMonthPicker()}</div>` : ''}
        <div class="wt-stats">逾期 <b class="wt-red">${stats.overdue}</b> · 今日 <b>${stats.today}</b> · 本周 <b>${stats.upcoming}</b> · 已完成 <b>${stats.done}</b> / ${stats.total}</div>
        <div class="wt-body">${body}</div>
      </div>`;
  }

  // ---------- 外部入口（首页卡 / 铃铛） ----------
  async function renderSummaryInto(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const arr = await WorkTasksSync.load();
    const stats = await getStats();
    const n = now();
    const items = arr.filter((t) => !t.done).sort((a, b) => parseLocal(a.dueAt) - parseLocal(b.dueAt)).slice(0, 5);
    el.innerHTML = `
      <div class="glass-card-header">
        <span class="glass-card-title"><span class="title-icon">📌</span>我的任务</span>
        <span class="glass-card-action" onclick="App.go('workTasks')">查看全部 ›</span>
      </div>
      <div class="todo-list">
        ${stats.overdue ? `<div class="todo-item"><div class="todo-dot urgent"></div><span class="todo-text">${stats.overdue} 项任务已逾期</span><span class="todo-meta">立即处理 ›</span></div>` : ''}
        ${items.length ? items.map((t) => `<div class="todo-item ${isOverdue(t) ? 'todo-warn' : ''}" onclick="App.go('workTasks')">
            <div class="todo-dot ${isOverdue(t) ? 'urgent' : 'normal'}"></div>
            <span class="todo-text">${esc(t.title)}</span>
            <span class="todo-meta">${esc(dueLabel(t))}</span>
          </div>`).join('') : (stats.overdue ? '' : '<div class="todo-item"><div class="todo-dot normal"></div><span class="todo-text">暂无待办事项 ✓</span></div>')}
      </div>`;
  }

  function bellInfo() {
    // 同步返回（缓存已加载时）；异步刷新由 refreshBell 处理
    const arr = WorkTasksSync.getCache();
    const overdue = arr.filter((t) => isOverdue(t)).length;
    return { overdue, total: arr.length };
  }
  async function refreshBell() {
    const el = document.getElementById('wtBell');
    if (el) {
      const arr = await WorkTasksSync.load();
      const overdue = arr.filter((t) => isOverdue(t)).length;
      el.innerHTML = `📌${overdue ? `<span class="wt-bell-dot">${overdue}</span>` : ''}`;
      el.title = overdue ? `${overdue} 项任务逾期` : '我的任务';
      const sb = document.getElementById('badgeWorkTasks');
      if (sb) { if (overdue > 0) { sb.textContent = overdue; sb.hidden = false; } else { sb.hidden = true; } }
    }
  }

  // ---------- 交互（暴露给 onclick） ----------
  function setMode(k) { _mode = k; render(); }
  function goToday() { _cursor = startOfDay(now()); _monthOpen = false; render(); }
  function shiftCursor(d) { _cursor = addDays(startOfDay(_cursor), d); render(); }
  function goDate(s) { const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) _cursor = new Date(+m[1], +m[2] - 1, +m[3]); _mode = 'day'; _monthOpen = false; render(); }
  function shiftMonth(d) { _cursor = new Date(_cursor.getFullYear(), _cursor.getMonth() + d, 1); _mode = 'month'; render(); }
  function toggleMonth(v) { _monthOpen = (v === undefined) ? !_monthOpen : v; render(); }

  async function onQuickAdd(val) {
    val = (val || '').trim(); if (!val) return;
    const suppliers = await getSuppliers();
    const cap = resolveCapture(val, suppliers);
    if (cap.workflow) {
      const tasks = await buildWorkflowTasks(cap.workflow);
      let arr = await WorkTasksSync.load(); arr = arr.concat(tasks); await WorkTasksSync.save(arr);
      WBModal && WBModal.notify && WBModal.notify(`已生成「${cap.workflow.supplier.供应商}」新招跟进 ${tasks.length} 步计划`);
    } else {
      await addTask({ title: cap.title, dueAt: cap.dueAt, allDay: cap.allDay });
    }
    render();
    refreshBell();
    if (typeof DashboardModule !== 'undefined' && DashboardModule.renderMyTasksCard) DashboardModule.renderMyTasksCard();
  }
  async function onToggle(id) {
    const arr = await WorkTasksSync.load();
    const t = arr.find((x) => x.id === id);
    if (!t) return;
    const nowDone = !t.done;
    // 🟢 v229.39（M1 墨水沉入）：先动 DOM（局部更新，不整页重绘破坏动画），再写云
    t.done = nowDone; t.updatedAt = Date.now();
    await WorkTasksSync.save(arr);
    const row = document.querySelector('.wt-ev[data-id="' + id + '"]');
    if (row) {
      if (nowDone) {
        row.classList.add('wt-muted', 'is-sinking');
        setTimeout(() => row.classList.remove('is-sinking'), 440);
      } else {
        row.classList.remove('wt-muted');
      }
      const cb = row.querySelector('input[type=checkbox]');
      if (cb) cb.checked = nowDone;
    }
    updateRingLive();                 // M3：进度环即时同步（不靠整页重绘）
    refreshBell();
    if (typeof DashboardModule !== 'undefined' && DashboardModule.renderMyTasksCard) DashboardModule.renderMyTasksCard();
    if (nowDone) showUndo('已了结', () => onToggle(id)); // 撤销 = 反勾选（回原位）
    else hideUndo();
  }

  async function onRemove(id) {
    const arr = await WorkTasksSync.load();
    const rec = arr.find((x) => x.id === id);
    if (!rec) return;
    const snapshot = JSON.parse(JSON.stringify(rec));
    const kids = arr.filter((x) => x.parentId === id).map((x) => JSON.parse(JSON.stringify(x)));
    await removeTask(id);             // 写云（含连带子任务）
    // 🟢 v229.39（M2 可逆 > 确认）：直接删 + 乐观移除 DOM + 6 秒可撤销，不再弹 confirm
    const toDel = new Set([id]); kids.forEach((k) => toDel.add(k.id));
    toDel.forEach((did) => {
      const r = document.querySelector('.wt-ev[data-id="' + did + '"]');
      if (r) { r.classList.add('removing'); setTimeout(() => { if (r.parentNode) r.remove(); }, 320); }
    });
    refreshBell();
    if (typeof DashboardModule !== 'undefined' && DashboardModule.renderMyTasksCard) DashboardModule.renderMyTasksCard();
    showUndo('已删除', () => restoreTasks([snapshot].concat(kids)));
  }

  // 🟢 v229.39（M2 撤销）：把记录按原样插回（保 id / 顺序），再整页重绘一次
  async function restoreTasks(recs) {
    let arr = await WorkTasksSync.load();
    recs.forEach((r) => { if (!arr.find((x) => x.id === r.id)) arr.push(r); });
    await WorkTasksSync.save(arr);
    render(); refreshBell();
    if (typeof DashboardModule !== 'undefined' && DashboardModule.renderMyTasksCard) DashboardModule.renderMyTasksCard();
  }

  // 🟢 v229.39（M3）：不重绘整页，直接改当前日视图进度环的 --p 与文案
  function updateRingLive() {
    const ring = document.querySelector('.wt-ring');
    if (!ring) return; // 仅日视图有环；周/月视图无环，跳过
    const arr = WorkTasksSync.getCache();
    const t0 = startOfDay(_cursor), t1 = addDays(t0, 1);
    const dayTasks = arr.filter((t) => { const d = parseLocal(t.dueAt); return d && d >= t0 && d < t1; });
    const total = dayTasks.length, doneCnt = dayTasks.filter((t) => t.done).length;
    const pct = total ? Math.round((doneCnt / total) * 100) : 0;
    ring.style.setProperty('--p', pct);
    const span = ring.querySelector('span'); if (span) span.textContent = doneCnt + '/' + total;
  }

  // ---------- 撤销浮条（全局单例，挂在 body，render 重绘不丢） ----------
  let _undoTimer = 0, _undoFn = null;
  function ensureUndoEl() {
    let el = document.getElementById('wtUndo');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wtUndo'; el.className = 'wt-undo'; el.setAttribute('role', 'status');
      el.innerHTML = '<span class="wt-undo-txt"></span><button type="button" class="wt-undo-btn">撤销</button><i class="bar"></i>';
      document.body.appendChild(el);
    }
    return el;
  }
  function showUndo(text, fn) {
    clearTimeout(_undoTimer);
    _undoFn = fn;
    const el = ensureUndoEl();
    el.querySelector('.wt-undo-txt').textContent = text;
    el.classList.add('show');
    const bar = el.querySelector('.bar');
    bar.style.animation = 'none'; void bar.offsetWidth; // 重置进度条
    bar.style.animation = 'wtUndoBar 6s linear forwards';
    _undoTimer = setTimeout(hideUndo, 6000);
  }
  function hideUndo() {
    clearTimeout(_undoTimer); _undoFn = null;
    const el = document.getElementById('wtUndo'); if (el) el.classList.remove('show');
  }
  // 撤销按钮（事件委托，IIFE 内仅绑定一次）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.wt-undo-btn');
    if (btn) { const f = _undoFn; hideUndo(); if (f) f(); }
  });

  // ---------- 启动：业务驱动同步 ----------
  async function bootstrap() {
    try { await ensureOrderApproveTasks(); } catch (e) { console.warn('[work-tasks] 订单未批同步(已忽略):', e && e.message); }
    refreshBell();
  }

  // ---------- 同步分包生命周期（阶段1/2：进入即拉 + 轻轮询） ----------
  function startSync() {
    if (typeof WorkTasksSync === 'undefined') return;
    WorkTasksSync.start((merged) => {
      // 远端变更 → 仅当本模块仍在前台时重渲（避免离开后异步重绘）
      if (typeof App !== 'undefined' && App.currentModule === 'workTasks') render();
    });
  }
  function stopSync() { if (typeof WorkTasksSync !== 'undefined') WorkTasksSync.stop(); }
  function onLeave() { stopSync(); }  // App.go 切走本模块时调用，清定时器

  return {
    render, renderSummaryInto, refreshBell, bellInfo, bootstrap,
    setMode, goToday, shiftCursor, goDate, shiftMonth, toggleMonth,
    onQuickAdd, onToggle, onRemove,
    addFromBusiness, ensureOrderApproveTasks,
    startSync, stopSync, onLeave,
    _debug: { _load: WorkTasksSync.load, getStats, addTask, removeTask, toggleDone },
  };
})();
if (typeof window !== 'undefined') window.WorkTasksModule = WorkTasksModule;
