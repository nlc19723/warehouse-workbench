// ============================================
// 出库管理模块 V1 - 独立数据表 · 智能联想 · CRUD · 打印
// ============================================

// ─── 出库单录入模块 ───
const OutboundModule = {
  currentOrderNo: '',    // 当前编辑的出库单号（空=新增模式）
  editingMode: false,    // true=编辑模式(搜索加载后)
  defaultRows: 15,        // 默认空白行数
  autoAddRows: 5,        // 到最后一行时自动增加的行数

  async render() {
    const content = document.getElementById('contentArea');
    const today = new Date().toISOString().split('T')[0];
    const projects = await DataStore.getOutboundProjects();

    content.innerHTML = `
      <!-- 操作栏 -->
      <div class="filter-bar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:0;">
        <input type="text" id="obSearchNo" placeholder="搜索出库单号..." value=""
          onkeydown="if(event.key==='Enter')OutboundModule.searchOrder()">
        <button class="search-glass" onclick="OutboundModule.searchOrder()">🔍 搜索</button>
        <button class="secondary" onclick="OutboundModule.resetForm()">重置</button>
        <button class="primary" onclick="OutboundModule.saveOrder()">💾 录入</button>
        <button class="secondary" onclick="OutboundModule.activateEdit()">✏️ 修改</button>
        <button class="secondary" style="color:var(--status-danger);border-color:var(--status-danger);" onclick="OutboundModule.deleteOrder()">🗑️ 删除</button>
        <button class="secondary" onclick="OutboundModule.printOrder()">🖨️ 打印</button>
      </div>

      <!-- 表头信息区 -->
      <div class="glass-card" style="margin-bottom:14px;">
        <div class="glass-card-header">
          <span class="glass-card-title"><span class="title-icon">📤</span>出库单信息</span>
        </div>
        <div style="display:grid;grid-template-columns:auto auto auto auto;gap:12px 24px;padding:16px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:12.5px;font-weight:600;color:var(--text-muted);white-space:nowrap;">出库单号</label>
            <button id="obPrevBtn" onclick="OutboundModule.navigateOrder(-1)" title="上一单"
              style="width:30px;height:34px;border:1px solid var(--card-border);border-radius:8px;background:linear-gradient(180deg,var(--card-bg),rgba(0,0,0,0.04));box-shadow:0 2px 4px rgba(0,0,0,0.08),inset 0 1px 0 rgba(255,255,255,0.6);color:var(--text-main);font-size:14px;cursor:pointer;transition:all 0.15s;">◀</button>
            <input type="text" id="obOrderNo" placeholder="自动生成或手动输入" style="width:180px;height:34px;border:1px solid var(--card-border);border-radius:8px;padding:0 10px;font-size:13px;background:var(--card-bg);color:var(--text-main);">
            <button id="obNextBtn" onclick="OutboundModule.navigateOrder(1)" title="下一单"
              style="width:30px;height:34px;border:1px solid var(--card-border);border-radius:8px;background:linear-gradient(180deg,var(--card-bg),rgba(0,0,0,0.04));box-shadow:0 2px 4px rgba(0,0,0,0.08),inset 0 1px 0 rgba(255,255,255,0.6);color:var(--text-main);font-size:14px;cursor:pointer;transition:all 0.15s;">▶</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:12.5px;font-weight:600;color:var(--text-muted);white-space:nowrap;">出库时间</label>
            <input type="date" id="obDate" value="${today}" style="width:130px;height:34px;border:1px solid var(--card-border);border-radius:8px;padding:0 10px;font-size:13px;background:var(--card-bg);color:var(--text-main);">
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:12.5px;font-weight:600;color:var(--text-muted);white-space:nowrap;">项目名称</label>
            <input type="text" id="obProject" placeholder="输入或选择项目名称" style="width:280px;height:34px;border:1px solid var(--card-border);border-radius:8px;padding:0 10px;font-size:13px;background:var(--card-bg);color:var(--text-main);" autocomplete="off">
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <label style="font-size:12.5px;font-weight:600;color:var(--text-muted);white-space:nowrap;">领用人员</label>
            <input type="text" id="obReceiver" placeholder="输入领用人员" style="width:130px;height:34px;border:1px solid var(--card-border);border-radius:8px;padding:0 10px;font-size:13px;background:var(--card-bg);color:var(--text-main);">
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

    // 自动生成单号（如果为空）
    if (!document.getElementById('obOrderNo').value) {
      const nextNo = await this.generateNextOrderNo();
      document.getElementById('obOrderNo').value = nextNo;
    }

    // 渲染默认空白行
    this.renderDetailRows();

    // 绑定项目名称联想（来源：入库列表去重后的项目名称）
    setTimeout(() => this.bindProjectAutocomplete(), 100);
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
      const all = await db.inbound.toArray();
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
    } catch (e) { /* ignore */ }
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
        <table class="data-table" style="width:auto;table-layout:fixed;">
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
          <td style="text-align:center;font-size:12px;color:var(--text-muted);">${idx + 1}</td>
          <td style="position:relative;">
            <input type="text" class="ob-code-input" placeholder="输入编码联想..."
              value="${r.存货编码 || ''}"
              data-row="${idx}" autocomplete="off"
              style="width:100%;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:var(--card-bg);color:var(--text-main);outline:none;box-sizing:border-box;">
          </td>
          <td><input type="text" class="ob-name-input" readonly placeholder="自动填充"
            value="${r.存货名称 || ''}" data-row="${idx}"
            style="width:100%;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:rgba(0,0,0,0.03);color:var(--text-body);outline:none;box-sizing:border-box;"></td>
          <td><input type="text" class="ob-spec-input" readonly placeholder="自动填充"
            value="${r.规格型号 || ''}" data-row="${idx}"
            style="width:100%;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:rgba(0,0,0,0.03);color:var(--text-body);outline:none;box-sizing:border-box;"></td>
          <td style="text-align:right;"><input type="number" class="ob-qty-input" placeholder="0"
            value="${r.出库数量 || ''}" data-row="${idx}" min="0" step="any"
            style="width:80px;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:var(--card-bg);color:var(--text-main);outline:none;text-align:right;"></td>
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

    // 点击外部关闭联想（只绑一次，避免重复调用 bindAutocomplete 时累积监听器）
    if (!this._docClickBound) {
      this._docClickBound = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.autocomplete-dropdown') && !e.target.closest('.ob-code-input')) {
          this.hideAutocomplete();
        }
      });
    }
  },

  // 显示联想下拉
  async showAutocomplete(inputEl, keyword) {
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

    // 构建下拉浮层 HTML
    let itemsHtml = '';
    results.forEach(r => {
      itemsHtml += `<div class="autocomplete-item" data-code="${escAttr(r.存货编码 || '')}" data-name="${escAttr(r.存货名称 || '')}" data-spec="${escAttr(r.规格型号 || '')}">
        <span class="autocomplete-code">${esc(r.存货编码 ?? '')}</span>
        <span class="autocomplete-name">${esc(r.存货名称 || '')}</span>
        <span class="autocomplete-spec">${esc(r.规格型号 || '')}</span>
      </div>`;
    });

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
      <td style="text-align:center;font-size:12px;color:var(--text-muted);">${newRowIdx + 1}</td>
      <td style="position:relative;">
        <input type="text" class="ob-code-input" placeholder="输入编码联想..."
          data-row="${newRowIdx}" autocomplete="off"
          style="width:100%;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:var(--card-bg);color:var(--text-main);outline:none;box-sizing:border-box;">
      </td>
      <td><input type="text" class="ob-name-input" readonly placeholder="自动填充"
        data-row="${newRowIdx}"
        style="width:100%;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:rgba(0,0,0,0.03);color:var(--text-body);outline:none;box-sizing:border-box;"></td>
      <td><input type="text" class="ob-spec-input" readonly placeholder="自动填充"
        data-row="${newRowIdx}"
        style="width:100%;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:rgba(0,0,0,0.03);color:var(--text-body);outline:none;box-sizing:border-box;"></td>
      <td style="text-align:right;"><input type="number" class="ob-qty-input" placeholder="0"
        data-row="${newRowIdx}" min="0" step="any"
        style="width:80px;height:32px;border:1px solid var(--card-border);border-radius:6px;padding:0 8px;font-size:12px;background:var(--card-bg);color:var(--text-main);outline:none;text-align:right;"></td>
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
  async getAllOrderNos() {
    const all = await db.outbound.toArray();
    const set = new Set(all.map(r => r.出库单号).filter(Boolean));
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

  // 翻阅前后出库单（dir: -1=上一单, 1=下一单）
  async navigateOrder(dir) {
    const allNos = await this.getAllOrderNos();
    if (allNos.length === 0) {
      this.showMsg('暂无任何出库单可翻阅', true);
      return;
    }
    const current = document.getElementById('obOrderNo').value.trim();
    let idx = allNos.indexOf(current);
    if (idx === -1) {
      // 当前单号不在列表中（可能是新建的或手动改的），从最近的一单开始
      idx = dir > 0 ? -1 : 0;
    }
    const newIdx = idx + dir;
    if (newIdx < 0) { this.showMsg('已经是第一单了', true); return; }
    if (newIdx >= allNos.length) { this.showMsg('已经是最后一单了', true); return; }

    const targetNo = allNos[newIdx];
    document.getElementById('obSearchNo').value = targetNo;
    await this.searchOrder();
  },

  async searchOrder() {
    // 🔴 防御（S1）：输入框可能在模块切换后不存在，必须判空，否则 null.value 抛 TypeError
    const el = document.getElementById('obSearchNo');
    if (!el) { console.warn('[出库] searchOrder: 出库单号输入框不存在（可能已切换模块），跳过'); return; }
    const orderNo = el.value.trim();
    if (!orderNo) { this.showMsg('请输入出库单号进行搜索', true); return; }

    const records = await db.outbound.where('出库单号').equals(orderNo).toArray();
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
    this.showMsg(`已加载出库单 "${orderNo}"，共 ${records.length} 条明细`);
  },

  // 重置表单（智能生成下一个单号）
  async resetForm() {
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
      this.showMsg(`✅ 表单已重置，新单号：${nextNo}`);
    } catch (err) {
      console.error('重置表单失败:', err);
      this.showMsg('❌ 重置失败: ' + (err.message || err), true);
    }
  },

  // 录入/保存（带重复校验和提示）
  async saveOrder() {
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

    // 重复单号校验：如果不是修改模式 或 单号变了，则禁止保存已存在的单号
    const exists = await db.outbound.where('出库单号').equals(orderNo).count();
    const isSameAsEditing = this.editingMode && this.currentOrderNo === orderNo;
    if (exists > 0 && !isSameAsEditing) {
      this.showMsg(`❌ 出库单号 "${orderNo}" 已存在！如需修改请先点击"✏️ 修改"按钮再录入`, true);
      return;
    }

    try {
      // 如果是编辑模式且单号变化，先删旧数据
      if (this.editingMode && this.currentOrderNo && this.currentOrderNo !== orderNo) {
        await db.outbound.where('出库单号').equals(this.currentOrderNo).delete();
      }

      // 删除同单号的旧明细（upsert 语义：先删后插）
      await db.outbound.where('出库单号').equals(orderNo).delete();

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

      await db.outbound.bulkAdd(newRecords);

      this.currentOrderNo = orderNo;
      this.editingMode = false;

      // 录入成功后：自动生成下一个单号 + 重置明细表 + 显示成功提示 + 同步云端
      const nextNo = await this.generateNextOrderNo();
      document.getElementById('obOrderNo').value = nextNo;
      document.getElementById('obProject').value = '';
      document.getElementById('obReceiver').value = '';
      this.renderDetailRows();
      this.showMsg(`✅ 出库单 "${orderNo}" 已保存（${details.length} 条明细），新单号：${nextNo}`);
      this._syncOutboundToCloud();   // ← 增量同步 outbound 表到云端
    } catch (err) {
      console.error('保存出库单失败:', err);
      this.showMsg('❌ 保存失败: ' + err.message, true);
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

  // 删除当前出库单（带成功/失败提示）
  async deleteOrder() {
    try {
      const orderNo = this.currentOrderNo || document.getElementById('obSearchNo').value.trim();
      if (!orderNo) {
        // 尝试从表头取
        const headerNo = document.getElementById('obOrderNo').value.trim();
        if (!headerNo) { this.showMsg('❌ 请先指定要删除的出库单号', true); return; }
        const cnt = await db.outbound.where('出库单号').equals(headerNo).count();
        if (cnt === 0) { this.showMsg(`❌ 出库单号 "${headerNo}" 不存在`, true); return; }
        if (!confirm(`确定要删除出库单 "${headerNo}" 及其全部 ${cnt} 条明细吗？此操作不可恢复！`)) return;
        await db.outbound.where('出库单号').equals(headerNo).delete();
        this.showMsg(`✅ 已删除出库单 "${headerNo}"（${cnt} 条明细）`);
        this._syncOutboundToCloud();   // ← 增量同步 outbound 表
        await this.resetForm();
        return;
      }

      const cnt = await db.outbound.where('出库单号').equals(orderNo).count();
      if (cnt === 0) { this.showMsg(`❌ 出库单号 "${orderNo}" 不存在`, true); return; }
      if (!confirm(`确定要删除出库单 "${orderNo}" 及其全部 ${cnt} 条明细吗？此操作不可恢复！`)) return;

      await db.outbound.where('出库单号').equals(orderNo).delete();
      this.showMsg(`✅ 已删除出库单 "${orderNo}"（${cnt} 条明细）`);
      this._syncOutboundToCloud();   // ← 增量同步 outbound 表
      await this.resetForm();
    } catch (err) {
      console.error('删除失败:', err);
      this.showMsg('❌ 删除失败: ' + err.message, true);
    }
  },

  // 异步增量同步 outbound 到云端（不阻塞 UI，失败仅在 console 提示）
  _syncOutboundToCloud() {
    if (typeof DataLoader === 'undefined' || !DataLoader.pushOutboundToCloud) return;
    DataLoader.pushOutboundToCloud().catch(err => {
      console.warn('[出库] 增量同步失败:', err.message || err);
    });
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
          <td>${d.code ?? ''}</td>
          <td>${d.name ?? ''}</td>
          <td>${d.spec ?? ''}</td>
          <td style="text-align:right;">${d.qty || 0}</td>
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
          <tr><td style="padding:6px 10px;border:1px solid #ddd;width:25%;background:#f9f9f9;font-weight:600;">出库单号</td><td style="padding:6px 10px;border:1px solid #ddd;">${printNo}</td>
              <td style="padding:6px 10px;border:1px solid #ddd;width:25%;background:#f9f9f9;font-weight:600;">出库时间</td><td style="padding:6px 10px;border:1px solid #ddd;">${printDate}</td></tr>
          <tr><td style="padding:6px 10px;border:1px solid #ddd;background:#f9f9f9;font-weight:600;">项目名称</td><td style="padding:6px 10px;border:1px solid #ddd;">${printProject}</td>
              <td style="padding:6px 10px;border:1px solid #ddd;background:#f9f9f9;font-weight:600;">领用人员</td><td style="padding:6px 10px;border:1px solid #ddd;">${printReceiver}</td></tr>
        </table>
        <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
          <thead><tr style="background:#f0f0f0;">
            <th style="padding:8px;border:1px solid #ccc;width:40px;text-align:center;">序号</th>
            <th style="padding:8px;border:1px solid #ccc;width:120px;">存货编码</th>
            <th style="padding:8px;border:1px solid #ccc;">存货名称</th>
            <th style="padding:8px;border:1px solid #ccc;width:120px;">规格型号</th>
            <th style="padding:8px;border:1px solid #ccc;width:80px;text-align:right;">出库数量</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot><tr style="background:#f9f9f9;font-weight:700;">
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
    // 移除已有的 toast（保留最新一条）
    document.querySelectorAll('.ob-toast-notification').forEach(t => {
      if (t !== document.querySelector('.ob-toast-notification:last-of-type')) t.remove();
    });

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
  pageSize: 20,

  async render() {
    const content = document.getElementById('contentArea');
    const projects = await DataStore.getOutboundProjects();

    content.innerHTML = `
      <div class="filter-bar" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:0;">
        <input type="text" id="oblKw" placeholder="搜索单号/编码/名称/领用人..." value="${this.currentFilter.keyword || ''}"
          onkeydown="if(event.key==='Enter')OutboundListModule.applyFilter()">
        <input type="date" id="oblStartDate" value="${this.currentFilter.startDate || ''}" class="filter-date">
        <span class="filter-sep">至</span>
        <input type="date" id="oblEndDate" value="${this.currentFilter.endDate || ''}" class="filter-date">
        <select id="oblProject" title="按项目筛选">
          <option value="">全部项目</option>
          ${projects.map(p => `<option value="${escAttr(p)}" ${this.currentFilter.项目名称 === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
        <button class="search-glass" onclick="OutboundListModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="OutboundListModule.resetFilter()">重置</button>
        <button class="secondary" onclick="OutboundListModule.exportData()">📥 导出Excel</button>
      </div>

      <div id="oblSummary"></div>
      <div id="oblTableArea"></div>
      <div id="oblPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    const result = await DataStore.getOutbound(this.currentFilter, this.currentPage, this.pageSize);
    const { items, total, totalPages } = result;

    // KPI 统计（🟡 M6：基于全量筛选结果，而非仅当前分页，避免分页导致数值偏低）
    const allLimit = (window.AppConfig && AppConfig.app && AppConfig.app.kpiAllLimit) || 1000000;
    const allFiltered = await DataStore.getOutbound(this.currentFilter, 1, allLimit);
    const orderNos = [...new Set(allFiltered.items.map(i => i.出库单号).filter(Boolean))];
    const totalQty = allFiltered.items.reduce((s, i) => s + (parseFloat(i.出库数量) || 0), 0);

    document.getElementById('oblSummary').innerHTML = `
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
            <col style="width:240px;">      <!-- 项目名称（最长） -->
            <col style="width:90px;">       <!-- 领用人员 -->
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
              <th class="ob-th-center">领用人员</th>
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
                <td class="ob-td-center">${(this.currentPage - 1) * this.pageSize + idx + 1}</td>
                <td class="ob-td-center"><a href="#outbound" onclick="OutboundListModule.goToEntry('${escAttr(item.出库单号 || '')}'); return false;" style="color:var(--primary);text-decoration:none;font-weight:600;">${esc(item.出库单号 ?? '')}</a></td>
                <td style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escAttr(item.项目名称 || '')}">${esc(item.项目名称 ?? '')}</td>
                <td class="ob-td-center">${esc(item.领用人员 ?? '')}</td>
                <td class="ob-td-center">${esc(item.出库时间 ?? '')}</td>
                <td class="ob-td-center" style="font-family:monospace;font-size:11.5px;">${esc(item.存货编码 ?? '')}</td>
                <td class="ob-td-center" style="font-size:11.5px;" title="${escAttr(item.存货名称 || '')}">${esc(item.存货名称 ?? '')}</td>
                <td class="ob-td-center" style="font-size:11.5px;">${esc(item.规格型号 ?? '')}</td>
                <td class="ob-td-center" style="font-weight:600;">${item.出库数量 != null ? parseFloat(item.出库数量).toLocaleString('zh-CN',{maximumFractionDigits:2}) : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(total, totalPages);
    TableUtils.initSmartSelect('oblTableArea');
  },

  // 点击单号跳转到录入页
  goToEntry(orderNo) {
    // 临时存储要加载的单号，再切换到出库录入模块
    // App.go('outbound') 渲染后会自动检测并加载该单（见 app.js go() 内的 checkPendingLoad）
    sessionStorage.setItem('_ob_load_order_no', orderNo);
    if (typeof App !== 'undefined' && App.go) App.go('outbound');
  },

  // 检查是否有待加载的单号（在 render 开头调用）
  checkPendingLoad() {
    const pendingNo = sessionStorage.getItem('_ob_load_order_no');
    if (!pendingNo) return;
    sessionStorage.removeItem('_ob_load_order_no');
    // 🔴 延迟执行（S1）：仅当仍停留在出库录入模块时才加载，
    // 避免切换模块后 obSearchNo 不存在导致 searchOrder 崩溃，或误把待加载单号套用到其它模块
    setTimeout(() => {
      if (typeof App === 'undefined' || App.currentModule !== 'outbound') return;
      const el = document.getElementById('obSearchNo');
      if (!el) return;
      el.value = pendingNo;
      OutboundModule.searchOrder();
    }, 200);
  },

  renderPagination(total, totalPages) {
    const page = this.currentPage;
    const html = [];
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">共 <b>${total}</b> 条</span>`);
    html.push(`<span class="page-btns">`);
    html.push(`<button onclick="OutboundListModule.goPage(1)" ${page===1?'disabled':''}>«</button>`);
    html.push(`<button onclick="OutboundListModule.goPage(${page-1})" ${page===1?'disabled':''}>‹</button>`);
    const start=Math.max(1,page-2), end=Math.min(totalPages,start+4);
    for(let i=start;i<=end;i++) html.push(`<button class="${i===page?'active':''}" onclick="OutboundListModule.goPage(${i})">${i}</button>`);
    html.push(`<button onclick="OutboundListModule.goPage(${page+1})" ${page===totalPages?'disabled':''}>›</button>`);
    html.push(`<button onclick="OutboundListModule.goPage(${totalPages})" ${page===totalPages?'disabled':''}>»</button>`);
    html.push(`</span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">每页 <select onchange="OutboundListModule.changePageSize(+this.value)" style="height:28px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-body);font-size:11px;padding:0 4px;"><option value="20" ${this.pageSize===20?'selected':''}>20</option><option value="50" ${this.pageSize===50?'selected':''}>50</option><option value="100" ${this.pageSize===100?'selected':''}>100</option></select> 条</span>`);
    html.push(`<span style="font-size:12px;color:var(--text-secondary);">跳至 <input type="number" id="oblPageJumper" min="1" max="${totalPages}" value="${page}" onkeydown="if(event.key==='Enter')OutboundListModule.goPage(+this.value)" style="width:44px;height:28px;text-align:center;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:var(--text-main);font-size:12px;"> / ${totalPages} 页</span>`);
    document.getElementById('oblPagination').innerHTML = html.join('');
  },

  changePageSize(size) { this.pageSize=size; this.currentPage=1; this.loadData(); },
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
    this.pageSize = 20;
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
  }
};
