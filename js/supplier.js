// ============================================
// 供应商管理模块 V3 - 统一表格 · 合同到期排序 · 20条/页
// ============================================

const SupplierModule = {
  currentFilter: {},
  currentPage: 1,
  pageSize: AppConfig.app.defaultPageSize,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    const types = await DataStore.getSupplierTypes();
    const departments = await DataStore.getSupplierDepartments();
    if (myToken !== undefined && myToken !== App._goToken) return;

    content.innerHTML = `
      <div class="filter-bar filter-bar-m" data-mod="supplier">
        <input type="text" id="supplierKw" class="fb-search" placeholder="搜索供应商名称..." value="${escAttr(this.currentFilter.keyword || '')}" onkeydown="if(event.key==='Enter')SupplierModule.applyFilter()">
        <div class="fb-row fb-row--fields">
          <div class="fb-field"><select id="supplierType">
          <option value="">全部类型</option>
          ${types.map(t => `<option value="${escAttr(t)}" ${this.currentFilter.类型 === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select></div>
          <div class="fb-field"><select id="supplierDept">
          <option value="">全部招采部门</option>
          ${departments.map(d => `<option value="${escAttr(d)}" ${this.currentFilter.招采部门 === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}
        </select></div>
          <div class="fb-field"><select id="contractWarn">
          <option value="">合同状态</option>
          <option value="expiring">即将到期(&lt;30天)</option>
          <option value="near">临近期(30-90天)</option>
          <option value="expired">已到期</option>
        </select></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="SupplierModule.applyFilter()">筛选</button>
          <button class="btn--ghost" onclick="SupplierModule.resetFilter()">重置</button>
          <button class="btn--ghost" onclick="SupplierModule.exportData()">📥 导出</button>
        </div>
      </div>

      <!-- 合同状态统计区 -->
      <div id="contractStatsArea"></div>

      <div id="supplierTableArea"></div>
      <div id="supplierPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    // 🟢 v227.74：移动端筛选栏字段行配平（≤768px 按最长选项动态分配 flex-grow）
    if (window.FilterLayout) FilterLayout.balanceAll();

    await this.loadTable(myToken);
  },

  async loadTable(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    let suppliers = await DataStore.getSuppliers(this.currentFilter);

    // 🟢 v209 AUDIT-305：每个供应商的「所属年度」= 年度合同到期时间的年份；
    //   仅用于下方「已入库金额」运行时兜底（合同年度内已供口径，与年度合同金额比得出进度）。
    //   🟢 v230.22：未入库金额已改为合同期间口径（见下方派生段），不再使用本 Map——
    //   两列不同问：已入库=年度进度，未入库=合同期间内待收欠账。
    const yearBySup = new Map();
    suppliers.forEach(s => {
      if (!s.供应商) return;
      const y = s.年度合同到期时间 ? new Date(s.年度合同到期时间 + 'T00:00:00').getFullYear() : NaN;
      if (!isNaN(y)) yearBySup.set(s.供应商, y);
    });

    // 运行时补全：若已入库金额全为0，从入库表汇总
    const allZero = suppliers.length > 0 && suppliers.every(s => !s.年度已供入库金额 || s.年度已供入库金额 === 0);
    if (allZero) {
      try {
        const inbound = await DataStore.getRows('inbound');
        // 🟢 v230.20（AUDIT-230-03）：分组收集后走 TableUtils.sumMoney 定点汇总
        //   （以「分」为整数单位累加），替代逐行浮点累加，规避尾差漂移。
        const rowsBySup = new Map();
        inbound.forEach(row => {
          const sup = row.供应商;
          if (!sup) return;
          const yr = row.入库日期 ? new Date(row.入库日期 + 'T00:00:00').getFullYear() : NaN;
          const targetYr = yearBySup.get(sup);
          if (targetYr && !isNaN(yr) && yr !== targetYr) return; // 非合同所属年度 → 跳过（无年度信息则全计，降级兼容）
          if (!rowsBySup.has(sup)) rowsBySup.set(sup, []);
          rowsBySup.get(sup).push(row);
        });
        const map = new Map();
        rowsBySup.forEach((rowsOfSup, sup) => {
          map.set(sup, TableUtils.sumMoney(rowsOfSup, r => r.原币价税合计));
        });
        suppliers.forEach(s => {
          if (map.has(s.供应商)) {
            s.年度已供入库金额 = map.get(s.供应商);
            // 🟢 v230.20（AUDIT-230-03）：占比定点规整（6 位）
            if (s.年度合同金额 > 0) s.年度已供入库金额占比 = TableUtils.roundQty(s.年度已供入库金额 / s.年度合同金额, 6);
          }
        });
      } catch(e){
    /*ignore*/ console.warn('[supplier.js:83] 异常(已忽略):', e);
  }
    }

    // 🟢 v230.22（用户二次反馈修订）：派生列「未入库金额(元)」= Σ(订单.未入库量 × 订单.原币含税单价)，
    //   【仅计订单日期落在合同期间内的订单】。期间构造与 _calcPhaseAmounts（v229.18 入库侧）同源：
    //   第 N 期 = [该期生效, 次期生效)，末期 = [末期生效, 末期生效 + 合同年限]；三期并集即合同全生命期。
    //   口径演进：v230.13 按「年度合同到期时间的年份」过滤 → 跨年度合同（2026 签/2027-28 到期）
    //   的 2026 订单被整段误杀（线上 10/10 零值根因）；v230.21 一度取消过滤改全量口径 →
    //   用户反馈合同已过期后的未入订单不应计入（如共同君行 7,306 元，合同 2025-08-31 已过期），
    //   且明确「要过滤，以年度生效~合同到期为区间」。本版以日期区间比较实现：跨年不误杀、过期不计。
    //   降级规则：供应商无任何生效日期 → 不过滤全计（防误杀）；订单无日期 → 计入（真实欠账）。
    //   不按审批状态过滤（未入库天然包含未批订单，未批也是未发生业务）。
    //   数据源为订单表（IndexedDB，getRows 表级缓存命中零开销），纯派生、不落任何存储。
    //   单价取 原币含税单价（与订单列表「含税单价」展示列同口径）。
    try {
      const orders = await DataStore.getRows('orders');
      const parseTs = (v) => { if (!v) return null; const s = String(v); const d = new Date(s.includes('T') ? s : s + 'T00:00:00'); return isNaN(d.getTime()) ? null : d.getTime(); };
      // 合同期间构造（与 _calcPhaseAmounts / v229.18 同源）：第 N 期=[该期生效, 次期生效)，末期=[末期生效, 末期+合同年限]
      const rangesOfSup = (s) => {
        const ps = [s.第一年度生效时间, s.第二年度生效时间, s.第三年度生效时间].map(parseTs).filter((t) => t != null);
        if (!ps.length) return null;                       // 无期间信息 → 不过滤（降级全计，防误杀）
        const single = (parseFloat(s.合同年限) || ps.length) / (parseInt(s.签订次数) || ps.length);
        const rs = [];
        for (let i = 0; i < ps.length; i++) {
          const start = ps[i];
          const sd = new Date(start);
          const end = (i < ps.length - 1) ? ps[i + 1] : new Date(sd.getFullYear() + Math.round(single), sd.getMonth(), sd.getDate()).getTime();
          rs.push([start, end]);
        }
        return rs;
      };
      const rangeBySup = new Map();
      suppliers.forEach((s) => { if (s.供应商) rangeBySup.set(s.供应商, rangesOfSup(s)); });
      const uninMap = new Map();
      orders.forEach(o => {
        const sup = o.供应商;
        if (!sup) return;
        const qty = parseFloat(o.未入库量);
        if (!(qty > 0)) return;                     // 无未入库余量 → 不产生未入库金额（NaN 亦被排除）
        const price = parseFloat(o.原币含税单价);
        if (!(price > 0)) return;                   // 防 NaN 污染累加
        const od = parseTs(o.日期);
        const rs = rangeBySup.get(sup);
        // 有期间信息且订单日期可解析但落在全部期间之外 → 不计（v230.22：合同期外欠账不列本期）
        if (rs && od != null && !rs.some(([a, b]) => od >= a && od < b)) return;
        // 🟢 v230.20（AUDIT-230-03）：按供应商分组收集，稍后统一 sumMoney 定点汇总
        if (!uninMap.has(sup)) uninMap.set(sup, []);
        uninMap.get(sup).push({ 未入库量: qty, 原币含税单价: price });
      });
      suppliers.forEach(s => {
        const rowsOfSup = uninMap.get(s.供应商);
        // 行值 = 未入库量 × 含税单价；sumMoney 逐行按分取整后累加
        s.年度未供入库金额 = rowsOfSup ? TableUtils.sumMoney(rowsOfSup, r => r.未入库量 * r.原币含税单价) : 0;
      });
    } catch (e) {
      console.warn('[supplier.js] 未入库金额派生(已忽略):', e && e.message);
    }

    // 🟢 v229.98（AUDIT-229-98-23）：留住「未被合同状态筛过」的全量，供顶部统计卡用。
    //   原先统计卡吃的是筛选后的数据 → 选「已到期」后，即将到期/临近期/安全三项统计全变 0，
    //   用户一筛选就失去了全局概览。
    const allSuppliers = suppliers.slice();

    const contractWarn = document.getElementById('contractWarn')?.value;
    if (contractWarn) {
      const now = new Date();
      suppliers = suppliers.filter(s => {
        if (!s.年度合同到期时间) return false;
        const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
        if (contractWarn === 'expiring') return days >= 0 && days <= 30;
        if (contractWarn === 'near') return days > 30 && days <= 90;
        if (contractWarn === 'expired') return days < 0;
        return true;
      });
    }

    const now = new Date();
    suppliers.sort((a, b) => {
      const daysA = a.年度合同到期时间
        ? Math.ceil((new Date(a.年度合同到期时间) - now) / (1000 * 60 * 60 * 24))
        : 99999;
      const daysB = b.年度合同到期时间
        ? Math.ceil((new Date(b.年度合同到期时间) - now) / (1000 * 60 * 60 * 24))
        : 99999;

      const aExpired = daysA < 0;
      const bExpired = daysB < 0;

      if (aExpired && !bExpired) return 1;
      if (!aExpired && bExpired) return -1;

      if (!aExpired && !bExpired) {
        if (daysA === 99999 && daysB === 99999) return 0;
        if (daysA === 99999) return 1;
        if (daysB === 99999) return -1;
        return daysA - daysB;
      }

      return daysB - daysA;
    });

    if (rt !== undefined && rt !== App._goToken) return;
    // 🟢 v229.98（AUDIT-229-98-23）：统计卡始终基于全量，不受合同状态筛选影响
    this.renderContractStats(allSuppliers);
    // 🟢 v229.98（AUDIT-229-98-24）：把「当前屏幕上的行」存下来给导出用（见 exportData）
    this._filteredSuppliers = suppliers;

    const total = suppliers.length;
    const pageSize = this.pageSize === 'all' ? total : this.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    this.currentPage = page;
    const items = suppliers.slice((page - 1) * pageSize, page * pageSize);

    const area = document.getElementById('supplierTableArea');
    if (items.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无供应商数据</div></div>';
      TableUtils.setHtml('supplierPagination', '');
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>供应商</th>
              <th>签订次数</th>
              <th>合同年限</th>
              <th>第一年度生效</th>
              <th>第二年度生效</th>
              <th>第三年度生效</th>
              <th>本期生效</th>
              <th>本期合同到期</th>
              <th>剩余天数</th>
              <th>合同最终到期</th>
              <th>年度合同金额(元)</th>
              <th>未入库金额(元)</th>
              <th>已入库金额(元)</th>
              <th>已入库占比</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(s => {
              const _curStart = SupplierModule._currentPeriodStart(s);
              let daysTag = '';
              if (s.年度合同到期时间) {
                const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
                if (days < 0) { daysTag = `<span class="tag tag-danger">已过期${-days}天</span>`; }
                else if (days <= 30) { daysTag = `<span class="tag tag-warning">${days}天</span>`; }
                else daysTag = `<span class="tag tag-success">${days}天</span>`;
              }
              const ratio = s.年度已供入库金额占比 || 0;
              const pct = Math.round(ratio * 100);
              // 颜色规则：<60%草绿色，60-80%蛋黄色，>80%暗红色
              const barClass = pct >= 80 ? 'danger' : pct >= 60 ? 'warning' : '';
              return `
                <tr>
                  <td>${esc(s.类型 ?? '')}</td>
                  <td><strong>${esc(s.供应商)}</strong></td>
                  <td style="text-align:center">${esc(s.签订次数 ?? '')}</td>
                  <td style="text-align:center">${esc(s.合同年限 ?? '')}</td>
                  <td>${esc(s.第一年度生效时间 ?? '—')}</td>
                  <td>${esc(s.第二年度生效时间 ?? '—')}</td>
                  <td>${esc(s.第三年度生效时间 ?? '—')}</td>
                  <td>${_curStart}</td>
                  <td>${esc(s.年度合同到期时间 ?? '')}</td>
                  <td>${daysTag || ''}</td>
                  <td>${esc(s.最终到期时间 ?? '')}</td>
                  <td>${TableUtils.formatMoney(s.年度合同金额)}</td>
                  <td>${TableUtils.formatMoney(s.年度未供入库金额 || 0)}</td>
                  <td>${TableUtils.formatMoney(s.年度已供入库金额)}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div class="progress-bar" style="width:70px;">
                        <div class="progress-fill ${barClass}" style="width:${pct}%;"></div>
                      </div>
                      <span style="font-size:11px;color:var(--text-secondary);min-width:36px;">${pct}%</span>
                    </div>
                  </td>
                  <td><button class="btn-detail" onclick="SupplierModule.viewDetail(${JSON.stringify(s.id)})" aria-label="查看供应商 ${escAttr(s.供应商 ?? '')} 详情" title="查看${escAttr(s.供应商 ?? '')}的合同与入库详情">🔍 详情</button></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    this.renderPagination(total, totalPages);
    TableUtils.initExcelSelection('supplierTableArea');
    TableUtils.initSortableHeaders('supplierTableArea');
  },

  // 🟢 v229.18：本期生效 = 三期中 ≤ 今天的最新一期（用户口径"判断今天属于哪个最新的生效日期"）；
  //   三期都为未来日期时回退展示最早一期，避免空白。
  _currentPeriodStart(s) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const ps = [s.第一年度生效时间, s.第二年度生效时间, s.第三年度生效时间]
      .map(d => d ? new Date(String(d).includes('T') ? d : d + 'T00:00:00') : null)
      .filter(d => d && !isNaN(d.getTime()));
    if (!ps.length) return '—';
    const v = ps.filter(d => d.getTime() <= t.getTime());
    const pick = v.length ? Math.max(...v.map(x => x.getTime())) : Math.min(...ps.map(x => x.getTime()));
    const d = ps.find(x => x.getTime() === pick);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },

  // 🟢 v229.18：详情各期「期间入库金额」——第 N 期 = [该期生效, 次期生效) 入库总额；末期 = [末期生效, 末期生效 + 单次合同年限]。
  _calcPhaseAmounts(s, inbound) {
    const ps = [s.第一年度生效时间, s.第二年度生效时间, s.第三年度生效时间]
      .map(d => d ? new Date(String(d).includes('T') ? d : d + 'T00:00:00') : null)
      .filter(d => d && !isNaN(d.getTime()));
    if (!ps.length) return [];
    const single = (parseFloat(s.合同年限) || ps.length) / (parseInt(s.签订次数) || ps.length);
    const ranges = [];
    for (let i = 0; i < ps.length; i++) {
      const start = ps[i];
      const end = (i < ps.length - 1) ? ps[i + 1]
        : new Date(start.getFullYear() + Math.round(single), start.getMonth(), start.getDate());
      ranges.push([start, end]);
    }
    const sum = new Array(ranges.length).fill(0);
    (inbound || []).forEach(r => {
      const d = r.入库日期 ? new Date(String(r.入库日期).includes('T') ? r.入库日期 : r.入库日期 + 'T00:00:00') : null;
      if (!d || isNaN(d.getTime())) return;
      for (let i = 0; i < ranges.length; i++) {
        if (d.getTime() >= ranges[i][0].getTime() && d.getTime() < ranges[i][1].getTime()) {
          sum[i] += parseFloat(r.原币价税合计) || 0; break;
        }
      }
    });
    return ranges.map(([st, en], i) => ({ start: st, end: en, amount: sum[i], isLast: i === ranges.length - 1 }));
  },

  _buildPhaseSection(s, inbound) {
    const amts = this._calcPhaseAmounts(s, inbound);
    if (!amts.length) return '';
    const p = n => String(n).padStart(2, '0');
    const fmt = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const cards = amts.map((ph, i) => `
      <div style="text-align:center;padding:10px 6px;border:1px solid var(--line);border-radius:8px;${ph.isLast ? 'background:#eef4fd;border-color:#bfdbfe' : ''}">
        <b>第 ${i + 1} 期</b>${ph.isLast ? '<span class="tag tag-success" style="margin-left:6px;vertical-align:middle;">本期</span>' : ''}<br>
        <span style="font-size:12px;color:var(--text2)">${fmt(ph.start)} 至 ${fmt(ph.end)}</span><br>
        <span style="font-size:12px;color:var(--text2)">期间入库金额</span><br>
        <b style="font-size:15px${ph.isLast ? ';color:var(--primary-dark)' : ''}">¥${TableUtils.formatMoney(ph.amount)}</b>
      </div>`).join('');
    return `
      <h3 style="margin:0 0 8px;font-size:14px;">📅 各期生效时间 + 分期入库金额</h3>
      <div style="display:grid;grid-template-columns:repeat(${amts.length},1fr);gap:10px;margin-bottom:8px;">${cards}</div>
      <details style="font-size:12.5px;color:var(--text2);margin-bottom:16px;">
        <summary style="cursor:pointer;color:var(--primary)">📐 字段口径说明</summary>
        <div style="margin-top:6px;line-height:1.7">
          · 年度合同金额 = 签订一次合同的合同限价；<br>
          · 已供入库金额 = 最新的年度合同生效时间 → 今日，当年度合同期内入库总额；占比 = 已供入库 ÷ 年度合同金额；<br>
          · 签订次数 = 供应周期内需签订（含续签）次数；合同年限 = 供应周期；单次合同年限 = 供应周期 ÷ 签订次数；<br>
          · 各期「期间入库」= 该期生效 → 次期生效（不含）的入库总额；最后一期 = 该期生效 → 生效时间 + 单次合同年限。
        </div>
      </details>`;
  },

  renderContractStats(suppliers) {
    const now = new Date();
    let expiring = 0, near = 0, safe = 0, expired = 0;

    suppliers.forEach(s => {
      if (!s.年度合同到期时间) return;
      const days = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
      if (days < 0) expired++;
      else if (days <= 30) expiring++;
      else if (days <= 90) near++;
      else safe++;
    });

    TableUtils.setHtml('contractStatsArea', `
      <div class="contract-stats">
        <div class="contract-stat-item csw">
          <div class="cs-label">即将到期(&lt;30天)</div>
          <div class="cs-num">${expiring}</div>
        </div>
        <div class="contract-stat-item csnear">
          <div class="cs-label">临近期(30-90天)</div>
          <div class="cs-num">${near}</div>
        </div>
        <div class="contract-stat-item cssafe">
          <div class="cs-label">合同安全(&gt;90天)</div>
          <div class="cs-num">${safe}</div>
        </div>
        <div class="contract-stat-item csd">
          <div class="cs-label">已到期</div>
          <div class="cs-num">${expired}</div>
        </div>
      </div>
    `);
  },

  renderPagination(total, totalPages) {
    TableUtils.renderPagination('supplierPagination', { module: 'SupplierModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.currentPage = 1;
    this.loadTable();
  },

  goPage(p) {
    this.currentPage = p;
    this.loadTable();
  },

  applyFilter() {
    this.currentFilter = {
      keyword: document.getElementById('supplierKw').value.trim(),
      类型: document.getElementById('supplierType').value,
      招采部门: document.getElementById('supplierDept').value
    };
    this.currentPage = 1;
    this.loadTable();
  },

  resetFilter() {
    // 🟢 v229.98（AUDIT-229-98-11）：重置时一并清掉【表头列筛选】。
    //   原先「重置」只清顶部筛选栏（关键词/下拉/日期），表头列筛选仍生效且跨刷新存活 ——
    //   用户点了重置发现行数没变，误以为功能坏了。
    if (typeof TableUtils !== 'undefined' && TableUtils.clearColumnFiltersInView) TableUtils.clearColumnFiltersInView();
    this.currentFilter = {};
    this.currentPage = 1;
    this.pageSize = AppConfig.app.defaultPageSize;
    document.getElementById('supplierKw').value = '';
    document.getElementById('supplierType').value = '';
    document.getElementById('supplierDept').value = '';
    const cw = document.getElementById('contractWarn');
    if (cw) cw.value = '';
    this.loadTable();
  },

  async viewDetail(id) {
    const supplier = await db.suppliers.get(id);
    if (!supplier) return;

    // 获取该供应商的全部订单和入库记录，按日期降序取最近10条
    const [allOrders, allInbound] = await Promise.all([
      db.orders.where('供应商').equals(supplier.供应商).toArray(),
      db.inbound.where('供应商').equals(supplier.供应商).toArray()
    ]);

    // 按日期降序排列，取前10条
    const orders = allOrders
      .sort((a, b) => (b.日期 || '').localeCompare(a.日期 || ''))
      .slice(0, 10);
    const inbound = allInbound
      .sort((a, b) => (b.入库日期 || '').localeCompare(a.入库日期 || ''))
      .slice(0, 10);

    // 从现存量基础档案匹配填充存货编码（双路取码：① 记录自身字段 存货编码/存货编号；② codeMap 兜底）
    if (typeof DataLoader !== 'undefined' && DataLoader.fillStockCode) {
      const codeMap = await DataLoader.getStockNameSpecCodeMap();
      if (orders.length > 0) orders.forEach(o => DataLoader.fillStockCode(o, codeMap));
      if (inbound.length > 0) inbound.forEach(i => DataLoader.fillStockCode(i, codeMap));
    }

    // 计算最近3个月订单/入库趋势图数据
    const trendData = this._calcTrendData(allOrders, allInbound);
    const phaseSection = this._buildPhaseSection(supplier, allInbound);

    document.getElementById('modalTitle').textContent = supplier.供应商;
    TableUtils.setHtml('modalBody', `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
        <div><strong>类型:</strong> ${esc(supplier.类型 ?? '')}</div>
        <div><strong>招采部门:</strong> ${esc(supplier.招采部门 ?? '')}</div>
        <div><strong>签订次数:</strong> ${esc(supplier.签订次数 ?? '')}</div>
        <div><strong>合同年限:</strong> ${esc(supplier.合同年限 ?? '')}</div>
        <div><strong>第一年度生效:</strong> ${esc(supplier.第一年度生效时间 ?? '—')}</div>
        <div><strong>第二年度生效:</strong> ${esc(supplier.第二年度生效时间 ?? '—')}</div>
        <div><strong>第三年度生效:</strong> ${esc(supplier.第三年度生效时间 ?? '—')}</div>
        <div><strong>本期合同到期:</strong> ${esc(supplier.年度合同到期时间 ?? '')}</div>
        <div><strong>合同最终到期:</strong> ${esc(supplier.最终到期时间 ?? '')}</div>
        <div><strong>单次合同年限:</strong> ${esc(Math.round(parseFloat(supplier.合同年限 || 0) / (parseInt(supplier.签订次数) || 1) * 10) / 10)} 年</div>
        <div><strong>年度合同金额(元):</strong> ${TableUtils.formatMoney(supplier.年度合同金额)}</div>
        <div><strong>已入库金额(元):</strong> ${TableUtils.formatMoney(supplier.年度已供入库金额)}</div>
        <div><strong>生产厂址:</strong> ${esc(supplier.生产厂址 ?? '')}</div>
        <div><strong>办公地址:</strong> ${esc(supplier.地址 ?? '')}</div>
      </div>
      ${phaseSection}

      <!-- 趋势图区域 -->
      <div style="margin-bottom:16px;">
        <h4 style="margin:0 0 8px;font-size:14px;">📈 近3月趋势对比</h4>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div class="glass-card" style="padding:12px;margin:0;">
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">订单金额（万元）</div>
            <div style="height:140px;position:relative;">
              <canvas id="supDetailOrderChart"></canvas>
            </div>
          </div>
          <div class="glass-card" style="padding:12px;margin:0;">
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">入库金额（万元）</div>
            <div style="height:140px;position:relative;">
              <canvas id="supDetailInboundChart"></canvas>
            </div>
          </div>
        </div>
      </div>

      <h4 style="margin:12px 0 8px;">最近订单(10)</h4>
      ${orders.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">暂无订单</div>' : `
        <table class="data-table">
          <thead><tr><th>订单编号</th><th>日期</th><th>存货编码</th><th>存货名称</th><th>数量</th><th>未入库</th></tr></thead>
          <tbody>${orders.map(o => `
            <tr><td>${esc(o.订单编号 ?? '')}</td><td>${esc(o.日期 ?? '')}</td><td>${esc(o._存货编码 ?? '')}</td><td>${esc(o.存货名称 ?? '')}</td><td>${esc(o.数量 ?? '')}</td><td>${esc(o.未入库量 ?? '')}</td></tr>
          `).join('')}</tbody>
        </table>
      `}

      <h4 style="margin:12px 0 8px;">最近入库(10)</h4>
      ${inbound.length === 0 ? '<div style="color:var(--text-muted);font-size:13px;">暂无入库</div>' : `
        <table class="data-table">
          <thead><tr><th>入库单号</th><th>入库日期</th><th>存货编码</th><th>存货名称</th><th>数量</th><th>含税金额</th></tr></thead>
          <tbody>${inbound.map(i => `
            <tr><td>${esc(i.入库单号 ?? '')}</td><td>${esc(i.入库日期 ?? '')}</td><td>${esc(i._存货编码 ?? '')}</td><td>${esc(i.存货名称 ?? '')}</td><td>${esc(i.数量 ?? '')}</td><td>${TableUtils.formatMoney(i.原币价税合计)}</td></tr>
          `).join('')}</tbody>
        </table>
      `}
    `);
    document.getElementById('modalOverlay').classList.add('show');

    // 渲染趋势图
    setTimeout(() => this._renderTrendCharts(trendData), 100);
  },

  // 计算最近3个月的订单/入库趋势数据
  _calcTrendData(orders, inbound) {
    const months = [];
    const now = new Date();
    for (let i = 2; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        year: d.getFullYear(),
        month: d.getMonth() + 1
      });
    }

    const orderAmounts = months.map(m => {
      const rows = orders.filter(o => {
        if (!o.日期) return false;
        const d = new Date(o.日期);
        return d.getFullYear() === m.year && (d.getMonth() + 1) === m.month;
      });
      return TableUtils.sumMoney(rows, '原币价税合计') / 10000; // 🟢 AUDIT-003 整数分聚合后转万元
    });

    const inboundAmounts = months.map(m => {
      const rows = inbound.filter(i => {
        if (!i.入库日期) return false;
        const d = new Date(i.入库日期);
        return d.getFullYear() === m.year && (d.getMonth() + 1) === m.month;
      });
      return TableUtils.sumMoney(rows, '原币价税合计') / 10000; // 🟢 AUDIT-003 整数分聚合后转万元
    });

    return { labels: months.map(m => m.label), orderAmounts, inboundAmounts };
  },

  // 渲染趋势图
  // 🟢 v228.08：Chart 改为按需加载 —— 本函数升级为 async，先加载 chart 组件再绘制。
  //   调用点无需 await：图表异步补上，加载失败仅跳过图表、不影响详情主流程。
  async _renderTrendCharts(data) {
    const chartOpts = (label, color, values) => ({
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [{
          label: label,
          data: values,
          borderColor: color,
          backgroundColor: color + '20',
          fill: true,
          tension: 0.3,
          pointRadius: 4,
          pointBackgroundColor: color
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, suggestedMax: 20, ticks: { font: { size: 11 }, stepSize: 20 } },
          x: { ticks: { font: { size: 11 } } }
        }
      }
    });

    // 🟢 v228.08：chart.min.js 不再随首屏预载，首次绘制前动态加载
    try { await LazyLib.chart(); }
    catch (e) { console.warn('[supplier] 图表组件加载失败，已跳过趋势图:', e && e.message); return; }
    if (typeof Chart === 'undefined') return;

    // 在 await 之后取 canvas：若期间用户已关闭详情弹窗，元素不存在则自然跳过
    const orderCanvas = document.getElementById('supDetailOrderChart');
    const inboundCanvas = document.getElementById('supDetailInboundChart');

    // 🟡 先销毁旧实例（M4）：反复打开详情弹窗会累积 Chart 实例（Chart.js 全局注册表），
    // 旧实例不销毁会导致内存泄漏、动画帧持续运行。
    if (this._supOrderChart) { try { this._supOrderChart.destroy(); } catch (e) {
    console.warn('[supplier.js:432] 异常(已忽略):', e);
  } this._supOrderChart = null; }
    if (orderCanvas && typeof Chart !== 'undefined') {
      this._supOrderChart = new Chart(orderCanvas, chartOpts('订单金额', '#357ABD', data.orderAmounts));
    }
    if (this._supInboundChart) { try { this._supInboundChart.destroy(); } catch (e) {
    console.warn('[supplier.js:436] 异常(已忽略):', e);
  } this._supInboundChart = null; }
    if (inboundCanvas && typeof Chart !== 'undefined') {
      this._supInboundChart = new Chart(inboundCanvas, chartOpts('入库金额', '#28a745', data.inboundAmounts));
    }
  },

  async exportData() {
    // 🟢 v229.98（AUDIT-229-98-24）：导出跟随当前筛选。
    //   原先无条件取全量供应商，屏幕上筛了「即将到期」导出来却是全部 —— 屏幕与文件对不上。
    //   优先用 loadData 存下的筛选结果；尚未加载过时退回按当前筛选条件取一次。
    let suppliers = Array.isArray(this._filteredSuppliers) ? this._filteredSuppliers : null;
    if (!suppliers) suppliers = await DataStore.getSuppliers(this.currentFilter);
    if (suppliers.length === 0) { WBModal.alert('没有数据可导出'); return; }
    // 🟢 v229.03：导出列 = 工作台表格当前 9 列（剩余天数/已入库占比与页面文案一致，操作列不导）
    const now = new Date();
    const rows = suppliers.map(s => {
      let days = '';
      if (s.年度合同到期时间) {
        const d = Math.ceil((new Date(s.年度合同到期时间) - now) / (1000 * 60 * 60 * 24));
        days = d < 0 ? ('已过期' + (-d) + '天') : (d + '天');
      }
      const pct = Math.round((s.年度已供入库金额占比 || 0) * 100);
      return {
        '类型': s.类型 ?? '',
        '供应商': s.供应商 ?? '',
        '合同年限': s.合同年限 ?? '',
        '合同到期日': s.年度合同到期时间 ?? '',
        '剩余天数': days,
        '合同金额(元)': s.年度合同金额 ?? '',
        '未入库金额(元)': s.年度未供入库金额 ?? 0,
        '已入库金额(元)': s.年度已供入库金额 ?? '',
        '已入库占比': pct + '%',
        '招采部门': s.招采部门 ?? ''
      };
    });
    this.exportToExcel(rows, '供应商管理');
  },

  exportToExcel(data, sheetName) {
    // 🟢 O1：复用统一导出（文件名格式保持原样：名称_YYYYMMDD.xlsx）
    const now = new Date();
    const filename = `${sheetName}_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.xlsx`;
    TableUtils.exportToExcel(data, filename, sheetName);
  }
};
