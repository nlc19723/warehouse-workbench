// ============================================
// 出库管理模块 V1 - 独立数据表 · 智能联想 · CRUD · 打印
// ============================================

// ─── 出库单录入模块 ───
const OutboundModule = {
  currentOrderNo: '',    // 当前编辑的出库单号（空=新增模式）
  editingMode: false,    // true=编辑模式(搜索加载后)
  defaultRows: 15,        // 默认空白行数
  autoAddRows: 5,        // 到最后一行时自动增加的行数

  async render(token) {
    if (token !== undefined) this._rt = token;
    // 🔴 修复单例状态污染：每次进入模块重置为「新增模式」，避免残留 editingMode/currentOrderNo 误删其他出库单
    this.currentOrderNo = '';
    this.editingMode = false;
    const myToken = token;
    const content = document.getElementById('contentArea');
    const today = new Date().toISOString().split('T')[0];

    // 🟢 v227.25：先渲染骨架 DOM，把 projects/下一单号这类"取数重活"挪到 rIC（不阻塞首屏绘制）。
    content.innerHTML = `
      <!-- 操作栏 -->
      <div class="filter-bar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:0;">
        <input type="text" id="obSearchNo" placeholder="搜索出库单号..." value=""
          onkeydown="if(event.key==='Enter')OutboundModule.searchOrder()">
        <button class="btn--primary" onclick="OutboundModule.searchOrder()">🔍 搜索</button>
        <button class="btn--ghost" onclick="OutboundModule.resetForm()">重置</button>
        <button class="btn--primary" onclick="OutboundModule.saveOrder()">💾 录入</button>
        <button class="btn--ghost" onclick="OutboundModule.activateEdit()">✏️ 修改</button>
        <button class="btn--danger" onclick="OutboundModule.deleteOrder()">🗑️ 删除</button>
        <button class="btn--ghost" onclick="OutboundModule.printOrder()">🖨️ 打印</button>
      </div>

      <!-- 表头信息区 -->
      <div class="glass-card" style="margin-bottom:14px;">
        <div class="glass-card-header">
          <span class="glass-card-title"><span class="title-icon">📤</span>出库单信息</span>
        </div>
        <div class="ob-header-grid" style="display:grid;grid-template-columns:auto auto auto auto;gap:12px 24px;padding:16px;">
          <div class="ob-field ob-field-row">
            <label class="ob-field-label" style="font-size:14px;font-weight:700;color:var(--text-main);white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">出库单号</label>
            <div class="ob-orderno-row">
              <button id="obPrevBtn" class="ob-orderno-btn wb-pager-btn wb-prev" onclick="OutboundModule.navigateOrder(-1)" title="减小单号" aria-label="减小单号"></button>
              <input type="text" id="obOrderNo" placeholder="自动生成或手动输入">
              <button id="obNextBtn" class="ob-orderno-btn wb-pager-btn wb-next" onclick="OutboundModule.navigateOrder(1)" title="增大单号" aria-label="增大单号"></button>
            </div>
          </div>
          <div class="ob-field ob-field-row">
            <label class="ob-field-label" style="font-size:14px;font-weight:700;color:var(--text-main);white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">出库时间</label>
            <input type="text" id="obDate" value="${escAttr(today)}" readonly class="dp-input">
          </div>
          <div class="ob-field ob-field-row">
            <label class="ob-field-label" style="font-size:14px;font-weight:700;color:var(--text-main);white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">项目名称</label>
            <input type="text" id="obProject" placeholder="输入或选择项目名称" style="width:280px" autocomplete="off">
          </div>
          <div class="ob-field ob-field-row">
            <label class="ob-field-label" style="font-size:14px;font-weight:700;color:var(--text-main);white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">领用人员</label>
            <input type="text" id="obReceiver" placeholder="输入领用人员" style="width:160px">
          </div>
        </div>
      </div>

      <!-- 明细表格区 -->
      <div class="glass-card ob-detail-card" style="margin-bottom:14px;">
        <div class="glass-card-header">
          <span class="glass-card-title"><span class="title-icon">📋</span>明细列表</span>
        </div>
        <div id="obDetailTable" class="ob-entry-table-wrapper"></div>
      </div>

      <!-- 状态提示 -->
      <div id="obStatusMsg" style="font-size:12px;color:var(--text-muted);text-align:center;"></div>
    `;

    // 渲染默认空白行（先有骨架）
    this.renderDetailRows();
    // 挂载出库时间自定义日期选择器（替换原生 type=date）
    if (typeof DatePicker !== 'undefined') DatePicker.mount('obDate');

    // 🟢 v227.25：projects 取数、生成单号、绑定联想全部延后到浏览器空闲帧（消除「点出库→卡片闪一下」卡顿）。
    const ric = window.requestIdleCallback || function(cb){ return setTimeout(cb, 16); };
    ric(() => {
      // 期间用户可能已切走 —— 守卫
      if (myToken !== undefined && myToken !== App._goToken) return;
      (async () => {
        try {
          if (!document.getElementById('obOrderNo').value) {
            const nextNo = await this.generateNextOrderNo();
            if (myToken !== undefined && myToken !== App._goToken) return;
            const obNoEl = document.getElementById('obOrderNo');
            if (obNoEl) obNoEl.value = nextNo;
          }
          this.bindProjectAutocomplete();
        } catch (e) {
          console.warn('[outbound] 后台取数失败(已忽略):', e && e.message);
        }
      })();
    });
  },

  // 🟡 修复：离开出库模块时清理 document 级 click 监听，避免监听器泄漏
  onLeave() {
    if (this._docClickHandler) {
      document.removeEventListener('click', this._docClickHandler);
      this._docClickHandler = null;
      this._docClickBound = false;
    }
  },

  // 项目名称智能联想（从入库列表去重后的项目名称，按最近入库时间倒序）
  // 先挂监听器，再异步加载项目 —— 避免首次点击时监听器还未绑定
  async bindProjectAutocomplete() {
    const input = document.getElementById('obProject');
    if (!input) return;
    // 强制重绑（确保最新一次 render 后的新 input 能拿到监听器）

    // ─── 第 1 步：立刻同步挂上事件监听器（不等异步）───
    let debounceTimer = null;

    const showOnInteraction = () => {
      const projs = this._cachedProjects || [];
      if (projs.length) this.showProjectAutocomplete(input, projs);
    };
    // 三个事件都覆盖，确保任意场景都触发
    input.addEventListener('focus',     showOnInteraction);
    input.addEventListener('mousedown', showOnInteraction);
    input.addEventListener('click',     showOnInteraction);
    input.addEventListener('pointerdown', showOnInteraction);

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const projs = this._cachedProjects || [];
        const kw = input.value.trim().toLowerCase();
        const filtered = kw ? projs.filter(p => p.toLowerCase().includes(kw)) : projs;
        if (filtered.length) this.showProjectAutocomplete(input, filtered);
        else this.hideProjectAutocomplete();
      }, 200);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.hideProjectAutocomplete(); input.blur(); }
    });

    // ─── 第 2 步：异步从 DB 加载项目（不阻塞监听器挂载）───
    try {
      const all = await DataStore.getRows('inbound');
      const projectTimeMap = new Map();
      all.forEach(r => {
        if (!r.项目名称) return;
        const name = r.项目名称;
        const time = r.入库时间 || r.入库日期 || r.日期 || '';
        const existing = projectTimeMap.get(name);
        if (!existing || time > existing) projectTimeMap.set(name, time);
      });
      // 按时间倒序（最近的在最前），空时间的排最后
      this._cachedProjects = [...projectTimeMap.entries()]
        .sort((a, b) => {
          if (!a[1] && !b[1]) return 0;
          if (!a[1]) return 1;
          if (!b[1]) return -1;
          return b[1].localeCompare(a[1]);
        })
        .map(e => e[0]);

      // 加载完若用户已经在 input 里，立即弹一次
      if (document.activeElement === input && this._cachedProjects.length) {
        this.showProjectAutocomplete(input, this._cachedProjects);
      }
    } catch (e) {
    /* ignore */ console.warn('[outbound.js:166] 异常(已忽略):', e);
  }
  },

  showProjectAutocomplete(inputEl, projects) {
    document.querySelectorAll('.project-autocomplete-dropdown').forEach(d => d.remove());

    let itemsHtml = '';
    projects.slice(0, 30).forEach(p => {
      itemsHtml += `<div class="autocomplete-item project-autocomplete-item" data-project="${escAttr(p)}">
        <span class="autocomplete-name">${esc(p)}</span>
      </div>`;
    });
    if (!itemsHtml) return;

    const dropdown = document.createElement('div');
    dropdown.className = 'project-autocomplete-dropdown autocomplete-dropdown';
    dropdown.innerHTML = itemsHtml;

    const rect = inputEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.width = Math.max(rect.width, 280) + 'px';
    dropdown.style.zIndex = '9999';

    document.body.appendChild(dropdown);

    dropdown.querySelectorAll('.project-autocomplete-item').forEach(item => {
      item.addEventListener('click', () => {
        inputEl.value = item.dataset.project;
        this.hideProjectAutocomplete();
      });
    });
  },

  hideProjectAutocomplete() {
    document.querySelectorAll('.project-autocomplete-dropdown').forEach(d => d.remove());
  },

  // 渲染明细行
  renderDetailRows(dataRows) {
    const rows = dataRows || Array.from({ length: this.defaultRows }, () => ({}));
    const container = document.getElementById('obDetailTable');
    let html = `
      <div id="obTableContainer" style="display:flex;justify-content:flex-start;">
        <table class="data-table" style="width:auto;table-layout:fixed;" data-table-key="outbound">
          <thead>
            <tr>
              <th style="width:40px;text-align:center;">序号</th>
              <th style="width:160px;">存货编码</th>
              <th style="width:140px;">存货名称</th>
              <th style="width:120px;">规格型号</th>
              <th style="width:90px;text-align:right;">出库数量</th>
              <th style="width:45px;text-align:center;" id="obAddRowTh">
                <button onclick="OutboundModule.addRow()" title="添加新行"
                  style="border:none;background:none;color:var(--primary);cursor:pointer;font-size:16px;padding:0;line-height:1;"
                  onmouseover="this.style.transform='scale(1.2)'" onmouseout="this.style.transform=''">＋</button>
              </th>
            </tr>
          </thead>
          <tbody id="obTbody">
    `;

    rows.forEach((r, idx) => {
      html += `
        <tr data-row="${idx}">
          <td style="text-align:center;color:var(--text-muted);">${idx + 1}</td>
          <td style="position:relative;">
            <input type="text" class="ob-code-input ob-input" placeholder="输入编码联想..."
              value="${escAttr(r.存货编码 || '')}"
              data-row="${idx}" autocomplete="off"
              >
          </td>
          <td><input type="text" class="ob-name-input ob-detail-input" readonly placeholder="自动填充"
            value="${escAttr(r.存货名称 || '')}" data-row="${idx}"
            ></td>
          <td><input type="text" class="ob-spec-input ob-detail-input" readonly placeholder="自动填充"
            value="${escAttr(r.规格型号 || '')}" data-row="${idx}"
            ></td>
          <td style="text-align:right;"><input type="number" class="ob-qty-input" placeholder="0"
            value="${escAttr(r.出库数量 || '')}" data-row="${idx}" min="0" step="any"
            ></td>
          <td style="text-align:center;"><button onclick="OutboundModule.removeRow(${idx})" style="border:none;background:none;color:var(--status-danger);cursor:pointer;font-size:15px;padding:2px 4px;" title="删除此行">🗑️</button></td>
        </tr>`;
    });

    html += `
          </tbody>
        </table>
      </div>
    `;
    container.innerHTML = html;

    // 绑定联想事件
    this.bindAutocomplete();
  },

  // 绑定智能联想事件 + 批量粘贴 + 自动增行
  bindAutocomplete() {
    const inputs = document.querySelectorAll('.ob-code-input');
    inputs.forEach(input => {
      // 已绑定过则跳过，避免 renderDetailRows/addRow/_ensureRows/checkAutoExpand 反复调用时
      // 为每个输入框累积多套 focus/input/keydown 监听器（曾导致异步查询线性膨胀、内存泄漏）
      if (input.dataset.bound === '1') return;
      input.dataset.bound = '1';
      let debounceTimer = null;

      input.addEventListener('focus', (e) => {
        this.showAutocomplete(e.target, '');
        // 检查是否接近最后一行，自动增行
        this.checkAutoExpand();
      });

      input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.showAutocomplete(e.target, e.target.value.trim());
          // 每次输入后检查是否需要自动增行
          this.checkAutoExpand();
        }, 200);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { this.hideAutocomplete(); e.target.blur(); }
        if (e.key === 'Tab') { setTimeout(() => this.hideAutocomplete(), 100); }
      });
    });

    // ─── 统一批量粘贴处理器（事件委托到 tbody）───
    // 支持：
    //   1) tab 分隔 → 多列同步填充（编码/名称/规格/数量）
    //   2) 仅换行分隔 → 单列多行填充（编码列 或 数量列）
    //   3) 单值 → 走默认粘贴流程
    const tbody = document.getElementById('obTbody');
    if (tbody && !tbody.dataset.pasteBound) {
      tbody.dataset.pasteBound = '1';
      tbody.addEventListener('paste', (e) => {
        const target = e.target;
        if (!target.matches('.ob-code-input, .ob-qty-input')) return;

        const pasteData = e.clipboardData.getData('text');
        if (!pasteData || !pasteData.trim()) return;

        // 解析为 2D 矩阵 [行][列]
        const lines = pasteData.split(/[\r\n]+/).map(r => r.trim()).filter(Boolean);
        if (lines.length === 0) return;
        const matrix = lines.map(r => r.split(/\t+/).map(c => c.trim()).filter(c => c.length));
        const hasTabs = /\t/.test(pasteData);

        const startRowIdx = parseInt(target.dataset.row);
        const curTbody = document.getElementById('obTbody');

        if (hasTabs) {
          // === 多列同步粘贴 ===
          e.preventDefault();
          const neededRows = startRowIdx + matrix.length;
          this._ensureRows(curTbody, neededRows);

          matrix.forEach((cols, i) => {
            const rowIdx = startRowIdx + i;
            // 编码 → 触发联想自动填充 名称+规格
            if (cols[0]) {
              const codeInput = document.querySelector(`.ob-code-input[data-row="${rowIdx}"]`);
              if (codeInput) {
                codeInput.value = cols[0];
                this.autoFillByCode(cols[0], rowIdx);
              }
            }
            // 用户直接粘贴的名称（覆盖联想结果）
            if (cols[1]) {
              const nameInput = document.querySelector(`.ob-name-input[data-row="${rowIdx}"]`);
              if (nameInput) nameInput.value = cols[1];
            }
            if (cols[2]) {
              const specInput = document.querySelector(`.ob-spec-input[data-row="${rowIdx}"]`);
              if (specInput) specInput.value = cols[2];
            }
            if (cols[3]) {
              const qtyInput = document.querySelector(`.ob-qty-input[data-row="${rowIdx}"]`);
              if (qtyInput) qtyInput.value = cols[3];
            }
          });

          const maxCols = Math.max(...matrix.map(r => r.length));
          this.showMsg(`✅ 已批量粘贴 ${matrix.length} 行 × ${maxCols} 列（编码/名称/规格/数量）`);
          // 聚焦到下一行的编码框
          const nextRowIdx = startRowIdx + matrix.length;
          const nextInput = document.querySelector(`.ob-code-input[data-row="${nextRowIdx}"]`);
          if (nextInput) nextInput.focus();
          this.hideAutocomplete();
        } else if (lines.length > 1) {
          // === 单列多行粘贴（按当前所在列填充）===
          e.preventDefault();
          const neededRows = startRowIdx + lines.length;
          this._ensureRows(curTbody, neededRows);

          const isCodeCol = target.classList.contains('ob-code-input');
          if (isCodeCol) {
            lines.forEach((code, i) => {
              const rowIdx = startRowIdx + i;
              const codeInput = document.querySelector(`.ob-code-input[data-row="${rowIdx}"]`);
              if (codeInput) {
                codeInput.value = code;
                this.autoFillByCode(code, rowIdx);
              }
            });
            this.showMsg(`✅ 已粘贴 ${lines.length} 个编码到明细行`);
          } else {
            lines.forEach((val, i) => {
              const rowIdx = startRowIdx + i;
              const qtyInput = document.querySelector(`.ob-qty-input[data-row="${rowIdx}"]`);
              if (qtyInput) qtyInput.value = val;
            });
            this.showMsg(`✅ 已粘贴 ${lines.length} 个数量到明细行`);
          }
          this.hideAutocomplete();
        }
        // 单值：不 preventDefault，走默认粘贴
      });
    }

    // 点击外部关闭联想（只绑一次，离开模块时移除，避免监听器泄漏）
    if (!this._docClickBound) {
      this._docClickBound = true;
      this._docClickHandler = (e) => {
        if (!e.target.closest('.autocomplete-dropdown') && !e.target.closest('.ob-code-input')) {
          this.hideAutocomplete();
        }
      };
      document.addEventListener('click', this._docClickHandler);
    }
  },

  // 显示联想下拉
  // 🟢 v136：async race 守卫，与 order-check.js 同因
  _showToken: 0,
  async showAutocomplete(inputEl, keyword) {
    this._showToken += 1;
    const myToken = this._showToken;
    // 先移除其他已打开的下拉
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => d.remove());

    if (!keyword && inputEl.value) keyword = inputEl.value;

    // 从 db.stock 模糊查询
    let results = [];
    if (keyword) {
      const kw = keyword.toLowerCase();
      results = await db.stock.filter(s =>
        (s.存货编码 && s.存货编码.toLowerCase().includes(kw)) ||
        (s.存货名称 && s.存货名称.toLowerCase().includes(kw))
      ).limit(20).toArray();
    } else {
      // 无关键词时显示前20条
      results = await db.stock.limit(20).toArray();
    }

    if (results.length === 0) return;

    // 🟢 v136：await 期间可能已有更新的调用抢走 token，本调用直接放弃
    if (myToken !== this._showToken) return;

    // 构建下拉浮层 HTML
    let itemsHtml = '';
    results.forEach(r => {
      itemsHtml += `<div class="autocomplete-item" data-code="${escAttr(r.存货编码 || '')}" data-name="${escAttr(r.存货名称 || '')}" data-spec="${escAttr(r.规格型号 || '')}">
        <span class="autocomplete-code">${esc(r.存货编码 ?? '')}</span>
        <span class="autocomplete-name">${esc(r.存货名称 || '')}</span>
        <span class="autocomplete-spec">${esc(r.规格型号 || '')}</span>
      </div>`;
    });

    // 🟢 v136：防御性清理
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => d.remove());

    const dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    dropdown.innerHTML = itemsHtml;

    // 定位到输入框下方
    const rect = inputEl.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = (rect.bottom + 2) + 'px';
    dropdown.style.width = Math.max(rect.width, 300) + 'px';
    dropdown.style.zIndex = '9999';

    document.body.appendChild(dropdown);

    // 点击选项 → 填充当前行
    dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('click', () => {
        const rowIdx = parseInt(inputEl.dataset.row);
        inputEl.value = item.dataset.code;
        // 填充同行其他字段
        const nameInput = document.querySelector(`.ob-name-input[data-row="${rowIdx}"]`);
        const specInput = document.querySelector(`.ob-spec-input[data-row="${rowIdx}"]`);
        if (nameInput) nameInput.value = item.dataset.name;
        if (specInput) specInput.value = item.dataset.spec;
        this.hideAutocomplete();
        // 跳到数量列
        const qtyInput = document.querySelector(`.ob-qty-input[data-row="${rowIdx}"]`);
        if (qtyInput) qtyInput.focus();
      });
    });
  },

  hideAutocomplete() {
    document.querySelectorAll('.autocomplete-dropdown').forEach(d => d.remove());
  },

  // 按编码自动填充存货名称和规格型号（从db.stock只读引用）
  async autoFillByCode(code, rowIdx) {
    if (!code) return;
    const stock = await db.stock.where('存货编码').equals(code).first();
    if (stock) {
      const nameInput = document.querySelector(`.ob-name-input[data-row="${rowIdx}"]`);
      const specInput = document.querySelector(`.ob-spec-input[data-row="${rowIdx}"]`);
      if (nameInput) nameInput.value = stock.存货名称 || '';
      if (specInput) specInput.value = stock.规格型号 || '';
    }
  },

  // 检查是否接近最后一行，自动增加5行
  checkAutoExpand() {
    const tbody = document.getElementById('obTbody');
    if (!tbody) return;
    const rowCount = tbody.children.length;
    // 检查最后几行是否有数据（从倒数第3行开始检查）
    let lastFilledRow = -1;
    for (let i = rowCount - 1; i >= Math.max(0, rowCount - 3); i--) {
      const row = tbody.children[i];
      if (row) {
        const codeVal = row.querySelector('.ob-code-input')?.value?.trim();
        const qtyVal = row.querySelector('.ob-qty-input')?.value;
        if (codeVal || (qtyVal && parseFloat(qtyVal) > 0)) {
          lastFilledRow = i;
          break;
        }
      }
    }
    // 如果最后3行都有数据，或者当前行数-已填行 <= 2，则自动增行
    if (lastFilledRow >= rowCount - 3 || rowCount - lastFilledRow <= 2) {
      for (let i = 0; i < this.autoAddRows; i++) {
        this.appendEmptyRow(tbody);
      }
      this.renumberRows();
      // 给新行绑定事件
      this.bindAutocomplete();
    }
  },

  // 追加一个空白行到tbody（内部方法，不触发renumber）
  appendEmptyRow(tbody) {
    const newRowIdx = tbody.children.length;
    const tr = document.createElement('tr');
    tr.dataset.row = newRowIdx;
    tr.innerHTML = `
      <td style="text-align:center;color:var(--text-muted);">${newRowIdx + 1}</td>
      <td style="position:relative;">
        <input type="text" class="ob-code-input ob-input" placeholder="输入编码联想..."
          data-row="${newRowIdx}" autocomplete="off"
          >
      </td>
      <td><input type="text" class="ob-name-input ob-detail-input" readonly placeholder="自动填充"
        data-row="${newRowIdx}"
        ></td>
      <td><input type="text" class="ob-spec-input ob-detail-input" readonly placeholder="自动填充"
        data-row="${newRowIdx}"
        ></td>
      <td style="text-align:right;"><input type="number" class="ob-qty-input" placeholder="0"
        data-row="${newRowIdx}" min="0" step="any"
        ></td>
      <td style="text-align:center;"><button onclick="OutboundModule.removeRow(${newRowIdx})" style="border:none;background:none;color:var(--status-danger);cursor:pointer;font-size:15px;padding:2px 4px;" title="删除此行">🗑️</button></td>
    `;
    tbody.appendChild(tr);
  },

  // 确保 tbody 至少有 targetRowCount 行（不够则补 + 自动多预留 autoAddRows）
  _ensureRows(tbody, targetRowCount) {
    const currentCount = tbody.children.length;
    let addCount = 0;
    if (targetRowCount > currentCount) {
      addCount = targetRowCount - currentCount;
    } else if (targetRowCount >= currentCount - this.autoAddRows) {
      // 填充到末行附近，自动多预留 autoAddRows
      addCount = this.autoAddRows;
    }
    if (addCount > 0) {
      for (let i = 0; i < addCount; i++) this.appendEmptyRow(tbody);
      this.renumberRows();
      this.bindAutocomplete();
    }
  },

  // 添加空白行（点击+添加行按钮）
  addRow() {
    const tbody = document.getElementById('obTbody');
    if (!tbody) return;
    this.appendEmptyRow(tbody);
    this.renumberRows();
    // 给新行绑定联想+粘贴+自动增行事件
    this.bindAutocomplete();
    // 聚焦新行的编码框
    const newInput = tbody.lastElementChild && tbody.lastElementChild.querySelector('.ob-code-input');
    if (newInput) newInput.focus();
  },

  // 删除指定行
  removeRow(rowIdx) {
    const tr = document.querySelector(`#obTbody tr[data-row="${rowIdx}"]`);
    if (tr) tr.remove();
    this.renumberRows();
  },

  // 重新编号
  renumberRows() {
    const rows = document.querySelectorAll('#obTbody tr');
    rows.forEach((tr, idx) => {
      tr.dataset.row = idx;
      tr.cells[0].textContent = idx + 1;
      // 更新所有 input 的 data-row
      tr.querySelectorAll('input').forEach(input => input.dataset.row = idx);
      // 更新删除按钮
      const delBtn = tr.querySelector('button[onclick]');
      if (delBtn) delBtn.setAttribute('onclick', `OutboundModule.removeRow(${idx})`);
    });
  },

  // 收集表单数据
  collectFormData() {
    const orderNo = document.getElementById('obOrderNo').value.trim();
    const date = document.getElementById('obDate').value;
    const project = document.getElementById('obProject').value.trim();
    const receiver = document.getElementById('obReceiver').value.trim();

    const details = [];
    const rows = document.querySelectorAll('#obTbody tr');
    rows.forEach(tr => {
      const code = tr.querySelector('.ob-code-input')?.value?.trim() || '';
      const name = tr.querySelector('.ob-name-input')?.value?.trim() || '';
      const spec = tr.querySelector('.ob-spec-input')?.value?.trim() || '';
      const qtyStr = tr.querySelector('.ob-qty-input')?.value || '';
      const qty = parseFloat(qtyStr) || 0;

      // 只收集有存货编码或有数量的有效行
      if (code || qty > 0) {
        details.push({ orderNo, date, project, receiver, code, name, spec, qty });
      }
    });

    return { orderNo, date, project, receiver, details };
  },

  // 显示状态消息（保留底部状态条，同时弹顶部 toast）
  showMsg(msg, isError = false) {
    const el = document.getElementById('obStatusMsg');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? 'var(--status-danger)' : 'var(--status-success)';
      setTimeout(() => { el.textContent = ''; }, 4000);
    }
    // 同时弹顶部 toast（这是用户最容易看到的）
    Toast.show(msg, isError ? 'error' : 'success');
  },

  // ─── CRUD 操作 ───

  // 搜索/加载已有出库单
  // 获取所有已存在的出库单号列表（按单号字符串升序）
  // 🟢 AUDIT-005：仅取「出库单号」字段，改用游标 each 遍历，避免把整行（含明细）全量载入内存
  async getAllOrderNos() {
    // 🟢 v227.77：临时出库独立 store —— OutboundModule（侧边栏「临时出库」）只看 db.tempOutbound
    const set = new Set();
    await db.tempOutbound.each(r => { if (r && r.出库单号) set.add(r.出库单号); });
    return [...set].sort();
  },

  // 生成下一个可用单号（在已有单号基础上 +1，保留前缀格式）
  async generateNextOrderNo() {
    const today = new Date().toISOString().split('T')[0];
    const prefix = 'CK' + today.replace(/-/g, '');
    const orderNos = await this.getAllOrderNos();
    // 找今天最大序号（严格匹配 CK + 8位日期 + 1~4位序号，防止贪婪匹配把日期当序号）
    const todayNos = orderNos.filter(n => n.startsWith(prefix));
    let nextSeq = 1;
    if (todayNos.length) {
      const maxSeq = Math.max(...todayNos.map(n => {
        const m = n.match(/^CK\d{8}(\d{1,4})$/);   // 严格：序号限 1~4 位
        return m ? parseInt(m[1]) : 0;
      }));
      nextSeq = maxSeq + 1;
    }
    // 检测并报告脏数据（早期版本贪婪匹配产生的非法格式单号）
    const malformed = todayNos.filter(n => !/^CK\d{8}\d{1,4}$/.test(n));
    if (malformed.length > 0 && !this._warnedMalformed) {
      this._warnedMalformed = true;
      console.warn('[出库] 发现 ' + malformed.length + ' 条格式异常的单号（早期 bug 残留，已自动忽略）：', malformed);
      setTimeout(() => this.showMsg(`⚠️ 检测到 ${malformed.length} 条历史脏单号，已忽略。建议手动清理`, true), 600);
    }
    return prefix + String(nextSeq).padStart(3, '0');
  },

  // 翻阅前后出库单（dir: -1=减小单号，1=增大单号）
  // 🟢 v228.03：新增「未录单号（新单）」虚拟档位 —— 位于列表最前（idx = -1）。
  //   原实现把新增态的 idx 也算作 -1，导致 ◀ 到第一单后 newIdx=-1 被判「已经是第一单」直接 return，
  //   于是从「未录单号」切到历史单后就再也切不回来（只能去点【重置】按钮）。
  //   现改为：idx ∈ [-1, total-1]，-1 = 未录单号（新增态），0..total-1 = 已存单号。
  async navigateOrder(dir) {
    const allNos = await this.getAllOrderNos();
    if (allNos.length === 0) {
      this.showMsg('暂无任何出库单可翻阅', true);
      return;
    }
    const curEl = document.getElementById('obOrderNo');
    const current = (curEl && curEl.value || '').trim();
    // 新增态判定：单号为空 / 不在已存单号列表中（如生成的待用新单号）
    const idx = (!current || allNos.indexOf(current) === -1) ? -1 : allNos.indexOf(current);
    const newIdx = idx + dir;
    // 🟢 v228.03：到边只禁用按钮、不弹提示（切换单号不需要提示信息）
    if (newIdx < -1) { this._setObOrderNoBtnsDisabled(-1, allNos.length); return; }
    if (newIdx >= allNos.length) { this._setObOrderNoBtnsDisabled(allNos.length - 1, allNos.length); return; }
    if (newIdx === -1) {
      // 回到「未录单号」新增态（静默重置，重新生成下一个待用单号）
      await this.resetForm(true);
      this._setObOrderNoBtnsDisabled(-1, allNos.length);
      return;
    }
    const targetNo = allNos[newIdx];
    const searchEl = document.getElementById('obSearchNo');
    if (searchEl) searchEl.value = targetNo;
    await this.searchOrder(true);   // silent：翻号切换不弹提示
    this._setObOrderNoBtnsDisabled(newIdx, allNos.length);
  },

  /** 🟢 v227.24：根据当前 idx/总数更新出库单号翻号键 disabled
   *  🟢 v228.03：idx = -1 表示「未录单号」新增态（列表最前），此时 ◀ 禁用、▶ 可用；
   *    第一单（idx=0）的 ◀ 必须可用，否则无法退回未录单号。 */
  _setObOrderNoBtnsDisabled(idx, total) {
    const prev = document.getElementById('obPrevBtn');
    const next = document.getElementById('obNextBtn');
    if (prev) prev.disabled = idx <= -1;
    if (next) next.disabled = idx >= total - 1;
  },

  // 🟢 v228.03：silent=true 时不弹「已加载出库单」提示（翻号切换单号不需要提示信息）
  async searchOrder(silent) {
    // 🔴 防御（S1）：输入框可能在模块切换后不存在，必须判空，否则 null.value 抛 TypeError
    const el = document.getElementById('obSearchNo');
    if (!el) { console.warn('[出库] searchOrder: 出库单号输入框不存在（可能已切换模块），跳过'); return; }
    const orderNo = el.value.trim();
    if (!orderNo) { this.showMsg('请输入出库单号进行搜索', true); return; }

    // 🟢 v227.77：临时出库独立表
    const records = await db.tempOutbound.where('出库单号').equals(orderNo).toArray();
    if (records.length === 0) {
      this.showMsg(`未找到出库单号 "${orderNo}" 的记录`, true);
      return;
    }

    // 填充表头
    const first = records[0];
    document.getElementById('obOrderNo').value = first.出库单号 || orderNo;
    document.getElementById('obDate').value = first.出库时间 || '';
    document.getElementById('obProject').value = first.项目名称 || '';
    document.getElementById('obReceiver').value = first.领用人员 || '';

    // 填充明细行
    this.currentOrderNo = orderNo;
    this.editingMode = true;
    const detailRows = records.map(r => ({
      存货编码: r.存货编码 || '',
      存货名称: r.存货名称 || '',
      规格型号: r.规格型号 || '',
      出库数量: r.出库数量 || ''
    }));
    this.renderDetailRows(detailRows);
    if (!silent) this.showMsg(`已加载出库单 "${orderNo}"，共 ${records.length} 条明细`);
  },

  // 重置表单（智能生成下一个单号）
  // 🟢 v228.03：silent=true 时不弹「表单已重置」提示（翻号切回「未录单号」时静默）
  async resetForm(silent) {
    try {
      this.currentOrderNo = '';
      this.editingMode = false;
      document.getElementById('obSearchNo').value = '';
      const today = new Date().toISOString().split('T')[0];

      // 异步获取最新单号 + 1
      const nextNo = await this.generateNextOrderNo();
      document.getElementById('obOrderNo').value = nextNo;

      document.getElementById('obDate').value = today;
      document.getElementById('obProject').value = '';
      document.getElementById('obReceiver').value = '';
      this.renderDetailRows();
      if (!silent) this.showMsg(`✅ 表单已重置，新单号：${nextNo}`);
    } catch (err) {
      console.error('重置表单失败:', err);
      this.showMsg('❌ 重置失败: ' + (err.message || err), true);
    }
  },

  // 录入/保存（带重复校验和提示）
  async saveOrder() {
    if (this._busy) { this.showMsg('⏳ 正在保存，请稍候…', true); return; }
    this._busy = true;
    try {
    const { orderNo, date, project, receiver, details } = this.collectFormData();

    // 校验
    if (!orderNo) { this.showMsg('❌ 请填写出库单号！', true); return; }
    if (!date) { this.showMsg('❌ 请选择出库时间！', true); return; }
    if (!project) { this.showMsg('❌ 请填写项目名称！', true); return; }
    if (!receiver) { this.showMsg('❌ 请填写领用人员！', true); return; }
    if (details.length === 0) { this.showMsg('❌ 请至少添加一条明细！', true); return; }

    // 校验每行必填（4 列都必须有数据）
    for (let i = 0; i < details.length; i++) {
      if (!details[i].code) {
        this.showMsg(`❌ 第 ${i + 1} 行：请输入存货编码`, true);
        return;
      }
      if (!details[i].name) {
        this.showMsg(`❌ 第 ${i + 1} 行：存货名称为空（请确认编码 ${details[i].code} 是否存在于现存量表）`, true);
        return;
      }
      if (!details[i].spec) {
        this.showMsg(`❌ 第 ${i + 1} 行：规格型号为空（请确认编码 ${details[i].code} 是否存在于现存量表）`, true);
        return;
      }
      if (!details[i].qty || details[i].qty <= 0) {
        this.showMsg(`❌ 第 ${i + 1} 行：出库数量必须大于0`, true);
        return;
      }
    }

    // 重复单号校验（v227.77：临时出库独立表，与中心库房出库单列表互不影响）
    const exists = await db.tempOutbound.where('出库单号').equals(orderNo).count();
    const isSameAsEditing = this.editingMode && this.currentOrderNo === orderNo;
    if (exists > 0 && !isSameAsEditing) {
      this.showMsg(`❌ 出库单号 "${orderNo}" 已存在！如需修改请先点击"✏️ 修改"按钮再录入`, true);
      return;
    }

    try {
      // 🟢 v207 AUDIT-101：删除 + 插入整体包进事务（中途失败整体回滚，不会只剩删除），
      //   事务成功后由 DataStore.write 统一失效 outbound 表缓存。
      //   旧代码「先删后插」无事务 + 写后不失效缓存 → 后续读取拿到进入模块时的旧快照，
      //   再被启动时 restoreOutboundFromSettings 用旧快照覆盖本地，新单凭空消失。
      const delOld = this.editingMode && this.currentOrderNo && this.currentOrderNo !== orderNo
        ? this.currentOrderNo : null;

      // 插入新明细
      const newRecords = details.map(d => ({
        出库单号: orderNo,
        出库时间: date,
        项目名称: project,
        领用人员: receiver,
        存货编码: d.code,
        存货名称: d.name,
        规格型号: d.spec,
        出库数量: d.qty
      }));

      // 🟢 v227.77：写入临时出库独立表 db.tempOutbound（与中心库房出库单列表的 db.outbound 物理隔离）
      //   左/右键翻页 + 录入 + 修改 + 删除 全部走此表；不触碰老 db.outbound。
      await DataStore.write('tempOutbound', () => db.transaction('rw', db.tempOutbound, async () => {
        if (delOld) await db.tempOutbound.where('出库单号').equals(delOld).delete();
        await db.tempOutbound.where('出库单号').equals(orderNo).delete();
        await db.tempOutbound.bulkAdd(newRecords);
      }));

      this.currentOrderNo = orderNo;
      this.editingMode = false;

      // 录入成功后：自动生成下一个单号 + 重置明细表 + 显示成功提示 + 同步云端
      const nextNo = await this.generateNextOrderNo();
      document.getElementById('obOrderNo').value = nextNo;
      document.getElementById('obProject').value = '';
      document.getElementById('obReceiver').value = '';
      this.renderDetailRows();
      this.showMsg(`✅ 临时出库单 "${orderNo}" 已保存（${details.length} 条明细），新单号：${nextNo}`);
      this._syncTemporaryOutboundToCloud();   // 🟢 v227.77：仅同步到临时出库云端数据包（不影响中心库房出库单列表）
    } catch (err) {
      console.error('保存出库单失败:', err);
      this.showMsg('❌ 保存失败: ' + err.message, true);
    }
    } finally {
      this._busy = false;
    }
  },

  // 激活编辑（配合搜索使用）
  activateEdit() {
    if (!this.currentOrderNo) {
      this.showMsg('请先搜索一个出库单再修改', true);
      return;
    }
    this.editingMode = true;
    this.showMsg(`已激活编辑模式，修改后点击「录入」保存`);
  },

  // 🟢 v227.77：临时出库独立表 —— OutboundModule 删除走 db.tempOutbound（不影响中心库房出库单列表）
  async deleteOrder() {
    if (this._busy) { this.showMsg('⏳ 正在删除，请稍候…', true); return; }
    this._busy = true;
    try {
      const orderNo = this.currentOrderNo || document.getElementById('obSearchNo').value.trim();
      if (!orderNo) {
        // 尝试从表头取
        const headerNo = document.getElementById('obOrderNo').value.trim();
        if (!headerNo) { this.showMsg('❌ 请先指定要删除的出库单号', true); return; }
        const cnt = await db.tempOutbound.where('出库单号').equals(headerNo).count();
        if (cnt === 0) { this.showMsg(`❌ 出库单号 "${headerNo}" 不存在`, true); return; }
        if (!await WBModal.confirm(`确定要删除临时出库单 "${headerNo}" 及其全部 ${cnt} 条明细吗？此操作不可恢复！`, { title: '⚠ 危险操作' })) return;
        // 🟢 v207 AUDIT-101：写后失效缓存
        await DataStore.write('tempOutbound', () => db.tempOutbound.where('出库单号').equals(headerNo).delete());
        this.showMsg(`✅ 已删除临时出库单 "${headerNo}"（${cnt} 条明细）`);
        this._syncTemporaryOutboundToCloud();
        await this.resetForm();
        return;
      }

      const cnt = await db.tempOutbound.where('出库单号').equals(orderNo).count();
      if (cnt === 0) { this.showMsg(`❌ 出库单号 "${orderNo}" 不存在`, true); return; }
      if (!await WBModal.confirm(`确定要删除临时出库单 "${orderNo}" 及其全部 ${cnt} 条明细吗？此操作不可恢复！`, { title: '⚠ 危险操作' })) return;

      // 🟢 v207 AUDIT-101：写后失效缓存
      await DataStore.write('tempOutbound', () => db.tempOutbound.where('出库单号').equals(orderNo).delete());
      this.showMsg(`✅ 已删除临时出库单 "${orderNo}"（${cnt} 条明细）`);
      this._syncTemporaryOutboundToCloud();
      await this.resetForm();
    } catch (err) {
      console.error('删除失败:', err);
      this.showMsg('❌ 删除失败: ' + err.message, true);
    } finally {
      this._busy = false;
    }
  },

  // 🟢 v227.77：异步增量同步「临时出库」到独立云端 bundle + 独立 setting key
  //   老 _syncOutboundToCloud 走的是 db.outbound（中心库房出库单列表），已废弃。
  _syncTemporaryOutboundToCloud() {
    if (typeof DataLoader !== 'undefined' && DataLoader.pushTempOutboundToCloud) {
      DataLoader.pushTempOutboundToCloud().catch(err => {
        console.warn('[临时出库] 增量同步失败:', err && err.message ? err.message : err);
        if (typeof Toast !== 'undefined') Toast.warn('临时出库已保存，但云端同步失败，下次改动将自动重试');
      });
    }
    if (typeof DataStore !== 'undefined' && DataStore.syncTemporaryOutboundToSettings) {
      DataStore.syncTemporaryOutboundToSettings().catch(err => {
        console.warn('[临时出库] 设置同步失败:', err && err.message ? err.message : err);
        if (typeof Toast !== 'undefined') Toast.warn('临时出库已保存，但跨设备设置同步失败');
      });
    }
  },

  // 打印
  printOrder() {
    const { orderNo, date, project, receiver, details } = this.collectFormData();
    if (!orderNo && details.length === 0) { this.showMsg('没有可打印的内容', true); return; }

    const printNo = orderNo || document.getElementById('obOrderNo').value || '(未命名)';
    const printDate = date || document.getElementById('obDate').value || '';
    const printProject = project || document.getElementById('obProject').value || '';
    const printReceiver = receiver || document.getElementById('obReceiver').value || '';

    let rowsHtml = '';
    if (details.length > 0) {
      details.forEach((d, i) => {
        rowsHtml += `<tr>
          <td style="text-align:center;">${i + 1}</td>
          <td>${esc(d.code ?? '')}</td>
          <td>${esc(d.name ?? '')}</td>
          <td>${esc(d.spec ?? '')}</td>
          <td style="text-align:right;">${esc(d.qty || 0)}</td>
        </tr>`;
      });
    } else {
      rowsHtml = '<tr><td colspan="5" style="text-align:center;color:#999;">(无明细数据)</td></tr>';
    }

    const totalQty = details.reduce((s, d) => s + (parseFloat(d.qty) || 0), 0);

    const printContent = `
      <div style="font-family:'Microsoft YaHei','PingFang SC',sans-serif;padding:20px;max-width:800px;margin:auto;">
        <h2 style="text-align:center;margin-bottom:4px;">出 库 单</h2>
        <p style="text-align:center;color:#666;font-size:12px;margin-top:0;margin-bottom:20px;">
          打印时间：${new Date().toLocaleString('zh-CN')}
        </p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
          <tr><td class="op-print-cell op-print-label" style="width:25%;">出库单号</td><td class="op-print-cell">${esc(printNo)}</td>
              <td class="op-print-cell op-print-label" style="width:25%;">出库时间</td><td class="op-print-cell">${esc(printDate)}</td></tr>
          <tr><td class="op-print-cell op-print-label">项目名称</td><td class="op-print-cell">${esc(printProject)}</td>
              <td class="op-print-cell op-print-label">领用人员</td><td class="op-print-cell">${esc(printReceiver)}</td></tr>
        </table>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead><tr class="op-print-thead">
            <th style="padding:8px;border:1px solid #ccc;width:40px;text-align:center;">序号</th>
            <th style="padding:8px;border:1px solid #ccc;width:120px;">存货编码</th>
            <th style="padding:8px;border:1px solid #ccc;">存货名称</th>
            <th style="padding:8px;border:1px solid #ccc;width:120px;">规格型号</th>
            <th style="padding:8px;border:1px solid #ccc;width:80px;text-align:right;">出库数量</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot><tr class="op-print-tfoot">
            <td colspan="4" style="padding:8px;border:1px solid #ccc;text-align:right;">合计</td>
            <td style="padding:8px;border:1px solid #ccc;text-align:right;">${totalQty}</td>
          </tr></tfoot>
        </table>
        <div style="margin-top:24px;display:flex;justify-content:space-between;font-size:12px;color:#666;">
          <span>制单人：_______________</span>
          <span>领用人签字：_______________</span>
          <span>日期：_______________</span>
        </div>
      </div>`;

    // 写入打印容器并触发打印
    const printWin = window.open('', '_blank');
    if (!printWin) {
      this.showMsg('❌ 浏览器拦截了打印窗口，请允许弹出窗口后重试', true);
      return;
    }
    printWin.document.write(`
      <!DOCTYPE html><html><head><meta charset="utf-8"><title>出库单-${esc(printNo)}</title>
      <style>@page{size:A4;margin:15mm;} body{margin:0;padding:0;}</style>
      </head><body>${printContent}</body></html>`);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => { printWin.print(); }, 300);
  }
};


// ─── 全局 Toast 通知系统（顶部居中浮窗）───
const Toast = {
  show(msg, type = 'success', duration = 3500) {
    // 移除所有已有 toast，保证「只留最新一条」（O7）
    document.querySelectorAll('.ob-toast-notification').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = `ob-toast-notification ob-toast-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️';
    // 图标用 innerHTML（固定安全），消息文本用 textContent（防 XSS）
    toast.innerHTML = `<span class="ob-toast-icon">${icon}</span><span class="ob-toast-text"></span>`;
    toast.querySelector('.ob-toast-text').textContent = msg;
    toast.style.cssText = `
      position: fixed; top: 90px; left: 50%; transform: translateX(-50%) translateY(-30px);
      z-index: 999999; padding: 14px 24px; border-radius: 14px;
      color: #fff; font-size: 14px; font-weight: 600;
      display: flex; align-items: center; gap: 10px; min-width: 280px; max-width: 720px;
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid rgba(255,255,255,0.2);
      box-shadow: 0 12px 32px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.15);
      opacity: 0;
      ${type === 'success' ? 'background: linear-gradient(135deg, rgba(16, 185, 129, 0.96), rgba(5, 150, 105, 0.96));' : ''}
      ${type === 'error'   ? 'background: linear-gradient(135deg, rgba(239, 68, 68, 0.96), rgba(220, 38, 38, 0.96));' : ''}
      ${type === 'warn'    ? 'background: linear-gradient(135deg, rgba(245, 158, 11, 0.96), rgba(217, 119, 6, 0.96));' : ''}
    `;
    document.body.appendChild(toast);

    // 强制 reflow，触发动画
    void toast.offsetWidth;
    toast.style.transition = 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(-30px)';
      setTimeout(() => toast.remove(), 400);
    }, duration);
  },
  success(msg, duration) { this.show(msg, 'success', duration); },
  error(msg, duration)   { this.show(msg, 'error', duration); },
  warn(msg, duration)    { this.show(msg, 'warn', duration); }
};


// ─── 出库列表模块 ───
const OutboundListModule = {
  currentFilter: {},
  currentPage: 1,
  pageSize: AppConfig.app.defaultPageSize,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    const projects = await DataStore.getOutboundProjects();
    // 🟡 F2：render 开头 await 后、提交 DOM 前用渲染时的局部 token 守卫，避免过期 render 覆盖新 DOM
    if (myToken !== undefined && myToken !== App._goToken) return;

    // 清理可能遗留的旧日期选择器弹窗（render 会重建 input）
    if (typeof DatePicker !== 'undefined') DatePicker.unmountAll();

    content.innerHTML = `
      <div class="filter-bar filter-bar-m" data-mod="obl">
        <input type="text" id="oblKw" class="fb-search" placeholder="搜索单号/编码/名称/项目..." value="${escAttr(this.currentFilter.keyword || '')}"
          onkeydown="if(event.key==='Enter')OutboundListModule.applyFilter()">
        <div class="fb-row fb-row--date">
          <div class="fb-field"><input type="text" id="oblStartDate" value="${escAttr(this.currentFilter.startDate || '')}" class="filter-date dp-input" placeholder="起始日期" readonly></div>
          <span class="fb-sep">至</span>
          <div class="fb-field"><input type="text" id="oblEndDate" value="${escAttr(this.currentFilter.endDate || '')}" class="filter-date dp-input" placeholder="结束日期" readonly></div>
        </div>
        <div class="fb-row fb-row--fields">
          <div class="fb-field"><select id="oblProject" class="filter-row-selects-select" title="按项目筛选">
          <option value="">全部项目</option>
          ${projects.map(p => `<option value="${escAttr(p)}" ${this.currentFilter.项目名称 === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="OutboundListModule.applyFilter()">筛选</button>
          <button class="btn--ghost" onclick="OutboundListModule.resetFilter()">重置</button>
          <button class="btn--ghost" onclick="OutboundListModule.importData()">⬆ 导入</button>
          <button class="btn--ghost" onclick="OutboundListModule.exportData()">📥 导出Excel</button>
        </div>
      </div>

      <div id="oblSummary"></div>
      <div id="oblTableArea"></div>
      <div id="oblPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    if (window.enhanceSearchSelect) {
      enhanceSearchSelect('oblProject', { placeholder: '搜索项目', widthMode: 'half' });
    }

    // 挂载自定义日期选择器（替换原生 type=date，保持 id 与 change 事件不变）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.mount('oblStartDate');
      DatePicker.mount('oblEndDate');
    }

    // 🟢 v227.74：移动端筛选栏字段行配平（≤768px 按最长选项动态分配 flex-grow）
    if (window.FilterLayout) FilterLayout.balanceAll();

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const result = await DataStore.getOutbound(this.currentFilter, this.currentPage, this.pageSize);
    const { items, total, totalPages } = result;
    // 🟢 v209 AUDIT-106：页码越界时钳制回合法范围（其余模块均有 Math.min，此处补齐，避免删末条后显示空白）
    if (totalPages > 0 && this.currentPage > totalPages) {
      this.currentPage = totalPages;
      return this.loadData(rt);
    }

    // KPI 统计（🟡 M6：基于全量筛选结果，而非仅当前分页，避免分页导致数值偏低）
    // 当选择「全部」时，当前结果已是全量，避免再查一次
    let allFiltered;
    if (this.pageSize === 'all') {
      allFiltered = result;
    } else {
      const allLimit = (window.AppConfig && AppConfig.app && AppConfig.app.kpiAllLimit) || 1000000;
      allFiltered = await DataStore.getOutbound(this.currentFilter, 1, allLimit);
    }
    const orderNos = [...new Set(allFiltered.items.map(i => i.出库单号).filter(Boolean))];
    const totalQty = allFiltered.items.reduce((s, i) => s + (parseFloat(i.出库数量) || 0), 0);

    if (rt !== undefined && rt !== App._goToken) return;
    const _obl = document.getElementById('oblSummary');
    if (!_obl) return; // 🟡 F2 兜底：DOM 已被其它 render 替换（如 outbound 录入覆盖列表），放弃过期提交
    _obl.innerHTML = `
      <div class="kpi-grid" style="display:flex;gap:12px;justify-content:flex-start;flex-wrap:wrap;">
        <div class="kpi-card card-info" style="width:150px;"><div class="kpi-label">出库单数</div><div class="kpi-value">${orderNos.length}</div></div>
        <div class="kpi-card card-info" style="width:150px;"><div class="kpi-label">明细条数</div><div class="kpi-value">${total}</div></div>
        <div class="kpi-card card-warning" style="width:150px;"><div class="kpi-label">总出库数量</div><div class="kpi-value">${totalQty.toLocaleString('zh-CN',{maximumFractionDigits:2})}</div></div>
      </div>
    `;

    // 表格渲染
    const area = document.getElementById('oblTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📤</div><div class="empty-text">暂无出库记录</div></div>';
      document.getElementById('oblPagination').innerHTML = '';
      return;
    }

    area.innerHTML = `
      <div class="ob-list-table-wrapper">
        <table class="data-table ob-list-table" style="table-layout:fixed;">
          <colgroup>
            <col style="width:48px;">       <!-- 序号 -->
            <col style="width:130px;">      <!-- 出库单号 -->
            <col style="width:260px;">      <!-- 项目名称（最长，删除领用人列后加宽） -->
            <col style="width:108px;">      <!-- 出库时间 -->
            <col style="width:118px;">      <!-- 存货编码 -->
            <col style="width:118px;">      <!-- 存货名称 = 1 × 存货编码（缩短一半） -->
            <col style="width:140px;">      <!-- 规格型号 -->
            <col style="width:108px;">      <!-- 出库数量 -->
          </colgroup>
          <thead>
            <tr>
              <th class="ob-th-center">序号</th>
              <th class="ob-th-center">出库单号</th>
              <th class="ob-th-center">项目名称</th>
              <th class="ob-th-center">出库时间</th>
              <th class="ob-th-center">存货编码</th>
              <th class="ob-th-center">存货名称</th>
              <th class="ob-th-center">规格型号</th>
              <th class="ob-th-center">出库数量</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((item, idx) => `
              <tr>
                <td class="ob-td-center">${(this.currentPage - 1) * (this.pageSize === 'all' ? items.length : this.pageSize) + idx + 1}</td>
                <td class="ob-td-center"><a href="#outbound" onclick="OutboundListModule.goToEntry('${escAttr(item.出库单号 || '')}'); return false;" style="color:var(--primary);text-decoration:none;font-weight:600;">${esc(item.出库单号 ?? '')}</a></td>
                <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(item.项目名称 || '')}">${esc(item.项目名称 ?? '')}</td>
                <td class="ob-td-center">${esc(item.出库时间 ?? '')}</td>
                <!-- 🟢 v199：去掉内联 font-size:11.5px，三列字号跟随单元格统一（monospace 保留） -->
                <td class="ob-td-center" style="font-family:monospace;">${TableUtils.link('stock', item.存货编码 ?? '', item.存货编码 ?? '')}</td>
                <td class="ob-td-center" title="${escAttr(item.存货名称 || '')}"><strong>${esc(item.存货名称 ?? '')}</strong></td>
                <td class="ob-td-center">${esc(item.规格型号 ?? '')}</td>
                <td class="ob-td-center" style="font-weight:600;">${item.出库数量 != null ? parseFloat(item.出库数量).toLocaleString('zh-CN',{maximumFractionDigits:2}) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(total, totalPages);
    TableUtils.initSmartSelect('oblTableArea');
    TableUtils.initSortableHeaders('oblTableArea');
  },

  // 点击单号跳转到录入页
  goToEntry(orderNo) {
    // 临时存储要加载的单号，再切换到出库录入模块
    // App.go('outbound') 渲染后会自动检测并加载该单（见 app.js go() 内的 checkPendingLoad）
    sessionStorage.setItem('_ob_load_order_no', orderNo);
    if (typeof App !== 'undefined' && App.go) App.go('outbound');
  },

  // 检查是否有待加载的单号（go('outbound') 渲染完成后调用）
  checkPendingLoad() {
    const pendingNo = sessionStorage.getItem('_ob_load_order_no');
    if (!pendingNo) return;
    sessionStorage.removeItem('_ob_load_order_no');
    // render 已完成（go 中 await 后才调用本函数），obSearchNo 已就绪；
    // 仅当仍停留在出库录入模块时才加载，避免切换模块后误套用到其它模块（F6 修复竞态）
    if (typeof App === 'undefined' || App.currentModule !== 'outbound') return;
    const el = document.getElementById('obSearchNo');
    if (!el) return;
    el.value = pendingNo;
    OutboundModule.searchOrder();
  },

  renderPagination(total, totalPages) {
    TableUtils.renderPagination('oblPagination', { module: 'OutboundListModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });
  },

  changePageSize(size) { this.pageSize = size === 'all' ? 'all' : parseInt(size, 10); this.currentPage=1; this.loadData(); },
  goPage(p) { this.currentPage=p; this.loadData(); },
  applyFilter() {
    this.currentFilter = {
      keyword: document.getElementById('oblKw')?.value.trim(),
      startDate: document.getElementById('oblStartDate')?.value,
      endDate: document.getElementById('oblEndDate')?.value,
      项目名称: document.getElementById('oblProject')?.value
    };
    this.currentPage = 1;
    this.loadData();
  },
  resetFilter() {
    this.currentFilter = {};
    this.currentPage = 1;
    this.pageSize = AppConfig.app.defaultPageSize;
    document.getElementById('oblKw').value='';
    document.getElementById('oblStartDate').value='';
    document.getElementById('oblEndDate').value='';
    document.getElementById('oblProject').value='';
    this.loadData();
  },
  async exportData() {
    const all = await db.outbound.toArray();
    // 🟢 O1：统一导出（行为与旧逻辑一致）
    TableUtils.exportToExcel(all, `出库明细_${new Date().toISOString().split('T')[0]}.xlsx`, '出库明细');
  },

  // ===== v227.78：导入 Excel（整体覆盖当前「中心出库列表」） =====
  // 源表头(22列) 关联至工作台列；领用人列已删除故不导入；序号列渲染时自然递增（不入库）。
  importData() {
    let input = document.getElementById('oblImportFile');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.id = 'oblImportFile';
      input.accept = '.xlsx,.xls';
      input.style.display = 'none';
      input.addEventListener('change', (e) => this._onImportFile(e));
      document.body.appendChild(input);
    }
    input.value = '';
    input.click();
  },

  async _onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const ok = await WBModal.confirm(
      '导入将清空「中心出库列表」当前全部数据，并用本文件内容整体覆盖。确定继续？',
      { title: '导入确认' }
    );
    if (!ok) return;
    showLoading('正在读取 Excel…');
    try {
      const buf = await file.arrayBuffer();
      // 🟢 v227.78：复用 DataLoader 的 Worker 解析（不支持 Worker 时主线程兜底），与系统导入一致
      const wb = await DataLoader._parseWorkbookAsync(buf);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) { Toast.warn('文件中没有可导入的数据行'); return; }
      // 🟢 v227.80：先建存货档案映射（存货名称+规格型号 → 存货编码），源缺编码时补全
      this._stockFilled = 0;
      await this._loadStockCodeMap();
      const mapped = this._mapImportRows(rows);
      if (!mapped.length) { Toast.warn('未识别到可导入明细（请确认表头含「出库单号/项目/出库日期」等列）'); return; }
      // 🟢 v227.80：整表覆盖 —— 清空现有数据 + 批量写入（恢复为覆盖式导入）
      await DataStore.write('outbound', () => db.transaction('rw', db.outbound, async () => {
        await db.outbound.clear();
        await db.outbound.bulkAdd(mapped);
      }));
      // 🟢 v227.78：同步云端，否则下次启动 restoreOutboundFromSettings 会用旧云端数据覆盖本次导入
      // 🟢 v227.84：失败时给用户明确反馈 —— 之前 .catch 静默吞掉，用户刷新后才发现数据消失
      let syncTip = '';
      if (typeof DataStore.syncOutboundToSettings === 'function') {
        const syncOk = await DataStore.syncOutboundToSettings();
        if (!syncOk) syncTip = '（云端同步失败，请检查云端配置；本地已保存）';
        else syncTip = '（已同步云端）';
      }
      this.currentFilter = {};
      this.currentPage = 1;
      await this.loadData();
      const filledMsg = this._stockFilled ? `，其中 ${this._stockFilled} 条依据存货档案补全编码` : '';
      Toast.success(`✅ 导入完成，共 ${mapped.length} 条明细（已整体覆盖${filledMsg}）${syncTip}`);
    } catch (err) {
      console.error('导入失败:', err);
      Toast.error('❌ 导入失败：' + (err && err.message ? err.message : err));
    } finally {
      hideLoading();
    }
  },

  // 源表头 → 工作台列（仅映射当前列表显示的字段，财务等列按"对应工作台表头"原则不导入）
  _mapImportRows(rows) {
    const out = [];
    for (const r of rows) {
      // 🟢 v227.78：本地日期格式化。SheetJS 解析 Excel 日期有浮点漂移（00:00:00 → 前一天 23:59:17，
      //   源于 Excel 1900 闰年序列化误差），直接 getDate 会"减一天"。这里 +1 分钟容错再取整到本地日，
      //   对纯日期数据万无一失（真实日期相差整日，1 分钟容差不会跨日）。
      let 出库时间 = '';
      const d = r['出库日期'];
      if (d instanceof Date) {
        const s = new Date(d.getTime() + 60000);
        出库时间 = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
      } else if (d != null && d !== '') {
        出库时间 = String(d).slice(0, 10);
      }
      const qty = r['数量'];
      // 🟢 v227.80：存货编码 —— 源有则用源；源缺失则按 存货名称+规格型号 从存货档案补全
      let 存货编码 = (r['存货编码'] ?? '').toString().trim();
      if (!存货编码 && this._stockCodeMap) {
        const key = TableUtils.buildStockKey(r['存货名称'], r['规格型号']);
        存货编码 = this._stockCodeMap.get(key) || '';
        if (存货编码) this._stockFilled = (this._stockFilled || 0) + 1;
      }
      out.push({
        出库单号: (r['出库单号'] ?? '').toString().trim(),
        项目名称: (r['项目'] ?? '').toString().trim(),
        出库时间,
        存货编码,
        存货名称: (r['存货名称'] ?? '').toString().trim(),
        规格型号: (r['规格型号'] ?? '').toString().trim(),
        出库数量: (qty === '' || qty == null) ? 0 : Number(qty)
      });
    }
    return out;
  },

  // 🟢 v227.80：构建存货档案映射 存货名称+规格型号 → 存货编码（用于源缺编码时补全）
  async _loadStockCodeMap() {
    const rows = await db.stock.toArray();
    const m = new Map();
    for (const s of rows) {
      if (!s.存货编码) continue;
      const key = TableUtils.buildStockKey(s.存货名称, s.规格型号);
      if (key && !m.has(key)) m.set(key, String(s.存货编码).trim());
    }
    this._stockCodeMap = m;
  }
};
