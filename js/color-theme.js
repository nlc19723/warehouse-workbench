// js/color-theme.js — 表格配色引擎（v159）
// 能力：5 套预设 + 单组微调 + 按列上色 + 按单元格条件上色 + 暗色自动反相
// 配置存 localStorage('ocColorConfig')；颜色以 CSS 变量 / 内联 style 注入
(function () {
  'use strict';

  // 5 套预设（每组：元数据 meta / 库存参考 stock / 结果 result，各 {bg, fg}）
  const PALETTES = {
    sky:    { name: '晴空橙光',     meta: { bg: '#DCEEF8', fg: '#1387C0' }, stock: { bg: '#FAEDD1', fg: '#C73E00' }, result: { bg: '#FDE4D6', fg: '#C73E00' } },
    paper:  { name: '纸红复古',     meta: { bg: '#F1E6D8', fg: '#28314E' }, stock: { bg: '#DEE2EC', fg: '#28314E' }, result: { bg: '#F2D7DB', fg: '#AA2B3A' } },
    purple: { name: '紫莺金灰',     meta: { bg: '#ECE3F4', fg: '#7953B1' }, stock: { bg: '#F2F2F2', fg: '#7953B1' }, result: { bg: '#FEF3D0', fg: '#B88B00' } },
    wheat:  { name: '麦浪青野',     meta: { bg: '#F1ECE0', fg: '#117C0D' }, stock: { bg: '#DCEEDD', fg: '#117C0D' }, result: { bg: '#FCEBC8', fg: '#B58728' } },
    antique: { name: '古纸鎏金朱红', meta: { bg: '#F8EBD4', fg: '#B22A2A' }, stock: { bg: '#FAF0DA', fg: '#B22A2A' }, result: { bg: '#F4D5D2', fg: '#B22A2A' } },
  };

  const STORAGE_KEY = 'ocColorConfig';
  const DEFAULT_CFG = {
    version: 1,
    preset: 'sky',          // sky | paper | purple | wheat | antique | custom
    overrides: null,        // { meta:{bg,fg}, stock:{bg,fg}, result:{bg,fg} }
    scope: {
      tables: ['orderCheck'],        // 作用表 key；'*' = 全部已接入表
      dimension: 'group',            // group | column | cell
      columns: [],                   // 列维度：列名数组
      columnColors: { bg: '#DCEEF8', fg: '#1387C0' }, // 列维度共享配色
      cellRules: [],                 // 单元格维度：{ column, op:'contains'|'equals', value, colors:{bg,fg} }
    },
  };

  // ---------- 颜色工具 ----------
  function hexToRgb(h) {
    h = (h || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
  }
  function mix(c1, c2, t) {
    const a = hexToRgb(c1), b = hexToRgb(c2);
    return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }
  // 亮色组色 → 暗色反相（深底亮字）
  function invertGroup(g) {
    return { bg: mix(g.bg, '#0f172a', 0.82), fg: mix(g.fg, '#e2e8f0', 0.55) };
  }

  // ---------- 配置读写 ----------
  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_CFG));
      const cfg = JSON.parse(raw);
      cfg.scope = Object.assign({}, DEFAULT_CFG.scope, cfg.scope || {});
      if (!Array.isArray(cfg.scope.columns)) cfg.scope.columns = [];
      if (!Array.isArray(cfg.scope.cellRules)) cfg.scope.cellRules = [];
      if (!Array.isArray(cfg.scope.tables) || !cfg.scope.tables.length) cfg.scope.tables = ['orderCheck'];
      if (!cfg.scope.columnColors) cfg.scope.columnColors = { bg: '#DCEEF8', fg: '#1387C0' };
      return cfg;
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_CFG));
    }
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) {
    console.warn('[color-theme.js:66] 异常(已忽略):', e);
  }
  }

  // 合并 preset + overrides → 实际组色
  function activeGroupColors(cfg, isDark) {
    const base = PALETTES[cfg.preset] ? PALETTES[cfg.preset] : PALETTES.sky;
    const out = {
      meta: Object.assign({}, base.meta),
      stock: Object.assign({}, base.stock),
      result: Object.assign({}, base.result),
    };
    if (cfg.overrides) {
      for (const g of ['meta', 'stock', 'result']) {
        if (cfg.overrides[g]) out[g] = Object.assign({}, out[g], cfg.overrides[g]);
      }
    }
    if (isDark) {
      out.meta = invertGroup(out.meta);
      out.stock = invertGroup(out.stock);
      out.result = invertGroup(out.result);
    }
    return out;
  }

  function isDarkNow() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  // 注入分组变量到 <html>
  function applyGroupVars(cfg) {
    const dark = isDarkNow();
    const c = activeGroupColors(cfg, dark);
    const root = document.documentElement;
    const set = (k, v) => root.style.setProperty(k, v);
    set('--oc-meta-bg', c.meta.bg); set('--oc-meta-fg', c.meta.fg); set('--oc-meta-bd', dark ? mix(c.meta.bg, '#ffffff', 0.15) : mix(c.meta.bg, '#000', 0.12));
    set('--oc-stock-bg', c.stock.bg); set('--oc-stock-fg', c.stock.fg); set('--oc-stock-bd', dark ? mix(c.stock.bg, '#ffffff', 0.15) : mix(c.stock.bg, '#000', 0.12));
    set('--oc-result-bg', c.result.bg); set('--oc-result-fg', c.result.fg); set('--oc-result-bd', dark ? mix(c.result.bg, '#ffffff', 0.15) : mix(c.result.bg, '#000', 0.12));
  }

  // 找列索引（按 thead th 文本）
  function colIndex(tableEl, colName) {
    const ths = tableEl.querySelectorAll('thead th');
    for (let i = 0; i < ths.length; i++) {
      if (ths[i].textContent.trim() === colName) return i;
    }
    return -1;
  }

  function clearTint(tableEl) {
    tableEl.querySelectorAll('td.oc-tint').forEach(td => {
      td.classList.remove('oc-tint');
      td.style.background = '';
      td.style.color = '';
    });
  }

  function tintCell(td, colors, dark) {
    const bg = dark ? mix(colors.bg, '#0f172a', 0.82) : colors.bg;
    const fg = dark ? mix(colors.fg, '#e2e8f0', 0.55) : colors.fg;
    td.classList.add('oc-tint');
    td.style.background = bg;
    td.style.color = fg;
  }

  // 按 scope 给单表上色（列 / 单元格维度）
  function tintTable(tableEl, cfg) {
    clearTint(tableEl);
    const dark = isDarkNow();
    const sc = cfg.scope;
    if (sc.dimension === 'column') {
      const colors = sc.columnColors || { bg: '#DCEEF8', fg: '#1387C0' };
      (sc.columns || []).forEach(col => {
        const idx = colIndex(tableEl, col);
        if (idx < 0) return;
        tableEl.querySelectorAll('tbody tr').forEach(tr => {
          const td = tr.children[idx];
          if (td) tintCell(td, colors, dark);
        });
      });
    } else if (sc.dimension === 'cell') {
      (sc.cellRules || []).forEach(rule => {
        const idx = colIndex(tableEl, rule.column);
        if (idx < 0) return;
        const colors = rule.colors || { bg: '#eeeeee', fg: '#666666' };
        tableEl.querySelectorAll('tbody tr').forEach(tr => {
          const td = tr.children[idx];
          if (!td) return;
          const txt = (td.textContent || '').trim();
          const hit = rule.op === 'equals' ? txt === rule.value : txt.includes(rule.value);
          if (hit) tintCell(td, colors, dark);
        });
      });
    }
  }

  function tableKeyOf(tableEl) {
    return tableEl.getAttribute('data-table-key') || '';
  }

  // 全站重绘
  function repaintAll() {
    const cfg = loadConfig();
    applyGroupVars(cfg);
    const sc = cfg.scope;
    document.querySelectorAll('.data-table').forEach(tableEl => {
      const key = tableKeyOf(tableEl);
      const inScope = sc.tables.indexOf('*') >= 0 || sc.tables.indexOf(key) >= 0;
      if (inScope) tintTable(tableEl, cfg);
      else clearTint(tableEl);
    });
  }

  function applyAndSave(cfg) {
    saveConfig(cfg);
    repaintAll();
  }

  window.ColorTheme = {
    PALETTES, DEFAULT_CFG, STORAGE_KEY,
    loadConfig, saveConfig, applyAndSave, repaintAll, applyGroupVars,
    activeGroupColors, invertGroup, colIndex, tintTable, clearTint, isDarkNow,
  };

  // 主题切换（data-theme 变化）自动重绘（暗色反相）
  if (typeof MutationObserver !== 'undefined') {
    const _obs = new MutationObserver(() => {
      try { repaintAll(); } catch (e) {
    console.warn('[color-theme.js:192] 异常(已忽略):', e);
  }
    });
    _obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
})();
