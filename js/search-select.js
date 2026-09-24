/*
 * search-select.js  —  轻量模糊搜索下拉组件（零依赖）
 * 用途：把原生 <select> 的长列表（供应商/项目等）增强为可输入搜索的下拉，
 *       同时保留原生 <select> 元素与 select.value，业务代码读取方式不变。
 * 用法：
 *   const ss = new SearchSelect(document.getElementById('recSupplier'), {placeholder:'搜索供应商'});
 *   // 动态选项变化后调用 ss.sync() 同步
 * 设计要点：
 *   1. 原生 select 仅隐藏（visibility:hidden + 绝对定位占位），DOM 值仍存在
 *   2. 选中项写回 select.value 并派发 change 事件
 *   3. 默认项（value="" 的"全部"项）始终在面板顶部，初始即选中"全部"
 *   4. 支持键盘：↑↓ 移动、Enter 选中、Esc 关闭、Backspace 清空到"全部"
 *   5. 模糊匹配：子串包含（大小写不敏感）；匹配以"全都排前"优先
 */

class SearchSelect {
  constructor(selectEl, opts = {}) {
    if (!selectEl) return;
    this.select = selectEl;
    this.placeholder = opts.placeholder || selectEl.title || '搜索…';
    this.placeholderEmpty = opts.placeholderEmpty || this._firstEmptyText() || '全部';
    this.onChange = opts.onChange || null;
    // 宽度策略：full = 完整显示最长项 / half = 一半 / auto = 自适应 / fit = 紧凑自适应（按最长选项文本实宽）
    this.widthMode = opts.widthMode || 'auto';
    this.width = opts.width || null;
    // 🟢 v229.14：紧凑外观（分页栏「每页条数」）—— 触发器/面板缩内边距
    this.compact = !!opts.compact;
    this.open = false;
    this.activeIdx = 0;
    this._build();
    this.sync();
    // 监听原生 select 被外部改动（如重置按钮、段切换重渲染）
    this._observer = new MutationObserver(() => this.sync());
    this._observer.observe(this.select, { childList: true, attributes: true, subtree: true });
  }

  _firstEmptyText() {
    const def = this.select.querySelector('option[value=""]');
    return def ? def.textContent.trim() : '';
  }

  _computeWidth() {
    if (this.width) return this.width;
    // 🟢 v229.15 fit：按最长选项文本实宽紧凑自适应（CJK 12px / ASCII 7px + 对称 chrome 28px，配 11.5px 字号）
    if (this.widthMode === 'fit') {
      const opts = Array.from(this.select.options).filter(o => o.value !== '');
      const texts = opts.map(o => o.textContent.trim());
      if (this.placeholder) texts.push(this.placeholder);
      if (!texts.length) return '50px';
      const px = t => Array.from(t).reduce((s, ch) => s + (ch.charCodeAt(0) > 255 ? 12 : 7), 0);
      const widest = Math.max(...texts.map(px));
      return Math.ceil(widest + 28) + 'px';
    }
    const opts = Array.from(this.select.options).filter(o => o.value !== '');
    if (!opts.length) return '160px';
    const longest = opts.reduce((a, b) => b.textContent.length > a.textContent.length ? b : a);
    const len = longest.textContent.length;
    // 中文 ~13px / 字符，含 padding 28px + caret 24px
    const pxPerChar = 13;
    const full = Math.ceil(len * pxPerChar + 52);
    if (this.widthMode === 'half') return Math.ceil(full / 2) + 'px';
    return full + 'px';
  }

  _build() {
    console.log('[ESS] _build for', this.select.id);
    // 包裹容器
    const wrap = document.createElement('div');
    // 🟢 v229.14：显式 width 时加 ss-fixed（CSS 端 min-width:0），避免 .ss-wrap 150px 最小宽覆盖此 width；
    // compact 时加 ss-compact（CSS 端缩触发器/面板内边距）
    wrap.className = 'ss-wrap ss-mode-' + this.widthMode
      + (this.width ? ' ss-fixed' : '')
      + (this.compact ? ' ss-compact' : '');
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-block';
    wrap.style.flex = '0 0 auto';
    wrap.style.width = this._computeWidth();
    // 把原生 select 缩成占位（保留值/尺寸）
    this.select.style.position = 'absolute';
    this.select.style.opacity = '0';
    this.select.style.width = '100%';
    this.select.style.height = '100%';
    this.select.style.fontSize = '16px'; // 避免 iOS 缩放
    this.select.style.border = 'none';
    this.select.style.padding = '0';
    this.select.style.margin = '0';
    this.select.style.top = '0';
    this.select.style.left = '0';
    this.select.style.zIndex = '1';
    this.select.classList.add('ss-native');

    // 🟢 S1（v228.98）：触发框由 <button> 改为 <input type="text"> —— 打开后原地变为可输入搜索框，
    //   搜索框即下拉框本身，不再插入第二个浮层元素（旧 .ss-search-input），布局零位移。
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ss-trigger';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-haspopup', 'listbox');
    input.setAttribute('aria-expanded', 'false');
    input.readOnly = true;                 // 关闭态只读，点击打开后变可输入
    input.tabIndex = 0;

    const panel = document.createElement('div');
    panel.className = 'ss-panel';
    panel.setAttribute('role', 'listbox');
    panel.style.display = 'none';

    // 先占位：把空 wrap 插到 select 之前（此时 wrap 与 select 平级，无父子环）
    this.select.parentNode.insertBefore(wrap, this.select);
    // 再把 select 移入 wrap，并加入 trigger / panel
    wrap.appendChild(this.select);
    wrap.appendChild(input);
    wrap.appendChild(panel);

    this.wrap = wrap;
    this.input = input;
    this.panel = panel;

    // 事件
    // 点击：关闭态才打开（打开态点击用于移动光标，不关）；键盘/输入统一接管
    input.addEventListener('click', (e) => { e.stopPropagation(); if (!this.open) this.openPanel(); });
    input.addEventListener('keydown', (e) => this._onKey(e));
    input.addEventListener('input', () => this._onQuery(this.input.value));
    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.ss-item');
      if (item) this._choose(item.dataset.val);
    });
    this._docHandler = (e) => { if (!wrap.contains(e.target)) this.close(); };
    document.addEventListener('click', this._docHandler);
  }

  // 同步原生 option 到内部列表，并刷新显示
  sync() {
    this.items = Array.from(this.select.options).map(o => ({
      value: o.value,
      text: o.textContent.trim(),
      isDefault: o.value === ''
    }));
    this._renderTrigger();
    if (this.open) this._renderPanel(this._filter(this.input ? this._lastQuery || '' : ''));
  }

  _renderTrigger() {
    const sel = this.select;
    const val = sel.value;
    const opt = Array.from(sel.options).find(o => o.value === val);
    const txt = opt ? opt.textContent.trim() : this.placeholderEmpty;
    this.input.setAttribute('aria-expanded', this.open ? 'true' : 'false');
    if (this.open) return;            // 打开态：保留用户正在输入的搜索词，不回写所选文本
    this.input.value = txt;
    this.input.readOnly = true;
    this.input.classList.toggle('ss-placeholder', val === '');
    this.input.title = txt;
  }

  _filter(q) {
    q = (q || '').trim().toLowerCase();
    const list = this.items;
    if (!q) return list; // 无查询：含默认"全部"项（排第一）
    // 有查询：只显示匹配项（不含默认项），Enter 直接选中首个匹配
    const matched = list.filter(it => !it.isDefault && it.text.toLowerCase().includes(q));
    // 按匹配位置排序：前缀匹配优先
    matched.sort((a, b) => {
      const ai = a.text.toLowerCase().indexOf(q);
      const bi = b.text.toLowerCase().indexOf(q);
      return ai - bi;
    });
    return matched;
  }

  _renderPanel(list) {
    this.panel.innerHTML = '';
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'ss-empty';
      empty.textContent = '无匹配项';
      this.panel.appendChild(empty);
      this.activeIdx = -1;
      return;
    }
    list.forEach((it, i) => {
      const el = document.createElement('div');
      el.className = 'ss-item' + (it.isDefault ? ' ss-default' : '') + (i === this.activeIdx ? ' ss-active' : '');
      el.dataset.val = it.value;
      el.setAttribute('role', 'option');
      el.textContent = it.text;
      this.panel.appendChild(el);
    });
  }

  // 🟢 S1（v228.98）：输入即筛选 —— 复用 _lastQuery + 防抖（与旧搜索框逻辑一致），键盘 Enter 同步
  _onQuery(q) {
    this._lastQuery = q;
    this.activeIdx = 0;
    if (!this._renderDebounced) {
      this._renderDebounced = (typeof TableUtils !== 'undefined' && TableUtils.debounce)
        ? TableUtils.debounce(() => {
            this._renderPanel(this._filter(this._lastQuery || ''));
            const act = this.panel.querySelector('.ss-active');
            if (act) act.scrollIntoView({ block: 'nearest' });
          }, 200)
        : null;
    }
    if (this._renderDebounced) this._renderDebounced();
    else {
      this._renderPanel(this._filter(q || ''));
      const act = this.panel.querySelector('.ss-active');
      if (act) act.scrollIntoView({ block: 'nearest' });
    }
  }

  _onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.open) { this.openPanel(); return; }
      this._move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.open) {
        const list = this._filter(this._lastQuery || '');
        const it = list[this.activeIdx];
        if (it) this._choose(it.value);
      } else {
        this.openPanel();
      }
    } else if (e.key === 'Escape') {
      this.close();
    }
  }

  _move(dir) {
    const list = this._filter(this._lastQuery || '');
    if (!list.length) return;
    let i = this.activeIdx + dir;
    if (i < 0) i = 0;
    if (i >= list.length) i = list.length - 1;
    this.activeIdx = i;
    this._renderPanel(list);
    const act = this.panel.querySelector('.ss-active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }

  _choose(val) {
    this.select.value = val;
    this._renderTrigger();
    this.close();
    // 派发 change 事件，确保依赖 select.value 的逻辑（含 reset 之外的监听）生效
    this.select.dispatchEvent(new Event('change', { bubbles: true }));
    if (this.onChange) this.onChange(val);
  }

  toggle() { this.open ? this.close() : this.openPanel(); }

  openPanel() {
    // 🟢 v229.05 单开互斥：打开任一下拉前，先收起其他已展开的下拉实例
    //   （SearchSelect 是全工作台下拉的统一实现，此处一处修改即全局生效：
    //    筛选栏/弹窗/分页的所有下拉，同一时刻至多展开一个）
    if (window._ssRegistry) {
      for (const k in window._ssRegistry) {
        const o = window._ssRegistry[k];
        if (o && o !== this && o.open) { try { o.close(); } catch (e) { /* 单个异常不影响本次打开 */ } }
      }
    }
    this.open = true;
    this._lastQuery = '';
    this.activeIdx = 0;
    this.select.style.visibility = 'hidden';
    // 🟢 S1（v228.98）：触发框（input）原地变搜索框 —— 取消只读、清空，直接接收键盘输入
    this.input.readOnly = false;
    this.input.value = '';
    this.input.classList.remove('ss-placeholder');
    this.input.setAttribute('aria-expanded', 'true');
    this.panel.style.display = 'block';
    this._renderPanel(this._filter(''));
    this.input.focus();
    try { this.input.select(); } catch (e) {}   // 桌面端选中全部便于覆盖；移动端无副作用
  }

  close() {
    this.open = false;
    this.panel.style.display = 'none';
    this.input.classList.remove('ss-open');
    this.select.style.visibility = '';
    this._renderTrigger();          // 回写所选文本并恢复只读
  }

  destroy() {
    document.removeEventListener('click', this._docHandler);
    if (this._observer) this._observer.disconnect();
    if (this.wrap && this.wrap.parentNode) {
      this.wrap.parentNode.insertBefore(this.select, this.wrap);
      this.wrap.parentNode.removeChild(this.wrap);
    }
    this.select.classList.remove('ss-native');
    this.select.style.cssText = '';
  }
}

window.SearchSelect = SearchSelect;

// 全局注册表，避免重复初始化；调用 enhanceSearchSelect(id, opts) 升级单个
// 注意：无论传入字符串 id 还是元素，内部一律以「元素自身的稳定 id」为注册键，
// 避免把不同 select 都序列化成 "[object HTMLSelectElement]" 撞键（曾导致只包住最后处理的 1 个）。
window._ssRegistry = window._ssRegistry || {};
window.enhanceSearchSelect = function (id, opts) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return null;
  if (!el.id) el.id = 'autoSs_' + (++window._autoSsSeq);
  const key = el.id;
  const cached = window._ssRegistry[key];
  // 重入检测：元素已不在组件 wrap 内（render 重建了 DOM）→ 销毁旧实例重建
  if (cached) {
    if (el.closest && el.closest('.ss-wrap')) return cached; // 仍有效
    try { cached.destroy(); } catch (e) {
      console.warn('[search-select.js] 异常(已忽略):', e);
    }
    delete window._ssRegistry[key];
  }
  const ss = new SearchSelect(el, opts);
  window._ssRegistry[key] = ss;
  return ss;
};
// 🗑 AUDIT-228-06（v228.18）：删除死代码 enhanceSearchSelects —— 全仓零引用
//   （js/ 与 index.html 均无调用），保留只有维护负担。批量升级如需恢复，
//   可用一行替代：(list||[]).forEach(it => window.enhanceSearchSelect(it.id, it.opts));

// ============================================
// 🟢 v229.05：全工作台下拉统一器
// 以订单跟踪的 search-select 毛玻璃下拉为唯一模板，自动升级三类原生 <select>：
//   1) 筛选栏（.filter-bar）—— 库存预警分类/状态、盘点记录、供应商筛选等全部模块
//   2) 弹窗（.modal-overlay）—— 权限预设(kePreset)、盘点分派/补派盘点人(asCounter/rsCounter)
//   3) 分页栏（.pagination-bar）—— 各模块「每页条数」
// MutationObserver 监听 DOM：模块渲染 / 弹窗打开后自动增强，无需各模块逐个接入。
// 豁免：select.closest('.no-auto-ss') 显式退出；表格行内 select（出库录入等）暂不纳入。
// ============================================
window._autoSsSeq = 0;
window.autoEnhanceSelects = function (root) {
  const scope = root || document;
  let n = 0;
  scope.querySelectorAll('select').forEach(sel => {
    if (sel.classList.contains('ss-native')) return;   // 已增强
    if (sel.closest('.ss-wrap')) return;               // 已在组件内
    if (sel.multiple || sel.disabled) return;
    if (sel.closest('.no-auto-ss')) return;            // 显式豁免
    const inFilter = !!sel.closest('.filter-bar');
    const inModal  = !!sel.closest('.modal-overlay');
    const inPager  = !!sel.closest('.pagination-bar');
    if (!inFilter && !inModal && !inPager) return;
    if (!sel.id) sel.id = 'autoSs_' + (++window._autoSsSeq);
    const opts = { placeholder: sel.title || '搜索…' };
    // 🟢 v229.14：紧凑自适应——宽度按最长选项文本实宽（fit），外观紧凑（ss-compact）
    if (inPager) { opts.widthMode = 'fit'; opts.compact = true; opts.placeholder = '每页'; }
    // 传字符串 id（而非元素），使 enhanceSearchSelect 以 el.id 为稳定注册键，杜绝撞键
    try { window.enhanceSearchSelect(sel.id, opts); n++; } catch (e) { /* 单个失败不影响其余 */ }
  });
  return n;
};

(function () {
  if (window.__autoSsObserver) return;
  window.__autoSsObserver = true;
  let timer = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        // 有新增强时重跑移动端筛选栏等分（增强会重建 DOM 结构）
        if (window.autoEnhanceSelects(document) > 0 && window.FilterLayout) FilterLayout.balanceAll();
      } catch (e) { /* 静默：增强失败不影响原功能 */ }
    }, 120);
  });
  function start() {
    if (!document.body) { setTimeout(start, 50); return; }
    obs.observe(document.body, { childList: true, subtree: true });
    // 首轮：接管脚本加载前已渲染的静态 select
    setTimeout(() => {
      try { window.autoEnhanceSelects(document); } catch (e) { /* 静默 */ }
    }, 300);
  }
  start();
})();
