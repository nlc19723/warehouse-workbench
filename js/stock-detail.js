// ============================================
// 存货档案（detail）模块 —— 重建实现
// 数据来源：DataStore.queryByEntity('stock', code) 扇出各表关联行
// 复用：DetailCommon / TableUtils（分页 / 排序 / 筛选 / 智能选择）
// ============================================================
//
// 🟢 v118：订单表通过「存货编号」关联；该档案页额外用 getOrdersForStock 反向联动，
//   解决 queryByEntity 按存货编码漏查。
// 🟢 v192 / 🟢 v228.20：6 个 section 各自分页 + 排序/筛选/智能选区。
// 🟢 v229.96：入库记录/关联订单/出库记录原为固定「近3个月」，改为由页面顶部
//   「日期区间」控件（默认近一个月→今天）统一控制；标题去掉「（近3个月）」。
// ============================================================

window.StockDetailModule = {
  _rt: undefined,
  _sections: null,
  // 🟢 v229.96：日期区间状态（会话内保持，切出切回不重置；首次进入默认 近一个月→今天）
  _dateFrom: null,
  _dateTo: null,
  // 🟢 v229.96：三表未过滤原始数据，日期区间变化时据此重算
  _rawInbound: [],
  _rawOrders: [],
  _rawOutbound: [],

  async render(token) {
    if (token !== undefined) this._rt = token;
    const content = document.getElementById('contentArea');
    if (!content) return;

    const pe = App.pendingEntity;
    const code = pe && pe.type === 'stock' ? pe.key : '';
    if (!code) { content.innerHTML = this._buildStockEmptyState(); return; }

    // 🟢 v229.96：render 会重建 input，先卸载旧日期选择器实例（避免 document 监听泄漏）
    if (typeof DatePicker !== 'undefined') DatePicker.unmountAll();
    this._ensureStockDateDefaults();

    // 🟢 v229.64：不再弹全屏「正在加载存货档案…」遮罩——查询为内存内同步级操作，
    //   切模块的轻量骨架+顶栏进度条（go 内 _showSwitchSkeleton）已足够，避免多余弹窗。
    try {
      const rel = await DataStore.queryByEntity('stock', code);
      if (token !== undefined && token !== App._goToken) return;
      const stockRows = rel.stock || [];
      const main = stockRows[0] || {};
      // 🟢 v229.89：基础信息「仓库名称」改为「是否呆滞」——该存货是否落入低周转清单(lowTurnover)
      try {
        const lowHit = await db.lowTurnover.where('存货编码').equals(code).first();
        main.是否呆滞 = lowHit ? '低周转材料' : '非低周转材料';
      } catch (e) { main.是否呆滞 = '非低周转材料'; }
      // 🟡 修复：orders 表以「存货编号」关联（非「存货编码」），queryByEntity 按存货编码会漏查，改用 getOrdersForStock 反向联动
      const ordersForStock = await DataStore.getOrdersForStock(code, main.存货名称, main.规格型号);

      const baseAndQrBlock = this._buildBaseAndQrBlock(main, code);
      const dateRangeBar = this._buildStockDateBar();
      this._initStockSections(rel, ordersForStock);
      const sectionHosts = this._buildSectionHosts();

      content.innerHTML = DetailCommon.backBar() +
        `<h2 style="margin:6px 0 18px;font-size:20px;">📦 存货档案 · ${esc(main.存货名称 || code)}${main.规格型号 ? ' (' + esc(main.规格型号) + ')' : ''}</h2>` +
        baseAndQrBlock +
        dateRangeBar +
        sectionHosts;

      // 🟢 A1：二维码下载 / 打印按钮绑定
      this._bindStockQrButtons(content, main, code);
      // 🟢 v229.96：日期区间控件（控制下方入库/订单/出库三表）
      this._bindStockDateBar(content);
      // 🟢 v230.32：「显示全部时间」按钮（事件委托绑定一次，按钮随空态重渲染）
      if (!content.dataset.stkShowAllBound) {
        content.dataset.stkShowAllBound = '1';
        content.addEventListener('click', (e) => {
          const btn = e.target && e.target.closest && e.target.closest('[data-stk-show-all]');
          if (btn) this._showAllTime(btn.getAttribute('data-stk-show-all'));
        });
      }
      this._renderAllStockSections();

      if (rel._breachSoft) this._appendBreachTip(content, rel);
    } catch (e) {
      console.error('[StockDetailModule]', e);
      content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败: ${esc(e.message || e)}</div></div>`;
    }
  },

  // 无存货编码时的空态
  _buildStockEmptyState() {
    return `<div class="empty-state" style="padding:56px 20px;text-align:center;">
      <div class="empty-icon">📦</div>
      <div style="font-size:15px;margin-top:10px;color:var(--text-secondary);">未指定存货编码</div>
      <button class="btn--ghost" onclick="App.back()">← 返回</button></div>`;
  },

  // ============================================================
  // 🟢 v229.96：日期区间控件（控制下方入库记录/关联订单/出库记录三表）
  // ============================================================

  // 首次进入默认「近一个月 → 今天」；用户改过则保持（切出切回不重置）
  _ensureStockDateDefaults() {
    if (this._dateFrom && this._dateTo) return;
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - 1);
    this._dateTo = iso(to);
    this._dateFrom = iso(from);
  },

  // 版式与全站日期框统一：.filter-bar-m + fb-row--date + dp-input（查询/订单/入库同款）
  _buildStockDateBar() {
    return `<div class="filter-bar filter-bar-m" style="margin:0 0 14px;">
      <div class="fb-row fb-row--date">
        <div class="fb-field"><input type="text" id="stkDateFrom" class="filter-date dp-input" placeholder="起始日期" title="起始日期" value="${escAttr(this._dateFrom || '')}" readonly></div>
        <span class="fb-sep filter-sep">至</span>
        <div class="fb-field"><input type="text" id="stkDateTo" class="filter-date dp-input" placeholder="结束日期" title="结束日期" value="${escAttr(this._dateTo || '')}" readonly></div>
      </div>
    </div>`;
  },

  // 🟢 v230.32：日期类 section 的「智能空态」——
  //   该存货有原始数据、但被顶部日期区间过滤为 0 时，不再只写「暂无数据」，
  //   明示「区间外还有 N 条（日期 A ~ B）」并给「显示全部时间」一键放宽入口。
  //   报障场景：订单都在一个月前，默认「近一个月→今天」区间下关联订单 (0)，
  //   用户误以为数据丢失。
  _buildEmptyState(sectionId, s) {
    const base = '<div class="empty-state" style="padding:14px;"><div class="empty-icon">📭</div><div class="empty-text">暂无数据</div></div>';
    if (!s || !s.dateField) return base;
    const rawMap = { 'stk-inbound': this._rawInbound, 'stk-orders': this._rawOrders, 'stk-outbound': this._rawOutbound };
    const raw = rawMap[sectionId] || [];
    if (raw.length === 0) return base;
    // 区间外数据的日期范围（与 filterByDateRange 同口径归一化）
    const dates = raw.map(r => String((r && r[s.dateField]) || '').slice(0, 10).replace(/\//g, '-')).filter(Boolean).sort();
    if (dates.length === 0) return base;
    const from = this._dateFrom || '最早';
    const to = this._dateTo || '今天';
    return `<div class="empty-state" style="padding:14px;">
      <div class="empty-icon">🗓️</div>
      <div class="empty-text">该日期区间（${esc(from)} 至 ${esc(to)}）内无记录；区间外还有 <b>${raw.length}</b> 条（日期 ${esc(dates[0])} ~ ${esc(dates[dates.length - 1])}），可放宽顶部日期区间查看。</div>
      <button class="btn--ghost" type="button" style="margin-top:8px;" data-stk-show-all="${escAttr(sectionId)}">显示全部时间</button>
    </div>`;
  },

  // 「显示全部时间」：清空日期区间（两端不限）并重渲染三表 + 顶部输入框
  _showAllTime(sectionId) {
    this._dateFrom = '';
    this._dateTo = '';
    const fi = document.getElementById('stkDateFrom');
    const ti = document.getElementById('stkDateTo');
    if (fi) fi.value = '';
    if (ti) ti.value = '';
    this._applyStockDateRange();
  },

  _bindStockDateBar(content) {
    if (typeof DatePicker !== 'undefined') {
      DatePicker.mount('stkDateFrom');
      DatePicker.mount('stkDateTo');
    }
    const from = content.querySelector('#stkDateFrom');
    const to = content.querySelector('#stkDateTo');
    if (from) from.addEventListener('change', () => this._onStockDateChange('from', from.value));
    if (to) to.addEventListener('change', () => this._onStockDateChange('to', to.value));
  },

  _onStockDateChange(which, value) {
    const v = (value || '').slice(0, 10);
    if (which === 'from') this._dateFrom = v; else this._dateTo = v;
    this._applyStockDateRange();
  },

  // 日期区间变化 → 重算三表数据、复位分页、刷新标题计数并重渲染
  _applyStockDateRange() {
    if (!this._sections) return;
    const specs = [
      ['stk-inbound', this._rawInbound, '入库日期'],
      ['stk-orders', this._rawOrders, '日期'],
      ['stk-outbound', this._rawOutbound, '出库时间']
    ];
    specs.forEach(([id, raw, field]) => {
      const s = this._sections[id];
      if (!s) return;
      s.rows = TableUtils.filterByDateRange(raw, field, this._dateFrom, this._dateTo);
      s.currentPage = 1;
      const titleEl = document.getElementById(id + '-title');
      if (titleEl) titleEl.innerHTML = esc(s.title) + ` <span class="count">(${s.rows.length})</span>`;
      this._renderSection(id);
    });
  },

  // 🟢 v197：基础信息网格 + 存货二维码卡片（并排由 CSS 控制）
  _buildBaseAndQrBlock(main, code) {
    const base = [
      { label: '存货编码', field: '存货编码' },
      { label: '存货名称', field: '存货名称' },
      { label: '规格型号', field: '规格型号' },
      // 🟢 v229.89：「仓库名称」改为「是否呆滞」——判别该存货是否在低周转清单(lowTurnover)内
      { label: '是否呆滞', field: '是否呆滞', render: v => v === '低周转材料'
        ? `<span style="color:var(--status-danger,#c62828);font-weight:600;">低周转材料</span>`
        : `<span style="color:var(--status-ok,#2e7d32);">非低周转材料</span>` },
      { label: '现存数量', field: '现存数量' }
    ];
    const baseGridHtml = `<div class="detail-grid">${base.map(c => {
      const raw = main[c.field];
      const val = c.render ? c.render(raw) : esc(DetailCommon.fmt(raw));
      return `<div class="detail-kv"><span class="k">${c.label}</span><span class="v">${val}</span></div>`;
    }).join('')}</div>`;

    // 🟢 A1：档案页存货二维码（编码纯文本 = 存货编码；离线生成，零存储；新增存货自动有码）
    // 🟢 v228.12：下载/打印按钮放到名称/规格下方，避免二维码右侧空白
    const qrSvg = window.QR ? QR.svg(code) : '';
    const qrCardHtml = qrSvg ? `<div class="detail-section qr-card">
      <div class="qr-body">
        <div class="qr-img">${qrSvg}</div>
        <div class="qr-info">
          <div class="qr-meta">
            <div class="qr-name">${esc(main.存货名称 || '')}</div>
            ${main.规格型号 ? `<div class="qr-spec">规格：${esc(main.规格型号)}</div>` : ''}
          </div>
          <div class="qr-actions">
            <button class="btn--ghost" type="button" data-qr-download="${esc(code)}">⬇ 下载 PNG</button>
            <button class="btn--ghost" type="button" data-qr-print="${esc(code)}">🖨 打印</button>
          </div>
        </div>
      </div></div>` : '';

    const baseSection = `<div class="detail-section detail-section-base"><h3>基础信息</h3>${baseGridHtml}</div>`;
    // v197：并排用 detail-base-qr-row 容器；移动端 CSS 回退为列堆叠
    const combinedRow = qrCardHtml
      ? `<div class="detail-base-qr-row">${baseSection}${qrCardHtml}</div>`
      : baseSection;
    // 兼容：qrCardHtml 为空时 combinedRow 就是 baseSection 本身，避免空容器
    return qrCardHtml ? combinedRow : baseSection;
  },

  // 🟢 v120/v197/v198/v200/v228.20：6 个 section 的列定义（与主模块统一）
  _buildStockColumns() {
    // 🟢 v200：把「供应商」挪到「入库量」之后
    // 🟢 v228.11：入库记录增加「项目名称」列，放在供应商左侧
    const inboundCols = [
      { label: '入库单号', field: '入库单号' },
      { label: '入库日期', field: '入库日期' },
      { label: '入库量', field: '数量' },
      { label: '项目名称', field: '项目名称' },
      { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
      { label: '含税单价', field: '原币含税单价' },
      { label: '含税金额', field: '原币价税合计' },
      // 🟢 v229.89：末列关联入库列表「备注」（表体备注）
      { label: '备注', field: '表体备注' }
    ];
    // 🟢 v200：把「供应商」挪到「订单量」之后，与入库表统一为「量 + 供应商」结构
    // 🟢 v228.11：关联订单增加「项目名称」列，放在供应商左侧
    const orderCols = [
      { label: '订单编号', field: '订单编号', render: r => TableUtils.link('order', r.订单编号, r.订单编号) },
      { label: '日期', field: '日期' },
      { label: '订单量', field: '数量' },
      { label: '项目名称', field: '项目名称' },
      { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
      { label: '未入库订单量', field: '未入库量' },
      { label: '含税单价', field: '原币含税单价' },
      { label: '含税金额', field: '原币价税合计' },
      { label: '状态', field: '审批状态' }
    ];
    const alertCols = [
      { label: '分类', field: '分类' },
      { label: '月均入库', field: '近一年月均入库量' },
      { label: '现存量', field: '现存量' },
      { label: '补货值', field: '补货值' },
      { label: '在途订单', field: '在途订单' },
      { label: '仓库', field: '所上或库房' },
      { label: '项目', field: '工程项目' }
    ];
    const priceCols = [
      { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
      { label: '含税单价', field: '含税单价' },
      { label: '生效日期', field: '生效日期' },
      { label: '失效日期', field: '失效日期' },
      { label: '类型', field: '类型' }
    ];
    // 🟢 v229.89：低周转材料表删除（该信息已并入基础信息「是否呆滞」判别）
    // 🟢 v228.20：出库记录（中心出库列表 db.outbound）。
    //   列名与顺序刻意与「中心出库列表」表格保持一致，便于两处对照；
    //   出库单号按用户要求做纯文本展示（不跳转），故直接用 field 走默认 esc 渲染。
    const outboundCols = [
      { label: '出库单号', field: '出库单号' },
      { label: '项目名称', field: '项目名称' },
      { label: '出库时间', field: '出库时间' },
      { label: '存货编码', field: '存货编码' },
      { label: '存货名称', field: '存货名称' },
      { label: '规格型号', field: '规格型号' },
      { label: '出库数量', field: '出库数量' }
    ];
    return { inboundCols, orderCols, alertCols, priceCols, outboundCols };
  },

  // 🟢 v192 / 🟢 v228.20 / 🟢 v229.96：6 个 section 各自的分页/排序状态
  //   入库记录/关联订单/出库记录按页面顶部「日期区间」过滤（默认近一个月→今天，可改）
  _initStockSections(rel, ordersForStock) {
    const { inboundCols, orderCols, alertCols, priceCols, outboundCols } = this._buildStockColumns();
    this._rawInbound = rel.inbound || [];
    this._rawOrders = ordersForStock || [];
    this._rawOutbound = rel.outbound || [];
    this._sections = {
      'stk-inbound': { title: '入库记录', dateField: '入库日期', rows: TableUtils.filterByDateRange(this._rawInbound, '入库日期', this._dateFrom, this._dateTo), columns: inboundCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      'stk-orders':  { title: '关联订单', dateField: '日期', rows: TableUtils.filterByDateRange(this._rawOrders, '日期', this._dateFrom, this._dateTo), columns: orderCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      // 🟢 v228.20：出库记录 —— 数据源为「中心出库列表」db.outbound（经 EntityLinks.stock.tables
      //   新增 outbound 扇出由 queryByEntity 取回）。按对象 key 顺序渲染，故紧跟在关联订单之后。
      // 🟢 v229.96：与同页两个表格同样受页面顶部「日期区间」控制，口径一致。
      'stk-outbound': { title: '出库记录', dateField: '出库时间', rows: TableUtils.filterByDateRange(this._rawOutbound, '出库时间', this._dateFrom, this._dateTo), columns: outboundCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      'stk-alert':   { title: '库存预警', rows: rel.inventoryAlerts || [], columns: alertCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      'stk-pricing': { title: '合同价格', rows: rel.pricing || [], columns: priceCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null }
    };
  },

  // 生成各 section 的 <details> 占位宿主
  _buildSectionHosts() {
    return Object.keys(this._sections).map(id =>
      `<details class="detail-section" open><summary><h3 id="${id}-title">${esc(this._sections[id].title)} <span class="count">(${this._sections[id].rows.length})</span></h3></summary><div id="${id}" class="detail-table-host"></div></details>`
    ).join('');
  },

  // 🟢 A1：二维码下载 / 打印按钮绑定
  _bindStockQrButtons(content, main, code) {
    const dlBtn = content.querySelector('[data-qr-download]');
    if (dlBtn) dlBtn.addEventListener('click', () => this._downloadQrPng(dlBtn.getAttribute('data-qr-download')));
    const prBtn = content.querySelector('[data-qr-print]');
    if (prBtn) prBtn.addEventListener('click', () => this._printQr(prBtn.getAttribute('data-qr-print'), main.存货名称, main.规格型号));
  },

  // 逐个填充 section 表格 + 分页器
  _renderAllStockSections() {
    Object.keys(this._sections).forEach(id => this._renderSection(id));
  },

  // 违约台账软匹配提示
  _appendBreachTip(content, rel) {
    const tip = document.createElement('div');
    tip.style.cssText = 'font-size:12px;color:var(--status-warning,#b7791f);margin:6px 0 0;';
    tip.textContent = '⚠️ 违约台账为按名称软匹配结果，可能含其他同名公司数据';
    content.appendChild(tip);
  },

  // ============================================================
  // 🟢 v192：分页 + 排序 + 筛选 + 智能选区（与 supplier-detail 同款实现）
  // ============================================================

  _renderSection(sectionId) {
    const s = this._sections[sectionId];
    if (!s) return;
    const host = document.getElementById(sectionId);
    if (!host) return;

    // 1) 数据层排序
    let data = s.rows;
    if (s.sort && s.sort.field) {
      const field = s.sort.field;
      const dir = s.sort.dir;
      data = data.slice().sort((a, b) => {
        const va = a && a[field], vb = b && b[field];
        const clean = (v) => String(v == null ? '' : v).replace(/[¥$￥,\s，%]/g, '');
        const na = parseFloat(clean(va));
        const nb = parseFloat(clean(vb));
        if (!isNaN(na) && !isNaN(nb)) return dir === 1 ? na - nb : nb - na;
        const sa = String(va == null ? '' : va);
        const sb = String(vb == null ? '' : vb);
        return dir === 1 ? sa.localeCompare(sb, 'zh') : sb.localeCompare(sa, 'zh');
      });
    }

    // 2) 分页切片
    const total = data.length;
    const pageSize = s.pageSize === 'all' ? total : s.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    const page = Math.min(s.currentPage, Math.max(1, totalPages));
    s.currentPage = page;
    const items = data.slice((page - 1) * pageSize, page * pageSize);

    // 3) 写表格 DOM
    const head = s.columns.map(c => `<th>${esc(c.label)}</th>`).join('');
    if (items.length === 0) {
      host.innerHTML = this._buildEmptyState(sectionId, s);
    } else {
      const body = items.map(r => `<tr>${s.columns.map(c => `<td>${c.render ? c.render(r) : esc(DetailCommon.fmt(r && r[c.field]))}</td>`).join('')}</tr>`).join('');
      host.innerHTML = `<div class="table-wrapper"><table class="data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }

    // 4) 分页器
    const details = host.closest('details');
    const barId = sectionId + 'Pagination';
    let bar = document.getElementById(barId);
    if (!bar && details) {
      bar = document.createElement('div');
      bar.id = barId;
      bar.className = 'pagination-bar';
      bar.style.justifyContent = 'center';
      bar.style.gap = '8px';
      details.appendChild(bar);
    }
    if (bar) {
      TableUtils.renderPagination(barId, {
        module: 'StockDetailModule',
        section: sectionId,
        total, totalPages, page, pageSize
      });
    }

    // 5) 智能选区 + 排序/筛选
    if (items.length > 0) {
      TableUtils.initExcelSelection(sectionId);
      TableUtils.initSortableHeaders(sectionId, {
        // 🟢 v229.97（AUDIT-229-97-02）：显式传 getColField 返回【数据字段】而非表头文案。
        //   initSortableHeaders 默认用 <th> 文本当字段名，而本页多列 label ≠ field
        //   （入库量→数量、订单量→数量、未入库订单量→未入库量、含税金额→原币价税合计、
        //     状态→审批状态、月均入库→近一年月均入库量），
        //   导致 onSortChange 收到的是 label，下面 findIndex(field===label) 恒为 -1、
        //   数据层排序 a[-1] 恒等 → 这些列「点了排序毫无反应、箭头也不显示」。
        getColField: (th) => (s.columns[th.cellIndex] && s.columns[th.cellIndex].field) || (th.textContent || '').trim(),
        initialSort: s.sort ? { col: s.columns.findIndex(c => c.field === s.sort.field), dir: s.sort.dir } : null,
        onSortChange: (field, dir) => {
          s.sort = dir === 0 ? null : { field, dir };
          s.currentPage = 1;
          this._renderSection(sectionId);
        }
      });
      // 🟢 v192：标记已初始化，防止 app.js 的 MutationObserver 用无 onSortChange 的
      //   initSortableHeadersAuto 覆盖本模块绑定的事件 listener
      const table = host.querySelector('.data-table');
      if (table) table.dataset.sortableInitialized = '1';
    }
  },

  goPage(sectionOrPage, page) {
    if (typeof sectionOrPage === 'number' || (!page && !this._sections[sectionOrPage])) return;
    const section = sectionOrPage;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const s = this._sections[section];
    if (!s) return;
    s.currentPage = p;
    this._renderSection(section);
  },

  changePageSize(section, size) {
    const s = this._sections[section];
    if (!s) return;
    s.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    s.currentPage = 1;
    this._renderSection(section);
  },

  // 🟢 A1：将二维码导出为白底 PNG（复用共享 QR 组件）
  _downloadQrPng(code) {
    if (window.QR) QR.downloadPng(code);
  },

  // 🟢 A1：单张二维码打印（复用共享 QR 组件）
  _printQr(code, name, spec) {
    if (window.QR) QR.printWindow(code, name, spec);
  }
};
