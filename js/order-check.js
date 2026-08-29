// ============================================
// 订货核对模块 V4 - 出库式明细录入 · 库存预警/低周转联动
// ============================================

const OrderCheckModule = {
  currentOrderNo: '',    // 当前编辑的核对单号（空=新增模式）
  editingMode: false,    // true=编辑模式
  defaultRows: 15,        // 默认空白行数
  autoAddRows: 5,        // 到最后一行时自动增加的行数
  _formDraft: null,      // 🟢 v113：录入草稿（明细行 input 值，切换模块回来时恢复；保存/重置时清空）
  _draftObs: null,       // 🟢 v113：contentArea MutationObserver 引用（模块切换时触发暂存）

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    if (myToken !== undefined && myToken !== App._goToken) return;

    // 🟢 v113：先暂存录入草稿（如果之前有未保存的明细行），防止切换模块回来被重建清空
    const hasDraft = !!this._formDraft;

    content.innerHTML = `
      <!-- 🟢 v117：删除顶部工具栏（搜索框+6个按钮）；模块职责：新增/编辑核对单的明细录入 -->
      <!-- 🟢 v113：明细表格区（已删除「订货核对单信息」面板与「明细列表」卡片标题） -->
      <!-- 🟢 v153：决策 KPI 横幅（粘贴需求后自动汇总） -->
      <div id="ocKpiBanner" class="oc-kpi-banner" style="display:none;margin:8px 0;padding:10px 14px;border-radius:10px;
        background:var(--card-bg,#fff);border:1px solid var(--border-color,#e2e8f0);font-size:12px;"></div>

      <div id="ocDetailTable" class="oc-entry-table-wrapper" style="overflow-x:auto;"></div>

      <!-- 🟢 v153：一键回填建议量到数量列 -->
      <div style="margin:8px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button class="glass-btn-3d" onclick="OrderCheckModule.applySuggestions()" title="把每行的『建议订货量』写回『数量』列（不覆盖你手填的需求原文前请先核对）">↩ 建议量回填数量列</button>
        <button class="glass-btn-3d" onclick="OrderCheckModule.recomputeAll()" title="按当前所有行的数据重新计算建议量与决策">🔄 重新计算全部</button>
      </div>

      <!-- 状态提示 -->
      <div id="ocStatusMsg" style="font-size:12px;color:var(--text-muted);text-align:center;"></div>
    `;

    // 🐞 FIX v156：移除「render 内清零 _formDraft」的回归（v117 残留）。
    // 草稿由 onLeave→_captureFormDraft 暂存，_restoreFormDraft 恢复完成后再自行清空（见 line ~1100）。
    // 若在此提早清零，_restoreFormDraft 读到 null 会直接渲染空白行 → 切模块回来录入丢失。

    // 渲染默认空白行（若存在录入草稿则从草稿恢复）
    if (hasDraft) {
      this._restoreFormDraft();
    } else {
      this.renderDetailRows();
    }

    // 🟢 v113：恢复所有用户偏好（列宽/对齐通过全局 observer 自动生效；明细表特殊 key 单独初始化）
    if (typeof TableUtils !== 'undefined') {
      const tbl = document.querySelector('#ocDetailTable .data-table');
      if (tbl) {
        TableUtils.initColumnResize(tbl, { tableKey: 'orderChecks' });
        TableUtils.initSortableHeaders('ocDetailTable', { tableKey: 'orderChecks' });
      }
    }
  },

  // 渲染明细行
  renderDetailRows(dataRows) {
    const rows = dataRows || Array.from({ length: this.defaultRows }, () => ({}));
    const container = document.getElementById('ocDetailTable');
    let html = `
      <div id="ocTableContainer" data-table-key="orderChecks" style="min-width:100%;">
        <table class="data-table" style="width:auto;table-layout:fixed;" data-table-key="orderCheck">
          <thead>
            <tr>
              <th style="width:40px;text-align:center;" data-col="idx">序号</th>
              <th style="width:130px;text-align:center;" data-col="code">存货编码</th>
              <th style="width:130px;text-align:center;" data-col="name">存货名称</th>
              <th style="width:110px;text-align:center;" data-col="spec">规格型号</th>
              <th style="width:80px;text-align:center;" data-col="qty">数量</th>
              <th style="width:120px;text-align:center;" data-col="category">分类</th>
              <th style="width:80px;text-align:center;" data-col="stock">现存量</th>
              <th style="width:80px;text-align:center;" data-col="ontheway">在途订单</th>
              <th style="width:100px;text-align:center;" data-col="warehouse">仓库</th>
              <th style="width:120px;text-align:center;" data-col="project">项目</th>
              <th style="width:80px;text-align:center;" data-col="low">是否低周转</th>
              <th style="width:90px;text-align:center;" data-col="unavailable">暂无法使用量</th>
              <th style="width:90px;text-align:center;" data-col="suggest">建议订货量</th>
              <th style="width:110px;text-align:center;" data-col="decision">决策</th>
              <th style="width:45px;text-align:center;" data-col="action" data-noresize="1" data-nofilter="1" id="ocAddRowTh">
                <button onclick="OrderCheckModule.addRow()" title="添加新行"
                  style="border:none;background:none;color:var(--primary);cursor:pointer;font-size:16px;padding:0;line-height:1;"
                  onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform=''">＋</button>
              </th>
            </tr>
          </thead>
          <tbody id="ocTbody">
    `;

    rows.forEach((r, idx) => {
      html += this._rowHtml(idx, r);
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
    container.innerHTML = html;

    // 绑定联想事件
    this.bindAutocomplete();

    // 🟢 v153：数量列（需求计划量）改动后重算该行决策
    const qtyDelegated = container.querySelector('#ocTbody');
    if (qtyDelegated && !qtyDelegated.dataset.qtyCalcBound) {
      qtyDelegated.dataset.qtyCalcBound = '1';
      qtyDelegated.addEventListener('input', (e) => {
        if (e.target.classList && e.target.classList.contains('oc-qty-input')) {
          const idx = parseInt(e.target.dataset.row);
          clearTimeout(this._qtyTimer);
          this._qtyTimer = setTimeout(() => this._computeDecision(idx), 250);
        }
      });
    }
    // 初始化列宽拖拽（通用能力，也可由全局 observer 自动处理）
    const ocTbl = document.querySelector('#ocTableContainer .data-table');
    if (ocTbl) TableUtils.initColumnResize(ocTbl, { tableKey: 'orderChecks' });
    // 🟢 v113：表头筛选+对齐按钮组（订单核对明细表）
    if (typeof TableUtils !== 'undefined' && TableUtils.initSortableHeaders) {
      TableUtils.initSortableHeaders('ocDetailTable', { tableKey: 'orderChecks' });
    }
    // 🟢 v157：行渲染（含草稿恢复）后按内容上色
    this._paintCells();
  },

  _rowHtml(idx, r) {
    return `
      <tr data-row="${idx}">
        <td style="text-align:center;color:var(--text-muted);">${idx + 1}</td>
        <td style="text-align:center;position:relative;">
          <input type="text" class="oc-code-input oc-input" placeholder="输入编码联想..."
            value="${r.存货编码 || ''}"
            data-row="${idx}" autocomplete="off">
        </td>
        <td style="text-align:center;"><input type="text" class="oc-name-input oc-detail-input" readonly placeholder=""
          value="${r.存货名称 || ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="text" class="oc-spec-input oc-detail-input" readonly placeholder=""
          value="${r.规格型号 || ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="number" class="oc-qty-input" placeholder=""
          value="${r.数量 !== undefined && r.数量 !== null && r.数量 !== '' ? r.数量 : ''}" data-row="${idx}" min="0" step="any"></td>
        <td style="text-align:center;"><input type="text" class="oc-category-input oc-detail-input" data-grp="meta" readonly placeholder=""
          value="${r.分类 || ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="text" class="oc-stock-input oc-detail-input" data-grp="stock" readonly placeholder=""
          value="${r.现存量 !== undefined ? r.现存量 : ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="text" class="oc-ontheway-input oc-detail-input" data-grp="stock" readonly placeholder=""
          value="${r.在途订单 !== undefined ? r.在途订单 : ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="text" class="oc-warehouse-input oc-detail-input" data-grp="meta" readonly placeholder=""
          value="${r.仓库 || ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="text" class="oc-project-input oc-detail-input" data-grp="meta" readonly placeholder=""
          value="${r.项目 || ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="text" class="oc-low-input oc-detail-input" data-grp="stock" readonly placeholder=""
          value="${r.是否低周转 || ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="text" class="oc-unavailable-input oc-detail-input" data-grp="stock" readonly placeholder=""
          value="${r.暂无法使用量 !== undefined ? r.暂无法使用量 : ''}" data-row="${idx}"></td>
        <td style="text-align:center;"><input type="number" class="oc-suggest-input oc-detail-input" data-grp="result" readonly placeholder=""
          value="${r.建议订货量 !== undefined && r.建议订货量 !== null && r.建议订货量 !== '' ? r.建议订货量 : ''}" data-row="${idx}" min="0" step="any" style="font-weight:600;color:var(--primary);"></td>
        <td style="text-align:center;"><span class="oc-decision-cell" data-row="${idx}">${r.决策 || ''}</span></td>
        <td style="text-align:center;"><button onclick="OrderCheckModule.removeRow(${idx})" style="border:none;background:none;color:var(--status-danger);cursor:pointer;font-size:15px;padding:2px 4px;" title="删除此行">🗑️</button></td>
      </tr>`;
  },

  // 绑定智能联想事件 + 批量粘贴 + 自动增行
  bindAutocomplete() {
    const inputs = document.querySelectorAll('.oc-code-input');
    inputs.forEach(input => {
      if (input.dataset.bound === '1') return;
      input.dataset.bound = '1';
      let debounceTimer = null;

      input.addEventListener('focus', (e) => {
        this.showAutocomplete(e.target, '');
        this.checkAutoExpand();
      });

      input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.showAutocomplete(e.target, e.target.value.trim());
          this.checkAutoExpand();
        }, 200);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.hideAutocomplete(); e.target.blur(); }
        if (e.key === 'Tab') { setTimeout(() => this.hideAutocomplete(), 100); }
        if (e.key === 'Enter') {
          // 回车直接触发自动填充
          const code = e.target.value.trim();
          if (code) {
            const rowIdx = parseInt(e.target.dataset.row);
            this.autoFillByCode(code, rowIdx);
          }
          this.hideAutocomplete();
        }
      });

      input.addEventListener('blur', (e) => {
        // 延迟执行，避免下拉选项点击时 input 先失焦
        setTimeout(() => {
          const code = e.target.value.trim();
          const rowIdx = parseInt(e.target.dataset.row);
          if (code) this.autoFillByCode(code, rowIdx);
        }, 200);
      });
    });

    // ─── 统一批量粘贴处理器（事件委托到 tbody）───
    const tbody = document.getElementById('ocTbody');
    if (tbody && !tbody.dataset.pasteBound) {
      tbody.dataset.pasteBound = '1';
      tbody.addEventListener('paste', (e) => {
        const target = e.target;
        if (!target.matches('.oc-code-input, .oc-qty-input')) return;

        const pasteData = e.clipboardData.getData('text');
        if (!pasteData || !pasteData.trim()) return;

        const lines = pasteData.split(/[\r\n]+/).map(r => r.trim()).filter(Boolean);
        if (lines.length === 0) return;
        const matrix = lines.map(r => r.split(/\t+/).map(c => c.trim()).filter(c => c.length));
        const hasTabs = /\t/.test(pasteData);

        const startRowIdx = parseInt(target.dataset.row);
        const curTbody = document.getElementById('ocTbody');

        if (hasTabs) {
          // === 多列同步粘贴：编码/名称/规格/数量 ===
          e.preventDefault();
          const neededRows = startRowIdx + matrix.length;
          this._ensureRows(curTbody, neededRows);

          matrix.forEach((cols, i) => {
            const rowIdx = startRowIdx + i;
            if (cols[0]) {
              const codeInput = document.querySelector(`.oc-code-input[data-row="${rowIdx}"]`);
              if (codeInput) {
                codeInput.value = cols[0];
                this.autoFillByCode(cols[0], rowIdx);
              }
            }
            if (cols[1]) {
              const nameInput = document.querySelector(`.oc-name-input[data-row="${rowIdx}"]`);
              if (nameInput) nameInput.value = cols[1];
            }
            if (cols[2]) {
              const specInput = document.querySelector(`.oc-spec-input[data-row="${rowIdx}"]`);
              if (specInput) specInput.value = cols[2];
            }
            if (cols[3]) {
              const qtyInput = document.querySelector(`.oc-qty-input[data-row="${rowIdx}"]`);
              if (qtyInput) qtyInput.value = cols[3];
            }
          });

          const maxCols = Math.max(...matrix.map(r => r.length));
          this.showMsg(`✅ 已批量粘贴 ${matrix.length} 行 × ${maxCols} 列`);
          const nextRowIdx = startRowIdx + matrix.length;
          const nextInput = document.querySelector(`.oc-code-input[data-row="${nextRowIdx}"]`);
          if (nextInput) nextInput.focus();
          this.hideAutocomplete();
        } else if (lines.length > 1) {
          // === 单列多行粘贴 ===
          e.preventDefault();
          const neededRows = startRowIdx + lines.length;
          this._ensureRows(curTbody, neededRows);

          const isCodeCol = target.classList.contains('oc-code-input');
          if (isCodeCol) {
            lines.forEach((code, i) => {
              const rowIdx = startRowIdx + i;
              const codeInput = document.querySelector(`.oc-code-input[data-row="${rowIdx}"]`);
              if (codeInput) {
                codeInput.value = code;
                this.autoFillByCode(code, rowIdx);
              }
            });
            this.showMsg(`✅ 已粘贴 ${lines.length} 个编码到明细行`);
          } else {
            lines.forEach((val, i) => {
              const rowIdx = startRowIdx + i;
              const qtyInput = document.querySelector(`.oc-qty-input[data-row="${rowIdx}"]`);
              if (qtyInput) qtyInput.value = val;
            });
            this.showMsg(`✅ 已粘贴 ${lines.length} 个数量到明细行`);
          }
          this.hideAutocomplete();
        }
        // 单值：不 preventDefault，走默认粘贴
      });
    }

    // 点击外部关闭联想
    if (!this._docClickBound) {
      this._docClickBound = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.autocomplete-dropdown') && !e.target.closest('.oc-code-input')) {
          this.hideAutocomplete();
        }
      });
      // 🟢 v136：页面滚动时立即收起下拉，避免 position:fixed 的下拉卡在原视口位置
      if (window.innerWidth <= 768) {
        window.addEventListener('scroll', () => this.hideAutocomplete(), { passive: true });
      }
    }
  },

  // 显示联想下拉
  // 🟢 v136：async race 守卫。快速切换 input A→B 时，两次 showAutocomplete 的 await 区间重叠，
  //   旧调用 await 返回后仍会创建一个孤儿 dropdown，导致 body 上同时挂两个。
  //   修：每次调用前 ++token 并记录 myToken，await 返回后若 myToken !== _showToken 则放弃创建；
  //   此外创建 dropdown 前再做一次防御性清理，覆盖 await 期间其他路径产生的残留。
  _showToken: 0,
  async showAutocomplete(inputEl, keyword) {
    this._showToken += 1;
    const myToken = this._showToken;
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => d.remove());

    if (!keyword && inputEl.value) keyword = inputEl.value;

    let results = [];
    if (keyword) {
      const kw = keyword.toLowerCase();
      results = await db.stock.filter(s =>
        (s.存货编码 && s.存货编码.toLowerCase().includes(kw)) ||
        (s.存货名称 && s.存货名称.toLowerCase().includes(kw))
      ).limit(20).toArray();
    } else {
      results = await db.stock.limit(20).toArray();
    }

    // 🟢 v136：await 期间可能已有更新的调用抢走 token，本调用直接放弃
    if (myToken !== this._showToken) return;
    if (results.length === 0) return;

    let itemsHtml = '';
    results.forEach(r => {
      itemsHtml += `<div class="autocomplete-item" data-code="${escAttr(r.存货编码 || '')}" data-name="${escAttr(r.存货名称 || '')}" data-spec="${escAttr(r.规格型号 || '')}">
        <span class="autocomplete-code">${esc(r.存货编码 ?? '')}</span>
        <span class="autocomplete-name">${esc(r.存货名称 || '')}</span>
        <span class="autocomplete-spec">${esc(r.规格型号 || '')}</span>
      </div>`;
    });

    // 🟢 v136：防御性清理——await 期间别的路径可能塞了 dropdown 进来
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => d.remove());

    const dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    dropdown.innerHTML = itemsHtml;

    const rect = inputEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.width = Math.max(rect.width, 320) + 'px';
    dropdown.style.zIndex = '9999';

    document.body.appendChild(dropdown);

    dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('click', () => {
        const rowIdx = parseInt(inputEl.dataset.row);
        inputEl.value = item.dataset.code;
        this.autoFillByCode(item.dataset.code, rowIdx);
        this.hideAutocomplete();
        const qtyInput = document.querySelector(`.oc-qty-input[data-row="${rowIdx}"]`);
        if (qtyInput) qtyInput.focus();
      });
    });
  },

  hideAutocomplete() {
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => d.remove());
  },

  // 按编码自动填充：先读 stock 名称/规格，再到库存预警读分类/现存量/在途/仓库/项目，
  // 最后到低周转读是否低周转/暂无法使用量。若库存预警中无匹配，提示并清空本行。
  async autoFillByCode(code, rowIdx) {
    if (!code) return;

    // 1. 从存货档案（stock）读取名称、规格
    const stock = await db.stock.where('存货编码').equals(code).first();
    if (stock) {
      this._setVal(rowIdx, '.oc-name-input', stock.存货名称 || '');
      this._setVal(rowIdx, '.oc-spec-input', stock.规格型号 || '');
    }

    // 2. 从库存预警读取关联字段
    const alert = await db.inventoryAlerts.where('存货编码').equals(code).first();
    if (!alert) {
      this.showMsg(`❌ 未找到物料 "${code}" 的库存预警信息`, true);
      this._clearAutoFilled(rowIdx);
      return;
    }

    this._setVal(rowIdx, '.oc-category-input', alert.分类 || '');
    this._setVal(rowIdx, '.oc-stock-input', alert.现存量 !== undefined ? alert.现存量 : '');
    this._setVal(rowIdx, '.oc-ontheway-input', alert.在途订单 !== undefined ? alert.在途订单 : '');
    this._setVal(rowIdx, '.oc-warehouse-input', alert.所上或库房 || '');
    this._setVal(rowIdx, '.oc-project-input', alert.工程项目 || '');

    // 3. 从低周转材料读取
    const lt = await db.lowTurnover.where('存货编码').equals(code).first();
    if (lt) {
      this._setVal(rowIdx, '.oc-low-input', '低周转');
      this._setVal(rowIdx, '.oc-unavailable-input', lt.暂无法使用量 !== undefined ? lt.暂无法使用量 : '');
    } else {
      this._setVal(rowIdx, '.oc-low-input', '');
      this._setVal(rowIdx, '.oc-unavailable-input', '');
    }

    // 4. 自动计算建议订货量 + 决策标签
    await this._computeDecision(rowIdx);
    // 🟢 v157：自动填充后按内容上色（建议量/决策等结果列）
    this._paintCells(rowIdx);
  },

  // 🟢 v154：单行决策计算（以库存水位为核心锚点）
  // 基础量：最高库存 H、最低库存 L、中库存 M=(H+L)/2、现存量 S、需求 D、净需求 N=D−S
  // 可用供给 = 现存量 S（按用户要求：不加减在途/暂无法使用量；补货值不进决策）
  // 决策树：
  //   0. 未填/需求0 → 待定
  //   1. 消耗优先组（低周转 / 不使用类/空分类）→ N>0 补缺口=N；N≤0 不订
  //   2. 非消耗组 N≤0 → 不订·库存够
  //   3. 非消耗组 N>0 → 库存水位 + 分类因子
  //        H 为空 = 用户不想存库存 → 直接按缺口订（有现存优先消耗）
  //        C类：H>20 且 S>80%H → 建议=N−40%S（>0订/≤0不订）；否则按缺口
  //              H≤20 且 D/S≥1/2 → 按缺口订；否则不订
  //        B类以上：k 浮动[0.15,0.30]（水位定位线性插值，中库存0.20）
  //              H>20 → 建议=N−k·S（>0订/≤0不订）；H≤20 → 建议=N
  //        工程类加「直送」标注但仍算量
  // v155：单行订货决策（以库存水位为核心，全部引用工作台自身数据）
  // 数据来源：分类/现存量/最高库存/最低库存/低周转 ← 工作台 db；需求计划量 ← 用户粘贴的外部需求
  // 中库存 = (最高库存 + 最低库存) / 2；净需求 = 需求计划量 − 现存量
  // 最高库存为空或 0 → 视为「不想存库存」→ 缺口即补
  async _computeDecision(rowIdx) {
    const num = (选择器) => {
      const el = document.querySelector(选择器 + `[data-row="${rowIdx}"]`);
      const v = el ? parseFloat(el.value) : NaN;
      return isNaN(v) ? 0 : v;
    };
    const 取文本 = (选择器) => {
      const el = document.querySelector(选择器 + `[data-row="${rowIdx}"]`);
      return el ? (el.value || '').trim() : '';
    };

    const 需求计划量 = num('.oc-qty-input');          // 用户粘贴的外部需求计划量
    const 现存量 = num('.oc-stock-input');             // 工作台库存预警现存量
    const 分类 = 取文本('.oc-category-input');         // 工作台分类
    const 是否低周转 = 取文本('.oc-low-input') === '低周转';

    // 工作台库存预警：最高库存 / 最低库存（决策核心锚点）
    const 编码节点 = document.querySelector(`.oc-code-input[data-row="${rowIdx}"]`);
    const 编码 = 编码节点 ? 编码节点.value.trim() : '';
    let 最高库存 = NaN, 最低库存 = NaN;
    if (编码) {
      try {
        const 预警 = await db.inventoryAlerts.where('存货编码').equals(编码).first();
        if (预警) {
          if (typeof 预警.最高库存 === 'number') 最高库存 = 预警.最高库存;
          if (typeof 预警.最低库存预警 === 'number') 最低库存 = 预警.最低库存预警;
        }
      } catch (e) { /* 忽略 */ }
    }
    const 不想存库存 = isNaN(最高库存) || 最高库存 <= 0;   // 最高库存空或 0 = 不想存库存
    const 中库存 = isNaN(最高库存) ? NaN
      : (isNaN(最低库存) ? 最高库存 * 0.5 : (最高库存 + 最低库存) / 2);

    // ── 分组（按工作台分类字符串匹配）──
    const 含工程类 = 分类.includes('工程类');
    const 重点组 = 分类.includes('A') || 分类.includes('B');   // A / B / A工程类 / B工程类
    const 长尾组 = 分类.includes('C');                          // C / C工程类
    // 消耗优先组：低周转 / 不使用类 / 空分类（工作台已全部分类，空分类仅作防御兜底）
    const 消耗优先组 = 是否低周转 || 分类.includes('不使用') || 分类 === '';
    const 直送 = 含工程类 ? '直送·' : '';

    const 净需求 = 需求计划量 - 现存量;            // 净需求 = 需求 − 现存量
    let 建议量 = 0;
    let 决策 = '';
    let 颜色 = '';

    if (编码 === '' || 需求计划量 <= 0) {
      // 0. 未填编码或需求为 0 → 待定
      决策 = '待定·无数据';
      颜色 = 'oc-dec-gray';
    }
    // 🟢 v160：优先规则（命中即返回，绕过后续水位/系数逻辑）—— 用户明确"需求大就全部订"
    //   仅作用于非消耗优先组；建议量一律 = 计划量 D（保证 ≤ 计划量硬约束）
    else if (!消耗优先组 && 需求计划量 > 现存量) {
      // 2a-优先：需求 > 现存量 → 全部订货（需求缺口，直接全量）
      建议量 = 需求计划量;
      决策 = 直送 + '全部订·需求大量';
      颜色 = 'oc-dec-blue';
    } else if (!消耗优先组 && 现存量 >= 0.5 * 需求计划量 && 需求计划量 >= 0.5 * 现存量) {
      // 2b-优先：两边都过对方 1/2（含 D=S）→ 全部订货
      //   （高库存档 S≥80%H 且 D≥½S 的场景也必然满足本条件，已被本分支统一覆盖，无需单独分支）
      建议量 = 需求计划量;
      决策 = 直送 + '全部订·需求大量';
      颜色 = 'oc-dec-blue';
    } else if (消耗优先组) {
      // 1. 消耗优先组：优先消耗库存；净需求>0 补缺口，否则已有库存够
      if (净需求 > 0) {
        建议量 = 净需求;
        决策 = '低周转·补缺口';
        颜色 = 'oc-dec-orange';
      } else {
        决策 = '不订·库存够';
        颜色 = 'oc-dec-green';
      }
    } else if (需求计划量 > 现存量) {
      // 2. 非消耗组 且 需求>现存量（缺货）→ 库存水位 + 分类因子
      if (重点组) {
        if (不想存库存 || 最高库存 <= 20) {
          // 不想存库存（空/0）或小最高库存（>0）→ 缺口即补（全订）
          建议量 = 净需求;
          决策 = 直送 + '建议订·全量补';
          颜色 = 'oc-dec-blue';
        } else {
          // 最高库存>20：按水位浮动系数（最低库存15% / 中库存20% / 最高库存30%）消耗一部分
          let 水位定位 = 0.5;
          if (!isNaN(最低库存) && 最高库存 > 最低库存) {
            水位定位 = (现存量 - 最低库存) / (最高库存 - 最低库存);
            水位定位 = Math.max(0, Math.min(1, 水位定位));
          }
          const 浮动系数 = Math.max(0.15, Math.min(0.30, 0.20 + 0.20 * (水位定位 - 0.5)));
          const 浮动建议 = 净需求 - 浮动系数 * 现存量;
          if (浮动建议 > 0) {
            建议量 = 浮动建议;
            决策 = 直送 + '建议订·按水位';
            颜色 = 'oc-dec-blue';
          } else {
            决策 = 直送 + '不订·水位充足';
            颜色 = 'oc-dec-green';
          }
        }
      } else {
        // 长尾组（C / C工程类）
        if (不想存库存) {
          建议量 = 净需求;
          决策 = 直送 + '部分订·按缺口';
          颜色 = 'oc-dec-orange';
        } else if (最高库存 <= 20) {
          // 小最高库存（>0）→ 小批量，缺口即补
          建议量 = 净需求;
          决策 = 直送 + '部分订·小批量';
          颜色 = 'oc-dec-orange';
        } else if (现存量 > 0.8 * 最高库存) {
          // 高库存（现存量>80%最高）：消耗 40% 现存量
          const 高库建议 = 净需求 - 0.4 * 现存量;
          if (高库建议 > 0) {
            建议量 = 高库建议;
            决策 = 直送 + '部分订·高库存消耗';
            颜色 = 'oc-dec-orange';
          } else {
            决策 = 直送 + '不订·维持中低库存';
            颜色 = 'oc-dec-green';
          }
        } else if (!isNaN(中库存) && 现存量 < 中库存) {
          // 库存偏低（低于中库存）：直接补缺口
          建议量 = 净需求;
          决策 = 直送 + '低水位·直接订';
          颜色 = 'oc-dec-orange';
        } else {
          // 中等库存（≥中库存 且 <80%最高）：消耗 30% 现存量
          const 中库建议 = 净需求 - 0.3 * 现存量;
          if (中库建议 > 0) {
            建议量 = 中库建议;
            决策 = 直送 + '部分订·中等库存消耗';
            颜色 = 'oc-dec-orange';
          } else {
            决策 = 直送 + '不订·维持中低库存';
            颜色 = 'oc-dec-green';
          }
        }
      }
    } else {
      // 3. 非消耗组 且 需求≤现存量（库存够）
      if (不想存库存) {
        决策 = 直送 + '不订·库存够';
        颜色 = 'oc-dec-green';
      } else if (!isNaN(中库存) && 现存量 < 中库存 && 需求计划量 > 0.5 * 现存量) {
        // 库存偏低 且 需求占现存量过半 → 维持中库存水平（补到中库存）
        // 🟢 v160：夹紧到 [0, 计划量]，确保建议量不超过计划需求（硬约束）
        建议量 = Math.max(0, Math.min(需求计划量, 中库存 - 现存量));
        决策 = 直送 + '低水位·补到中库存';
        颜色 = 'oc-dec-orange';
      } else {
        决策 = 直送 + '不订·库存够';
        颜色 = 'oc-dec-green';
      }
    }

    // 写回建议量列 + 决策标签（建议量取整，0 显示空）
    this._setVal(rowIdx, '.oc-suggest-input', 建议量 > 0 ? Math.round(建议量) : '');
    const 决策节点 = document.querySelector(`.oc-decision-cell[data-row="${rowIdx}"]`);
    if (决策节点) {
      决策节点.textContent = 决策;
      决策节点.className = 'oc-decision-cell ' + 颜色;
    }

    this._refreshKpi();
    // 🟢 v157：决策计算后按内容上色（建议量列）
    this._paintCells(rowIdx);
  },


  // 🟢 v153：汇总 KPI 横幅
  _refreshKpi() {
    const banner = document.getElementById('ocKpiBanner');
    if (!banner) return;
    const tbody = document.getElementById('ocTbody');
    if (!tbody) return;

    let demandTotal = 0, suggestTotal = 0, noOrder = 0, lowTurn = 0, eng = 0, rows = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
      const idx = tr.dataset.row;
      if (idx === undefined) return;
      rows++;
      const q = parseFloat(document.querySelector(`.oc-qty-input[data-row="${idx}"]`)?.value) || 0;
      const sRaw = document.querySelector(`.oc-suggest-input[data-row="${idx}"]`)?.value;
      const s = parseFloat(sRaw) || 0;
      const dec = document.querySelector(`.oc-decision-cell[data-row="${idx}"]`)?.textContent || '';
      const cat = document.querySelector(`.oc-category-input[data-row="${idx}"]`)?.value || '';
      const isLow = document.querySelector(`.oc-low-input[data-row="${idx}"]`)?.value === '低周转';
      demandTotal += q;
      suggestTotal += s;
      if (dec.includes('不订')) noOrder++;
      if (isLow) lowTurn++;
      if (cat.includes('工程类')) eng++;
    });

    if (rows === 0) { banner.style.display = 'none'; return; }
    banner.style.display = 'block';
    banner.innerHTML = `
      <span style="margin-right:16px;"><b>需求总量</b> ${this._fmt(demandTotal)}</span>
      <span style="margin-right:16px;color:var(--primary);"><b>建议订货</b> ${this._fmt(suggestTotal)}</span>
      <span style="margin-right:16px;color:var(--status-success,#16a34a);"><b>不订/暂缓</b> ${noOrder}</span>
      <span style="margin-right:16px;color:#d97706;"><b>低周转</b> ${lowTurn}</span>
      <span style="margin-right:16px;color:#2563eb;"><b>工程类直送</b> ${eng}</span>
      <span style="color:var(--text-muted);">共 ${rows} 行</span>
    `;
  },

  _fmt(n) {
    if (n === 0) return '0';
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(2) + '万';
    return Math.round(n * 100) / 100 + '';
  },

  // 🟢 v153：一键把建议量写回数量列
  applySuggestions() {
    const tbody = document.getElementById('ocTbody');
    if (!tbody) return;
    let cnt = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
      const idx = tr.dataset.row;
      if (idx === undefined) return;
      const sRaw = document.querySelector(`.oc-suggest-input[data-row="${idx}"]`)?.value;
      const s = parseFloat(sRaw);
      if (sRaw !== undefined && sRaw !== '' && s > 0) {
        const qEl = document.querySelector(`.oc-qty-input[data-row="${idx}"]`);
        if (qEl) { qEl.value = Math.round(s); cnt++; }
      }
    });
    this.showMsg(`✅ 已回填 ${cnt} 行的建议订货量到数量列`);
  },

  // 🟢 v153：重新计算全部行的决策
  async recomputeAll() {
    const tbody = document.getElementById('ocTbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr')).map(tr => tr.dataset.row).filter(r => r !== undefined);
    for (const idx of rows) {
      await this._computeDecision(idx);
    }
    this.showMsg(`✅ 已重新计算 ${rows.length} 行`);
  },


  _setVal(rowIdx, selector, value) {
    const input = document.querySelector(`${selector}[data-row="${rowIdx}"]`);
    if (input) input.value = value;
  },

  // 清空自动填充列（保留用户手动输入的编码、数量）
  _clearAutoFilled(rowIdx) {
    this._setVal(rowIdx, '.oc-name-input', '');
    this._setVal(rowIdx, '.oc-spec-input', '');
    this._setVal(rowIdx, '.oc-category-input', '');
    this._setVal(rowIdx, '.oc-stock-input', '');
    this._setVal(rowIdx, '.oc-ontheway-input', '');
    this._setVal(rowIdx, '.oc-warehouse-input', '');
    this._setVal(rowIdx, '.oc-project-input', '');
    this._setVal(rowIdx, '.oc-low-input', '');
    this._setVal(rowIdx, '.oc-unavailable-input', '');
    this._paintCells(rowIdx);
  },

  // 🟢 v157：按内容显隐列分组底色——仅"有数据的单元格"上色，空单元格回归透明底
  // 🟢 v158：色作用于 td 上（覆盖整 cell，避免 9px padding 透出 tr 斑马底稀释颜色）
  // 同时保留 input 自身染色，使粘贴/选中也能看到分组色
  _paintCells(rowIdx) {
    const tbody = document.getElementById('ocTbody');
    if (!tbody) return;
    const rows = rowIdx != null
      ? [tbody.querySelector(`tr[data-row="${rowIdx}"]`)].filter(Boolean)
      : Array.from(tbody.querySelectorAll('tr'));
    for (const tr of rows) {
      tr.querySelectorAll('[data-grp]').forEach(el => {
        const v = (el.value !== undefined ? el.value : (el.textContent || '')).trim();
        const grp = el.getAttribute('data-grp');
        if (!grp) return;
        const cls = 'oc-grp-' + grp;
        // 给 input 自身加类（粘贴/聚焦时颜色清晰）
        el.classList.toggle(cls, !!v);
        // 给 input 的父 <td> 加类（覆盖整个 cell，遮住 tr 斑马底）
        const td = el.parentElement;
        if (td && td.tagName === 'TD') td.classList.toggle(cls, !!v);
      });
    }
  },

  // 检查是否接近最后一行，自动增加5行
  checkAutoExpand() {
    const tbody = document.getElementById('ocTbody');
    if (!tbody) return;
    const rowCount = tbody.children.length;
    let lastFilledRow = -1;
    for (let i = rowCount - 1; i >= Math.max(0, rowCount - 3); i--) {
      const row = tbody.children[i];
      if (row) {
        const codeVal = row.querySelector('.oc-code-input')?.value?.trim();
        const qtyVal = row.querySelector('.oc-qty-input')?.value;
        if (codeVal || (qtyVal && parseFloat(qtyVal) > 0)) {
          lastFilledRow = i;
          break;
        }
      }
    }
    if (lastFilledRow >= rowCount - 3 || rowCount - lastFilledRow <= 2) {
      for (let i = 0; i < this.autoAddRows; i++) {
        this.appendEmptyRow(tbody);
      }
      this.renumberRows();
      this.bindAutocomplete();
    }
  },

  // 确保 tbody 至少有 targetRowCount 行
  _ensureRows(tbody, targetRowCount) {
    const currentCount = tbody.children.length;
    let addCount = 0;
    if (targetRowCount > currentCount) {
      addCount = targetRowCount - currentCount;
    } else if (targetRowCount >= currentCount - this.autoAddRows) {
      addCount = this.autoAddRows;
    }
    if (addCount > 0) {
      for (let i = 0; i < addCount; i++) this.appendEmptyRow(tbody);
      this.renumberRows();
      this.bindAutocomplete();
    }
  },

  // 追加一个空白行到 tbody
  appendEmptyRow(tbody) {
    const newRowIdx = tbody.children.length;
    const tr = document.createElement('tr');
    tr.dataset.row = newRowIdx;
    tr.innerHTML = this._rowHtml(newRowIdx, {});
    tbody.appendChild(tr);
  },

  // 添加空白行（点击+按钮）
  addRow() {
    const tbody = document.getElementById('ocTbody');
    if (!tbody) return;
    this.appendEmptyRow(tbody);
    this.renumberRows();
    this.bindAutocomplete();
    const newInput = tbody.lastElementChild && tbody.lastElementChild.querySelector('.oc-code-input');
    if (newInput) newInput.focus();
  },

  // 删除指定行
  removeRow(rowIdx) {
    const tr = document.querySelector(`#ocTbody tr[data-row="${rowIdx}"]`);
    if (tr) tr.remove();
    this.renumberRows();
  },

  // 重新编号
  renumberRows() {
    const rows = document.querySelectorAll('#ocTbody tr');
    rows.forEach((tr, idx) => {
      tr.dataset.row = idx;
      tr.cells[0].textContent = idx + 1;
      tr.querySelectorAll('input').forEach(input => input.dataset.row = idx);
      const delBtn = tr.querySelector('button[onclick^="OrderCheckModule.removeRow"]');
      if (delBtn) delBtn.setAttribute('onclick', `OrderCheckModule.removeRow(${idx})`);
    });
  },

  // 收集表单数据
  collectFormData() {
    // 🟢 v117：顶部工具栏已删除，单号由 saveOrder 自动生成；日期永远是今天，备注固定空字符串
    const orderNo = '';   // 留空，由 saveOrder() 自动 generateNextOrderNo()
    const date = new Date().toISOString().split('T')[0];
    const remark = '';

    const details = [];
    const rows = document.querySelectorAll('#ocTbody tr');
    rows.forEach(tr => {
      const code = tr.querySelector('.oc-code-input')?.value?.trim() || '';
      const name = tr.querySelector('.oc-name-input')?.value?.trim() || '';
      const spec = tr.querySelector('.oc-spec-input')?.value?.trim() || '';
      const qtyStr = tr.querySelector('.oc-qty-input')?.value || '';
      const qty = parseFloat(qtyStr) || 0;

      if (code || qty > 0) {
        details.push({
          orderNo,
          date,
          remark,
          code,
          name,
          spec,
          qty,
          category: tr.querySelector('.oc-category-input')?.value?.trim() || '',
          stockQty: tr.querySelector('.oc-stock-input')?.value?.trim() || '',
          onTheWay: tr.querySelector('.oc-ontheway-input')?.value?.trim() || '',
          warehouse: tr.querySelector('.oc-warehouse-input')?.value?.trim() || '',
          project: tr.querySelector('.oc-project-input')?.value?.trim() || '',
          isLow: tr.querySelector('.oc-low-input')?.value?.trim() || '',
          unavailable: tr.querySelector('.oc-unavailable-input')?.value?.trim() || ''
        });
      }
    });

    return { orderNo, date, remark, details };
  },

  // 显示状态消息
  showMsg(msg, isError = false) {
    const el = document.getElementById('ocStatusMsg');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? 'var(--status-danger)' : 'var(--status-success)';
      setTimeout(() => { el.textContent = ''; }, 4000);
    }
    Toast.show(msg, isError ? 'error' : 'success');
  },

  // ─── CRUD 操作 ───

  async getAllOrderNos() {
    const all = await DataStore.getRows('orderChecks');
    const set = new Set(all.map(r => r.核对单号).filter(Boolean));
    return [...set].sort();
  },

  async generateNextOrderNo() {
    const today = new Date().toISOString().split('T')[0];
    const prefix = 'DH' + today.replace(/-/g, '');
    const orderNos = await this.getAllOrderNos();
    const todayNos = orderNos.filter(n => n.startsWith(prefix));
    let nextSeq = 1;
    if (todayNos.length) {
      const maxSeq = Math.max(...todayNos.map(n => {
        const m = n.match(/^DH\d{8}(\d{1,4})$/);
        return m ? parseInt(m[1]) : 0;
      }));
      nextSeq = maxSeq + 1;
    }
    const malformed = todayNos.filter(n => !/^DH\d{8}\d{1,4}$/.test(n));
    if (malformed.length > 0 && !this._warnedMalformed) {
      this._warnedMalformed = true;
      console.warn('[订货核对] 发现 ' + malformed.length + ' 条格式异常的单号：', malformed);
    }
    return prefix + String(nextSeq).padStart(3, '0');
  },

  async navigateOrder(dir) {
    // 🟢 v117：已无 UI 入口（顶部搜索框已删除），保留方法以备未来使用
    const allNos = await this.getAllOrderNos();
    if (allNos.length === 0) { this.showMsg('暂无任何核对单可翻阅', true); return; }
    const current = (this.currentOrderNo || '').trim();
    let idx = allNos.indexOf(current);
    if (idx === -1) idx = dir > 0 ? -1 : 0;
    const newIdx = idx + dir;
    if (newIdx < 0) { this.showMsg('已经是第一单了', true); return; }
    if (newIdx >= allNos.length) { this.showMsg('已经是最后一单了', true); return; }

    this.currentOrderNo = allNos[newIdx];
    await this.searchOrder();
  },

  async searchOrder() {
    // 🟢 v117：已无 UI 入口，通过 this.currentOrderNo 调用
    const orderNo = (this.currentOrderNo || '').trim();
    if (!orderNo) { this.showMsg('请先设置当前核对单号', true); return; }

    const records = (await DataStore.getRows('orderChecks')).filter(r => r.核对单号 === orderNo);
    if (records.length === 0) {
      this.showMsg(`未找到核对单号 "${orderNo}" 的记录`, true);
      return;
    }

    const first = records[0];
    // 🟢 v117：搜索框已删除，currentOrderNo 即单号

    this.currentOrderNo = orderNo;
    this.editingMode = true;
    const detailRows = records.map(r => ({
      存货编码: r.存货编码 || '',
      存货名称: r.存货名称 || '',
      规格型号: r.规格型号 || '',
      数量: r.数量 || '',
      分类: r.分类 || '',
      现存量: r.现存量 !== undefined ? r.现存量 : '',
      在途订单: r.在途订单 !== undefined ? r.在途订单 : '',
      仓库: r.仓库 || '',
      项目: r.项目 || '',
      是否低周转: r.是否低周转 || '',
      暂无法使用量: r.暂无法使用量 !== undefined ? r.暂无法使用量 : ''
    }));
    this.renderDetailRows(detailRows);
    this.showMsg(`已加载核对单 "${orderNo}"，共 ${records.length} 条明细`);
  },

  async saveOrder() {
    if (this._busy) { this.showMsg('⏳ 正在保存，请稍候…', true); return; }
    this._busy = true;
    try {
      const { orderNo, date, remark, details } = this.collectFormData();

      // 🟢 v113：单号为空自动生成；日期永远是今天，无需校验
      const finalOrderNo = orderNo || await this.generateNextOrderNo();
      // 🟢 v117：搜索框已删除，无需回填 UI

      if (details.length === 0) { this.showMsg('❌ 请至少添加一条明细！', true); return; }

      for (let i = 0; i < details.length; i++) {
        if (!details[i].code) {
          this.showMsg(`❌ 第 ${i + 1} 行：请输入存货编码`, true);
          return;
        }
        if (!details[i].name) {
          this.showMsg(`❌ 第 ${i + 1} 行：存货名称为空（请确认编码 ${details[i].code} 是否存在于现存量表）`, true);
          return;
        }
      }

      const all = await DataStore.getRows('orderChecks');
      const exists = all.filter(r => r.核对单号 === finalOrderNo).length;
      const isSameAsEditing = this.editingMode && this.currentOrderNo === finalOrderNo;
      if (exists > 0 && !isSameAsEditing) {
        this.showMsg(`❌ 核对单号 "${finalOrderNo}" 已存在！如需修改请先点击"✏️ 修改"按钮再保存`, true);
        return;
      }

      // 如果是编辑模式且单号变化，先删旧数据
      if (this.editingMode && this.currentOrderNo && this.currentOrderNo !== finalOrderNo) {
        const oldKeys = (await DataStore.getRows('orderChecks')).filter(r => r.核对单号 === this.currentOrderNo).map(r => r.id);
        await db.orderChecks.bulkDelete(oldKeys);
      }

      // 删除同单号的旧明细（upsert）
      const oldIds = all.filter(r => r.核对单号 === finalOrderNo).map(r => r.id);
      if (oldIds.length) await db.orderChecks.bulkDelete(oldIds);

      const newRecords = details.map((d, idx) => ({
        核对单号: finalOrderNo,
        核对日期: date,
        备注: remark,
        行号: idx + 1,
        存货编码: d.code,
        存货名称: d.name,
        规格型号: d.spec,
        数量: d.qty,
        分类: d.category,
        现存量: d.stockQty,
        在途订单: d.onTheWay,
        仓库: d.warehouse,
        项目: d.project,
        是否低周转: d.isLow,
        暂无法使用量: d.unavailable
      }));

      await db.orderChecks.bulkAdd(newRecords);

      this.currentOrderNo = finalOrderNo;
      this.editingMode = false;

      // 🟢 v113：保存成功后清空草稿（明细已入库），重置表单为新建空白单
      this._formDraft = null;
      this.renderDetailRows();
      this.showMsg(`✅ 核对单 "${finalOrderNo}" 已保存（${details.length} 条明细）`);
    } catch (err) {
      console.error('保存核对单失败:', err);
      this.showMsg('❌ 保存失败: ' + err.message, true);
    } finally {
      this._busy = false;
    }
  },

  activateEdit() {
    if (!this.currentOrderNo) {
      this.showMsg('请先搜索一个核对单再修改', true);
      return;
    }
    this.editingMode = true;
    this.showMsg(`已激活编辑模式，修改后点击「保存」保存`);
  },

  async deleteOrder() {
    if (this._busy) { this.showMsg('⏳ 正在删除，请稍候…', true); return; }
    this._busy = true;
    try {
      // 🟢 v117：核对单号来源为 currentOrderNo（搜索框已删除）
      const orderNo = (this.currentOrderNo || '').trim();
      if (!orderNo) { this.showMsg('❌ 请先在订单跟踪中点击订单打开本模块的核对单', true); return; }

      const cnt = (await DataStore.getRows('orderChecks')).filter(r => r.核对单号 === orderNo).length;
      if (cnt === 0) { this.showMsg(`❌ 核对单号 "${orderNo}" 不存在`, true); return; }
      if (!await WBModal.confirm(`确定要删除核对单 "${orderNo}" 及其全部 ${cnt} 条明细吗？此操作不可恢复！`, { title: '⚠ 危险操作' })) return;

      const ids = (await DataStore.getRows('orderChecks')).filter(r => r.核对单号 === orderNo).map(r => r.id);
      await db.orderChecks.bulkDelete(ids);
      this.showMsg(`✅ 已删除核对单 "${orderNo}"（${cnt} 条明细）`);
      await this.resetForm();
    } catch (err) {
      console.error('删除失败:', err);
      this.showMsg('❌ 删除失败: ' + err.message, true);
    } finally {
      this._busy = false;
    }
  },

  async resetForm() {
    try {
      this.currentOrderNo = '';
      this.editingMode = false;
      // 🟢 v117：重置 = 清空草稿 + 空白明细（搜索框已删除）
      this._formDraft = null;
      this.renderDetailRows();
      this.showMsg(`✅ 表单已重置`);
    } catch (err) {
      console.error('重置表单失败:', err);
      this.showMsg('❌ 重置失败: ' + (err.message || err), true);
    }
  },

  exportData() {
    const { orderNo, date, remark, details } = this.collectFormData();
    const exportRows = details.map(d => ({
      核对单号: orderNo,
      核对日期: date,
      备注: remark,
      存货编码: d.code,
      存货名称: d.name,
      规格型号: d.spec,
      数量: d.qty,
      分类: d.category,
      现存量: d.stockQty,
      在途订单: d.onTheWay,
      仓库: d.warehouse,
      项目: d.project,
      是否低周转: d.isLow,
      暂无法使用量: d.unavailable
    }));
    TableUtils.exportToExcel(exportRows, `订货核对_${orderNo || new Date().toISOString().split('T')[0]}.xlsx`, '订货核对');
  },

  // 🟢 v113：模块卸载钩子（App.go 切换模块前会调）
  // 在这里主动捕获草稿，避免依赖 MutationObserver 的不确定性
  onLeave() {
    this._captureFormDraft();
  },

  // 🟢 v117：草稿暂存 - 切换模块前把所有明细行 input 值序列化到 _formDraft
  // 不再收集 searchNo（顶部工具栏已删除）
  _captureFormDraft() {
    try {
      const rows = document.querySelectorAll('#ocTbody tr');
      const rowDrafts = [];
      let nonEmptyCount = 0;
      rows.forEach(tr => {
        const draft = {
          code: tr.querySelector('.oc-code-input')?.value || '',
          name: tr.querySelector('.oc-name-input')?.value || '',
          spec: tr.querySelector('.oc-spec-input')?.value || '',
          qty: tr.querySelector('.oc-qty-input')?.value || '',
          category: tr.querySelector('.oc-category-input')?.value || '',
          stock: tr.querySelector('.oc-stock-input')?.value || '',
          ontheway: tr.querySelector('.oc-ontheway-input')?.value || '',
          warehouse: tr.querySelector('.oc-warehouse-input')?.value || '',
          project: tr.querySelector('.oc-project-input')?.value || '',
          low: tr.querySelector('.oc-low-input')?.value || '',
          unavailable: tr.querySelector('.oc-unavailable-input')?.value || ''
        };
        // 只统计「有任意填写」的行，避免空白行干扰
        const filled = Object.values(draft).some(v => String(v).trim() !== '');
        if (filled) nonEmptyCount++;
        rowDrafts.push(draft);
      });
      // 完全空白 → 不暂存（避免噪声）
      this._formDraft = nonEmptyCount === 0 ? null : { rows: rowDrafts };
    } catch (e) {
      console.warn('[订货核对] 草稿暂存失败:', e);
    }
  },

  // 🟢 v113：草稿恢复 - render() 时如果 _formDraft 存在，按草稿渲染
  _restoreFormDraft() {
    if (!this._formDraft) { this.renderDetailRows(); return; }
    const draft = this._formDraft;
    // 渲染对应数量的空白行（按草稿行数补足到 defaultRows）
    const data = draft.rows.length > this.defaultRows
      ? draft.rows
      : [...draft.rows, ...Array.from({ length: this.defaultRows - draft.rows.length }, () => ({}))];
    this.renderDetailRows(data);
    // 渲染完后回填 input 值
    const trs = document.querySelectorAll('#ocTbody tr');
    trs.forEach((tr, idx) => {
      const d = data[idx];
      if (!d) return;
      const setIf = (sel, val) => { const el = tr.querySelector(sel); if (el) el.value = val || ''; };
      setIf('.oc-code-input', d.code);
      setIf('.oc-name-input', d.name);
      setIf('.oc-spec-input', d.spec);
      setIf('.oc-qty-input', d.qty);
      setIf('.oc-category-input', d.category);
      setIf('.oc-stock-input', d.stock);
      setIf('.oc-ontheway-input', d.ontheway);
      setIf('.oc-warehouse-input', d.warehouse);
      setIf('.oc-project-input', d.project);
      setIf('.oc-low-input', d.low);
      setIf('.oc-unavailable-input', d.unavailable);
    });
    this._formDraft = null; // 恢复完即清，避免重复
    this.showMsg('📝 已恢复上次的录入草稿（请尽快保存或重置）');
  },

  // 🟢 v113：草稿机制已迁移到 App.go 切换模块前的主动调用（见 order-check.js 末尾），此处保留兼容
  _setupDraftObserver() {
    // 旧 MutationObserver 方案已废弃：render() 重建 DOM 会先清空旧节点触发误捕获，
    // 改成在 App.go 切换模块时主动调 _captureFormDraft() 更可靠。
    if (this._draftObs) { try { this._draftObs.disconnect(); } catch (e) {} this._draftObs = null; }
  }
};
