// ============================================
// 存货档案（detail）模块 —— 重建实现
// 数据来源：DataStore.queryByEntity('stock', code) 扇出各表关联行
// 复用：DetailCommon / TableUtils（分页 / 排序 / 筛选 / 智能选择）
// ============================================================
//
// 🟢 v118：订单表通过「存货编号」关联；该档案页额外用 getOrdersForStock 反向联动，
//   解决 queryByEntity 按存货编码漏查。
// 🟢 v192：5 个 section 各自分页 + 排序/筛选/智能选区；
//   入库记录 / 关联订单 仅显示最近 3 个月。
// ============================================================

window.StockDetailModule = {
  _rt: undefined,
  _sections: null,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const content = document.getElementById('contentArea');
    if (!content) return;

    const pe = App.pendingEntity;
    const code = pe && pe.type === 'stock' ? pe.key : '';
    if (!code) { content.innerHTML = this._buildStockEmptyState(); return; }

    showLoading('正在加载存货档案...');
    try {
      const rel = await DataStore.queryByEntity('stock', code);
      if (token !== undefined && token !== App._goToken) return;
      const stockRows = rel.stock || [];
      const main = stockRows[0] || {};
      // 🟡 修复：orders 表以「存货编号」关联（非「存货编码」），queryByEntity 按存货编码会漏查，改用 getOrdersForStock 反向联动
      const ordersForStock = await DataStore.getOrdersForStock(code, main.存货名称, main.规格型号);

      const baseAndQrBlock = this._buildBaseAndQrBlock(main, code);
      this._initStockSections(rel, ordersForStock);
      const sectionHosts = this._buildSectionHosts();

      content.innerHTML = DetailCommon.backBar() +
        `<h2 style="margin:6px 0 18px;font-size:20px;">📦 存货档案 · ${esc(main.存货名称 || code)}${main.规格型号 ? ' (' + esc(main.规格型号) + ')' : ''}</h2>` +
        baseAndQrBlock +
        sectionHosts;

      // 🟢 A1：二维码下载 / 打印按钮绑定
      this._bindStockQrButtons(content, main, code);
      this._renderAllStockSections();

      if (rel._breachSoft) this._appendBreachTip(content, rel);
    } catch (e) {
      console.error('[StockDetailModule]', e);
      content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败: ${esc(e.message || e)}</div></div>`;
    } finally {
      hideLoading();
    }
  },

  // 无存货编码时的空态
  _buildStockEmptyState() {
    return `<div class="empty-state" style="padding:56px 20px;text-align:center;">
      <div class="empty-icon">📦</div>
      <div style="font-size:15px;margin-top:10px;color:var(--text-secondary);">未指定存货编码</div>
      <button class="btn--ghost" onclick="App.back()">← 返回</button></div>`;
  },

  // 🟢 v197：基础信息网格 + 存货二维码卡片（并排由 CSS 控制）
  _buildBaseAndQrBlock(main, code) {
    const base = [
      { label: '存货编码', field: '存货编码' },
      { label: '存货名称', field: '存货名称' },
      { label: '规格型号', field: '规格型号' },
      { label: '仓库名称', field: '仓库名称' },
      { label: '现存数量', field: '现存数量' }
    ];
    const baseGridHtml = `<div class="detail-grid">${base.map(c => `<div class="detail-kv"><span class="k">${c.label}</span><span class="v">${esc(DetailCommon.fmt(main[c.field]))}</span></div>`).join('')}</div>`;

    // 🟢 A1：档案页存货二维码（编码纯文本 = 存货编码；离线生成，零存储；新增存货自动有码）
    // 🟢 v227.91：按钮排在二维码右边 —— qr-actions 提到 qr-body 内，与 qr-img 平级作为 flex 子项
    const qrSvg = window.QR ? QR.svg(code) : '';
    const qrCardHtml = qrSvg ? `<div class="detail-section qr-card">
      <div class="qr-body">
        <div class="qr-img">${qrSvg}</div>
        <div class="qr-meta">
          <div class="qr-name">${esc(main.存货名称 || '')}</div>
          ${main.规格型号 ? `<div class="qr-spec">规格：${esc(main.规格型号)}</div>` : ''}
        </div>
        <div class="qr-actions">
          <button class="btn--ghost" type="button" data-qr-download="${esc(code)}">⬇ 下载 PNG</button>
          <button class="btn--ghost" type="button" data-qr-print="${esc(code)}">🖨 打印</button>
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

  // 🟢 v120/v197/v198/v200：5 个 section 的列定义（与主模块统一）
  _buildStockColumns() {
    // 🟢 v200：把「供应商」挪到「入库量」之后
    const inboundCols = [
      { label: '入库单号', field: '入库单号' },
      { label: '入库日期', field: '入库日期' },
      { label: '入库量', field: '数量' },
      { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
      { label: '含税单价', field: '原币含税单价' },
      { label: '含税金额', field: '原币价税合计' }
    ];
    // 🟢 v200：把「供应商」挪到「订单量」之后，与入库表统一为「量 + 供应商」结构
    const orderCols = [
      { label: '订单编号', field: '订单编号', render: r => TableUtils.link('order', r.订单编号, r.订单编号) },
      { label: '日期', field: '日期' },
      { label: '订单量', field: '数量' },
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
    const lowCols = [
      { label: '仓库', field: '仓库名称' },
      { label: '现存数量', field: '现存数量' },
      { label: '暂无法使用量', field: '暂无法使用量' }
    ];
    return { inboundCols, orderCols, alertCols, priceCols, lowCols };
  },

  // 🟢 v192：5 个 section 各自的分页/排序状态（入库记录/关联订单 应用 3-month 过滤）
  _initStockSections(rel, ordersForStock) {
    const { inboundCols, orderCols, alertCols, priceCols, lowCols } = this._buildStockColumns();
    this._sections = {
      'stk-inbound': { title: '入库记录（近3个月）', rows: TableUtils.filterRecent3M(rel.inbound, '入库日期'), columns: inboundCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      'stk-orders':  { title: '关联订单（近3个月）', rows: TableUtils.filterRecent3M(ordersForStock, '日期'), columns: orderCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      'stk-alert':   { title: '库存预警', rows: rel.inventoryAlerts || [], columns: alertCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      'stk-pricing': { title: '合同价格', rows: rel.pricing || [], columns: priceCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
      'stk-low':     { title: '低周转材料', rows: rel.lowTurnover || [], columns: lowCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null }
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
      host.innerHTML = '<div class="empty-state" style="padding:14px;"><div class="empty-icon">📭</div><div class="empty-text">暂无数据</div></div>';
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
      TableUtils.initSmartSelect(sectionId);
      TableUtils.initSortableHeaders(sectionId, {
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
