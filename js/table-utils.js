// ============================================
// 智能单元格选择 + 浮动汇总提示工具 + Excel式表头排序筛选
// ============================================

const TableUtils = {
  // 数值列检测关键词（中文列名）
  NUMERIC_KEYWORDS: ['数量', '金额', '单价', '价格', '占比', '天数', '次数', '率', '存量', '入库量', '订货量', '周转', '总量', '库存', '可用量', '无法使用量', '在途', '比例', '合计', '总价', '月均', '扣款', '延迟'],

  /**
   * 初始化 Excel 式表头：点击排序(升/降/无) + 筛选图标弹出关键词搜索
   * 直接基于当前页渲染的 DOM 表格操作，稳健适配所有模块（不依赖 JS 数据数组）
   * @param {string} containerId - 表格容器ID（内含 .data-table）
   */
  initSortableHeaders(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const table = container.querySelector('.data-table');
    if (!table) return;
    const thead = table.querySelector('thead');
    if (!thead) return;

    const ths = thead.querySelectorAll('th');
    let currentSortCol = -1;   // 当前排序列索引
    let currentSortDir = 0;     // 0=无, 1=升序, 2=降序
    const columnFilters = {};   // { colIdx: 关键词 }

    ths.forEach((th, colIdx) => {
      const originalText = th.textContent.trim();
      th.innerHTML = `
        <span class="th-sort-label">${originalText}</span>
        <span class="th-filter-icon" data-col="${colIdx}" title="筛选 / 排序">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M2 4 L6 8 L10 4 Z"/></svg>
        </span>
      `;
      th.style.cursor = 'pointer';

      const filterIcon = th.querySelector('.th-filter-icon');

      // 点击 ▾ 图标：弹出 Excel 风格筛选面板（首次点击=打开面板）
      filterIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showFilterPopup(th, colIdx, columnFilters, (filterState) => {
          columnFilters[colIdx] = filterState;
          const hasActive = !!filterState && (
            !!filterState.kw ||
            (filterState.unchecked && filterState.unchecked.length > 0) ||
            (filterState.checked && filterState.checked.length === 0)
          );
          filterIcon.classList.toggle('active', hasActive);
          this._applyTableSortAndFilter(table, currentSortCol, currentSortDir, columnFilters);
        });
      });

      // 点击表头文字：切换排序（升序 → 降序 → 取消），与 ▾ 筛选分离
      const labelEl = th.querySelector('.th-sort-label');
      if (labelEl) {
        labelEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (currentSortCol === colIdx) {
            currentSortDir = currentSortDir === 1 ? 2 : currentSortDir === 2 ? 0 : 1;
          } else {
            currentSortDir = 1;
          }
          currentSortCol = currentSortDir === 0 ? -1 : colIdx;
          this._refreshArrowState(ths, currentSortCol, currentSortDir);
          this._applyTableSortAndFilter(table, currentSortCol, currentSortDir, columnFilters);
        });
      }
    });

    // 全局点击关闭筛选弹窗（仅绑定一次，避免重复监听）
    if (!TableUtils._outsideBound) {
      document.addEventListener('mousedown', (e) => {
        if (TableUtils._filterPopup && !TableUtils._filterPopup.contains(e.target)) {
          TableUtils._hideFilterPopup();
        }
      });
      TableUtils._outsideBound = true;
    }
  },

  _refreshArrowState(ths, col, dir) {
    ths.forEach((th, i) => {
      const label = th.querySelector('.th-sort-label');
      if (!label) return;
      // 重置所有表头样式
      label.classList.remove('sort-asc', 'sort-desc');
      label.style.color = '';
      // 当前排序列高亮
      if (i === col) {
        if (dir === 1) { label.classList.add('sort-asc'); label.style.color = 'var(--primary,#4a7ce8)'; }
        else if (dir === 2) { label.classList.add('sort-desc'); label.style.color = 'var(--primary,#4a7ce8)'; }
        else { label.style.color = ''; }
      }
    });
  },

  _applyTableSortAndFilter(table, sortCol, sortDir, filters) {
    const tbody = table.querySelector('tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));

    // 1) 重置可见性
    rows.forEach(tr => { tr.style.display = ''; });

    // 2) 值集合筛选 + 关键词筛选（多列叠加生效）
    Object.entries(filters).forEach(([ci, fs]) => {
      if (!fs) return;
      const col = parseInt(ci, 10);

      // 新格式：{ checked, unchecked, kw } — 基于复选框值集合过滤
      if (fs.checked !== undefined) {
        const checkedSet = new Set(fs.checked.map(v => v.toLowerCase()));
        const uncheckedSet = new Set(fs.unchecked?.map(v => v.toLowerCase()) || []);
        rows.forEach(tr => {
          const td = tr.children[col];
          const val = td ? td.textContent.trim() : '';
          const valLower = val.toLowerCase();
          // 如果有未勾选项（排除模式）：隐藏匹配未勾选的行
          // 如果无未勾选项但有勾选项（包含模式）：隐藏不在勾选中的行
          if (uncheckedSet.size > 0) {
            if (uncheckedSet.has(valLower)) tr.style.display = 'none';
          } else if (checkedSet.size > 0 && fs.checked.length < (fs.totalCount || 0)) {
            if (!checkedSet.has(valLower)) tr.style.display = 'none';
          }
        });
        // 同时应用关键词二次过滤
        if (fs.kw) {
          const k = fs.kw.toLowerCase();
          rows.forEach(tr => {
            if (tr.style.display === 'none') return;
            const td = tr.children[col];
            const val = td ? td.textContent.toLowerCase() : '';
            if (!val.includes(k)) tr.style.display = 'none';
          });
        }
        return;
      }

      // 旧格式兼容：纯关键词字符串
      const kw = typeof fs === 'string' ? fs : (fs.kw || '');
      if (!kw) return;
      const k = kw.toLowerCase();
      rows.forEach(tr => {
        const td = tr.children[col];
        const val = td ? td.textContent.toLowerCase() : '';
        if (!val.includes(k)) tr.style.display = 'none';
      });
    });

    // 3) 排序（仅对可见行原地重排）
    if (sortDir !== 0 && sortCol >= 0) {
      const visible = rows.filter(tr => tr.style.display !== 'none');
      visible.sort((a, b) => {
        const va = this._cellToComparable(a.children[sortCol]);
        const vb = this._cellToComparable(b.children[sortCol]);
        if (typeof va === 'number' && typeof vb === 'number') {
          return sortDir === 1 ? va - vb : vb - va;
        }
        const sa = String(va), sb = String(vb);
        return sortDir === 1 ? sa.localeCompare(sb, 'zh') : sb.localeCompare(sa, 'zh');
      });
      visible.forEach(tr => tbody.appendChild(tr));
    }
  },

  _cellToComparable(td) {
    if (!td) return '';
    const raw = (td.textContent || '').trim();
    if (raw === '' || raw === '-' || raw === '—' || raw === '/') return raw;
    // 去掉货币符号/千分位/百分号后尝试数值比较
    const cleaned = raw.replace(/[¥$￥,\s，%]/g, '');
    if (cleaned === '') return raw;
    const n = parseFloat(cleaned);
    if (!isNaN(n)) return n;
    return raw;
  },

  _showFilterPopup(th, colIdx, currentFilters, onConfirm) {
    this._hideFilterPopup();
    const rect = th.getBoundingClientRect();
    const table = th.closest('.data-table');
    const tbody = table ? table.querySelector('tbody') : null;
    const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];

    // 收集该列所有唯一值（包含被其他列筛选隐藏的行，确保选项不丢失）
    const valueMap = new Map();
    rows.forEach(tr => {
      const td = tr.children[colIdx];
      const rawVal = td ? (td.textContent || '').trim() : '';
      // 清理数值格式用于分组（如 330.29 和 330 显示为不同值）
      const displayVal = rawVal === '' ? '(空)' : rawVal;
      valueMap.set(displayVal, (valueMap.get(displayVal) || 0) + 1);
    });

    // 按值排序（数值在前，文本在后）
    const sortedValues = Array.from(valueMap.entries()).sort((a, b) => {
      const na = parseFloat(a[0]), nb = parseFloat(b[0]);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      if (!isNaN(na)) return -1;
      if (!isNaN(nb)) return 1;
      return a[0].localeCompare(b[0], 'zh');
    });

    const popupId = 'th-filter-popup-' + Date.now();
    const currentFs = currentFilters[colIdx] || null;
    // 兼容新旧格式：旧格式是字符串 keyword，新格式是 { checked, unchecked, kw }
    const currentKw = (currentFs && typeof currentFs === 'object') ? (currentFs.kw || '') : (currentFs || '');

    const popup = document.createElement('div');
    popup.className = 'excel-filter-popup';
    popup.id = popupId;
    popup.innerHTML = `
      <div class="efp-search-row">
        <input type="text" class="efp-search" placeholder="🔍 搜索筛选..." value="${currentKw}" />
      </div>
      <div class="efp-values" style="max-height:280px;overflow-y:auto;">
        ${sortedValues.length > 0 ? sortedValues.map(([val, count]) => {
          // 如果已有筛选状态，根据 checked/unchecked 列表决定初始勾选
          let isChecked = !currentKw; // 无关键词时默认全选
          if (currentFs && typeof currentFs === 'object' && currentFs.checked) {
            isChecked = currentFs.checked.includes(val);
          }
          return `
          <label class="efp-item">
            <input type="checkbox" class="efp-cb" data-val="${this._escapeAttr(val)}" ${isChecked ? 'checked' : ''} />
            <span class="efp-text">${this._escapeHtml(val)}</span>
            <span class="efp-count">(${count})</span>
          </label>`;
        }).join('') : '<div class="efp-empty">无数据</div>'}
      </div>
      <div class="efp-actions">
        <button class="efp-action-btn efp-select-all">全选</button>
        <button class="efp-action-btn efp-invert">反选</button>
        <button class="efp-action-btn efp-ok primary">确定</button>
        <button class="efp-action-btn efp-cancel">取消</button>
      </div>
    `;
    popup.style.position = 'fixed';
    // 定位在列头下方，不超出屏幕右边界
    const popupWidth = 280;
    const leftPos = Math.min(rect.left, window.innerWidth - popupWidth - 8);
    popup.style.left = leftPos + 'px';
    popup.style.top = (rect.bottom + 6) + 'px';
    popup.style.zIndex = '9999';
    popup.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(popup);

    const searchInput = popup.querySelector('.efp-search');
    const allCbs = popup.querySelectorAll('.efp-cb');

    // 搜索过滤复选列表
    searchInput.addEventListener('input', () => {
      const kw = searchInput.value.toLowerCase().trim();
      allCbs.forEach(cb => {
        const item = cb.closest('.efp-item');
        const text = cb.dataset.val.toLowerCase();
        item.style.display = (!kw || text.includes(kw)) ? '' : 'none';
      });
    });

    // 全选
    popup.querySelector('.efp-select-all').addEventListener('click', () => {
      allCbs.forEach(cb => { cb.checked = true; cb.closest('.efp-item').style.display = ''; });
    });

    // 反选
    popup.querySelector('.efp-invert').addEventListener('click', () => {
      allCbs.forEach(cb => {
        if (cb.closest('.efp-item').style.display !== 'none') {
          cb.checked = !cb.checked;
        }
      });
    });

    // 确定 → 收集复选框勾选状态 + 搜索关键词
    popup.querySelector('.efp-ok').addEventListener('click', () => {
      const checkedVals = Array.from(popup.querySelectorAll('.efp-cb:checked')).map(cb => cb.dataset.val);
      const allVals = Array.from(popup.querySelectorAll('.efp-cb')).map(cb => cb.dataset.val);
      const uncheckedVals = checkedVals.length < allVals.length
        ? allVals.filter(v => !checkedVals.includes(v)) : [];
      onConfirm({ checked: checkedVals, unchecked: uncheckedVals, kw: searchInput.value.trim(), totalCount: allVals.length });
      this._hideFilterPopup();
    });

    // 取消
    popup.querySelector('.efp-cancel').addEventListener('click', () => {
      this._hideFilterPopup();
    });

    // Enter/Escape 快捷键
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { popup.querySelector('.efp-ok').click(); }
      if (e.key === 'Escape') this._hideFilterPopup();
    });

    searchInput.focus();

    TableUtils._filterPopup = popup;
  },

  _escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  },

  _escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  _hideFilterPopup() {
    if (TableUtils._filterPopup) { TableUtils._filterPopup.remove(); TableUtils._filterPopup = null; }
  },

  /**
   * 初始化表格的智能选择功能
   * @param {string} containerId - 表格容器ID（内含 data-table）
   */
  initSmartSelect(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const table = container.querySelector('.data-table');
    if (!table) return;

    // 检测哪些列是数值列
    const numericCols = this.detectNumericColumns(table);

    let isSelecting = false;
    let selectedCells = []; // [{td, rowIdx, colIdx, value}]
    let floatTooltip = null;

    const getCellIndex = (td) => {
      const row = td.parentElement;
      const tbody = row.parentElement;
      return {
        rowIdx: Array.from(tbody.children).indexOf(row),
        colIdx: Array.from(row.children).indexOf(td)
      };
    };

    const clearSelection = () => {
      selectedCells.forEach(c => c.td.classList.remove('cell-selected'));
      selectedCells = [];
      this.hideFloatTooltip();
    };

    const updateSelection = (startCell, endCell) => {
      clearSelection();
      const start = getCellIndex(startCell);
      const end = getCellIndex(endCell);

      const minRow = Math.min(start.rowIdx, end.rowIdx);
      const maxRow = Math.max(start.rowIdx, end.rowIdx);
      const minCol = Math.min(start.colIdx, end.colIdx);
      const maxCol = Math.max(start.colIdx, end.colIdx);

      // 只选择数值列
      const selectedNumericCols = [];
      for (let c = minCol; c <= maxCol; c++) {
        if (numericCols.includes(c)) selectedNumericCols.push(c);
      }
      if (selectedNumericCols.length === 0) return;

      const tbody = startCell.parentElement.parentElement;
      const rows = tbody.children;
      let totalSum = 0;
      const cells = [];

      for (let r = minRow; r <= maxRow; r++) {
        const row = rows[r];
        if (!row) continue;
        selectedNumericCols.forEach(c => {
          const td = row.children[c];
          if (!td) return;
          td.classList.add('cell-selected');
          const val = parseFloat(td.textContent.replace(/[¥,，%]/g, '').trim());
          if (!isNaN(val)) {
            totalSum += val;
            cells.push({ td, rowIdx: r, colIdx: c, value: val });
          }
        });
      }
      selectedCells = cells;

      if (cells.length > 0) {
        this.showFloatTooltip(endCell, totalSum, cells.length);
      }
    };

    // 鼠标事件
    table.addEventListener('mousedown', (e) => {
      const td = e.target.closest('td');
      if (!td || td.closest('thead')) return;
      isSelecting = true;
      clearSelection();
      updateSelection(td, td);
    });

    table.addEventListener('mousemove', (e) => {
      if (!isSelecting) return;
      const td = e.target.closest('td');
      if (!td || td.closest('thead')) return;
      const firstCell = selectedCells.length > 0 ? selectedCells[0].td : td;
      updateSelection(firstCell, td);
    });

    document.addEventListener('mouseup', () => {
      if (isSelecting) {
        isSelecting = false;
        // 保持 tooltip 显示，点击其他地方清除
      }
    });

    // 点击表格外清除选择
    document.addEventListener('mousedown', (e) => {
      if (!container.contains(e.target)) {
        clearSelection();
      }
    });
  },

  /**
   * 检测表格中哪些列是数值列
   */
  detectNumericColumns(table) {
    const thead = table.querySelector('thead');
    if (!thead) return [];
    const headers = thead.querySelectorAll('th');
    const numericCols = [];

    headers.forEach((th, idx) => {
      const text = th.textContent.trim();
      if (this.NUMERIC_KEYWORDS.some(kw => text.includes(kw))) {
        numericCols.push(idx);
      }
    });

    // 如果没检测到，检查 tbody 第一行数据
    if (numericCols.length === 0) {
      const tbody = table.querySelector('tbody');
      const firstRow = tbody ? tbody.querySelector('tr') : null;
      if (firstRow) {
        firstRow.querySelectorAll('td').forEach((td, idx) => {
          const val = parseFloat(td.textContent.replace(/[¥,，%]/g, '').trim());
          if (!isNaN(val)) numericCols.push(idx);
        });
      }
    }

    return numericCols;
  },

  /**
   * 显示浮动汇总 tooltip
   */
  showFloatTooltip(anchorCell, sum, count) {
    this.hideFloatTooltip();
    const tooltip = document.createElement('div');
    tooltip.className = 'cell-summary-tooltip';
    tooltip.innerHTML = `
      <div class="cst-label">已选 ${count} 个数值</div>
      <div class="cst-value">${this.formatSum(sum)}</div>
    `;
    document.body.appendChild(tooltip);

    const rect = anchorCell.getBoundingClientRect();
    tooltip.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
    tooltip.style.top = (rect.top - tooltip.offsetHeight - 8) + 'px';
    tooltip.style.opacity = '1';
    tooltip.style.transform = 'translateY(0)';

    // 延迟更新位置（等渲染完成）
    requestAnimationFrame(() => {
      const tr = tooltip.getBoundingClientRect();
      tooltip.style.left = Math.min(rect.left, window.innerWidth - tr.width - 10) + 'px';
      tooltip.style.top = (rect.top - tr.height - 8) + 'px';
    });

    this._floatTooltip = tooltip;
  },

  hideFloatTooltip() {
    if (this._floatTooltip) {
      this._floatTooltip.remove();
      this._floatTooltip = null;
    }
  },

  formatSum(num) {
    if (Math.abs(num) >= 100000000) return '¥' + (num / 100000000).toFixed(2) + ' 亿';
    if (Math.abs(num) >= 10000) return '¥' + (num / 10000).toFixed(2) + ' 万';
    return '¥' + new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  },

  // ============================================================
  // 🟢 共享工具（O1/O2/O3/O5 去重）：导出 / 格式化 / 日期 / 编码键
  // ============================================================

  // 金额格式化（fractionDigits 默认 0，与供应商模块原行为一致；pricing 传 2）
  formatMoney(num, fractionDigits = 0) {
    if (num == null || num === '') return '';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: fractionDigits }).format(num);
  },

  // 数量/整数格式化（与订货核对/库存预警模块原行为一致）
  formatNum(num) {
    if (num == null || num === '') return '';
    return new Intl.NumberFormat('zh-CN').format(num);
  },

  // 距离今天的天数（向上取整；负数=已过期；无日期=null）
  daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
  },

  // 月份标签 YYYY-MM（兼容 Date 或日期字符串）
  monthLabel(dateOrStr) {
    const d = (dateOrStr instanceof Date) ? dateOrStr : new Date(dateOrStr);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  // 存货编码查找键：名称|规格，去空白（O5 去重，逻辑与原内联完全一致）
  buildStockKey(name, spec) {
    return ((name || '') + '|' + (spec || '')).replace(/\s+/g, '');
  },

  // 统一 Excel 导出（O1 去重）：rows 为空时提示并返回，行为与原各模块一致
  exportToExcel(rows, filename, sheetName) {
    if (!rows || !rows.length) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || '数据');
    XLSX.writeFile(wb, filename);
  }
};
