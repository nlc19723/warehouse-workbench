// ============================================
// 违约台账模块 V3 - 统一表格 · 统计卡片规范化 · 3D搜索按钮
// ============================================

const BreachModule = {
  currentData: [],

  async render() {
    const content = document.getElementById('contentArea');
    content.innerHTML = `
      <div class="filter-bar">
        <input type="text" id="breachKw" placeholder="搜索供应商名称..." onkeydown="if(event.key==='Enter')BreachModule.applyFilter()">
        <button class="search-glass" onclick="BreachModule.applyFilter()">🔍 搜索</button>
        <button class="secondary" onclick="BreachModule.resetFilter()">重置</button>
        <button class="secondary" onclick="BreachModule.exportData()">📥 导出</button>
      </div>

      <!-- 统计卡片（2x2田字格） + 规则面板（并排） -->
      <div id="breachSummary" class="chart-stats-row" style="margin-bottom:14px;">
        <div id="breachStats" class="breach-stats-grid"></div>
        <div id="breachRulesBox" class="breach-rules-panel"></div>
      </div>

      <div id="breachTableArea"></div>
    `;

    await this.loadData();
  },

  async loadData() {
    let records = await db.breach.toArray();
    const kw = document.getElementById('breachKw')?.value.trim().toLowerCase();
    if (kw) {
      records = records.filter(r => r.公司名称 && r.公司名称.toLowerCase().includes(kw));
    }

    const totalAmount = records.reduce((s, r) => s + (parseFloat(r.扣款金额) || 0), 0);
    const totalDelay = records.reduce((s, r) => s + (parseFloat(r.延迟天数) || 0), 0);
    const companySet = new Set(records.map(r => r.公司名称).filter(Boolean));

    document.getElementById('breachStats').innerHTML = `
      <div class="kpi-card card-danger">
        <div class="kpi-label">违约记录数</div>
        <div class="kpi-value">${records.length}</div>
      </div>
      <div class="kpi-card card-warning">
        <div class="kpi-label">涉及供应商</div>
        <div class="kpi-value">${companySet.size}</div>
      </div>
      <div class="kpi-card card-warning">
        <div class="kpi-label">总延迟天数</div>
        <div class="kpi-value">${totalDelay}</div>
      </div>
      <div class="kpi-card card-danger">
        <div class="kpi-label">扣款总额</div>
        <div class="kpi-value">¥${this.formatMoney(totalAmount)}</div>
      </div>
    `;

    document.getElementById('breachRulesBox').innerHTML = `
      <div class="glass-card" style="margin-bottom:0;">
        <div class="glass-card-header">
          <span class="glass-card-title"><span class="title-icon">📋</span>违约扣款规则</span>
        </div>
        <table class="data-table">
          <thead>
            <tr><th>延迟天数</th><th>扣款比例</th></tr>
          </thead>
          <tbody>
            <tr><td>2天</td><td><span class="tag tag-warning">5%</span></td></tr>
            <tr><td>4天</td><td><span class="tag tag-warning">10%</span></td></tr>
            <tr><td>6天</td><td><span class="tag tag-warning">15%</span></td></tr>
            <tr><td>8天及以上</td><td><span class="tag tag-danger">20%</span></td></tr>
          </tbody>
        </table>
      </div>
    `;

    this.currentData = records;
    this.renderTable();
  },

  renderTable() {
    const data = this.currentData;
    const area = document.getElementById('breachTableArea');
    if (data.length === 0) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">暂无违约记录</div></div>';
      return;
    }

    area.innerHTML = `
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>公司名称</th>
              <th>涉及订单号</th>
              <th>物料</th>
              <th>规格</th>
              <th>单价</th>
              <th>数量</th>
              <th>到货时间</th>
              <th>延迟天数</th>
              <th>扣款比例</th>
              <th>扣款金额</th>
              <th>违约次数</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(r => `
              <tr>
                <td><strong>${r.公司名称}</strong></td>
                <td>${r.涉及订单号 || '-'}</td>
                <td>${r.存货名称 || '-'}</td>
                <td>${r.规格型号 || '-'}</td>
                <td>¥${this.formatMoney(r.单价)}</td>
                <td>${r.数量}</td>
                <td>${r.到货时间 || '-'}</td>
                <td><span class="tag ${r.延迟天数 >= 8 ? 'tag-danger' : 'tag-warning'}">${r.延迟天数 || 0} 天</span></td>
                <td>${r.扣款比例 ? (parseFloat(r.扣款比例) * 100).toFixed(0) + '%' : '-'}</td>
                <td><strong>¥${this.formatMoney(r.扣款金额)}</strong></td>
                <td>${r.违约次数 || 0}</td>
                <td>${r.备注 || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    TableUtils.initSmartSelect('breachTableArea');
  },

  applyFilter() { this.loadData(); },
  resetFilter() {
    document.getElementById('breachKw').value = '';
    this.loadData();
  },
  exportData() {
    if (!this.currentData || this.currentData.length === 0) { alert('没有数据'); return; }
    const ws = XLSX.utils.json_to_sheet(this.currentData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '违约台账');
    XLSX.writeFile(wb, `违约台账_${new Date().toISOString().split('T')[0]}.xlsx`);
  },
  formatMoney(num) {
    if (!num) return '-';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(num);
  }
};
