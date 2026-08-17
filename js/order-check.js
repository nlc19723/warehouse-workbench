// ============================================
// 订货核对模块 V3 - 统一表格 · 3D搜索按钮
// ============================================

const OrderCheckModule = {
  currentData: [],

  async render() {
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="checkKw" placeholder="搜索物料名称..." onkeydown="if(event.key==='Enter')OrderCheckModule.applyFilter()">
        <select id="checkCategory">
          <option value="">全部分类</option>
          <option value="A">A类</option>
          <option value="B">B类</option>
          <option value="C">C类</option>
        </select>
        <button class="search-glass" onclick="OrderCheckModule.applyFilter()">筛选</button>
        <button class="secondary" onclick="OrderCheckModule.resetFilter()">重置</button>
        <button class="secondary" onclick="OrderCheckModule.exportData()">📥 导出</button>
      </div>

      <div id="checkSummary"></div>
      <div id="checkTableArea"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    let checks = await db.orderChecks.toArray();
    const kw = document.getElementById('checkKw')?.value.trim().toLowerCase();
    const category = document.getElementById('checkCategory')?.value;

    if (kw) {
      checks = checks.filter(c => c.存货名称 && c.存货名称.toLowerCase().includes(kw));
    }
    if (category) {
      checks = checks.filter(c => c.分类 === category);
    }

    const totalQty = checks.reduce((s, c) => s + (parseFloat(c.数量) || 0), 0);
    const lowTurnoverCount = checks.filter(c => c.低周转 === '是' || c.低周转 === true).length;

    document.getElementById('checkSummary').innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card card-info">
          <div class="kpi-label">订货项数</div>
          <div class="kpi-value">${checks.length}</div>
        </div>
        <div class="kpi-card card-info">
          <div class="kpi-label">订货总量</div>
          <div class="kpi-value">${this.formatNum(totalQty)}</div>
        </div>
        <div class="kpi-card card-warning">
          <div class="kpi-label">低周转项数</div>
          <div class="kpi-value">${lowTurnoverCount}</div>
        </div>
      </div>
    `;

    this.currentData = checks;
    this.renderTable();
  },

  applyFilter() { this.loadData(); },

  resetFilter() {
    document.getElementById('checkKw').value = '';
    document.getElementById('checkCategory').value = '';
    this.loadData();
  },

  renderTable() {
    const data = this.currentData;
    const area = document.getElementById('checkTableArea');

    if (data.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无订货数据</div></div>';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>存货编码</th>
              <th>存货名称</th>
              <th>规格型号</th>
              <th>单位</th>
              <th>订货数量</th>
              <th>现存量</th>
              <th>在途订单</th>
              <th>分类</th>
              <th>低周转</th>
              <th>仓库/项目</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(c => {
              const isLow = c.低周转 === '是' || c.低周转 === true;
              return `
                <tr class="${isLow ? 'row-warning' : ''}">
                  <td>${esc(c.存货编码 ?? '')}</td>
                  <td><strong>${esc(c.存货名称 ?? '')}</strong></td>
                  <td>${esc(c.规格型号 ?? '')}</td>
                  <td>${esc(c.主计量 ?? '')}</td>
                  <td>${esc(c.数量 ?? '')}</td>
                  <td>${esc(c.现存量 ?? '')}</td>
                  <td>${esc(c.在途订单 ?? 0)}</td>
                  <td>${c.分类 ? `<span class="tag ${c.分类 === 'A' ? 'tag-success' : c.分类 === 'B' ? 'tag-warning' : 'tag-neutral'}">${esc(c.分类)}</span>` : ''}</td>
                  <td>${isLow ? '<span class="tag tag-warning">是</span>' : '<span class="tag tag-neutral">否</span>'}</td>
                  <td>${esc(c.所上或库房 || c.工程项目 || '')}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;

    TableUtils.initSmartSelect('checkTableArea');
  },

  exportData() {
    // 🟢 O1：统一导出（行为与原逻辑一致）
    TableUtils.exportToExcel(this.currentData, `订货核对_${new Date().toISOString().split('T')[0]}.xlsx`, '订货核对');
  },

  formatNum(num) {
    return new Intl.NumberFormat('zh-CN').format(Math.round(num || 0));
  }
};
