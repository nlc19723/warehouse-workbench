/*
 * DatePicker —— 轻量自实现日期选择器（方案 B · v3 视觉）
 * 替换原生 <input type="date">（其日历弹窗是 shadow DOM 黑盒，无法定制箭头样式）。
 * 设计：立体毛玻璃拟物 popover + 扁平清爽 ± 按钮（右侧）+ 标题"Y 年 M 月"（可点击展开月年面板）。
 * 约束：保持 input 的 id 与原生一致、并 dispatch 原生 'change' 事件，
 *       因此各模块的 onDateChange / applyFilter 等读取 .value 的逻辑无需改动。
 */
const DatePicker = (() => {
  const STYLE_ID = 'datepicker-style';

  const CSS = `
  .dp-input {
    cursor: pointer;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%237b8794' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='18' rx='2'/><line x1='16' y1='2' x2='16' y2='6'/><line x1='8' y1='2' x2='8' y2='6'/><line x1='3' y1='10' x2='21' y2='10'/></svg>");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
  }
  .dp-input.open { border-color: var(--primary, #5B8FF9); box-shadow: 0 0 0 3px rgba(91,143,249,.18); }

  /* Popover：立体毛玻璃拟物 */
  .dp-pop {
    position: absolute; z-index: 9999;
    background: rgba(255,255,255,.72);
    backdrop-filter: blur(22px) saturate(170%); -webkit-backdrop-filter: blur(22px) saturate(170%);
    border: 1px solid rgba(255,255,255,.6); border-radius: 18px;
    box-shadow: 14px 18px 40px rgba(120,140,180,.40), -8px -8px 24px rgba(255,255,255,.70), inset 0 1px 2px rgba(255,255,255,.8);
    padding: 16px; width: 268px;
    font-size: 13px; color: #2b3445;
    animation: dpIn .18s ease-out;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  @keyframes dpIn { from { opacity: 0; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

  .dp-head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 10px; }
  .dp-title { flex: 1; text-align: center; font-weight: 600; font-size: 14px; cursor: pointer; padding: 7px 8px; border-radius: 10px; user-select: none; transition: all .14s; box-shadow: 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }
  .dp-title:hover { color: var(--primary, #5B8FF9); box-shadow: 0 0 0 2px rgba(91,143,249,.2) inset, 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }

  /* 扁平清爽按钮（白底 + 描边），右侧 */
  .dp-btn {
    width: 32px; height: 32px; border: 1px solid rgba(255,255,255,.6); border-radius: 10px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    color: #5b6573; font-weight: 600; font-size: 16px; line-height: 1;
    background: linear-gradient(145deg,#ffffff,#eef2f8);
    box-shadow: 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8);
    transition: all .12s; user-select: none;
  }
  .dp-btn:hover { color: var(--primary, #5B8FF9); box-shadow: 0 0 0 2px rgba(91,143,249,.22) inset, 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }
  .dp-btn:active { box-shadow: inset 2px 2px 6px rgba(174,186,210,.5), inset -2px -2px 4px rgba(255,255,255,.8); transform: translateY(1px); }

  .dp-weekrow { display: grid; grid-template-columns: repeat(7,1fr); text-align: center; color: #7b8794; font-size: 11px; margin: 6px 0 4px; }
  .dp-grid { display: grid; grid-template-columns: repeat(7,1fr); gap: 3px; }
  .dp-day { height: 33px; display: flex; align-items: center; justify-content: center; border-radius: 9px; cursor: pointer; transition: all .12s; font-size: 13px; }
  .dp-day:hover { background: #EAF1FE; color: var(--primary, #5B8FF9); box-shadow: 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }
  .dp-day.muted { color: #cdd5e0; cursor: default; }
  .dp-day.muted:hover { background: transparent; color: #cdd5e0; box-shadow: none; }
  .dp-day.today { font-weight: 700; color: var(--primary, #5B8FF9); box-shadow: inset 0 0 0 2px var(--primary, #5B8FF9); }
  .dp-day.today:hover { background: #EAF1FE; }
  .dp-day.selected { background: linear-gradient(145deg,var(--primary,#5B8FF9),var(--primary-hover,#3D7BF0)); color: #fff; box-shadow: 4px 4px 10px rgba(91,143,249,.4), inset 1px 1px 2px rgba(255,255,255,.4); }

  .dp-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(150,165,190,.18); font-size: 12px; }
  .dp-link { cursor: pointer; color: var(--primary, #5B8FF9); padding: 5px 10px; border-radius: 8px; transition: all .14s; box-shadow: 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }
  .dp-link:hover { background: #EAF1FE; }

  /* 月年面板：左年列 + 右月网格 */
  .dp-my { display: none; }
  .dp-my.show { display: flex; gap: 12px; }
  .dp-year-col { width: 64px; flex: none; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; padding: 2px; }
  .dp-year-col::-webkit-scrollbar { width: 5px; }
  .dp-year-col::-webkit-scrollbar-thumb { background: rgba(150,165,190,.3); border-radius: 3px; }
  .dp-year { padding: 9px 0; text-align: center; border-radius: 10px; cursor: pointer; font-size: 13px; color: #7b8794; transition: all .12s; box-shadow: 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }
  .dp-year:hover { color: var(--primary, #5B8FF9); }
  .dp-year.selected { background: linear-gradient(145deg,var(--primary,#5B8FF9),var(--primary-hover,#3D7BF0)); color: #fff; box-shadow: 4px 4px 10px rgba(91,143,249,.4), inset 1px 1px 2px rgba(255,255,255,.4); font-weight: 600; }

  .dp-month-area { flex: 1; display: flex; flex-direction: column; }
  .dp-month-area-title { font-size: 12px; color: #7b8794; margin-bottom: 6px; font-weight: 600; }
  .dp-month-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; }
  .dp-month { padding: 10px 0; text-align: center; border-radius: 10px; cursor: pointer; transition: all .14s; font-size: 13px; font-weight: 600; color: #2b3445; box-shadow: 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }
  .dp-month:hover { color: var(--primary, #5B8FF9); box-shadow: 0 0 0 2px rgba(91,143,249,.2) inset, 3px 3px 8px rgba(174,186,210,.4), -2px -2px 6px rgba(255,255,255,.8); }
  .dp-month.selected { background: linear-gradient(145deg,var(--primary,#5B8FF9),var(--primary-hover,#3D7BF0)); color: #fff; box-shadow: 4px 4px 12px rgba(91,143,249,.45), inset 1px 1px 2px rgba(255,255,255,.4); }
  .dp-month.current { color: var(--primary, #5B8FF9); }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const CN_MONTH = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
  const WEEK = ['日','一','二','三','四','五','六'];

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseISO(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); if (!y || !m || !d) return null; const dt = new Date(y, m - 1, d); return isNaN(dt) ? null : dt; }

  // 🟢 v208 AUDIT-105：每个 mount 实例持有一个 AbortController 并集中登记。
  //   旧代码在 document / window 上挂匿名监听且从不 removeEventListener，unmountAll
  //   只 remove 浮层 DOM —— 每次模块切换泄漏 2 个僵尸回调，切换几十次后点击/resize 逐次变卡。
  const _controllers = new Set();

  function mount(inputId) {
    ensureStyle();
    const input = document.getElementById(inputId);
    if (!input || input.dataset.dpMounted === '1') return;
    input.dataset.dpMounted = '1';
    const _ac = new AbortController();
    _controllers.add(_ac);
    input.readOnly = true;
    input.classList.add('dp-input');
    if (input.type === 'date') input.type = 'text'; // 兼容仍保留 type=date 的字段

    let view = parseISO(input.value) || new Date();
    let selected = parseISO(input.value);

    const pop = document.createElement('div');
    pop.className = 'dp-pop';
    pop.style.display = 'none';
    pop.dataset.forInput = inputId;
    document.body.appendChild(pop);
    input.__dpPop = pop;

    function place() {
      const r = input.getBoundingClientRect();
      pop.style.left = (window.scrollX + r.left) + 'px';
      pop.style.top = (window.scrollY + r.bottom + 8) + 'px';
    }

    function renderDay() {
      const y = view.getFullYear(), m = view.getMonth();
      const first = new Date(y, m, 1).getDay();
      const days = new Date(y, m + 1, 0).getDate();
      const today = new Date();
      const cells = [];
      for (let i = 0; i < first; i++) cells.push('<div class="dp-day muted"></div>');
      for (let d = 1; d <= days; d++) {
        const dt = new Date(y, m, d);
        const cls = [];
        if (selected && dt.toDateString() === selected.toDateString()) cls.push('selected');
        if (dt.toDateString() === today.toDateString()) cls.push('today');
        cells.push(`<div class="dp-day ${cls.join(' ')}" data-d="${d}">${d}</div>`);
      }
      pop.innerHTML = `
        <div class="dp-head">
          <div class="dp-title" data-act="openMy">${y} 年 ${m + 1} 月</div>
          <button type="button" class="dp-btn" data-act="pm" title="上一月">−</button>
          <button type="button" class="dp-btn" data-act="nm" title="下一月">+</button>
        </div>
        <div class="dp-weekrow">${WEEK.map(w => `<div>${w}</div>`).join('')}</div>
        <div class="dp-grid">${cells.join('')}</div>
        <div class="dp-foot">
          <span class="dp-link" data-act="clear">清除</span>
          <span class="dp-link" data-act="today">今天</span>
        </div>
      `;
      bindDay();
    }

    function renderMonthYear() {
      const y = view.getFullYear(), m = view.getMonth();
      const thisY = new Date().getFullYear();
      const thisM = new Date().getMonth();
      const years = [];
      const yearStart = Math.min(y, 2016), yearEnd = Math.max(y, 2060);
      for (let i = yearStart; i <= yearEnd; i++) {
        const cls = [];
        if (i === y) cls.push('selected');
        years.push(`<div class="dp-year ${cls.join(' ')}" data-y="${i}">${i}</div>`);
      }
      const months = CN_MONTH.map((name, i) => {
        const cls = [];
        if (i === m) cls.push('selected');
        else if (i === thisM && y === thisY) cls.push('current');
        return `<div class="dp-month ${cls.join(' ')}" data-mi="${i}">${name}</div>`;
      }).join('');
      pop.innerHTML = `
        <div class="dp-my show">
          <div class="dp-year-col">${years.join('')}</div>
          <div class="dp-month-area">
            <div class="dp-month-area-title">选择月份</div>
            <div class="dp-month-grid">${months}</div>
          </div>
        </div>
        <div class="dp-foot"><span class="dp-link" data-act="back">‹ 返回日历</span><span></span></div>
      `;
      // 把选中年滚到可视区中央
      const sel = pop.querySelector('.dp-year.selected');
      if (sel) {
        const col = pop.querySelector('.dp-year-col');
        if (col) col.scrollTop = sel.offsetTop - col.clientHeight / 2 + sel.clientHeight / 2;
      }
      bindMonthYear();
    }

    function bindDay() {
      pop.querySelectorAll('.dp-btn').forEach(b => b.addEventListener('click', () => {
        const a = b.dataset.act;
        // 加减月份：保持当前 day，超出目标月最大天数时自动夹紧（避免 1/31 → 2/31 溢出成 3/3）
        if (a === 'pm' || a === 'nm') {
          const anchor = selected || view; // 优先用已选日（用户视角）
          const newMonth = a === 'pm' ? anchor.getMonth() - 1 : anchor.getMonth() + 1;
          const targetYear = anchor.getFullYear() + Math.floor(newMonth / 12);
          const targetMonth0 = ((newMonth % 12) + 12) % 12;
          const lastDayOfTarget = new Date(targetYear, targetMonth0 + 1, 0).getDate();
          const finalDay = Math.min(anchor.getDate(), lastDayOfTarget);
          selected = new Date(targetYear, targetMonth0, finalDay);
          view = new Date(selected);
          // 同步 input.value 并触发 change（让业务筛选/校验照常工作）
          input.value = toISO(selected);
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        renderDay();
      }));
      pop.querySelector('.dp-title').addEventListener('click', () => { renderMonthYear(); });
      pop.querySelectorAll('.dp-day[data-d]').forEach(d => d.addEventListener('click', () => {
        selected = new Date(view.getFullYear(), view.getMonth(), +d.dataset.d);
        input.value = toISO(selected);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close();
      }));
      pop.querySelector('[data-act="clear"]').addEventListener('click', () => {
        input.value = ''; selected = null;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close();
      });
      pop.querySelector('[data-act="today"]').addEventListener('click', () => {
        selected = new Date(); view = new Date(selected);
        input.value = toISO(selected);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close();
      });
    }

    function bindMonthYear() {
      pop.querySelectorAll('.dp-year').forEach(el => el.addEventListener('click', () => {
        view.setFullYear(+el.dataset.y);
        renderMonthYear();
      }));
      pop.querySelectorAll('.dp-month').forEach(el => el.addEventListener('click', () => {
        view.setMonth(+el.dataset.mi);
        renderDay();
      }));
      pop.querySelector('[data-act="back"]')?.addEventListener('click', () => { renderDay(); });
    }

    function open() { place(); renderDay(); pop.style.display = 'block'; input.classList.add('open'); }
    function close() { pop.style.display = 'none'; input.classList.remove('open'); }

    // 全部监听挂载同一个 signal，unmountAll 时一次 abort 全解绑
    const _sig = { signal: _ac.signal };
    input.addEventListener('mousedown', (e) => e.preventDefault(), _sig); // 避免 mousedown 让 input 失焦
    input.addEventListener('click', (e) => { e.stopPropagation(); pop.style.display === 'block' ? close() : open(); }, _sig);
    document.addEventListener('mousedown', (e) => { if (!pop.contains(e.target) && e.target !== input) close(); }, _sig);
    window.addEventListener('resize', () => { if (pop.style.display === 'block') close(); }, _sig);
  }

  function unmountAll() {
    // 🟢 v208 AUDIT-105：先 abort 全部监听（document/window 上的匿名回调否则永久驻留），
    //   再移除浮层，并清掉 input 上的挂载标记 —— 旧代码漏掉这一步，导致同一 input 元素
    //   再次 mount 时被 `dpMounted === '1'` 挡住，日期框点击无反应。
    _controllers.forEach(ac => { try { ac.abort(); } catch (e) { /* 已 abort 忽略 */ } });
    _controllers.clear();
    document.querySelectorAll('.dp-pop').forEach(p => p.remove());
    document.querySelectorAll('input.dp-input[data-dp-mounted="1"]').forEach(inp => {
      delete inp.dataset.dpMounted;
      if (inp.__dpPop) { try { delete inp.__dpPop; } catch (e) { /* 只读属性忽略 */ } }
      inp.classList.remove('open');
    });
  }

  return { mount, unmountAll };
})();

// 兼容非模块脚本直接引用
if (typeof window !== 'undefined') window.DatePicker = DatePicker;
