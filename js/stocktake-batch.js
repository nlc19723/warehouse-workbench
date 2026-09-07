// v217 盘点批次汇总模块（第②层：汇总）
// 列表 = 已结束快照 ∪ 进行中实时计算（§2.6）；卡片组件共用；batchName 主标题 + sheetId 副标题。
window.StocktakeBatchModule = {
  filter: { type: '', keyword: '' },

  _isAdmin() {
    const u = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? AppConfig.getCurrentUser() : null;
    return !!(u && (u.role === 'admin' || u.username === '管理员'));
  },

  // 进入模块：先写模板（含 #stBatchArea），再 loadData 填充
  async render(token) {
    if (token !== undefined) this._rt = token;
    const content = document.getElementById('contentArea');
    if (!content) return;
    content.innerHTML = `
      <div class="filter-bar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
        <strong style="font-size:16px;">📦 盘点批次汇总</strong>
        <label style="font-size:13px;">类型
<select id="stbType" onchange="StocktakeBatchModule.filter.type=this.value;StocktakeBatchModule.loadData();" style="height:32px;border:1px solid var(--border-color);border-radius:8px;padding:0 6px;">
          <option value="">全部</option><option value="quarter">季度</option>
        </select>
        </label>
        <input id="stbKw" type="text" placeholder="搜索批次名 / 编码" oninput="StocktakeBatchModule.filter.keyword=this.value;StocktakeBatchModule.loadData();" style="height:32px;border:1px solid var(--border-color);border-radius:8px;padding:0 8px;font-size:13px;">
        <span id="stbCount" style="margin-left:auto;font-size:13px;opacity:.8;"></span>
      </div>
      <div id="stBatchArea"></div>
    `;
    await this.loadData(token);
  },

  async loadData(token) {
    if (token !== undefined && token !== App._goToken) return;
    const area = document.getElementById('stBatchArea');
    if (!area) return;

    await this._syncFromCloud();                                       // v217：先合并云端批次
    const batches = DataStore.getStocktakeBatches() || {};           // 已结束快照
    const allRecs = await DataStore.getStocktakeRecords();
    const sheetIds = [...new Set((allRecs || []).map(r => r.sheetId).filter(Boolean))];
    const liveIds = sheetIds.filter(id => !batches[id]);            // 进行中批次（无快照）
    const liveBatches = [];
    for (const id of liveIds) {
      const b = await this._computeLiveBatch(id);
      if (b) liveBatches.push(b);
    }
    const snapList = Object.keys(batches).map(k => batches[k]).filter(b => !b.voided);
    let all = snapList.concat(liveBatches);

    // 🟢 v226：日常盘点结果和过程不出现在盘点批次模块中 —— 任何筛选下都不展示日常。
    all = all.filter(b => b.sheetType !== 'daily');

    // 筛选
    if (this.filter.type) all = all.filter(b => b.sheetType === this.filter.type);
    const kw = (this.filter.keyword || '').trim().toLowerCase();
    if (kw) all = all.filter(b =>
      (b.batchName || '').toLowerCase().includes(kw) ||
      (b.sheetId || '').toLowerCase().includes(kw) ||
      (b.uncountedCodes || []).some(u => String(u.code || '').toLowerCase().includes(kw)));

    const cnt = document.getElementById('stbCount');
    if (cnt) cnt.textContent = '共 ' + all.length + ' 批次' + (liveBatches.length ? '（进行中 ' + liveBatches.length + '）' : '');

    if (!all.length) {
      area.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-text">暂无盘点批次</div><div class="empty-sub" style="margin-top:6px;font-size:13px;opacity:.75;">完成一次「盘点结束」后会自动生成批次汇总；进行中的批次也会实时出现在这里</div></div>';
      return;
    }
    // 排序：已结束按 savedAt 倒序；进行中置顶（实时性优先）
    all.sort((a, b) => {
      if (!!a.live !== !!b.live) return a.live ? -1 : 1;
      return String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
    });
    area.innerHTML = all.map(b => this._card(b)).join('');
  },

  _card(b) {
    const pct = (x) => Math.round((x || 0) * 100) + '%';
    const profit = (b.profit || 0), loss = (b.loss || 0);
    const pl = (profit ? ('盘盈 ' + profit.toFixed(2)) : '') + (profit && loss ? '  ' : '') + (loss ? ('盘亏 ' + loss.toFixed(2)) : '') || '无差异';
    const byCounter = Object.keys(b.byCounter || {}).map(c => {
      const v = b.byCounter[c];
      // 🟢 v224：不再直接读任务 status —— 已结束的批次里，任务没关的人会误显示"进行中"。
      //    改按「实盘 vs 指派」的实际完成度表述，管理员一眼看出谁还差多少。
      let st = '';
      if (v.assigned) {
        const done = v.done || 0;
        st = done >= v.assigned ? ' · 已结束' : (' · 未完成（差 ' + (v.assigned - done) + '）');
      } else {
        st = b.live ? ' · 进行中' : '';   // 无指派（日常自主盘点）不臆断"已结束"
      }
      return '<div style="font-size:12px;">' + esc(c) + '：实盘 ' + (v.done || 0) + (v.assigned ? (' / 指派 ' + v.assigned) : '') + st + '</div>';
    }).join('');
    const unc = (b.uncountedCodes || []).slice(0, 8).map(u => {
      // 🟢 v224：季度为分派制（不可手动认领），文案由"已认领·进行中"改为"已分派·未盘"
      const tag = u.reason === 'assigned' ? ('已分派·未盘 ' + esc(u.assignee || '')) : (u.reason === 'unassigned' ? '无人认领' : '归属未知');
      return `<div style="font-size:12px;color:#dc2626;">${esc(u.code)}（${tag}）</div>`;
    }).join('');
    // 🟢 v224：语义已从「结束时未盘按 0 补」变为「已盘为 0」，文案同步
    const zero = (b.zeroFilledCodes || []).slice(0, 4).map(z => `<div style="font-size:12px;color:#d97706;">${esc(z.code)}（${esc(z.assignee || '')} 已盘，数量为 0）</div>`).join('');
    return `
      <div class="st-batch-card" style="border:1px solid var(--border-color);border-radius:10px;padding:12px;margin-bottom:12px;background:var(--bg-primary,#fff);">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">
          <div>
            <b style="font-size:15px;">${esc(b.batchName || b.sheetId)}</b>
            ${b.live ? '<span style="font-size:11px;color:#16a34a;margin-left:6px;">● 进行中（实时）</span>' : '<span style="font-size:11px;color:#64748b;margin-left:6px;">已结束</span>'}
            <div style="font-size:11px;color:var(--text-secondary);">${esc(b.sheetId)}</div>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);text-align:right;">${b.sheetType === 'quarter' ? '季度' : '日常'} · ${esc(b.startDate || '')}~${esc(b.endDate || '')}</div>
        </div>
        <div style="display:flex;gap:14px;margin:10px 0;font-size:13px;flex-wrap:wrap;">
          <span>应盘 <b>${b.total}</b></span>
          <span>实盘 <b>${b.counted}</b></span>
          <span>已盘为0 <b style="color:#d97706;">${b.zeroFilled || 0}</b></span>
          <span>未盘 <b style="color:#dc2626;">${b.uncounted}</b></span>
        </div>
        <div style="font-size:12px;margin-bottom:6px;">实盘覆盖率 <b>${pct(b.realCoverage)}</b> · 账面覆盖率 <b>${pct(b.bookCoverage)}</b></div>
        <div style="font-size:12px;margin-bottom:6px;color:${profit ? '#16a34a' : (loss ? '#dc2626' : '#64748b')};">${pl}</div>
        ${byCounter ? '<div style="margin:6px 0;padding:6px 8px;background:var(--bg-secondary,#f8fafc);border-radius:6px;">' + byCounter + '</div>' : ''}
        ${unc ? '<div style="margin:6px 0;font-size:12px;color:#dc2626;">未盘清单：' + unc + (b.uncountedCodes.length > 8 ? '<div>…共 ' + b.uncountedCodes.length + ' 条</div>' : '') + '</div>' : ''}
        ${zero ? '<div style="margin:6px 0;font-size:12px;color:#d97706;">已盘为 0：' + zero + '</div>' : ''}
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn--ghost" onclick="StocktakeBatchModule.viewDetail('${escAttr(b.sheetId)}')">查看明细</button>
          <button class="btn--ghost" onclick="StocktakeBatchModule.exportBatch('${escAttr(b.sheetId)}')">导出</button>
          ${this._isAdmin() ? `
            <button class="btn--ghost" onclick="StocktakeBatchModule.regenerate('${escAttr(b.sheetId)}')">${b.live ? '结束生成' : '重新生成'}</button>
            <button class="btn--ghost" onclick="StocktakeBatchModule.voidBatch('${escAttr(b.sheetId)}')">${b.live ? '🗑️ 作废' : '作废'}</button>` : ''}
        </div>
      </div>`;
  },

  // v217：把其他设备生成的批次汇总拉下来并合入本地（按 sheetId 去重，generatedAt/savedAt 新者胜）
  async _syncFromCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return 0;
    if (typeof SyncManager.pullStocktakeBatches !== 'function') return 0;
    let remote = [];
    try { remote = await SyncManager.pullStocktakeBatches(); } catch (e) { return 0; }
    if (!remote || !remote.length) return 0;
    const local = DataStore.getStocktakeBatches() || {};
    let changed = 0;
    remote.forEach(b => {
      if (!b || !b.sheetId) return;
      const old = local[b.sheetId];
      const t = (x) => { const d = Date.parse(x && (x.generatedAt || x.savedAt)); return isNaN(d) ? 0 : d; };
      if (!old || t(b) > t(old)) { DataStore.addStocktakeBatch(b); changed++; }
    });
    return changed;
  },

  // 进行中批次实时聚合（与 _generateBatchSummary 对等；不落库）
  async _computeLiveBatch(sheetId) {
    const parsed = this._parseSheetId(sheetId);
    if (!parsed) return null;
    const { sheetType, startDate, endDate } = parsed;
    const stock = await DataStore.getRows('stock');
    const codes = (stock || []).map(s => String(s.存货编码 == null ? '' : s.存货编码).trim()).filter(Boolean);
    let totalCodes;
    if (sheetType === 'quarter') {
      totalCodes = new Set(codes);
    } else {
      const out = await DataStore.getOutbound({ startDate, endDate }, 1, 1000000);
      const outMap = {};
      (out && out.items ? out.items : (out || [])).forEach(it => {
        const c = String(it.存货编码 == null ? '' : it.存货编码).trim();
        if (!c) return;
        const n = parseFloat(it['出库数量']); outMap[c] = (outMap[c] || 0) + (isNaN(n) ? 0 : n);
      });
      totalCodes = new Set(codes.filter(c => outMap[c] > 0));
    }
    const recs = await DataStore.getStocktakeRecordsBySheet(sheetId);
    const valid = window.dedupStocktakeRecords((recs || []).filter(r => !r.voided));   // v217 存量去重
    // 🟢 v224：v223 起未盘不再按 0 写入；已盘为 0 与正常记录一起计入已盘
    // 🟢 v226：排除「未盘点」占位记录（盘点数量=null，UI 显示「/」）—— 它不是已盘
    const countedRecs = valid.filter(r => !(r.unfilled === 1 || r.盘点数量 == null || r.盘点数量 === ''));
    const realRecs = countedRecs;
    const countedSet = new Set(countedRecs.map(r => r.存货编码));
    const realSet = countedSet;
    let profit = 0, loss = 0;
    countedRecs.forEach(r => { const d = Number(r.差异量) || 0; if (d > 0) profit += d; else if (d < 0) loss += Math.abs(d); });
    const byCounter = {};
    realRecs.forEach(r => { const c = r.盘点人 || '未知'; byCounter[c] = byCounter[c] || { done: 0 }; byCounter[c].done++; });
    const tasks = DataStore.getTasksBySheet(sheetId);
    (tasks || []).forEach(t => { if (!byCounter[t.counter]) byCounter[t.counter] = { done: 0 }; byCounter[t.counter].assigned = t.codes ? t.codes.length : (t.noEnd - t.noStart + 1); byCounter[t.counter].status = t.status; });
    const uncounted = [...totalCodes].filter(c => !countedSet.has(c));
    const openTasks = (tasks || []).filter(t => t.status === 'open');
    const uncountedCodes = uncounted.map(code => {
      const t = openTasks.find(t => t.codes && t.codes.includes(code));
      if (t) return { code, reason: 'assigned', assignee: t.counter };
      return { code, reason: openTasks.length ? 'unassigned' : 'unknown', assignee: null };
    });
    const zeroFilledList = countedRecs.filter(r => r.closedByFinish).map(r => ({ code: r.存货编码, assignee: r.盘点人 || null }));
    return {
      sheetId, live: true,
      batchName: this._liveBatchName(parsed, tasks, valid),
      sheetType, startDate, endDate,
      total: totalCodes.size, counted: realSet.size, zeroFilled: zeroFilledList.length, uncounted: uncounted.length,
      realCoverage: totalCodes.size ? realSet.size / totalCodes.size : 0,
      bookCoverage: totalCodes.size ? countedSet.size / totalCodes.size : 0,
      profit: round2(profit), loss: round2(loss),
      byCounter, uncountedCodes, zeroFilledCodes: zeroFilledList,
      savedAt: new Date().toISOString(), generatedBy: '实时', deviceId: '', voided: 0
    };
  },

  // sheetId 形如 quarter_08-02_08-31（MM-DD，无年份，见审查 #14）
  // 兼容 v217 之前的存量格式 quarter_2026-08-02_08-31（带年份）
  _parseSheetId(sheetId) {
    const s = String(sheetId || '');
    let m = /^(daily|quarter)_(\d{2}-\d{2})_(\d{2}-\d{2})$/.exec(s);
    if (m) {
      const y = new Date().getFullYear();
      return { sheetType: m[1], startDate: y + '-' + m[2], endDate: y + '-' + m[3] };
    }
    m = /^(daily|quarter)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(s);
    if (m) return { sheetType: m[1], startDate: m[2], endDate: m[3] };
    return null;
  },

  _liveBatchName(parsed, tasks, recs) {
    const typeCn = parsed.sheetType === 'quarter' ? '季度盘点' : '日常盘点';
    let d = this._today();
    if (parsed.sheetType === 'quarter' && tasks && tasks.length) {
      const t = tasks.find(t => t.createdAt);
      if (t) d = String(t.createdAt).slice(0, 10);
    } else if (parsed.sheetType === 'daily' && recs && recs.length) {
      // 🟢 v224：日常盘点取记录中最早的「盘点日期」（真实盘点动作那天）
      const dates = recs.map(r => r.盘点日期 && String(r.盘点日期).slice(0, 10))
        .filter(s => s && /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
      if (dates[0]) d = dates[0];
    }
    return d + ' ' + typeCn;
  },

  _today() {
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  // 点批次 → 跳盘点记录列表，按 sheetId 过滤（用 localStorage 传参，避免 hash 路由冲突 §3.2）
  viewDetail(sheetId) {
    try { localStorage.setItem('wb_strec_filter_sheet', sheetId); } catch (e) {}
    if (typeof App !== 'undefined' && App.go) App.go('stocktakeRecord');
  },

  async regenerate(sheetId) {
    if (!this._isAdmin()) { WBModal.alert('仅管理员可重新生成'); return; }
    const b = await this._computeLiveBatch(sheetId);
    if (!b) { WBModal.alert('无法重新计算（批次不存在或无记录）'); return; }
    b.savedAt = new Date().toISOString();
    b.generatedBy = (AppConfig.getCurrentUser() || {}).username || '管理员';
    b.deviceId = (typeof StocktakeModule !== 'undefined' && StocktakeModule._deviceId) ? StocktakeModule._deviceId() : '';
    b.voided = 0; b.live = false;
    await DataStore.addStocktakeBatch(b);
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && SyncManager.pushStocktakeBatch) {
      try { await SyncManager.pushStocktakeBatch(b); } catch (e) {}
    }
    WBModal.alert('已重新生成本批次汇总');
    this.loadData();
  },

  async voidBatch(sheetId) {
    if (!this._isAdmin()) { WBModal.alert('仅管理员可作废'); return; }
    const snap = DataStore.getStocktakeBatch(sheetId);
    // v221：live 批次（无快照）的作废 = 丢弃该批次：删该 sheetId 下所有人的记录 + 删相关分派任务 + 删草稿
    // 已结束快照的作废 = 保留痕迹（voided=1），不删任何记录
    if (!snap) {
      const parsed = this._parseSheetId(sheetId);
      const ok = await WBModal.confirm('确认丢弃该进行中批次「' + sheetId + '」？\n将删除该批次所有盘点记录 + 相关分派任务（不可恢复）。\n如要保留结果，请用「🏁 盘点结束」生成快照。', { title: '丢弃批次' });
      if (!ok) return;
      try {
        // 1) 该批次的所有记录（含补 0）
        const allRecs = await DataStore.getStocktakeRecordsBySheet(sheetId);
        const ids = (allRecs || []).map(r => r.id).filter(x => x != null);
        if (ids.length) await DataStore.write('stocktake_records', () => db.stocktake_records.bulkDelete(ids));
        // 2) 关联的分派任务：open 任务的 sheetId 通常是 null，所以按 sheetType+startDate+endDate 匹配
        const allTasks = DataStore.getStocktakeTasks() || {};
        const toDelTasks = Object.keys(allTasks).filter(tid => {
          const t = allTasks[tid]; if (!t) return false;
          if (t.sheetId === sheetId) return true;        // 已有 sheetId 的（已结束）
          if (t.status === 'closed' && t.sheetId === sheetId) return true;
          // open 任务的 sheetId 是 null，按 sheetType + 开始/结束日期匹配
          if (!t.sheetId && t.startDate === parsed.startDate && t.endDate === parsed.endDate && t.sheetType === parsed.sheetType) return true;
          return false;
        });
        toDelTasks.forEach(tid => DataStore.deleteStocktakeTask(tid, { skipPush: true }));
        // 3) 草稿（StocktakeModule 的 draft 落 key 一般不固定，按 sheetId 兜底）
        try {
          const draft = localStorage.getItem('wb_stocktake_draft');
          if (draft && draft.includes(sheetId)) localStorage.removeItem('wb_stocktake_draft');
        } catch (e) {}
        // 4) 批量删除只推一次云端（含墓碑，其他设备上的僵尸任务同步消失）
        if (toDelTasks.length) await DataStore._pushStocktakeTasksToCloud();
        // 5) 如果本地盘点正好是这个批次，重置现场避免脏状态
        if (typeof StocktakeModule !== 'undefined' && StocktakeModule.sheet && StocktakeModule.sheet.sheetId === sheetId) {
          StocktakeModule._resetStocktakingSession();
        }
        if (typeof showToast === 'function') showToast('已丢弃该批次（删除 ' + ids.length + ' 条记录、' + toDelTasks.length + ' 个任务）');
      } catch (e) {
        console.error('[batch] 丢弃 live 批次失败:', e);
        WBModal.alert('丢弃失败：' + (e.message || e));
        return;
      }
      this.loadData();
      return;
    }
    // 已结束快照：保留痕迹
    const ok = await WBModal.confirm('确认作废该已结束批次？\n保留痕迹，记录不会被删除，汇总标记为「已作废」。', { title: '作废批次' });
    if (!ok) return;
    snap.voided = 1;
    await DataStore.addStocktakeBatch(snap);
    if (typeof showToast === 'function') showToast('已作废（保留痕迹，不删除）');
    this.loadData();
  },

  // 导出该批次明细（12 列 + sheetId），生成 CSV 下载
  async exportBatch(sheetId) {
    const rows = (await DataStore.getStocktakeRecordsBySheet(sheetId) || []).filter(r => !r.voided);
    if (!rows.length) { WBModal.alert('该批次无明细记录'); return; }
    const cols = ['存货编码', '存货名称', '规格型号', '现存量', '盘点数量', '差异量', '盘点日期', '盘点人', '盘点类别', '开始日期', '结束日期', '备注'];
    const escCsv = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = cols.join(',') + ',sheetId';
    const body = rows.map(r => cols.map(c => escCsv(r[c])).concat(escCsv(r.sheetId)).join(',')).join('\n');
    const blob = new Blob(['﻿' + head + '\n' + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = sheetId + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
