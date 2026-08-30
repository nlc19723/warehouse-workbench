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
    // 宽度策略：full = 完整显示最长项 / half = 一半 / auto = 自适应
    this.widthMode = opts.widthMode || 'auto';
    this.width = opts.width || null;
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
    // 包裹容器
    const wrap = document.createElement('div');
    wrap.className = 'ss-wrap ss-mode-' + this.widthMode;
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

    const input = document.createElement('button');
    input.type = 'button';
    input.className = 'ss-trigger';
    input.setAttribute('aria-haspopup', 'listbox');
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
    input.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    input.addEventListener('keydown', (e) => this._onKey(e));
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
    this.input.textContent = txt;
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
    this.open = true;
    this._lastQuery = '';
    this.activeIdx = 0;
    this.select.style.visibility = 'hidden';
    this.input.style.display = 'none';
    this.panel.style.display = 'block';
    this._renderPanel(this._filter(''));
    if (!this._searchInput) {
      const si = document.createElement('input');
      si.className = 'ss-search-input';
      si.type = 'text';
      si.placeholder = this.placeholder;
      si.addEventListener('click', (e) => e.stopPropagation());
      si.addEventListener('input', () => {
        this._lastQuery = si.value;
        this.activeIdx = 0;
        this._renderPanel(this._filter(si.value));
      });
      si.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          const list = this._filter(this._lastQuery || '');
          const it = list[this.activeIdx];
          if (it) this._choose(it.value);
        } else if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
      });
      this.wrap.appendChild(si);
      this._searchInput = si;
    }
    this._searchInput.value = '';
    this._searchInput.style.display = 'block';
    this._searchInput.focus();
  }

  close() {
    this.open = false;
    this.panel.style.display = 'none';
    this.input.classList.remove('ss-open');
    this.select.style.visibility = '';
    if (this._searchInput) this._searchInput.style.display = 'none';
    this.input.style.display = '';
    this._renderTrigger();
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
window._ssRegistry = window._ssRegistry || {};
window.enhanceSearchSelect = function (id, opts) {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return null;
  const cached = window._ssRegistry[id];
  // 重入检测：元素已不在组件 wrap 内（render 重建了 DOM）→ 销毁旧实例重建
  if (cached) {
    if (el.closest && el.closest('.ss-wrap')) return cached; // 仍有效
    try { cached.destroy(); } catch (e) {
    console.warn('[search-select.js:276] 异常(已忽略):', e);
  }
    delete window._ssRegistry[id];
  }
  const ss = new SearchSelect(el, opts);
  window._ssRegistry[id] = ss;
  return ss;
};
// 批量升级（传入 [{id, placeholder}]）
window.enhanceSearchSelects = function (list) {
  (list || []).forEach(it => window.enhanceSearchSelect(it.id, it.opts));
};
