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
    if (!code) {
      content.innerHTML = `<div class="empty-state" style="padding:56px 20px;text-align:center;">
        <div class="empty-icon">📦</div>
        <div style="font-size:15px;margin-top:10px;color:var(--text-secondary);">未指定存货编码</div>
        <button class="btn-secondary" onclick="App.back()">← 返回</button></div>`;
      return;
    }

    showLoading('正在加载存货档案...');
    try {
      const rel = await DataStore.queryByEntity('stock', code);
      if (token !== undefined && token !== App._goToken) return;
      const stockRows = rel.stock || [];
      const main = stockRows[0] || {};
      // 🟡 修复：orders 表以「存货编号」关联（非「存货编码」），queryByEntity 按存货编码会漏查，改用 getOrdersForStock 反向联动
      const ordersForStock = await DataStore.getOrdersForStock(code, main.存货名称, main.规格型号);

      const base = [
        { label: '存货编码', field: '存货编码' },
        { label: '存货名称', field: '存货名称' },
        { label: '规格型号', field: '规格型号' },
        { label: '仓库名称', field: '仓库名称' },
        { label: '现存数量', field: '现存数量' }
      ];
      const baseSection = `<div class="detail-section"><h3>基础信息</h3>
        <div class="detail-grid">${base.map(c => `<div class="detail-kv"><span class="k">${c.label}</span><span class="v">${esc(DetailCommon.fmt(main[c.field]))}</span></div>`).join('')}</div></div>`;

      // 🟢 v120：列名与主模块（入库列表）统一
      const inboundCols = [
        { label: '入库单号', field: '入库单号' },
        { label: '入库日期', field: '入库日期' },
        { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
        // 🟢 v117：明细表新增存货编码列（存货名称绑定存货编码）
        { label: '存货编码', render: r => TableUtils.link('stock', r.存货编码 || '', r.存货编码 || '') },
        { label: '存货名称', render: r => `<strong>${esc(r.存货名称 || '')}</strong>` },
        { label: '规格型号', field: '规格型号' },
        { label: '入库量', field: '数量' },
        { label: '含税单价', field: '原币含税单价' },
        { label: '含税金额', field: '原币价税合计' }
      ];
      // 🟢 v120：列名与主模块（订单列表）统一
      const orderCols = [
        { label: '订单编号', field: '订单编号', render: r => TableUtils.link('order', r.订单编号, r.订单编号) },
        { label: '日期', field: '日期' },
        { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
        // 🟢 v118：订单表"存货"键为 存货编号（不是 存货编码）
        { label: '存货编码', render: r => TableUtils.link('stock', r.存货编号 || '', r.存货编号 || '') },
        { label: '存货名称', render: r => `<strong>${esc(r.存货名称 || '')}</strong>` },
        { label: '规格型号', field: '规格型号' },
        { label: '订单量', field: '数量' },
        { label: '未入库订单量', field: '未入库量' },
        { label: '含税单价', field: '原币含税单价' },
        { label: '含税金额', field: '原币价税合计' },
        { label: '状态', field: '审批状态' }
      ];
      // 🟢 v120：列名与主模块（库存预警）统一
      const alertCols = [
        { label: '存货编码', field: '存货编码' },
        { label: '存货名称', field: '存货名称' },
        { label: '规格型号', field: '规格型号' },
        { label: '分类', field: '分类' },
        { label: '月均入库', field: '近一年月均入库量' },
        { label: '现存量', field: '现存量' },
        { label: '补货值', field: '补货值' },
        { label: '在途订单', field: '在途订单' },
        { label: '仓库', field: '所上或库房' },
        { label: '项目', field: '工程项目' }
      ];
      // 🟢 v120：列名与主模块（合同价格）统一
      const priceCols = [
        { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
        { label: '存货编码', field: '存货编码' },
        { label: '规格型号', field: '规格型号' },
        { label: '含税单价', field: '含税单价' },
        { label: '生效日期', field: '生效日期' },
        { label: '失效日期', field: '失效日期' },
        { label: '类型', field: '类型' }
      ];
      // 🟢 v120：列名与主模块（低周转材料）统一
      const lowCols = [
        { label: '仓库', field: '仓库名称' },
        { label: '存货编码', field: '存货编码' },
        { label: '存货名称', field: '存货名称' },
        { label: '规格型号', field: '规格型号' },
        { label: '现存数量', field: '现存数量' },
        { label: '暂无法使用量', field: '暂无法使用量' }
      ];

      // 🟢 v192：5 个 section 各自的分页/排序状态
      //   入库记录、关联订单 应用 3-month 过滤（按用户需求）
      this._sections = {
        'stk-inbound': { title: '入库记录（近3个月）', rows: TableUtils.filterRecent3M(rel.inbound, '入库日期'), columns: inboundCols, currentPage: 1, pageSize: 20, sort: null },
        'stk-orders':  { title: '关联订单（近3个月）', rows: TableUtils.filterRecent3M(ordersForStock, '日期'), columns: orderCols, currentPage: 1, pageSize: 20, sort: null },
        'stk-alert':   { title: '库存预警', rows: rel.inventoryAlerts || [], columns: alertCols, currentPage: 1, pageSize: 20, sort: null },
        'stk-pricing': { title: '合同价格', rows: rel.pricing || [], columns: priceCols, currentPage: 1, pageSize: 20, sort: null },
        'stk-low':     { title: '低周转材料', rows: rel.lowTurnover || [], columns: lowCols, currentPage: 1, pageSize: 20, sort: null }
      };

      // 渲染：基础信息 + 5 个 section 占位
      const sectionHosts = Object.keys(this._sections).map(id =>
        `<details class="detail-section" open><summary><h3 id="${id}-title">${esc(this._sections[id].title)} <span class="count">(${this._sections[id].rows.length})</span></h3></summary><div id="${id}" class="detail-table-host"></div></details>`
      ).join('');

      content.innerHTML = DetailCommon.backBar() +
        `<h2 style="margin:6px 0 18px;font-size:20px;">📦 存货档案 · ${esc(main.存货名称 || code)}${main.规格型号 ? ' (' + esc(main.规格型号) + ')' : ''}</h2>` +
        baseSection +
        sectionHosts;

      // 填入每个 section 的表格 + 分页器
      Object.keys(this._sections).forEach(id => this._renderSection(id));

      if (rel._breachSoft) {
        const tip = document.createElement('div');
        tip.style.cssText = 'font-size:12px;color:var(--status-warning,#b7791f);margin:6px 0 0;';
        tip.textContent = '⚠️ 违约台账为按名称软匹配结果，可能含其他同名公司数据';
        content.appendChild(tip);
      }
    } catch (e) {
      console.error('[StockDetailModule]', e);
      content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败: ${esc(e.message || e)}</div></div>`;
    } finally {
      hideLoading();
    }
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
  }
};
