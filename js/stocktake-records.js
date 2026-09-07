// ============================================
// 盘点记录模块 V2 - 扫码盘点（v215 · Step 3 记录与导出）
// ============================================
// Step 3 范围：12 列明细表格 + 筛选（盘点人/类别/日期/关键词）+ 导出 + 作废。
// 【行为保持】纯新增模块，只读写独立表 stocktake_records，不触碰现有 10 张业务表。
// 12 列：存货编码 / 存货名称 / 规格型号 / 现存量 / 盘点数量 / 差异量 /
//        盘点日期 / 盘点人 / 盘点类别 / 开始日期 / 结束日期 / 备注

const StocktakeRecordModule = {
  currentData: [],
  // v217：sheetId 为隐藏批次筛选（由「盘点批次汇总」→「查看明细」跳转带入，不展示为控件）
  filter: { 盘点人: '', 盘点类别: '', dateFrom: '', dateTo: '', keyword: '', sheetId: '' },
  showVoided: false,
  // 🟢 v227：多选删除 —— 选中集合存 recId（跨筛选保留，删除后移除）
  selected: new Set(),

  /** v217：从批次汇总跳转过来时调用，写入批次筛选并渲染 */
  async showBySheet(sheetId) {
    this.filter.sheetId = sheetId || '';
    try { localStorage.setItem('wb_strec_filter_sheet', sheetId || ''); } catch (e) {}
    await this.render();
  },

  clearSheetFilter() {
    this.filter.sheetId = '';
    try { localStorage.removeItem('wb_strec_filter_sheet'); } catch (e) {}
    this.render();
  },

  async render(token) {
    if (token !== undefined) this._rt = token;
    const content = document.getElementById('contentArea');
    if (!content) return;

    // v217：兼容直接通过 URL/模块切换进入时，读取上一次的批次筛选
    if (!this.filter.sheetId) {
      try { this.filter.sheetId = localStorage.getItem('wb_strec_filter_sheet') || ''; } catch (e) {}
    }
    const sheetTip = this.filter.sheetId ? `
      <div style="padding:7px 12px;margin-bottom:8px;border-radius:8px;background:var(--status-warning-bg,#fff7e6);
                  font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>📦 已按批次筛选：<b>${esc(this.filter.sheetId)}</b></span>
        <button class="btn--ghost" onclick="StocktakeRecordModule.clearSheetFilter()">查看全部</button>
      </div>` : '';

    content.innerHTML = `${sheetTip}
      <div class="filter-bar filter-bar-m" data-mod="str">
        <input type="text" id="strKw" class="fb-search" placeholder="搜索存货编码/名称..." value="${escAttr(this.filter.keyword)}"
          onkeydown="if(event.key==='Enter')StocktakeRecordModule.applyFilter()">
        <div class="fb-row fb-row--fields">
          <div class="fb-field"><select id="strCounter" onchange="StocktakeRecordModule.applyFilter()">
          <option value="">全部盘点人</option>
        </select></div>
          <div class="fb-field"><select id="strType" onchange="StocktakeRecordModule.applyFilter()">
          <option value="">全部类别</option>
          <option value="日常" ${this.filter.盘点类别 === '日常' ? 'selected' : ''}>日常</option>
          <option value="季度" ${this.filter.盘点类别 === '季度' ? 'selected' : ''}>季度</option>
        </select></div>
        </div>
        <div class="fb-row fb-row--date">
          <div class="fb-field"><input type="text" id="strFrom" value="${escAttr(this.filter.dateFrom)}" placeholder="起始日期" onchange="StocktakeRecordModule.applyFilter()"></div>
          <span class="fb-sep">至</span>
          <div class="fb-field"><input type="text" id="strTo" value="${escAttr(this.filter.dateTo)}" placeholder="结束日期" onchange="StocktakeRecordModule.applyFilter()"></div>
        </div>
        <div class="fb-row fb-row--buttons">
          <button class="btn--primary" onclick="StocktakeRecordModule.applyFilter()">🔍 搜索</button>
          <button class="btn--ghost" onclick="StocktakeRecordModule.resetFilter()">重置</button>
          <button class="btn--ghost" onclick="StocktakeRecordModule.exportData()">📥 导出</button>
          <button class="btn--danger" id="stRecDelBtn" onclick="StocktakeRecordModule.deleteSelected()">🗑️ 删除选中</button>
          <label style="display:flex;align-items:center;gap:4px;font-size:13px;">
          <input type="checkbox" id="strShowVoid" ${this.showVoided ? 'checked' : ''}
            onchange="StocktakeRecordModule.toggleVoided(this.checked)"> 显示已作废
        </label>
        </div>
      </div>
      <div id="strStats" style="margin-bottom:10px;"></div>
      <div id="stRecArea"><div class="empty-state"><div class="empty-text">加载中…</div></div></div>
    `;

    // 🟢 v227.35：盘点记录列表日期框挂载玻璃日历（统一风格，替代浏览器原生 date 弹层）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.unmountAll();
      DatePicker.mount('strFrom');
      DatePicker.mount('strTo');
    }

    // 🟢 v227.74：移动端筛选栏字段行配平（≤768px 按最长选项动态分配 flex-grow）
    if (window.FilterLayout) FilterLayout.balanceAll();

    await this.loadData(token);
  },

  async loadData(token) {
    if (token !== undefined && token !== App._goToken) return;
    const area = document.getElementById('stRecArea');
    if (!area) return;

    let rows = [];
    try {
      if (typeof DataStore !== 'undefined' && typeof DataStore.getStocktakeRecords === 'function') {
        rows = await DataStore.getStocktakeRecords();
      }
    } catch (e) {
      console.warn('[stocktake-records] 读取失败(已降级为空):', e);
      rows = [];
    }

    // 填充盘点人下拉（保留当前选中值）
    const counters = [...new Set((rows || []).map(r => r.盘点人).filter(Boolean))].sort();
    const sel = document.getElementById('strCounter');
    if (sel) {
      const cur = this.filter.盘点人;
      sel.innerHTML = '<option value="">全部盘点人</option>' +
        counters.map(c => `<option value="${escAttr(c)}" ${c === cur ? 'selected' : ''}>${esc(c)}</option>`).join('');
    }

    // 过滤
    let data = (rows || []).filter(r => r && !r.voided);
    if (this.showVoided) data = (rows || []).slice();
    const f = this.filter;
    const kw = String(f.keyword || '').trim().toLowerCase();
    if (kw) data = data.filter(r =>
      String(r.存货编码 || '').toLowerCase().includes(kw) ||
      String(r.存货名称 || '').toLowerCase().includes(kw));
    if (f.盘点人) data = data.filter(r => r.盘点人 === f.盘点人);
    if (f.盘点类别) data = data.filter(r => r.盘点类别 === f.盘点类别);
    if (f.dateFrom) data = data.filter(r => (r.盘点日期 || '') >= f.dateFrom);
    if (f.dateTo) data = data.filter(r => (r.盘点日期 || '') <= f.dateTo);
    // v217：隐藏的批次筛选（来自「盘点批次汇总」跳转）
    if (f.sheetId) data = data.filter(r => r.sheetId === f.sheetId);

    // 按盘点日期倒序、编码升序
    data.sort((a, b) => {
      const d = String(b.盘点日期 || '').localeCompare(String(a.盘点日期 || ''));
      return d !== 0 ? d : String(a.存货编码 || '').localeCompare(String(b.存货编码 || ''));
    });

    this.currentData = data;
    this.renderStats(data);

    if (!data.length) {
      area.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📝</div>
          <div class="empty-text">暂无盘点记录</div>
          <div class="empty-sub" style="margin-top:6px;font-size:13px;opacity:.75;">
            在【盘点】模块完成清点并保存后，记录会显示在这里
          </div>
        </div>`;
      this._updateSelBar();
      return;
    }

    const body = data.map(r => {
      // 🟢 v226：盘点数量/差异量为 null → 渲染「/」（盘点结束时的未盘点项）
      const diff = parseFloat(r.差异量);
      const color = isNaN(diff) || diff === 0 ? '' : (diff > 0 ? 'color:#16a34a;' : 'color:#dc2626;');
      const voidTag = r.voided ? '<span style="color:#999;">（已作废）</span>' : '';
      const batchNo = esc(r.batchNo || r.sheetId || '');
      const qtyCell = (r.盘点数量 == null || r.盘点数量 === '') ? '/' : this._num(r.盘点数量);
      const diffCell = (r.差异量 == null || r.差异量 === '')
        ? '/'
        : `<span style="${color}font-weight:600;">${this._num(r.差异量)}</span>`;
      const rid = escAttr(r.recId);
      const checked = this.selected.has(r.recId) ? 'checked' : '';
      // 🟢 v227.93 P4：操作列按钮溢出修复 —— 改为纵向 flex（窄屏自适应），按钮 padding 收紧，避免横向撑出可视区
      return `<tr${this.selected.has(r.recId) ? ' style="background:rgba(220,38,38,.05);"' : ''}>
        <td style="text-align:center;"><input type="checkbox" class="stRecChk" data-rid="${rid}" ${checked}
          onchange="StocktakeRecordModule.toggleOne(this)"></td>
        <td>${batchNo}</td>
        <td>${esc(r.存货编码 || '')}</td>
        <td>${esc(r.存货名称 || '')}</td>
        <td>${esc(r.规格型号 || '')}</td>
        <td>${this._num(r.现存量)}</td>
        <td>${qtyCell}</td>
        <td>${diffCell}</td>
        <td>${esc(r.盘点日期 || '')}</td>
        <td>${esc(r.盘点人 || '')}</td>
        <td>${esc(r.盘点类别 || '')}${voidTag}</td>
        <td>${esc(r.开始日期 || '')}</td>
        <td>${esc(r.结束日期 || '')}</td>
        <td>${esc(r.备注 || '')}</td>
        <td class="stRec-opcell">${r.voided
          ? `<button class="btn--ghost" onclick="StocktakeRecordModule.unvoid('${escAttr(r.recId)}')">恢复</button>`
          : `<button class="btn--ghost" onclick="StocktakeRecordModule.voidRecord('${escAttr(r.recId)}')">作废</button>
             <button class="btn--ghost" onclick="StocktakeRecordModule.editRecord('${escAttr(r.recId)}')">修正</button>`}
          <button class="btn--danger" onclick="StocktakeRecordModule.deleteRecord('${escAttr(r.recId)}')"
            title="永久删除该条记录">🗑️ 删除</button></td>
      </tr>`;
    }).join('');

    area.innerHTML = `
      <div style="overflow:auto;max-height:70vh;border:1px solid var(--border-color,#e5e7eb);border-radius:8px;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--bg-secondary,#f9fafb);z-index:1;">
            <tr>
              <th style="width:34px;text-align:center;"><input type="checkbox" id="stRecAll"
                onchange="StocktakeRecordModule.toggleAll(this)" title="全选/取消全选"></th>
              <th>盘点号</th><th>存货编码</th><th>存货名称</th><th>规格型号</th><th>现存量</th>
              <th>盘点数量</th><th>差异量</th><th>盘点日期</th><th>盘点人</th>
              <th>盘点类别</th><th>开始日期</th><th>结束日期</th><th>备注</th>
              <th class="stRec-opcell">操作</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
    this._updateSelBar();
  },

  // ---------------- v227：多选删除 ----------------
  toggleAll(cb) {
    const boxes = document.querySelectorAll('.stRecChk');
    boxes.forEach(b => {
      b.checked = cb.checked;
      if (cb.checked) this.selected.add(b.dataset.rid); else this.selected.delete(b.dataset.rid);
      const tr = b.closest('tr');
      if (tr) tr.style.background = cb.checked ? 'rgba(220,38,38,.05)' : '';
    });
    this._updateSelBar();
  },

  toggleOne(cb) {
    const rid = cb.dataset.rid;
    if (cb.checked) this.selected.add(rid); else this.selected.delete(rid);
    const tr = cb.closest('tr');
    if (tr) tr.style.background = cb.checked ? 'rgba(220,38,38,.05)' : '';
    const all = document.querySelectorAll('.stRecChk');
    const head = document.getElementById('stRecAll');
    if (head && all.length) head.checked = Array.from(all).every(b => b.checked);
    this._updateSelBar();
  },

  /** 刷新「删除选中」按钮文案（显示已选条数） */
  _updateSelBar() {
    const btn = document.getElementById('stRecDelBtn');
    if (!btn) return;
    const n = this.selected.size;
    btn.textContent = n ? `🗑️ 删除选中(${n})` : '🗑️ 删除选中';
    btn.disabled = !n;
    btn.style.opacity = n ? '1' : '.5';
    btn.style.cursor = n ? 'pointer' : 'not-allowed';
  },

  clearSelection() { this.selected.clear(); this._updateSelBar(); },

  async deleteSelected() {
    const ids = Array.from(this.selected);
    if (!ids.length) { if (typeof showToast === 'function') showToast('请先勾选要删除的记录'); return; }
    const ok = await WBModal.confirm(
      `确认删除选中的 ${ids.length} 条盘点记录？\n\n删除为永久操作，不可恢复；若已连接云端，其他设备同步后也会删除。`,
      { title: '⚠ 删除盘点记录' });
    if (!ok) return;
    await this._applyDelete(ids);
  },

  async deleteRecord(recId) {
    const ok = await WBModal.confirm('确认删除该条盘点记录？\n\n删除为永久操作，不可恢复。', { title: '⚠ 删除盘点记录' });
    if (!ok) return;
    await this._applyDelete([recId]);
  },

  /**
   * 物理删除 + 云端墓碑同步。
   * 与「作废」的区别：作废 = 软删（保留可追溯、可恢复）；删除 = 真删。
   * 云端墓碑：推 {recId, __deleted:1} 覆盖原记录，他端 pullCloudRecords 时据墓碑物理删本地同 recId 记录。
   */
  async _applyDelete(recIds) {
    try {
      const rows = await DataStore.getStocktakeRecords();
      const hits = (rows || []).filter(r => recIds.indexOf(r.recId) >= 0);
      if (!hits.length) { if (typeof showToast === 'function') showToast('未找到可删除的记录'); return; }

      const tombs = hits.map(h => ({ recId: h.recId, __deleted: 1, deletedAt: new Date().toISOString() }));
      // ① 先落本地墓碑队列（离线容错：上线后由 StocktakeModule.retryPendingSync 补推）
      if (typeof StocktakeModule !== 'undefined' && typeof StocktakeModule._addTombs === 'function') {
        StocktakeModule._addTombs(tombs);
      }
      // ② 本地物理删（逐条经 write 包装，保证 Dexie 事务提交）
      for (const h of hits) {
        if (h.id != null) await DataStore.deleteStocktakeRecord(h.id);
      }
      // ③ 云端墓碑（失败不回滚本地，保留在队列等下次补推）
      let synced = false;
      try {
        if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.syncStocktake === 'function') {
          const res = await SyncManager.syncStocktake(tombs);
          synced = !!(res && res.ok);
          if (synced && typeof StocktakeModule !== 'undefined' && typeof StocktakeModule._clearTombs === 'function') {
            StocktakeModule._clearTombs(tombs.map(t => t.recId));
          }
        }
      } catch (e) { console.warn('[stocktake-records] 删除墓碑同步失败(已入待推队列):', e && e.message); }

      hits.forEach(h => this.selected.delete(h.recId));
      if (typeof showToast === 'function') {
        showToast('已删除 ' + hits.length + ' 条记录' + (synced ? '（已同步云端）' : ''));
      }
      this.loadData();
    } catch (e) {
      console.error('[stocktake-records] 删除失败:', e);
      if (typeof showToast === 'function') showToast('删除失败：' + (e.message || e));
    }
  },

  renderStats(data) {
    const el = document.getElementById('strStats');
    if (!el) return;
    let profit = 0, loss = 0, same = 0, unfilled = 0;
    data.forEach(r => {
      const d = parseFloat(r.差异量);
      // 🟢 v226：差异量 null 表示盘点结束时的「未盘点」项（盘点数量也是 /）—— 不计入盘盈/盘亏/无差异
      if (isNaN(d) || r.差异量 == null) unfilled++;
      else if (d === 0) same++;
      else if (d > 0) profit++;
      else loss++;
    });
    el.innerHTML = `
      <div style="padding:8px 12px;border-radius:8px;background:var(--status-info-bg,#eef6ff);font-size:13px;display:flex;gap:18px;flex-wrap:wrap;">
        <span>共 <b>${data.length}</b> 条</span>
        <span style="color:#16a34a;">盘盈 <b>${profit}</b></span>
        <span style="color:#dc2626;">盘亏 <b>${loss}</b></span>
        <span>无差异 <b>${same}</b></span>
        ${unfilled > 0 ? '<span style="color:#94a3b8;">未盘点 <b>' + unfilled + '</b></span>' : ''}
      </div>`;
  },

  _num(v) {
    if (v === '' || v == null || isNaN(v)) return '';
    return String(Math.round(parseFloat(v) * 1000) / 1000);
  },

  applyFilter() {
    const g = id => document.getElementById(id);
    this.filter.keyword = (g('strKw') || {}).value || '';
    this.filter.盘点人 = (g('strCounter') || {}).value || '';
    this.filter.盘点类别 = (g('strType') || {}).value || '';
    this.filter.dateFrom = (g('strFrom') || {}).value || '';
    this.filter.dateTo = (g('strTo') || {}).value || '';
    this.loadData();
  },

  resetFilter() {
    // v217：重置时保留 sheetId（批次跳转上下文），需清除请点「查看全部」
    const keep = this.filter.sheetId || '';
    this.filter = { 盘点人: '', 盘点类别: '', dateFrom: '', dateTo: '', keyword: '', sheetId: keep };
    this.render();
  },

  toggleVoided(v) { this.showVoided = !!v; this.loadData(); },

  // 导出当前筛选结果（12 列，与页面一致）
  exportData() {
    if (!this.currentData || !this.currentData.length) {
      if (typeof showToast === 'function') showToast('暂无可导出的记录');
      return;
    }
    const cols = ['存货编码', '存货名称', '规格型号', '现存量', '盘点数量', '差异量',
      '盘点日期', '盘点人', '盘点类别', '开始日期', '结束日期', '备注'];
    const rows = this.currentData.map(r => {
      const o = {};
      cols.forEach(c => { o[c] = (c === '备注' || c === '存货名称' || c === '规格型号') ? (r[c] || '') : (r[c] === undefined ? '' : r[c]); });
      return o;
    });
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    try {
      TableUtils.exportToExcel(rows, `盘点记录_${stamp}.xlsx`, '盘点记录');
    } catch (e) {
      console.error('[stocktake-records] 导出失败:', e);
      if (typeof showToast === 'function') showToast('导出失败：' + (e.message || e));
    }
  },

  // 作废（软删除：只置 voided=1，记录本身保留以便追溯）
  async voidRecord(recId) {
    if (!(await WBModal.confirm('确认作废该条盘点记录？\n作废后不再计入统计，但记录保留可追溯。', { title: '作废记录' }))) return;
    await this._setVoid(recId, 1);
  },

  async unvoid(recId) { await this._setVoid(recId, 0); },

  async _setVoid(recId, val) {
    try {
      const rows = await DataStore.getStocktakeRecords();
      const hit = rows.find(r => r.recId === recId);
      if (!hit) { if (typeof showToast === 'function') showToast('未找到该记录'); return; }
      const next = Object.assign({}, hit, { voided: val, updatedAt: new Date().toISOString() });
      await DataStore.updateStocktakeRecord(hit.id, { voided: val });
      // v217：作废/恢复状态上云，否则他人设备看到的仍是未作废（按 recId 覆盖合并）
      try {
        if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.syncStocktake === 'function') {
          SyncManager.syncStocktake([next]);
        }
      } catch (e) { console.warn('[stocktake-records] 作废状态同步失败(已忽略):', e && e.message); }
      if (typeof showToast === 'function') showToast(val ? '已作废' : '已恢复');
      this.loadData();
    } catch (e) {
      console.error('[stocktake-records] 作废失败:', e);
      if (typeof showToast === 'function') showToast('操作失败：' + (e.message || e));
    }
  },

  // v216 Step 6.3：修正 = 软作废原记录 + 新增修正记录（保留审计痕迹，不 UPDATE 历史）
  async editRecord(recId) {
    if (!recId) return;
    let rows = [];
    try { rows = await DataStore.getStocktakeRecords(); } catch (e) { rows = []; }
    const r = (rows || []).find(x => x.recId === recId);
    if (!r) { if (typeof showToast === 'function') showToast('未找到该记录'); return; }
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    const m = document.getElementById('modal'); if (m) m.classList.remove('modal-compact');
    if (!overlay || !title || !body) return;
    title.textContent = '修正盘点记录';
    const stock = this._num(r.现存量);
    body.innerHTML =
      '<div style="max-width:340px;font-size:13px;">' +
      '<div style="margin-bottom:8px;color:var(--text-secondary);">存货：<b style="color:var(--text-main);">' + (typeof esc === 'function' ? esc(r.存货名称 || '') : (r.存货名称 || '')) + '</b> · ' + (typeof esc === 'function' ? esc(r.存货编码 || '') : (r.存货编码 || '')) + '</div>' +
      '<div style="display:flex;gap:14px;margin-bottom:10px;color:var(--text-secondary);"><span>现存量：<b style="color:var(--text-main);">' + stock + '</b></span><span>原盘点数量：<b style="color:var(--text-main);">' + this._num(r.盘点数量) + '</b></span></div>' +
      '<label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:3px;">修正后盘点数量</label>' +
      '<input type="number" id="editQty" value="' + (typeof escAttr === 'function' ? escAttr(r.盘点数量) : r.盘点数量) + '" style="width:100%;height:36px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;margin-bottom:10px;">' +
      '<label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:3px;">备注（可选）</label>' +
      '<input type="text" id="editNote" value="' + (typeof escAttr === 'function' ? escAttr(r.备注 || '') : (r.备注 || '')) + '" style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:14px;">' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
      '<button onclick="document.getElementById(\'modalOverlay\').classList.remove(\'show\');" class="btn--ghost" style="padding:8px 16px;">取消</button>' +
      '<button onclick="StocktakeRecordModule.applyEdit(\'' + (typeof escAttr === 'function' ? escAttr(recId) : recId) + '\')" class="btn--primary" style="padding:8px 16px;">保存修正</button>' +
      '</div></div>';
    overlay.classList.add('show');
    const q = document.getElementById('editQty');
    if (q) setTimeout(() => { try { q.focus(); q.select(); } catch (e) {} }, 30);
  },

  async applyEdit(recId) {
    const q = document.getElementById('editQty');
    const n = document.getElementById('editNote');
    if (!q) return;
    const newQty = q.value === '' ? '' : parseFloat(q.value);
    if (isNaN(newQty)) { if (typeof showToast === 'function') showToast('盘点数量必须为数字'); return; }
    let rows = [];
    try { rows = await DataStore.getStocktakeRecords(); } catch (e) { rows = []; }
    const orig = (rows || []).find(x => x.recId === recId);
    if (!orig) { if (typeof showToast === 'function') showToast('未找到原记录'); return; }
    const note = n ? n.value.trim() : '';
    const stock = parseFloat(orig.现存量) || 0;
    const diff = (newQty === '' ? 0 : newQty) - stock;
    const newRecId = (typeof StocktakeModule !== 'undefined' && StocktakeModule._uuid)
      ? StocktakeModule._uuid()
      : ('rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    // 1) 软作废原记录（保留可追溯）
    await DataStore.updateStocktakeRecord(orig.id, { voided: 1 });
    // 2) 新增修正记录（新 recId，标注来源，继承其余字段）
    const rec = Object.assign({}, orig, {
      recId: newRecId, 盘点数量: newQty === '' ? 0 : newQty, 差异量: diff,
      备注: (orig.备注 ? orig.备注 + '；' : '') + '修正自 ' + recId + (note ? ('：' + note) : ''),
      countedAt: new Date().toISOString(), voided: 0, closedByFinish: 0
    });
    delete rec.id;
    try {
      await DataStore.addStocktakeRecords([rec]);
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.syncStocktake === 'function') {
        // v217：原记录(作废态)与新记录一起推，避免他人设备仍把原记录计入统计
        try { await SyncManager.syncStocktake([Object.assign({}, orig, { voided: 1 }), rec]); } catch (e) { console.warn('[edit] 同步失败(忽略):', e); }
      }
      const overlay = document.getElementById('modalOverlay'); if (overlay) overlay.classList.remove('show');
      if (typeof showToast === 'function') showToast('已修正并保留原记录');
      this.loadData();
    } catch (e) {
      console.error('[stocktake-records] 修正失败:', e);
      if (typeof showToast === 'function') showToast('修正失败：' + (e.message || e));
    }
  },

  onLeave() { this.currentData = []; }
};
// v217：挂到 window，保持模块命名一致性（StocktakeBatchModule 同款写法）
window.StocktakeRecordModule = StocktakeRecordModule;
