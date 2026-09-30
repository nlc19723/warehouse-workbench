// 🟢 v227.74：移动端筛选栏布局助手
// 作用：把同一「文本框行」(.fb-row--fields) 内的下拉框 (.fb-field)，
//      按其内部最长 <option> 文本字符长度动态分配 flex-grow 比例，
//      使「全部供应商」(5字) 比「全部类型」(4字) 宽度更宽、且两者始终对齐到行宽。
// 仅在移动端（≤768px）生效，PC 端跳过（避免 JS 把 inline flex 写到 PC 端，破坏桌面横向流）。
// 调用：各模块 render 末尾执行 FilterLayout.balanceAll()
window.FilterLayout = (function () {
  // 🟢 v227.74：阈值从 560 → 768，与 CSS @media (max-width:768px) 同步
  // —— 561-768 区间也走纵向 flex-column 模式，需要按选项长度分配 flex 比例
  function isMobile() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 768px)').matches;
  }
  function textLen(s) { return (s || '').trim().length; }

  // 取一个 select 内最长 option 文本长度（含被 search-select 组件隐藏的原生 select）
  function longestOpt(sel) {
    let m = 1;
    for (const o of sel.options) m = Math.max(m, textLen(o.textContent));
    return m;
  }

  function balanceRow(row) {
    const fields = [...row.children].filter(c => c.classList && c.classList.contains('fb-field'));
    if (fields.length < 2) { fields.forEach(f => { f.style.flex = '1 1 0'; }); return; }
    const lens = fields.map(f => {
      const sel = f.querySelector('select');
      return sel ? longestOpt(sel) : Math.max(1, textLen(f.textContent));
    });
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    fields.forEach((f, i) => { f.style.flex = (lens[i] / total * 100).toFixed(2) + ' 1 0'; });
  }

  function balance(container) {
    if (!container || !isMobile()) return;
    container.querySelectorAll('.fb-row--fields').forEach(balanceRow);
  }

  // 全局扫描所有 .filter-bar-m（单页同时仅一个内容区，安全）
  function balanceAll(root) {
    if (!isMobile()) return;
    (root || document).querySelectorAll('.filter-bar-m').forEach(balance);
  }

  return { balance, balanceAll, isMobile };
})();
