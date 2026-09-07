// ============================================
// 供应商档案（detail）模块 —— 重建实现
// 数据来源：DataStore.queryByEntity('supplier', name) 扇出各表关联行
// 复用：DetailCommon / TableUtils（分页 / 排序 / 筛选 / 智能选择）
// ============================================================
//
// 🟢 v190：采购订单 / 入库记录 仅显示最近 3 个月数据，避免档案页过长。
// 🟢 v192：每个 section 独立分页（合同价格 / 采购订单 / 入库记录 / 违约台账）。
//   - 状态：this._sections[sectionId] = { rows, columns, currentPage, pageSize, sort }
//   - 排序作用于全量数据（跨页一致）；表头 Excel 筛选由 initSortableHeaders 接管（DOM 层）。
//   - 翻页器放在 <details> 内、表格之后，折叠时随 <details> 一起隐藏。
// ============================================================

window.SupplierDetailModule = {
  _rt: undefined,
  _sections: null, // 🟢 v192：4 个 section 各自的分页/排序状态

  async render(token) {
    if (token !== undefined) this._rt = token;
    const content = document.getElementById('contentArea');
    if (!content) return;

    const pe = App.pendingEntity;
    const name = pe && pe.type === 'supplier' ? pe.key : '';
    if (!name) {
      content.innerHTML = `<div class="empty-state" style="padding:56px 20px;text-align:center;">
        <div class="empty-icon">🏭</div>
        <div style="font-size:15px;margin-top:10px;color:var(--text-secondary);">未指定供应商</div>
        <button class="btn--ghost" onclick="App.back()">← 返回</button></div>`;
      return;
    }

    showLoading('正在加载供应商档案...');
    try {
      const rel = await DataStore.queryByEntity('supplier', name);
      if (token !== undefined && token !== App._goToken) return;
      const rows = rel.suppliers || [];
      const main = rows[0] || {};

      const base = [
        { label: '类型', field: '类型' },
        { label: '第一年度生效时间', field: '第一年度生效时间' },
        { label: '签订次数', field: '签订次数' },
        { label: '年度合同到期时间', field: '年度合同到期时间' },
        { label: '年度合同金额', field: '年度合同金额' },
        { label: '年度已供入库金额', field: '年度已供入库金额' },
        { label: '年度已供入库金额占比', field: '年度已供入库金额占比' },
        { label: '招采部门', field: '招采部门' },
        { label: '生产厂址', field: '生产厂址' },
        { label: '地址', field: '地址' }
      ];
      const baseSection = `<div class="detail-section"><h3>基础信息</h3>
        <div class="detail-grid">${base.map(c => `<div class="detail-kv"><span class="k">${c.label}</span><span class="v">${esc(DetailCommon.fmt(main[c.field]))}</span></div>`).join('')}</div></div>`;

      // 🟢 v120：列名与主模块（合同价格）统一（🟢 v190：删除"供应商"列）
      const priceCols = [
        { label: '存货编码', field: '存货编码', render: r => TableUtils.link('stock', r.存货编码, r.存货编码) },
        { label: '存货名称', field: '存货名称', render: r => `<strong>${esc(r.存货名称 ?? '')}</strong>` },
        { label: '规格型号', field: '规格型号' },
        { label: '含税单价', field: '含税单价' },
        { label: '生效日期', field: '生效日期' },
        { label: '失效日期', field: '失效日期' },
        { label: '类型', field: '类型' }
      ];
      // 🟢 v120：列名与主模块（订单列表）统一
      const orderCols = [
        { label: '订单编号', field: '订单编号', render: r => TableUtils.link('order', r.订单编号, r.订单编号) },
        { label: '日期', field: '日期' },
        // 🟢 v118：订单表"存货"键为 存货编号
        { label: '存货编码', render: r => TableUtils.link('stock', r.存货编号 || '', r.存货编号 || '') },
        { label: '存货名称', render: r => `<strong>${esc(r.存货名称 || '')}</strong>` },
        { label: '规格型号', field: '规格型号' },
        { label: '订单量', field: '数量' },
        { label: '未入库订单量', field: '未入库量' },
        { label: '含税单价', field: '原币含税单价' },
        { label: '含税金额', field: '原币价税合计' },
        { label: '状态', field: '审批状态' }
      ];
      // 🟢 v120：列名与主模块（入库列表）统一（🟢 v190：与主模块对齐"订单编号"列）
      const inboundCols = [
        { label: '订单编号', field: '表体订单号', render: r => r.表体订单号 ? TableUtils.link('order', String(r.表体订单号), String(r.表体订单号)) : '' },
        { label: '入库日期', field: '入库日期' },
        { label: '存货编码', render: r => TableUtils.link('stock', r.存货编码 || '', r.存货编码 || '') },
        { label: '存货名称', render: r => `<strong>${esc(r.存货名称 || '')}</strong>` },
        { label: '规格型号', field: '规格型号' },
        { label: '入库量', field: '数量' },
        { label: '含税单价', field: '原币含税单价' },
        { label: '含税金额', field: '原币价税合计' }
      ];
      // 🟢 v120：列名与主模块（违约台账）统一
      const breachCols = [
        { label: '公司名称', field: '公司名称' },
        { label: '涉及订单号', field: '涉及订单号' },
        { label: '存货编码', field: '存货编码' },
        { label: '存货名称', field: '存货名称' },
        { label: '规格型号', field: '规格型号' },
        { label: '含税单价', field: '含税单价' },
        { label: '数量', field: '数量' },
        { label: '到货时间', field: '到货时间' },
        { label: '延迟天数', field: '延迟天数' },
        { label: '扣款比例', field: '扣款比例' },
        { label: '扣款金额', field: '扣款金额' },
        { label: '违约次数', field: '违约次数' },
        { label: '备注', field: '备注' }
      ];

      // 🟢 v190：采购订单 / 入库记录 仅显示最近 3 个月数据（避免历史全量导致档案页过长）
      const recentOrders = TableUtils.filterRecent3M(rel.orders, '日期');
      const recentInbound = TableUtils.filterRecent3M(rel.inbound, '入库日期');

      // 🟢 v192：初始化 4 个 section 各自的分页/排序状态。重置 currentPage=1，
      //   保证从别的实体返回此供应商时不会保留上一次的页码。
      this._sections = {
        'sd-pricing': { title: '合同价格', rows: rel.pricing || [], columns: priceCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
        'sd-orders':  { title: `采购订单（近3个月 · ${recentOrders.length}/${(rel.orders || []).length}）`, rows: recentOrders, columns: orderCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
        'sd-inbound': { title: `入库记录（近3个月 · ${recentInbound.length}/${(rel.inbound || []).length}）`, rows: recentInbound, columns: inboundCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null },
        'sd-breach':  { title: '违约台账', rows: rel.breach || [], columns: breachCols, currentPage: 1, pageSize: AppConfig.app.defaultPageSize, sort: null }
      };

      // 渲染：基础信息 + 4 个 section 占位（表格与分页器在 _renderSection 中填入）
      const sectionHosts = Object.keys(this._sections).map(id =>
        `<details class="detail-section" open><summary><h3 id="${id}-title">${esc(this._sections[id].title)} <span class="count">(${this._sections[id].rows.length})</span></h3></summary><div id="${id}" class="detail-table-host"></div></details>`
      ).join('');

      content.innerHTML = DetailCommon.backBar() +
        `<h2 style="margin:6px 0 18px;font-size:20px;">🏭 供应商档案 · ${esc(name)}</h2>` +
        baseSection +
        sectionHosts;

      // 填入每个 section 的表格 + 分页器
      Object.keys(this._sections).forEach(id => this._renderSection(id));

      // 🟢 v192：违约台账的"软匹配"提示（从原 v190 代码下沉到此处）
      if (rel._breachSoft) {
        const tip = document.createElement('div');
        tip.style.cssText = 'font-size:12px;color:var(--status-warning,#b7791f);margin:6px 0 0;';
        tip.textContent = '⚠️ 违约台账为按名称软匹配结果，可能含其他同名公司数据';
        content.appendChild(tip);
      }
    } catch (e) {
      console.error('[SupplierDetailModule]', e);
      content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败: ${esc(e.message || e)}</div></div>`;
    } finally {
      hideLoading();
    }
  },

  // ============================================================
  // 🟢 v192：每个 section 各自的分页 + 排序 + 筛选 + 智能选区
  // ============================================================

  /**
   * 渲染某个 section 的表格（数据层分页 → 写入 DOM → 挂分页器 → 挂排序/筛选）
   * @param {string} sectionId - 在 _sections 中的 key（同时也是 DOM 容器的 id）
   */
  _renderSection(sectionId) {
    const s = this._sections[sectionId];
    if (!s) return;
    const host = document.getElementById(sectionId);
    if (!host) return;

    // 1) 数据层排序（作用于全部行，跨页一致）
    let data = s.rows;
    if (s.sort && s.sort.field) {
      const field = s.sort.field;
      const dir = s.sort.dir; // 1=asc, 2=desc
      data = data.slice().sort((a, b) => {
        const va = a && a[field], vb = b && b[field];
        // 与 TableUtils._cellToComparable 保持一致：去千分位/¥/% 后试数值比较
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

    // 4) 分页器：放在 <details> 内、表格之后（折叠时自动隐藏）
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
        module: 'SupplierDetailModule',
        section: sectionId,
        total, totalPages, page, pageSize
      });
    }

    // 5) 智能选区 + 排序/筛选（仅当有表格时挂）
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
      // 🟢 v192：标记已初始化，防止 app.js 的 MutationObserver 在后续 DOM 变化时
      //   用「无 onSortChange」的 initSortableHeadersAuto 把我的 listener 覆盖掉
      //   （那样点击排序后详情页的 s.sort 不会更新、跨页排序不生效）
      const table = host.querySelector('.data-table');
      if (table) table.dataset.sortableInitialized = '1';
    }
  },

  /**
   * 翻页器 onclick 回调（多 section 模式，renderPagination 生成的格式）
   *   单参形式 Module.goPage(N) 也支持，便于未来扩展。
   * @param {string|number} sectionOrPage
   * @param {number} [page]
   */
  goPage(sectionOrPage, page) {
    // 兼容：1 个参数 = 老格式（直接当页号，当前仅用于防护，正常不会到这）
    if (typeof sectionOrPage === 'number' || (!page && !this._sections[sectionOrPage])) {
      // 直接页号（如未来供应商档案页加顶部总翻页器时备用）
      return;
    }
    const section = sectionOrPage;
    const p = Math.max(1, parseInt(page, 10) || 1);
    const s = this._sections[section];
    if (!s) return;
    s.currentPage = p;
    this._renderSection(section);
  },

  /**
   * 改变每页条数（renderPagination 生成的格式）
   * @param {string} section
   * @param {string|number} size 'all' 或数字
   */
  changePageSize(section, size) {
    const s = this._sections[section];
    if (!s) return;
    s.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    s.currentPage = 1;
    this._renderSection(section);
  }
};
