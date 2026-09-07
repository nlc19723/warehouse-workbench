// ============================================
// 订单跟踪模块 V2 - 去重统计 + 升级分页
// ============================================

const OrderTrackModule = {
  currentFilter: { keyword: '', supplier: '' },
  currentPage: 1,
  pageSize: AppConfig.app.orderTrackPageSize,

  async render(token) {
    if (token !== undefined) this._rt = token;
    const myToken = token;
    const content = document.getElementById('contentArea');
    const suppliers = await DataStore.getOrderSuppliers();
    if (myToken !== undefined && myToken !== App._goToken) return;

    content.innerHTML = `
      <div class="filter-bar filter-bar-m" data-mod="track">
        <input type="text" id="trackKw" class="fb-search" placeholder="搜索订单编号、供应商、存货名称..." value="${escAttr(this.currentFilter.keyword || '')}" onkeydown="if(event.key==='Enter')OrderTrackModule.applyFilter()">
        <div class="fb-row fb-row--fields">
          <div class="fb-field"><select id="trackSupplier">
          <option value="">全部供应商</option>
          ${suppliers.map(s => `<option value="${escAttr(s)}" ${this.currentFilter.supplier === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        </select></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="OrderTrackModule.applyFilter()">筛选</button>
          <button class="btn--ghost" onclick="OrderTrackModule.resetFilter()">重置</button>
          <button class="btn--ghost" onclick="OrderTrackModule.exportData()">📥 导出</button>
        </div>
      </div>

      <div id="trackSummary"></div>
      <div class="card" style="padding:0;">
        <div id="trackTableArea" class="table-wrapper" style="overflow-x:auto;"></div>
      </div>
      <div id="trackPagination" class="pagination-bar" style="justify-content:center;gap:8px;"></div>
    `;

    if (window.enhanceSearchSelect) {
      enhanceSearchSelect('trackSupplier', { placeholder: '搜索供应商', widthMode: 'full' });
    }

    // 🟢 v227.74：移动端筛选栏字段行配平（≤768px 按最长选项动态分配 flex-grow）
    if (window.FilterLayout) FilterLayout.balanceAll();

    await this.loadData(myToken);
  },

  async loadData(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    let orders = await DataStore.getRows('orders');
    const kw = (this.currentFilter.keyword || '').replace(/\s+/g, '');
    const supplier = this.currentFilter.supplier || '';

    if (kw) {
      const kwLower = kw.toLowerCase();
      orders = orders.filter(o =>
        (o.订单编号 && String(o.订单编号).replace(/\s+/g, '').toLowerCase().includes(kwLower)) ||
        (o.供应商 && o.供应商.replace(/\s+/g, '').toLowerCase().includes(kwLower)) ||
        (o.存货名称 && o.存货名称.replace(/\s+/g, '').toLowerCase().includes(kwLower))
      );
    }
    if (supplier) {
      orders = orders.filter(o => o.供应商 === supplier);
    }

    // 仅显示有未入库量的订单；且排除「行关闭人」非空的行（已关闭说明供应商不需再送，无须跟踪）
    const pending = orders.filter(o => parseFloat(o.未入库量) > 0 && !(o.行关闭人 && String(o.行关闭人).trim()));

    // ===== 去重统计 =====
    const uniqueOrderNos = new Set(pending.map(o => o.订单编号).filter(Boolean));
    const uniqueCount = uniqueOrderNos.size;
    const totalUninbound = pending.reduce((s, o) => s + (parseFloat(o.未入库量) || 0), 0);
    const totalUninboundAmount = TableUtils.sumMoney(pending, '未入总金额'); // 🟢 AUDIT-003 整数分聚合

    if (rt !== undefined && rt !== App._goToken) return;
    document.getElementById('trackSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-warning">
          <div class="kpi-label">未入库订单数</div>
          <div class="kpi-value">${uniqueCount}</div>
          <div class="kpi-sub">总记录 ${pending.length} 条</div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">未入库总量</div>
          <div class="kpi-value">${TableUtils.formatNum(totalUninbound)}</div>
        </div>
        <div class="kpi-card card-danger">
          <div class="kpi-label">未入金额(元)</div>
          <div class="kpi-value">¥${TableUtils.formatMoney(totalUninboundAmount)}</div>
        </div>
      </div>
    `;

    this.currentData = pending;

    // 填充存货编码（双路取码，详见 DataLoader.fillStockCode）
    if (pending.length > 0 && typeof DataLoader !== 'undefined') {
      let codeMap = null;
      if (DataLoader.getStockNameSpecCodeMap) {
        try { codeMap = await DataLoader.getStockNameSpecCodeMap(); } catch (e) { codeMap = null; }
      }
      pending.forEach(o => DataLoader.fillStockCode(o, codeMap));
    }
    this.renderTable(rt);
  },

  applyFilter() {
    this.currentFilter.keyword = (document.getElementById('trackKw')?.value || '').trim();
    this.currentFilter.supplier = document.getElementById('trackSupplier')?.value || '';
    this.currentPage = 1;
    this.loadData();
  },

  resetFilter() {
    this.currentFilter = { keyword: '', supplier: '' };
    this.currentPage = 1;
    const kwInput = document.getElementById('trackKw');
    const supSelect = document.getElementById('trackSupplier');
    if (kwInput) kwInput.value = '';
    if (supSelect) supSelect.value = '';
    this.loadData();
  },

  renderTable(token) {
    const rt = (token !== undefined) ? token : this._rt;
    if (rt !== undefined && rt !== App._goToken) return;
    const data = this.currentData;
    const total = data.length;
    const pageSize = this.pageSize === 'all' ? total : this.pageSize;
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 1;
    const page = Math.min(this.currentPage, Math.max(1, totalPages));
    this.currentPage = page;
    const items = data.slice((page - 1) * pageSize, page * pageSize);

    if (items.length === 0) {
      document.getElementById('trackTableArea').innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">所有订单已全部入库</div></div>';
      document.getElementById('trackPagination').innerHTML = '';
      return;
    }

    document.getElementById('trackTableArea').innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>订单编号</th>
            <th>下单时间</th>
            <th>供应商</th>
            <th>项目</th>
            <th>存货编码</th>
            <th>存货名称</th>
            <th>规格型号</th>
            <th>订单量</th>
            <th>入库量</th>
            <th style="width:80px;">未入库订单量</th>
            <th style="width:120px;">入库进度</th>
            <th>未入金额</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(o => {
            const totalQty = parseFloat(o.数量) || 0;
            const inbound = parseFloat(o.累计入库数量) || 0;
            const pendingQty = parseFloat(o.未入库量) || 0;
            const percent = totalQty > 0 ? Math.min(100, Math.round((inbound / totalQty) * 100)) : 0;
            // 颜色规则：<60%草绿色，60-80%蛋黄色，>80%暗红色
            const progressClass = percent >= 80 ? 'danger' : percent >= 60 ? 'warning' : '';
            return `
              <tr>
                <td><strong>${TableUtils.link('order', o.订单编号 ?? '', o.订单编号 ?? '')}</strong></td>
                <td>${esc(o.日期 || o.已下单时间 || '')}</td>
                <td>${TableUtils.link('supplier', o.供应商 ?? '', o.供应商 ?? '')}</td>
                <td>${esc(o.项目名称 ?? '')}</td>
                <td>${TableUtils.link('stock', o._存货编码 ?? '', o._存货编码 ?? '')}</td>
                <td>${esc(o.存货名称)}</td>
                <td>${esc(o.规格型号 ?? '')}</td>
                <td>${o.数量}</td>
                <td>${o.累计入库数量 || 0}</td>
                <td><strong>${pendingQty}</strong></td>
                <td>
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div class="progress-bar" style="width:70px;">
                        <div class="progress-fill ${progressClass}" style="width:${percent}%;"></div>
                      </div>
                      <!-- 🟢 v199：去掉内联 font-size:11px，跟随单元格统一字号 -->
                      <span style="color:var(--text-secondary);min-width:36px;">${percent}%</span>
                    </div>
                  </td>
                <td>${TableUtils.formatMoney(o.未入总金额)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    // 🟢 O3：分页栏统一由 TableUtils.renderPagination 渲染（行为等价去重）
    TableUtils.renderPagination('trackPagination', { module: 'OrderTrackModule', total, totalPages, page: this.currentPage, pageSize: this.pageSize });

    TableUtils.initSortableHeaders('trackTableArea');
    // 🟢 v133：移动端安装浮动表头/首列（绕开 iOS Safari thead sticky bug）
    if (window.TableStickyOverlay) TableStickyOverlay.install('trackTableArea');
  },

  changePageSize(size) {
    this.pageSize = size === 'all' ? 'all' : parseInt(size, 10);
    this.currentPage = 1;
    this.renderTable();
  },

  goPage(p) {
    this.currentPage = p;
    this.renderTable();
  },

  exportData() {
    // 🟢 v195：导出仅保留表格中可见的 9 列（用户圈红的：订单编号 / 下单时间 / 供应商 / 项目 /
    //   存货编码 / 存货名称 / 规格型号 / 订单量 / 入库量），剔除未入库订单量 / 入库进度 / 未入金额。
    //   数据范围 = this.currentData（已是「关键词+供应商筛选后未入库全集」，含未显示页），
    //   日期字段统一为 YYYY-MM-DD，避免导出 Excel 里出现 ISO 时间戳 / 序列化字符串。
    const rows = (this.currentData || []);
    const filtered = rows.map(o => ({
      '订单编号': o.订单编号 ?? '',
      '下单时间': (o.日期 || o.已下单时间 || '').toString().slice(0, 10),
      '供应商': o.供应商 ?? '',
      '项目': o.项目名称 ?? '',
      '存货编码': o._存货编码 ?? '',
      '存货名称': o.存货名称 ?? '',
      '规格型号': o.规格型号 ?? '',
      '订单量': o.数量 ?? 0,
      '入库量': o.累计入库数量 || 0,
    }));
    TableUtils.exportToExcel(filtered, `订单跟踪_${new Date().toISOString().split('T')[0]}.xlsx`, '订单跟踪');
  }
};
