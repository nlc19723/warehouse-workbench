// ============================================
// 盘点模块 V2 - 扫码盘点（v215 · Step 2 盘点主流程）
// ============================================
// Step 2 范围：表格骨架（锁排序/全量渲染）+ 日常/季度盘点取数 + 认领序号区间 + 本地草稿。
// 【行为保持】本模块为纯新增，仅「读取」现有业务表（stock/inbound/outbound），不做任何写入或修改。
// 保存/记录/云端同步在 Step 3-4 实现，此处按钮为占位（友好提示，刻意不产生半成品逻辑）。
//
// 关键设计：
//   1. 序号 = 按「存货编码」升序后的行号；盘点态禁用列排序、不分页 → 序号稳定，多人认领区间才可靠。
//   2. 排序用简单字符串比较（非 localeCompare），保证跨设备/浏览器结果完全一致。
//   3. 日常盘点：出库是【筛选条件】，入库量是筛完之后的【补充信息列】（入库不作为保留条件）。

const StocktakeModule = {
  DRAFT_KEY: 'wb_stocktake_draft',
  PENDING_KEY: 'wb_stocktake_pending',   // 待补推云端的 recId 列表（离线容错）
  // 🟢 v227：删除墓碑队列 —— 离线删除时先落本地，联网后补推，
  //   否则上线 pull 会把已删记录从云端拉回来（删除失效）。
  TOMB_KEY: 'wb_stocktake_tombstones',
  // 🟢 v227：已弹窗提示过的分派任务（避免每次进模块都弹同一个提示）
  TASK_SEEN_KEY: 'wb_stocktake_task_seen',
  // 🟢 v226：「盘点会话」标记 —— 开局写入，只有点【盘点结束】或【放弃本次盘点】才清除。
  //   点【保存】= 暂停，不清除 → 下次进入据此弹窗提醒「必须点盘点结束才算完成」。
  OPEN_KEY: 'wb_stocktake_open_session',
  // 🟢 v227.5：本次盘点概览 —— 每人每次季度盘点一条。结构 { counter, batchNo, sheetId, sd, ed,
  //   totalCount, realCount, zeroCount, unfilledCount, completionRate, status, finishedAt, noStart, noEnd, updatedAt }
  OVERVIEW_KEY: 'wb_stocktake_overview',
  // 🟢 v227.5：本批次（季度盘点 round）结束标记 —— 一旦置为 'closed'，概览视图隐藏。
  //   key = batchNo；value = { closedBy, closedAt }
  ROUND_CLOSED_KEY: 'wb_stocktake_round_closed',
  // 🟢 v227.12：季度盘点「轮次」计数器 —— 同一批次可开多轮（首轮盘点后管理员开下一轮复核）。
  //   key = sheetId；value = 当前轮次号（默认 1）。结束本轮只关当前轮闸门，开下一轮 +1 并解闸。
  ROUND_NO_KEY: 'wb_stocktake_round_no',

  sheet: null,      // { sheetId, batchNo, sheetType:'daily'|'quarter', startDate, endDate }
  allRows: [],      // 本次应盘全集（按存货编码升序，序号稳定）
  query: { startDate: '', endDate: '' },
  task: { counter: '', noStart: null, noEnd: null, started: false },
  showInOut: false, // 是否露出「入库量/出库量」列
  // 🟢 v227.5：跟踪本 sheet 的入口类型（'daily' | 'quarter'），决定返回按钮的目的地
  _entrySheetType: null,
  // 🟢 v227.5+：picker 视图打开时启动 8s 轮询 + BroadcastChannel「实时同步」通道；
  //   离开 picker 时清掉定时器，避免无谓拉云端。
  _overviewPollTimer: null,
  _overviewChannel: null,

  // ---------------- 渲染 ----------------
  async render(token) {
    if (token !== undefined) this._rt = token;
    const content = document.getElementById('contentArea');
    if (!content) return;

    // 进入模块时，若已联网且有待补推的记录，后台自动补推（不阻塞渲染）
    this.retryPendingSync();
    // v217：后台拉取其他设备上传的盘点记录（汇总要能看见所有人的 —— 审查 #1）
    this.pullCloudRecords();
    // v227.5：后台拉取「本次盘点概览」+ 批次结束标记（管理员视图需展示盘点人完成率 → 必须从云端拉最新）
    this._pullQuarterOverviews();
    this._pullRoundClosed();

    // 🟢 v227.5+：注册 BroadcastChannel + storage 事件「实时同步」通道
    //   即使其它标签/窗口没有打开 picker，也能立即感知到概览更新
    this._ensureOverviewChannel();

    if (!this.query.startDate || !this.query.endDate) {
      const today = new Date();
      const pad = n => String(n).padStart(2, '0');
      const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      this.query.startDate = ymd(new Date(today.getTime() - 29 * 86400000));
      this.query.endDate = ymd(today);
    }

    // 🟢 v227.3：识别「从其他模块切回盘点模块」—— 不再弹"新分配任务"/"未结束盘点"，
    //   避免反复进/出模块被连续弹窗骚扰。仅在「真首次进入盘点模块」时弹。
    // 判定：app 记录的上一次 currentModule 不是 stocktake（或从未记录），视为"首次进入"。
    const lastMod = (typeof App !== 'undefined' && App._lastStocktakeModule) || null;
    const isReturningFromOtherModule = (lastMod === 'stocktake');
    App._lastStocktakeModule = 'stocktake';

    // 🟢 v227.35：先即时渲染模块壳（任务栏 + 日常/季度/扫码按钮），不再等云同步（最多 3s）才出现界面，
    //   消除「进入盘点模块要等很久」的体感。任务栏初态不含云端分派任务，同步完成后再刷新。
    if (isReturningFromOtherModule && this.sheet && this.allRows && this.allRows.length) {
      // 返回且现场仍在内存：直接复用 _renderTable，不弹任何模态（截图 4、5 场景）
      this._sheetTouched = this._sheetTouched || { saved: true, finished: false, abandoned: false };
      content.innerHTML = this._rootHtml();
      this.renderTable();
      this._syncAssignedTasks(3000).then(() => this._refreshTaskBar()); // 后台补同步任务栏
      return;
    }
    content.innerHTML = this._rootHtml();

    // 🟢 v225.2 / v227.35：进入模块后再后台同步「他人分派给我的任务」（云端 settings 通道）。
    //   带超时、不阻塞首屏；同步完成后刷新任务栏（反映管理员分派给我的任务）。
    await this._syncAssignedTasks(3000);
    this._refreshTaskBar();
    if (!isReturningFromOtherModule) {
      // 🟢 v227：有「新」分派给自己的季度任务 → 进模块即弹窗提示（同一任务只提示一次）
      this._notifyNewTasks();
      // 🟢 v227：有未结束的盘点 → 进模块即提醒必须点【盘点结束】（v226 需求5 的承诺）。
      // 🟢 v227.93 P3-3：若本次进入是"对往期盘点继续修改"（_editHistoricalDaily 路径），跳过此提示——
      //   修改行为本身会把当前批次标为未结束（_markOpenSession），若再弹未结束提示即自我打脸。
      if (!this._isEditingHistorical) this._notifyUnfinished();
      this._isEditingHistorical = false;
    }
  },

  // 盘点模块根布局（任务栏 + filter-bar + stArea），供 render 与 v227.3 的「返回保留现场」分支复用
  _rootHtml() {
    return `${this._unfinishedBannerHtml()}
      <div class="filter-bar">
        <button class="btn--primary" onclick="StocktakeModule.startDaily()">📋 日常盘点</button>
        <button class="btn--primary" onclick="StocktakeModule.startQuarter()">🗓️ 季度盘点</button>
        <button class="btn--ghost" onclick="StocktakeModule.openScan()">📷 扫码</button>
        <span id="stProgress" style="margin-left:auto;font-size:13px;opacity:.8;"></span>
      </div>
      <div id="stArea"></div>`;
  },

  /**
   * 🟢 v227.4：盘点工作台「常驻未结束盘点」状态条（非弹窗）。
   * 兜底 v227.3「模块切换不弹窗」弱化的提醒 —— 用户保存后忘了点【盘点结束】时，
   * 每次回到盘点模块根界面都能看到这条常驻提示，点【继续盘点】直接回现场、点【放弃本次】清除会话。
   * 仅在 localStorage 存在未结束会话（wb_stocktake_open_session，开局写入、结束/放弃才清除）时显示。
   */
  _unfinishedBannerHtml() {
    try {
      const s = this._getOpenSession();
      if (!s || !s.sheetType) return '';
      const typeCn = s.sheetType === 'daily' ? '日常' : '季度';
      const no = s.batchNo || s.sheetId || '';
      return `<div class="st-unfinished-banner" role="alert">
        <span class="st-ub-icon">⏸️</span>
        <span class="st-ub-text">你有 1 次<b>未结束</b>的${typeCn}盘点（盘点号 <b>${esc(no)}</b>）。<b>未点【盘点结束】不算完成</b>，不会写入盘点记录、也不会同步云端。</span>
        <span class="st-ub-actions">
          <button class="btn--primary" onclick="StocktakeModule.resumeOpenSession()">▶ 继续盘点</button>
          <button class="danger-3d" onclick="StocktakeModule.dismissOpenSession()">放弃本次</button>
        </span>
      </div>`;
    } catch (e) { return ''; }
  },

  /** 🟢 v227.4：从工作台状态条「继续盘点」—— 恢复原日期区间后走日常/季度入口，由 _detectUnfinished 命中并续盘 */
  async resumeOpenSession() {
    const s = this._getOpenSession();
    if (!s) { this.toast('没有未结束的盘点'); return; }
    // 恢复会话记录的日期区间（v227.4 起 _markOpenSession 会存），让续盘检测能精确命中
    if (s.startDate && s.endDate) { this.query.startDate = s.startDate; this.query.endDate = s.endDate; }
    if (s.sheetType === 'quarter') await this.startQuarter();
    else await this.startDaily();
  },

  /** 🟢 v227.4：从工作台状态条「放弃本次」—— 清会话标记 + 清草稿（已落库记录保留），刷新工作台使状态条消失 */
  dismissOpenSession() {
    this.clearDraft();
    this._clearOpenSession();
    this.toast('已放弃未结束的盘点（本地草稿已清除；已落库记录保留）');
    if (typeof App !== 'undefined' && App.go) App.go('stocktake');
  },

  // 🟢 v227.4：进入日常/季度子流程时，移除工作台根的状态条（它在 #stArea 之外，子流程只重渲染 #stArea 不会自动清掉）
  _hideUnfinishedBanner() {
    try { document.querySelectorAll('.st-unfinished-banner').forEach(el => el.remove()); } catch (e) { /* 忽略 */ }
  },

  async loadData(token) {
    if (token !== undefined && token !== App._goToken) return;
    const area = document.getElementById('stArea');
    if (!area) return;
    // 已有盘点数据则渲染表格（切换模块回来时保留现场），否则空态
    if (this.allRows && this.allRows.length) this.renderTable();
    else area.innerHTML = this.renderEmptyState();
  },

  setRange(key, val) { this.query[key] = val || ''; },

  toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else if (typeof WBModal !== 'undefined' && WBModal.alert) WBModal.alert(msg);
  },

  // ---------------- 日常盘点 ----------------
  // 逻辑：出库筛选 → 保留出过库的物料 → 对保留行补「入库量」列 → 渲染
  // 🟢 v224：日常盘点 = 自主盘点模式（不分配，点日常就开盘；登录账号为作业身份；
  //   重新进入若上次未结束 → 提示并跳回上次记录）
  // 🟢 v227 新流程：点【日常盘点】→ 日期/盘点号选择界面 → 点【开始盘点】→ 才真正开局填表。
  //   日期区间不再出现在盘点模块初始界面。
  async startDaily() {
    this._hideUnfinishedBanner();
    this._ensureDefaultRange();
    // 已有未结束的日常盘点现场（如点错按钮/切模块回来）→ 直接回现场，避免误点丢进度
    if (this.sheet && this.sheet.sheetType === 'daily' && this.allRows && this.allRows.length) {
      this.renderTable();
      this.toast('已回到正在进行的日常盘点（盘点号 ' + (this.sheet.batchNo || '') + '）');
      return;
    }
    await this._renderDailySetup();
  },

  /** 日期区间兜底：近 30 天（v227：初始界面无日期控件，此处统一给默认值） */
  _ensureDefaultRange() {
    if (this.query.startDate && this.query.endDate) return;
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (!this.query.startDate) this.query.startDate = ymd(new Date(today.getTime() - 29 * 86400000));
    if (!this.query.endDate) this.query.endDate = ymd(today);
  },

  /**
   * 🟢 v227.8：跨天续盘锚定 —— 修「昨天保存、今天进去全部重新盘点」。
   *   季度批次标识 sheetId 由查询区间算出（quarter_MM-DD_MM-DD），而默认区间是
   *   「今天−29天 ~ 今天」，每过一天整体平移一格。后果：昨天保存但没点【盘点结束】的
   *   现场，今天进来 sheetId 就变了 → 续盘检测（_detectUnfinished）查不到会话、
   *   草稿（按 sheetId 匹配）也对不上 → 表面上任务还在，一进去却是空表，
   *   等于让用户从头重盘一遍。
   *   只要存在未结束的季度会话（未点【盘点结束】/【放弃本次】），就把区间锚回它，
   *   保证 sheetId 跨天稳定；会话被结束或放弃后自动回到今天的默认区间。
   *   ⚠️ 超过 90 天的陈旧会话不锚定 —— 否则用户忘了处理就被永久锁死在老批次里。
   */
  _anchorRangeToOpenSession() {
    try {
      const s = this._getOpenSession();
      if (!s || s.sheetType !== 'quarter' || !s.startDate || !s.endDate) return;
      if (s.startedAt) {
        const age = Date.now() - new Date(s.startedAt).getTime();
        if (isFinite(age) && age > 90 * 86400000) return;
      }
      this.query.startDate = s.startDate;
      this.query.endDate = s.endDate;
    } catch (e) { /* 忽略 */ }
  },

  /** 本地日期 YYYY-MM-DD（❗不能用 toISOString().slice(0,10) —— 那是 UTC，GMT+8 凌晨会偏一整天） */
  _ymdLocal(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  /**
   * 🟢 v227.7/227.8：判断一个季度任务是否属于「当前批次」。
   *   曾经硬卡「任务 startDate/endDate 与当前查询区间完全相等」，一旦区间变了任务就全被
   *   过滤掉 → 管理员视图空、任务选择器空（线上挂的根因）。现在四级判定：
   *     ① 区间完全相等 → 命中（精确）
   *     ② 任务没有 startDate（旧版本写入 / 云端拉回未带）→ 命中
   *     ③ createdAt 当天落在当前 sd~ed 内 → 命中
   *     ④ createdAt 距今 30 天内 → 命中（区间锚定到未结束会话后会整体前移，
   *        今天新分派的任务会落在区间外，这层兜底避免任务凭空消失）
   */
  _taskInCurrentBatch(t, sd, ed) {
    if (!t || t.sheetType !== 'quarter') return false;
    if (t.startDate == null || t.startDate === '') return true;
    if (t.startDate === sd && t.endDate === ed) return true;
    try {
      const c = t.createdAt ? new Date(t.createdAt) : null;
      if (c && !isNaN(c.getTime())) {
        const cs = this._ymdLocal(c);
        if (cs >= sd && cs <= ed) return true;
        const age = Date.now() - c.getTime();
        if (isFinite(age) && age >= -86400000 && age <= 30 * 86400000) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  },

  /**
   * 🟢 v227：日常盘点「日期/盘点号选择界面」（仿出库单表头信息区格式）。
   *   两个日期框 + 盘点号（默认最新可用号，可下拉切换查看历史日常盘点）+【开始盘点】
   */
  async _renderDailySetup() {
    const area = document.getElementById('stArea');
    if (!area) return;
    this._ensureDefaultRange();

    // 🟢 v227：必须先读再生成——_genBatchNo 有副作用（会把当前号写入 no_map finished:false），
    //    若先生成再读，刚写的号会被当成「已存在（进行中）」，下拉就跳过「新建」选项了。
    const sd = this.query.startDate, ed = this.query.endDate;
    const curSheetId = 'daily_' + sd.slice(5) + '_' + ed.slice(5);
    let list = await this._dailyBatchOptions();
    // 🟢 v227.22：渲染阶段不落库——仅「看一眼」日常盘点界面不该生成盘点号（否则每打开一次写一个孤儿号）。
    //    真正把号写进 no_map 是在 beginDaily（用户点【开始盘点】）。curNo 仅用于界面展示「新建·未开始」。
    const curNo = this._genBatchNo('daily', curSheetId, false);
    // 🟢 该区间的「最新可用号」必须作为可选项且默认选中，
    //    否则下拉会回落到第一条（可能是已结束的历史号）→ 点开始盘点误进只读查看。
    if (!list.some(o => o.no === curNo)) {
      list.unshift({ no: curNo, sheetId: curSheetId, startDate: sd, endDate: ed, count: 0, finished: false, isNew: true });
    }

    // 🟢 v227.3：缓存盘点号列表 + 选中索引到 this，用于左右三角切换
    this._dailyList = list;
    this._dailyListIdx = Math.max(0, list.findIndex(o => o.no === curNo));

    // 未结束提示（有暂停/草稿的日常盘点）
    const openTip = await this._openSessionTip('daily');

    const curInfo = list[this._dailyListIdx] || { no: curNo, count: 0, isNew: true, finished: false };
    const pickedNo = curInfo.no;
    const isHistorical = (curInfo.count || 0) > 0;   // 已盘过 = 历史/进行中
    const isFinished = !!curInfo.finished;
    // 🟢 v227.24：翻号键到底即禁用 —— "翻到底就不要轮回了"
    const iAtFirst = this._dailyListIdx <= 0;
    const iAtLast = this._dailyListIdx >= list.length - 1;
    // 切到往期号（已盘过）→ 隐藏「开始盘点」按钮，显示「修改/保存」
    const startBtn = isHistorical
      ? ''
      : `<button class="btn--primary" onclick="StocktakeModule.beginDaily()" style="height:36px;padding:0 22px;font-size:14px;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">▶ 开始盘点</button>`;
    const histBtn = isHistorical
      ? `<button class="btn--primary" onclick="StocktakeModule._editHistoricalDaily()" style="height:36px;padding:0 18px;font-size:14px;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">✏️ 修改</button>
         <button class="btn--primary" onclick="StocktakeModule.saveToRecords()" style="height:36px;padding:0 18px;font-size:14px;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">💾 保存</button>`
      : '';
    const labelText = isHistorical
      ? (isFinished
          ? `${pickedNo}（${(curInfo.startDate || sd) + '~' + (curInfo.endDate || ed)} · ${curInfo.count} 条 · 已结束）`
          : `${pickedNo}（${(curInfo.startDate || sd) + '~' + (curInfo.endDate || ed)} · ${curInfo.count} 条 · 进行中）`)
      : `${pickedNo}（新建 · 未开始）`;

    area.innerHTML = `
      ${openTip}
      <div class="glass-card st-card-clean" style="margin-bottom:14px;">
        <div class="glass-card-header st-card-clean-header">
          <span class="glass-card-title"><span class="title-icon">📋</span>日常盘点</span>
          <div id="stDailyBtns" class="ob-field" style="display:inline-flex;gap:8px;align-items:center;margin:0;">
            ${startBtn}
            ${histBtn}
          </div>
        </div>
        <div id="stDailySetup" style="display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:14px 22px;">
          <div class="ob-field ob-field-row" style="gap:6px;">
            <label class="ob-field-label" style="font-size:13px;font-weight:700;color:var(--text-main);white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">开始日期</label>
            <input type="text" id="stStart" class="st-setup-date" value="${escAttr(sd)}" onchange="StocktakeModule.onSetupRangeChange()">
          </div>
          <span class="st-range-dash">至</span>
          <div class="ob-field ob-field-row" style="gap:6px;">
            <label class="ob-field-label" style="font-size:13px;font-weight:700;color:var(--text-main);white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">结束日期</label>
            <input type="text" id="stEnd" class="st-setup-date" value="${escAttr(ed)}" onchange="StocktakeModule.onSetupRangeChange()">
          </div>
          <div class="st-batch-group">
            <label class="ob-field-label" style="font-size:13px;font-weight:700;color:var(--text-main);white-space:nowrap;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">盘点号</label>
            <div class="st-batch-pager">
              <button type="button" class="st-mini-btn wb-pager-btn wb-prev" onclick="StocktakeModule._shiftDailyBatch(-1)" title="上一个盘点号"
                ${iAtFirst ? 'disabled' : ''} aria-label="上一个盘点号"></button>
              <div id="stSetupNoLabel" class="st-setup-no-label">${esc(labelText)}</div>
              <button type="button" class="st-mini-btn wb-pager-btn wb-next" onclick="StocktakeModule._shiftDailyBatch(1)" title="下一个盘点号"
                ${iAtLast ? 'disabled' : ''} aria-label="下一个盘点号"></button>
            </div>
          </div>
        </div>
      </div>
      <div id="stPreviewArea"></div>`;
    // 🟢 v227.35：日常盘点日期框挂载玻璃日历（统一风格，替代浏览器原生 date 弹层）
    if (typeof DatePicker !== 'undefined') {
      DatePicker.unmountAll();
      DatePicker.mount('stStart');
      DatePicker.mount('stEnd');
    }
    // 🟢 v227.2：先并行取数（与下方预览取数共用），并立刻挂出骨架占位，避免停顿感。
    this._warmDailyPreviewCache(curSheetId).catch(() => {});
    // 🟢 v227.24：根据当前位置启用/禁用翻号键（不再依赖 inline disabled）
    this._updateDailyShiftBtnsDisabled();
    await this._refreshPreview(curNo);
  },

  /**
   * 🟢 v227.2：预取【待盘预览】所需数据（outbound/inbound/stock），缓存供 _renderPreviewNew 复用，
   *   点击【日常盘点】立刻并行启动，与界面渲染流水并行，体感「无停顿」。
   */
  async _warmDailyPreviewCache(sheetId) {
    if (this._previewCache && this._previewCache.sheetId === sheetId) return;     // 已缓存
    const sd = this.query.startDate, ed = this.query.endDate;
    if (!sd || !ed) return;
    const [outRes, inRes, stock] = await Promise.all([
      DataStore.getOutbound({ startDate: sd, endDate: ed }, 1, 'all'),
      DataStore.getInbound({ startDate: sd, endDate: ed }, 1, 'all'),
      DataStore.getRows('stock')
    ]);
    this._previewCache = { sheetId, sd, ed, outRes, inRes, stock };
  },

  /**
   * 🟢 v227.1：刷新【盘点工作台下方预览表格】。
   *   选中号=未用新号 → 按当前日期区间生成「待盘预览」（现有库存现存量 + 入/出库列 + 空格数量）
   *   选中号=已有号：
   *     - 已结束 → 读历史记录 + 区间列，只读显示
   *     - 进行中 → 读已有盘点记录 + 区间列，「已盘」填实际数量「未盘」空格 + 现存量
   */
  async _refreshPreview(pickedNo) {
    const area = document.getElementById('stPreviewArea');
    if (!area) return;
    const no = String(pickedNo || '').trim();
    const list = await this._dailyBatchOptions();
    const info = list.find(o => o.no === no) || null;

    // 没选号 / 不存在 → 空态
    if (!no || !info) {
      area.innerHTML = '<div class="empty-state" style="padding:30px;"><div class="empty-icon">📋</div><div class="empty-text">请选择盘点号</div></div>';
      return;
    }

    // 已有记录（历史的 + 进行的）→ 只读视图
    if (info.count > 0) {
      await this._renderPreviewHistory(no, info);
      return;
    }

    // 新号（未开始）→ 按当前日期区间生成「待盘预览」
    const sd = this.query.startDate, ed = this.query.endDate;
    if (!sd || !ed) {
      area.innerHTML = '<div class="empty-state" style="padding:30px;"><div class="empty-icon">📅</div><div class="empty-text">请先选择开始与结束日期</div></div>';
      return;
    }

    // 🟢 v227.2：禁重复——同一区间已盘过记录 → 禁止新开
    const curSheetId = 'daily_' + sd.slice(5) + '_' + ed.slice(5);
    const sameRangeDone = list.find(o => o.sheetId === curSheetId && o.count > 0);
    if (sameRangeDone) {
      area.innerHTML = `
        <div class="st-banner-error" style="margin-bottom:10px;padding:10px 14px;border-radius:8px;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="font-size:16px;">⛔</span>
          <span><b>禁止重复盘点</b>：本日期区间（${esc(sd)} ~ ${esc(ed)}）已存在盘点记录 <b>${esc(sameRangeDone.no)}</b>（${sameRangeDone.count} 条）。请先在【盘点记录列表】删除该盘点记录后，再开新盘点。</span>
        </div>
        <div class="empty-state" style="padding:30px;"><div class="empty-icon">📋</div><div class="empty-text">本区间无可新建的盘点任务</div></div>`;
      return;
    }

    // 🟢 v227.2：消费缓存的预取数据；缓存内未命中时再现场取
    if (!this._previewCache || this._previewCache.sheetId !== curSheetId) {
      area.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-text">正在统计待盘数据…</div></div>';
      try {
        const [outRes, inRes, stock] = await Promise.all([
          DataStore.getOutbound({ startDate: sd, endDate: ed }, 1, 'all'),
          DataStore.getInbound({ startDate: sd, endDate: ed }, 1, 'all'),
          DataStore.getRows('stock')
        ]);
        this._previewCache = { sheetId: curSheetId, sd, ed, outRes, inRes, stock };
      } catch (e) {
        area.innerHTML = '<div class="empty-state" style="padding:30px;"><div class="empty-icon">⚠️</div><div class="empty-text">取数失败：' + esc(e.message || e) + '</div></div>';
        return;
      }
    }
    await this._renderPreviewNew(sd, ed, no, this._previewCache);
  },

  /**
   * 🟢 v227.1：预览表格 —— 切到【历史/进行中】盘点号时渲染。
   *   只读视图，不可改；「盘点结束」后查看完整数据用此函数。
   */
  async _renderPreviewHistory(no, info) {
    const area = document.getElementById('stPreviewArea');
    if (!area) return;
    area.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-text">加载历史数据…</div></div>';
    let recs = [];
    try { recs = await DataStore.getStocktakeRecords(); } catch (e) { recs = []; }
    const list = (recs || [])
      .filter(r => !r.voided && String(r.batchNo || '').trim() === String(no).trim())
      .sort((a, b) => String(a.存货编码 || '').localeCompare(String(b.存货编码 || '')));

    if (!list.length) {
      area.innerHTML = `
        <div class="empty-state" style="padding:30px;">
          <div class="empty-icon">📭</div>
          <div class="empty-text">盘点号 <b>${esc(no)}</b> 没有可查看的记录</div>
        </div>`;
      return;
    }

    // 🟢 v227.28：删除「已结束盘点号 xx 历史数据（只读）」冗余 banner（用户反馈：移动端和PC端都删除）
    area.innerHTML = `
      <div style="overflow:auto;max-height:60vh;border:1px solid var(--border-color,#e5e7eb);border-radius:8px;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--bg-secondary,#f9fafb);z-index:1;">
            <tr>
              <th>序号</th><th>存货编码</th><th>存货名称</th><th>规格型号</th><th>现存量</th>
              <th>盘点数量</th><th>差异量</th><th>盘点人</th><th>盘点日期</th><th>备注</th>
            </tr>
          </thead>
          <tbody>${list.map((r, i) => this._historyRowHtml(r, i + 1)).join('')}</tbody>
        </table>
      </div>`;
  },

  /** 历史数据行的 HTML（只读） */
  _historyRowHtml(r, no) {
    const dv = (r.差异量 === '' || r.差异量 == null) ? NaN : parseFloat(r.差异量);
    const dcolor = isNaN(dv) ? '' : (dv > 0 ? 'color:#16a34a;' : (dv < 0 ? 'color:#dc2626;' : ''));
    const qtyCell = (r.盘点数量 == null || r.盘点数量 === '') ? '<span style="opacity:.4;">/</span>' : this._num(r.盘点数量);
    const diffCell = (r.差异量 == null || r.差异量 === '')
      ? '<span style="opacity:.4;">/</span>'
      : `<span style="${dcolor}font-weight:600;">${this._num(r.差异量)}</span>`;
    return `<tr data-code="${escAttr(r.存货编码 || '')}">
      <td>${no}</td>
      <td>${esc(r.存货编码 || '')}</td>
      <td>${esc(r.存货名称 || '')}</td>
      <td>${esc(r.规格型号 || '')}</td>
      <td>${this._num(r.现存量)}</td>
      <td>${qtyCell}</td>
      <td>${diffCell}</td>
      <td>${esc(r.盘点人 || '')}</td>
      <td>${esc(r.盘点日期 || '')}</td>
      <td>${esc(r.备注 || '')}</td>
    </tr>`;
  },

  /**
   * 🟢 v227.1：预览表格 —— 选中【新】盘点号时渲染。
   *   按当前日期区间 → 出库筛选 → 现存量/入库/出库 + 空格盘点数量 + 空格备注。
   *   表格与 beginDaily 后的表格同款样式，仅盘点数量不可填、保存/结束按钮隐藏。
   * 🟢 v227.2：第四参 cache 由 _refreshPreview 预注入（warm cache），同步展示表格。
   */
  async _renderPreviewNew(sd, ed, no, cache) {
    const area = document.getElementById('stPreviewArea');
    if (!area) return;
    let outRes = cache && cache.outRes, inRes = cache && cache.inRes, stock = cache && cache.stock;
    if (!outRes || !inRes || !stock) {
      area.innerHTML = '<div class="empty-state" style="padding:20px;"><div class="empty-text">正在按当前日期区间统计待盘数据…</div></div>';
      try {
        [outRes, inRes, stock] = await Promise.all([
          DataStore.getOutbound({ startDate: sd, endDate: ed }, 1, 'all'),
          DataStore.getInbound({ startDate: sd, endDate: ed }, 1, 'all'),
          DataStore.getRows('stock')
        ]);
      } catch (e) {
        area.innerHTML = '<div class="empty-state" style="padding:30px;"><div class="empty-icon">⚠️</div><div class="empty-text">取数失败：' + esc(e.message || e) + '</div></div>';
        return;
      }
    }

    const outMap = this._aggByCode(outRes.items || [], '出库数量');
    const outCodes = new Set(Object.keys(outMap));

    if (outCodes.size === 0) {
      area.innerHTML = `
        <div class="empty-state" style="padding:30px;">
          <div class="empty-icon">📭</div>
          <div class="empty-text">当前筛选区间内<b>无出库记录</b></div>
          <div class="empty-sub" style="margin-top:6px;font-size:13px;opacity:.75;">日常盘点以出库为准；如需按全库清点，请使用【季度盘点】</div>
        </div>`;
      return;
    }

    const inMap = this._aggByCode(inRes.items || [], '数量');
    const rows = this.buildRows(stock || [], outMap, inMap, outCodes);
    if (!rows.length) {
      area.innerHTML = '<div class="empty-state" style="padding:30px;"><div class="empty-icon">📭</div><div class="empty-text">未找到可盘点的存货</div></div>';
      return;
    }

    const body = rows.map(r => `
      <tr data-code="${escAttr(r.存货编码)}">
        <td>${r.no}</td>
        <td>${esc(r.存货编码)}</td>
        <td>${esc(r.存货名称)}</td>
        <td>${esc(r.规格型号)}</td>
        <td>${this._num(r.现存量)}</td>
        <td>${this._num(r.入库量)}</td>
        <td>${this._num(r.出库量)}</td>
        <td><span style="opacity:.4;">/</span></td>
        <td class="st-diff" style="opacity:.4;">/</td>
        <td><span style="opacity:.4;">（填数量后自动）</span></td>
        <td>日常盘点</td>
        <td></td>
      </tr>`).join('');

    area.innerHTML = `
      <div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:var(--status-warning-bg,#fff7ed);border:1px solid #fed7aa;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>📋 盘点号 <b>${esc(no)}</b>（<b>新建 · 未开始</b>）</span>
        <span style="opacity:.7;font-size:12px;">区间 ${esc(sd)} ~ ${esc(ed)} · 共 <b>${rows.length}</b> 行 · 出库筛选</span>
        <span style="opacity:.7;font-size:12px;margin-left:auto;">点【开始盘点】激活后即可填写盘点数量并保存/结束</span>
      </div>
      <div style="overflow:auto;max-height:60vh;border:1px solid var(--border-color,#e5e7eb);border-radius:8px;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--bg-secondary,#f9fafb);z-index:1;">
            <tr>
              <th>序号</th><th>存货编码</th><th>存货名称</th><th>规格型号</th><th>现存量</th>
              <th>入库量</th><th>出库量</th><th>盘点数量</th><th>差异量</th><th>盘点人</th><th>盘点类别</th><th>备注</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  },

  /** 改日期 → 盘点号跟着刷新为「该区间的最新可用号」，同时刷新下方预览 */
  async onSetupRangeChange() {
    const s = document.getElementById('stStart'), e = document.getElementById('stEnd');
    if (s) this.query.startDate = s.value || '';
    if (e) this.query.endDate = e.value || '';
    const sd = this.query.startDate, ed = this.query.endDate;
    if (!sd || !ed) return;
    // 🟢 v227.3：日期变化 → 整卡片重渲（盘点号列表按新区间刷新；左右三角切换组件随之更新）
    await this._renderDailySetup();
  },

  /**
   * 🟢 v227.1：切换盘点号 — 不抢用户的日期。
   *   预览表格按 batchNo 查历史数据，与当前日期无关（日期只用于【开始新号】）。
   * 🟢 v227.3：盘点号已改用左右三角切换，保留此方法以兼容潜在外部调用；实际切换走 _shiftDailyBatch。
   */
  async onSetupBatchChange() {
    const no = (this._dailyList && this._dailyList[this._dailyListIdx] || {}).no || '';
    if (!no) return;
    await this._refreshPreview(no);
  },

  /**
   * 🟢 v227.3：左右三角切换盘点号（替换原 <select>）。
   *   dir = -1 选上一个；dir = +1 选下一个；越界自动绕回。
   */
  async _shiftDailyBatch(dir) {
    const list = this._dailyList || [];
    if (!list.length) return;
    let i = (this._dailyListIdx || 0) + dir;
    // 🟢 v227.24：翻到底即停住 —— 不再轮回（"左键控制盘点号减少，右键控制盘点号增大；翻到底就不要轮回"）
    if (i < 0) i = 0;
    if (i >= list.length) i = list.length - 1;
    if (i === this._dailyListIdx) return;   // 到底/到顶：禁用按钮不响应
    this._dailyListIdx = i;
    const info = list[i];
    // 重新渲染卡片头（按钮组随 isHistorical 切换） + 刷新预览
    this._updateDailySetupHeader(info);
    this._updateDailyShiftBtnsDisabled();
    await this._refreshPreview(info.no);
  },

  /** 🟢 v227.24：根据 _dailyListIdx 更新左右翻号键的 disabled 状态 */
  _updateDailyShiftBtnsDisabled() {
    const list = this._dailyList || [];
    const i = this._dailyListIdx || 0;
    const atFirst = i <= 0;
    const atLast = i >= list.length - 1;
    const btns = document.querySelectorAll('#stDailySetup .st-mini-btn');
    btns.forEach(b => {
      const isPrev = b.getAttribute('title') === '上一个盘点号';
      if (isPrev) b.disabled = atFirst;
      else b.disabled = atLast;
    });
  },

  /**
   * 🟢 v227.3：仅刷新日常盘点头部按钮组 + 标签文本（避免整卡片重渲造成日期框失焦）
   */
  _updateDailySetupHeader(info) {
    const label = document.getElementById('stSetupNoLabel');
    if (label) {
      const isHistorical = (info.count || 0) > 0;
      const text = isHistorical
        ? `${info.no}（${(info.startDate || this.query.startDate) + '~' + (info.endDate || this.query.endDate)} · ${info.count} 条${info.finished ? ' · 已结束' : ' · 进行中'}）`
        : `${info.no}（新建 · 未开始）`;
      label.textContent = text;
    }
    // 替换按钮区
    const old = document.getElementById('stDailyBtns');
    if (old) {
      const isHistorical = (info.count || 0) > 0;
      const html = isHistorical
        ? `<button class="btn--primary" onclick="StocktakeModule._editHistoricalDaily()" style="height:34px;padding:0 16px;">✏️ 修改</button>
           <button class="btn--primary" onclick="StocktakeModule.saveToRecords()" style="height:34px;padding:0 16px;">💾 保存</button>`
        : `<button class="btn--primary" onclick="StocktakeModule.beginDaily()" style="height:34px;padding:0 18px;">▶ 开始盘点</button>`;
      old.outerHTML = `<div class="ob-field" id="stDailyBtns" style="display:inline-flex;gap:8px;align-items:end;">${html}</div>`;
    }
  },

  /**
   * 🟢 v227.3：点击【修改】—— 进入往期日常盘点号，载入历史记录并切到可编辑填表。
   *   复用 _viewClosedDaily 的取数路径，但 sheet 设为可写状态（保留已盘数据可改）。
   * 🟢 v227.93 P3-3：进入前打 _isEditingHistorical 标记，让根 render() 跳过"未结束盘点"提示（修改行为本身
   *   会写新的 OPEN_SESSION 标记，若再弹未结束提示即自我打脸）。
   */
  async _editHistoricalDaily() {
    // 🟢 v227.93 P3-3：标记本次 render 是"修改往期"路径（render 是异步的，标记提前到调用前）
    this._isEditingHistorical = true;
    const list = this._dailyList || [];
    const info = list[this._dailyListIdx || 0];
    if (!info || (info.count || 0) === 0) { this.toast('当前盘点号暂无历史记录'); return; }
    // 切回日期为该批次原区间（用户可改，但默认是该历史号的）
    if (info.startDate && info.endDate) {
      this.query.startDate = info.startDate;
      this.query.endDate = info.endDate;
    }
    const no = info.no;

    // 🟢 v227.24：往期可修改 —— 取该盘点号历史记录 → 直接转成可编辑行（保留历史盘点数量/入库量/出库量等），
    //   走与 beginDaily 同款表格；用户可改盘点数量并【保存】/【盘点结束】。
    //   旧实现调用 _viewClosedDaily 只读视图，用户无法修改。
    const area = document.getElementById('stArea');
    if (area) area.innerHTML = '<div class="empty-state"><div class="empty-text">正在加载历史盘点数据…</div></div>';

    let recs = [];
    try { recs = await DataStore.getStocktakeRecords(); } catch (e) { recs = []; }
    recs = (recs || [])
      .filter(r => !r.voided && String(r.batchNo || '').trim() === String(no).trim())
      .sort((a, b) => String(a.存货编码 || '').localeCompare(String(b.存货编码 || '')));
    if (!recs.length) {
      if (area) area.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-text">盘点号 <b>${esc(no)}</b> 没有可修改的记录</div>
          <div class="empty-sub" style="margin-top:6px;font-size:13px;opacity:.75;">
            <button class="btn--ghost" onclick="StocktakeModule.startDaily()">← 返回选择日期与盘点号</button>
          </div>
        </div>`;
      return;
    }

    // 复用 sheet 字段，类型=日常；sheetId 用首个记录的 sheetId（保证 _countedCodes 等流程拿到正确 sheetId）
    const sheetId = recs[0].sheetId || ('daily_edit_' + no);
    this.sheet = {
      sheetId,
      batchNo: no,
      sheetType: 'daily',
      startDate: info.startDate || this.query.startDate,
      endDate: info.endDate || this.query.endDate
    };
    // 🟢 v227.24：行模板 —— 把历史记录中的「盘点数量/差异量/入库量/出库量/备注」原样塞回 rows；表头现存量/入库量/出库量
    //   一律从 stock 现算保持一致，避免与最新账面值脱钩。
    let stock = [];
    try { stock = await DataStore.getRows('stock'); } catch (e) {}
    const codeMap = new Map((stock || []).map(s => [String(s.存货编码 || ''), s]));
    this.allRowsFull = recs.map(r => {
      const s = codeMap.get(String(r.存货编码 || '')) || {};
      // 历史 no 是分派/编号当时算的，可能与当前 allRows 排序漂移 → 用历史值
      const noVal = (typeof r.no === 'number') ? r.no : null;
      return {
        no: noVal,
        存货编码: r.存货编码 || '',
        存货名称: r.存货名称 || s.存货名称 || '',
        规格型号: r.规格型号 || s.规格型号 || '',
        现存量: parseFloat(r.现存量) || parseFloat(s.现存量) || 0,
        入库量: parseFloat(r.入库量) || parseFloat(s.入库量) || 0,
        出库量: parseFloat(r.出库量) || parseFloat(s.出库量) || 0,
        盘点数量: r.盘点数量,                  // null = 未盘（保留原文显示「/」）
        差异量: r.差异量,                      // null = 未盘
        备注: r.备注 || '',
        assignedTaskId: null
      };
    });
    this.allRows = this.allRowsFull.slice();
    this.showInOut = true;
    this.task.started = true;
    this.task.noStart = recs[0].noStart || null;
    this.task.noEnd = recs[0].noEnd || null;
    // 盘点人沿用历史盘点人（登录态自动覆盖为当前账号）
    const logged = (typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn && AppConfig.isLoggedIn());
    const curUser = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? AppConfig.getCurrentUser() : null;
    this.task.counter = (logged && curUser && curUser.username) || recs[0].盘点人 || this.task.counter || '';
    this._sheetTouched = null;
    this._entrySheetType = 'daily';
    // 🟢 v227.24：标记未结束会话（让用户点【盘点结束】后正常走 finishStocktake 落库 + 更新原记录）
    this._markOpenSession(sheetId, 'daily', this.task.counter,
      this.sheet.startDate, this.sheet.endDate);
    this.renderTable();
    this.toast('已进入往期盘点号 ' + no + ' 的可修改模式：修改【盘点数量】后点【保存】或【盘点结束】');
  },

  /** 历史/进行中的日常盘点号列表（含区间、条数与结束状态），最新在前 */
  async _dailyBatchOptions() {
    const map = new Map();
    // ① 本机 no_map —— 唯一能拿到「该批次是否已结束」的数据源
    let m = {};
    try { m = JSON.parse(localStorage.getItem('wb_stocktake_no_map') || '{}') || {}; } catch (e) { m = {}; }
    Object.keys(m).forEach(k => {
      const it = m[k];
      if (!it || it.type !== 'daily' || !it.no) return;
      if (!map.has(it.no)) {
        map.set(it.no, { no: it.no, sheetId: k, startDate: '', endDate: '', count: 0, finished: !!it.finished });
      }
    });
    // ② 已落库的记录 → 补区间与条数（云端同步来的历史批次也能出现）
    let recs = [];
    try { recs = await DataStore.getStocktakeRecords(); } catch (e) { recs = []; }
    (recs || []).forEach(r => {
      if (!r || r.voided) return;
      if (String(r.盘点类别 || '') !== '日常') return;
      const no = String(r.batchNo || '').trim();
      if (!no) return;
      let it = map.get(no);
      if (!it) {
        it = { no: no, sheetId: r.sheetId || '', startDate: '', endDate: '', count: 0, finished: true };
        map.set(no, it);
      }
      it.count++;
      if (!it.startDate) it.startDate = r.开始日期 || '';
      if (!it.endDate) it.endDate = r.结束日期 || '';
    });
    // 🟢 v227.23：清理「仅打开过日常盘点界面、从未点【开始盘点】」产生的孤儿号
    //    （finished:false 且 count:0 且无未结束会话）—— 它们没有任何盘点数据，纯属界面副作用生成的噪声。
    //    ① 从 no_map 物理删除：否则孤儿号会一直"占着"当天基号，逼得当天真实批次被迫加 -2 后缀
    //       （例如残留 rc20260904 → 今天真实开局变成 rc20260904-2，看着像重复盘点）；
    //    ② 从下拉列表剔除：不再显示成「新建·未开始」。
    //    真正进行中的批次（点了开始盘点 → 有 OPEN_KEY 会话）不会被误删。
    const orphans = Array.from(map.values()).filter(it =>
      !it.finished && it.count === 0 && !this._openDailySessionFor(it.sheetId, it.no)
    );
    if (orphans.length) this._deleteDailyNos(orphans.map(o => o.sheetId));
    const orphanNos = new Set(orphans.map(o => o.no));
    const arr = Array.from(map.values()).filter(it => !orphanNos.has(it.no));
    return arr.sort((a, b) => String(b.no).localeCompare(String(a.no)));
  },

  /** 从 wb_stocktake_no_map 物理删除指定 sheetId 的条目（仅在确有删除时才写回） */
  _deleteDailyNos(sheetIds) {
    try {
      const MAP_KEY = 'wb_stocktake_no_map';
      const map = JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {};
      let changed = false;
      (sheetIds || []).forEach(k => { if (k && map[k]) { delete map[k]; changed = true; } });
      if (changed) localStorage.setItem(MAP_KEY, JSON.stringify(map));
    } catch (e) { /* 忽略 */ }
  },

  /** 是否存在与某 daily 盘点号对应的「未结束会话」（用户点过【开始盘点】且未结束/放弃） */
  _openDailySessionFor(sheetId, no) {
    try {
      const s = this._getOpenSession();
      if (!s || s.sheetType !== 'daily') return false;
      return s.sheetId === sheetId || (no && s.batchNo === no);
    } catch (e) { return false; }
  },

  /** 未结束会话提示条（日常/季度） */
  async _openSessionTip(sheetType) {
    try {
      const raw = localStorage.getItem(this.OPEN_KEY);
      if (!raw) return '';
      const s = JSON.parse(raw);
      if (!s || s.sheetType !== sheetType) return '';
      return `<div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:var(--status-warning-bg,#fff7ed);
                border:1px solid #fed7aa;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>⚠️ 你有一次<b>未结束</b>的${sheetType === 'daily' ? '日常' : '季度'}盘点（盘点号 <b>${esc(s.batchNo || s.sheetId || '')}</b>）。</span>
        <span style="color:#b45309;font-size:12px;">选择对应区间与盘点号后点【开始盘点】可继续；或点【放弃本次盘点】清除。</span>
      </div>`;
    } catch (e) { return ''; }
  },

  /**
   * 🟢 v227：点【开始盘点】—— 真正的日常盘点开局（原 startDaily 的取数逻辑）。
   *   若选中的是「已结束」的历史盘点号 → 进入只读查看模式。
   */
  async beginDaily() {
    const sd = this.query.startDate, ed = this.query.endDate;
    if (!sd || !ed) { this.toast('请先选择开始与结束日期'); return; }
    const sel = document.getElementById('stSetupNo');
    const pickedNo = sel ? String(sel.value || '').trim() : '';

    // 选了历史「已结束」的盘点号 → 只读查看其数据
    if (pickedNo) {
      const info = (await this._dailyBatchOptions()).find(o => o.no === pickedNo);
      if (info && info.finished && info.count > 0) {
        await this._viewClosedDaily(pickedNo);
        return;
      }
    }

    const counter = String(((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? (AppConfig.getCurrentUser() || {}).username : '') || this.task.counter || '').trim();
    const lastSheetId = 'daily_' + sd.slice(5) + '_' + ed.slice(5);
    const skipDailyResume = !!this._skipResumePrompt; this._skipResumePrompt = false;
    const resume = skipDailyResume ? null : await this._detectUnfinished(lastSheetId, 'daily', counter);
    if (resume) {
      this._entrySheetType = 'daily';
      await this._resumeToSheet(resume);
      return;
    }

    // 🟢 v227.2：禁重复——同一日期区间已盘过 → 拒绝开启
    const optsNow = await this._dailyBatchOptions();
    const sameRangeDone = optsNow.find(o => o.sheetId === lastSheetId && o.count > 0);
    if (sameRangeDone) {
      this.toast('该日期区间已在盘点记录中存在盘点（盘点号 ' + sameRangeDone.no + '，' + sameRangeDone.count + ' 条）。请先在【盘点记录列表】删除该盘点后再开新盘点');
      return;
    }

    const area = document.getElementById('stArea');
    if (area) area.innerHTML = '<div class="empty-state"><div class="empty-text">正在统计出入库…</div></div>';
    let obRes, inRes, stock;
    // 🟢 v227.3：先声明 sheetId（无出库分支也要用），避免块作用域引用未初始化变量
    const _dailySheetId = 'daily_' + sd.slice(5) + '_' + ed.slice(5);
    try {
      [obRes, inRes, stock] = await Promise.all([
        DataStore.getOutbound({ startDate: sd, endDate: ed }, 1, 'all'),
        DataStore.getInbound({ startDate: sd, endDate: ed }, 1, 'all'),
        DataStore.getRows('stock')
      ]);

      const outMap = this._aggByCode(obRes.items || [], '出库数量');
      const outCodes = new Set(Object.keys(outMap));

      // 🟢 v227.24：无出库时直接拦截，不再进入盘点界面。
      //   日常盘点 = 出库筛选，区间内无出库时该批次没有盘点意义；提示改用季度盘点更直接。
      if (outCodes.size === 0) {
        if (area) area.innerHTML = `
          <div class="empty-state" style="padding:40px;">
            <div class="empty-icon">📭</div>
            <div class="empty-text">当前日期区间（${esc(sd)} ~ ${esc(ed)}）内<b>无出库记录</b>，无法开始日常盘点</div>
            <div class="empty-sub" style="margin-top:8px;font-size:13px;opacity:.75;">
              日常盘点以出库为筛选依据，区间无出库即无可盘数据。<br>
              如需按全库清点，请使用【季度盘点】；如需更换区间，请修改左上方「开始/结束日期」。
            </div>
            <button class="btn--ghost" onclick="StocktakeModule.startDaily()" style="margin-top:14px;">← 重新选择区间</button>
          </div>`;
        this.toast('所选区间无出库数据，请更换区间或改用季度盘点');
        return;
      }

      const inMap = this._aggByCode(inRes.items || [], '数量');
// 🟢 v226：盘点号 = rc/jd + YYYYMMDD[-N]
  //   命名按「点击日常/季度时的当日日期」，同一批次未结束时复用；已结束后当日再开局递增 -2/-3。
  //   sheetId 内部仍保留旧格式（向后兼容，避免破坏云端 key/批次汇总索引）；
  //   对外展示统一用「盘点号」，盘点记录列表/批次汇总/认领区均显示 batchNo。
  const _autoNo = this._genBatchNo('daily', _dailySheetId);
  // 🟢 v227：下拉里明确选了盘点号 → 以所选为准（续 historial 进行中的批次）
  this.batchNo = pickedNo || _autoNo;
  if (pickedNo && pickedNo !== _autoNo) this._pinBatchNo('daily', _dailySheetId, pickedNo);
    this.sheet = { sheetId: _dailySheetId, batchNo: this.batchNo, sheetType: 'daily', startDate: sd, endDate: ed };
    // 🟢 v226：开局即登记「未结束会话」；只有点【盘点结束】/【放弃】才清除（保存=暂停，不清）
    this._sheetTouched = null;   // 🟢 v227.5：新开一轮盘点 → 清空上一轮 save/finish 痕迹
    this._markOpenSession(_dailySheetId, 'daily', counter || this.task.counter, sd, ed);
    // 🟢 v227.5：记住入口类型（daily）—— 返回按钮回到日常盘点日期选择界面
    this._entrySheetType = 'daily';
    // 🟢 v226：日常盘点 = 自主盘点，作业身份直接锁定为当前登录账号（盘点人据此自动带出/落库）。
    //   旧实现只在「认领区间」时赋值，未认领时 task.counter 为空 → 保存的记录盘点人空白，
    //   且结束时 _countedCodes(…,counter) 匹配不上已存行 → 同一行被重复写一条「未盘点」记录。
    if (counter) this.task.counter = counter;
    this.allRowsFull = this.buildRows(stock || [], outMap, inMap, outCodes);
    this.allRows = this.allRowsFull.slice();
    this.showInOut = true;
    this.task.started = false;
    await this._applyResumeFilter();   // 续盘：剔除本人已盘的（序号保持全集编号）
    this._restoreDraft();
    await this._applyAssignedIfAny();     // v217：登录态自动领用分配给本人的 open 任务
    this.renderTable();
    } catch (e) {
      console.error('[stocktake] 日常盘点取数失败:', e);
      if (area) area.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">取数失败：' + esc(e.message || e) + '</div></div>';
    }
  },

  /** 把指定盘点号固定绑定到 sheetId（用户在下拉里明确选了历史/进行中的号时使用） */
  _pinBatchNo(type, sheetId, no) {
    if (!sheetId || !no) return;
    try {
      const MAP_KEY = 'wb_stocktake_no_map';
      const map = JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {};
      map[sheetId] = { no: no, type: type, finished: false, date: this._today().replace(/-/g, '') };
      localStorage.setItem(MAP_KEY, JSON.stringify(map));
    } catch (e) { /* 忽略 */ }
  },

  /**
   * 🟢 v227：查看「已结束」的日常盘点号的历史数据（只读）。
   *   界面上不提供填写/保存/结束，只可返回日期选择界面重开。
   */
  async _viewClosedDaily(no) {
    const area = document.getElementById('stArea');
    if (area) area.innerHTML = '<div class="empty-state"><div class="empty-text">加载中…</div></div>';
    let recs = [];
    try { recs = await DataStore.getStocktakeRecords(); } catch (e) { recs = []; }
    const list = (recs || [])
      .filter(r => !r.voided && String(r.batchNo || '').trim() === String(no).trim())
      .sort((a, b) => String(a.存货编码 || '').localeCompare(String(b.存货编码 || '')));

    if (!list.length) {
      if (area) area.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <div class="empty-text">盘点号 <b>${esc(no)}</b> 没有可查看的记录</div>
          <div class="empty-sub" style="margin-top:6px;font-size:13px;opacity:.75;">
            <button class="btn--ghost" onclick="StocktakeModule.startDaily()">← 返回选择日期与盘点号</button>
          </div>
        </div>`;
      return;
    }

    const body = list.map((r, i) => {
      const dv = (r.差异量 === '' || r.差异量 == null) ? NaN : parseFloat(r.差异量);
      const dcolor = isNaN(dv) ? '' : (dv > 0 ? 'color:#16a34a;' : (dv < 0 ? 'color:#dc2626;' : ''));
      const qtyCell = (r.盘点数量 == null || r.盘点数量 === '') ? '/' : this._num(r.盘点数量);
      const diffCell = (r.差异量 == null || r.差异量 === '')
        ? '/'
        : `<span style="${dcolor}font-weight:600;">${this._num(r.差异量)}</span>`;
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(r.存货编码 || '')}</td>
        <td>${esc(r.存货名称 || '')}</td>
        <td>${esc(r.规格型号 || '')}</td>
        <td>${this._num(r.现存量)}</td>
        <td>${qtyCell}</td>
        <td>${diffCell}</td>
        <td>${esc(r.盘点人 || '')}</td>
        <td>${esc(r.盘点日期 || '')}</td>
        <td>${esc(r.备注 || '')}</td>
      </tr>`;
    }).join('');

    if (area) area.innerHTML = `
      <div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:var(--status-info-bg,#eef6ff);font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>📖 盘点号 <b>${esc(no)}</b> 已结束，以下为历史盘点数据（<b>只读</b>，不可修改）</span>
        <span style="opacity:.7;font-size:12px;">区间 ${esc(list[0].开始日期 || '')} ~ ${esc(list[0].结束日期 || '')} · 共 ${list.length} 条</span>
        <button class="btn--ghost" onclick="StocktakeModule.startDaily()" style="margin-left:auto;padding:4px 12px;font-size:12px;">← 返回</button>
      </div>
      <div style="overflow:auto;max-height:68vh;border:1px solid var(--border-color,#e5e7eb);border-radius:8px;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--bg-secondary,#f9fafb);z-index:1;">
            <tr>
              <th>序号</th><th>存货编码</th><th>存货名称</th><th>规格型号</th><th>现存量</th>
              <th>盘点数量</th><th>差异量</th><th>盘点人</th><th>盘点日期</th><th>备注</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  },

  // ---------------- 季度盘点 ----------------
  // 🟢 v224：季度盘点 = 分配模式 —— 点按钮不直接开盘，
  //   先检测本人是否有未结束任务（提示跳回），
  //   否则展示「该批次所有 open 任务」，由本人点击领取后进入。
  //   这样「分派后不能手动认领」的语义就到位：除被分配的任务，否则无法进入季度盘点。
  // 🟢 v227：季度盘点为全库清点，不需要（也没有）日期区间 —— 直接开局。
  //   批次标识仍用 query 区间（默认近 30 天，跨设备一致），但不再强制用户先选日期。
  async startQuarter() {
    this._hideUnfinishedBanner();
    this._anchorRangeToOpenSession();   // 🟢 v227.8：跨天续盘锚定（详见方法注释）
    this._ensureDefaultRange();
    const sd = this.query.startDate, ed = this.query.endDate;
    const counter = String(((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? (AppConfig.getCurrentUser() || {}).username : '') || this.task.counter || '').trim();

    // 🟢 v225.2：点「季度盘点」时再拉一次云端任务（进模块那次可能超时/当时离线，
    //   或用户在模块内改了日期区间后直接开季度盘点）。任务栏与选择器都依赖它。
    await this._syncAssignedTasks(4000);

    const sheetId = 'quarter_' + sd.slice(5) + '_' + ed.slice(5);
    // 续盘检测（同批次+同作业身份 草稿未清 或 任务 open 且未完成）
    // 🟢 v227.5：保存后点【返回】→ 不自动续盘，直接渲染季度初始界面（要能看见「本次盘点概览」）
    const skipQuarterResume = !!this._skipResumePrompt; this._skipResumePrompt = false;
    const resume = skipQuarterResume ? null : await this._detectUnfinished(sheetId, 'quarter', counter);
    if (resume) {
      this._entrySheetType = 'quarter';
      await this._resumeToSheet(resume);
      return;
    }

    // 拉本批次所有 open 任务
    const allTasks = DataStore.getStocktakeTasks() || {};
    const myTasks = counter ? (DataStore.getMyOpenTasks(counter) || []) : [];
    // 🟢 v224：本人已结束的任务 → 补盘入口（否则结束后发现漏盘，在界面上根本点不到）
    const myClosed = counter
      ? Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
          t && t.counter === counter && t.status === 'closed' && this._taskInCurrentBatch(t, sd, ed))
      : [];
    // 🟢 v227.7/227.8：批次归属判定统一走 _taskInCurrentBatch（四级兜底，见该方法注释）
    const sameBatchAll = Object.keys(allTasks)
      .map(k => allTasks[k])
      .filter(t => this._taskInCurrentBatch(t, sd, ed));

    // 🟢 v226：盘点号在「批次」层面生成（jd + 当日日期），本批次所有领取人共用同一个号
    this.batchNo = this._genBatchNo('quarter', sheetId);

    // 🟢 v227.5：实时拉取云端「本次盘点概览」（其他盘点人刚完成的盘点数也会同步过来，
    //   让管理员视图/我的概览的数字保持一致）
    try { await this._pullQuarterOverviews(); } catch (e) { console.warn('[stocktake] 拉云端概览失败(已忽略):', e && e.message); }

    this._entrySheetType = 'quarter';
    this._renderQuarterTaskPicker(sd, ed, sheetId, myTasks, sameBatchAll, counter, myClosed, this.batchNo);
    // 🟢 v227.5+：picker 打开 → 启动 8s 轮询拉云端概览，管理员视图实时看到盘点人进度
    //   通道注册放在这里兜底：render() 之外的入口（直接调 startQuarter / 页面内跳转）也要通
    this._ensureOverviewChannel();
    // 🟢 v227.16：picker 打开时若已联网，顺手补推离线队列（批次状态/概览/任务），低代价自愈
    try { if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) this._flushCloudQueue(); } catch (e) { /* 忽略 */ }
    this._startOverviewPolling();
  },

  // 季度盘点任务选择器 —— 列「我的任务」和「本批次全部任务（管理员视图）」
  _renderQuarterTaskPicker(sd, ed, sheetId, myTasks, allBatch, counter, myClosed, batchNo) {
    const area = document.getElementById('stArea');
    if (!area) return;
    // 🟢 v227.68：记录当前作业视图上下文，供「刷新任务」重渲染本区（我的任务/分派/补盘）
    this._pickerCtx = { sd, ed, sheetId, counter, batchNo };
    const escA = (s) => typeof escAttr === 'function' ? escAttr(s) : String(s);
    const escH = (s) => typeof esc === 'function' ? esc(s) : String(s);
    // 🟢 v227.9：批次已强制结束 → picker 内所有入口（进入盘点/补盘/认领）禁用，前端直观反映
    const roundClosed = this.isQuarterRoundClosed(sheetId);
    // 🟢 v227.12：当前轮次 + 已结束轮次（用于「第 N 轮」展示与「开下一轮」）
    const roundNo = this._getRoundNo(sheetId);
    const closedRound = this._getClosedRound(sheetId);
    const roundBadge = roundClosed
      ? `<span class="st-pill-error" style="margin-left:8px;font-size:12px;padding:2px 8px;border-radius:6px;">⛔ 第 ${closedRound || roundNo} 轮已结束</span>`
      : `<span class="st-pill-success" style="margin-left:8px;font-size:12px;padding:2px 8px;border-radius:6px;">🟢 第 ${roundNo} 轮 · 进行中</span>`;

    const myRows = myTasks.map(t => `
      <div class="st-banner-warning" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;margin-bottom:6px;">
        <span style="font-size:13px;"><b>${escH(t.counter)}</b> · 序号 ${t.noStart}-${t.noEnd} · ${(t.codes || []).length} 项</span>
        <span style="margin-left:auto;font-size:11px;color:var(--text-secondary);">${t.createdAt ? escH(String(t.createdAt).slice(0,10)) : ''}</span>
        ${(roundClosed && !t.replenishAssigned)
          ? '<span style="font-size:12px;color:#dc2626;padding:4px 12px;">⛔ 已结束</span>'
          : `<button class="btn--primary" onclick="StocktakeModule._claimQuarterTask('${escA(t.taskId)}')" style="padding:4px 12px;font-size:12px;">${t.replenishAssigned ? '🔧 补盘' : '进入盘点'}</button>`}
      </div>`).join('') || `<div style="display:flex;align-items:center;gap:10px;padding:14px 8px;color:var(--text-secondary);font-size:13px;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 28px;color:var(--text-muted);opacity:0.65;">
          <rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z" fill="currentColor" fill-opacity="0.18"/>
          <line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>
        </svg>
        <div style="flex:1 1 auto;">
          <div>暂无分配给你的任务</div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">任务由管理员分派后会自动出现在这里</div>
        </div>
      </div>`;

    // 🟢 v227.3：管理员视图（"本批次全部任务"）与【查看/分派盘点任务】权限绑定
    //   而非只看 isAdmin() —— 让有 stocktakeAssign 权限的库管员也能看到本批次全貌
    const hasAssignPerm = (function () {
      try {
        if (typeof AppConfig === 'undefined') return false;
        const c = ((typeof AppConfig.getCurrentUser === 'function' && AppConfig.getCurrentUser()) || {}).username || '';
        if (!c) return false;
        if (typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin()) return true;
        const mods = typeof AppConfig.getKeeperModules === 'function' ? AppConfig.getKeeperModules(c) : null;
        if (!mods) return true; // 老账号（全开）
        return mods.indexOf('stocktakeAssign') !== -1;
      } catch (e) { return false; }
    })();
    const isAdmin = hasAssignPerm;
    const allRows = allBatch.map(t => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px dashed var(--border-color,#eee);font-size:13px;">
        <span style="min-width:90px;"><b>${escH(t.counter)}</b></span>
        <span style="color:var(--text-secondary);">${t.noStart}-${t.noEnd} · ${(t.codes || []).length} 项</span>
        <span style="margin-left:auto;color:var(--text-secondary);font-size:11px;">${t.status === 'closed' ? '✅ 已完成' : (t.status === 'open' ? '🟡 进行中' : '')}</span>
        ${(!roundClosed && t.counter === counter && t.status === 'open')
          ? `<button class="btn--ghost" onclick="StocktakeModule._claimQuarterTask('${escA(t.taskId)}')" style="padding:3px 10px;font-size:12px;">认领</button>`
          : ''}
      </div>`).join('') || `<div style="display:flex;align-items:center;gap:10px;padding:14px 8px;color:var(--text-secondary);font-size:13px;">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 28px;color:var(--text-muted);opacity:0.65;">
          <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z"/><path d="M3 7l9 4 9-4"/><line x1="12" y1="11" x2="12" y2="21"/>
        </svg>
        <div style="flex:1 1 auto;">
          <div>本批次暂无任务</div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">管理员可在「分派任务」中创建盘点任务</div>
        </div>
      </div>`;

    // 🟢 v224：已结束任务 → 补盘入口（漏盘补录）
    const closedArr = myClosed || [];
    const closedRows = closedArr.map(t => `
      <div class="st-banner-info" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;margin-bottom:6px;">
        <span style="font-size:13px;"><b>${escH(t.counter)}</b> · 序号 ${t.noStart}-${t.noEnd} · ${(t.codes || []).length} 项 · <span style="color:#2563eb;">已结束</span></span>
        <span style="margin-left:auto;font-size:11px;color:var(--text-secondary);">${t.closedAt ? escH(String(t.closedAt).slice(0, 10)) : ''}</span>
        ${(roundClosed && !t.replenishAssigned)
          ? '<span style="font-size:12px;color:#dc2626;padding:4px 12px;">⛔ 已结束</span>'
          : `<button class="btn--ghost" onclick="StocktakeModule._claimQuarterTask('${escA(t.taskId)}')" style="padding:4px 12px;font-size:12px;">${t.replenishAssigned ? '🔧 补盘（管理员指派）' : '补盘'}</button>`}
      </div>`).join('');

    // 🟢 v227.21：补盘仅限「已结束的轮次」。新轮次（roundClosed=false）下若云端把上一轮的
    //   closed 任务同步回来，本块一律不渲染，避免上一轮漏盘伪装成本轮「补盘」入口。
    const closedBlock = (roundClosed && closedRows) ? `
        <div style="background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;margin-bottom:12px;">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px;">🧩 我的补盘（已结束的任务）</div>
          ${(function () {
            const anyAssigned = (closedArr || []).concat(myTasks || []).some(t => t && t.replenishAssigned);
            if (anyAssigned) return '<div style="font-size:12px;color:#2563eb;margin-bottom:6px;">🔧 管理员已指派你补盘 —— 点「补盘」后只会列出尚未盘过的编码。</div>';
            return roundClosed
              ? '<div style="font-size:12px;color:#dc2626;margin-bottom:6px;">本批次已被管理员结束，不可再补盘。</div>'
              : '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">发现漏盘可点「补盘」继续，系统只会列出你还没盘过的编码。</div>';
          })()}
          ${closedRows}
        </div>` : '';

    // 🟢 v227.5：本次盘点概览（云端概览同步来的统计）—— 仅在本批次（round）未结束时展示
    const overviewBlock = (!counter || roundClosed) ? '' : this._renderMyOverviewBlock(counter, batchNo, sheetId, sd, ed);

    // 🟢 v227.5：管理员视图（本批次全部任务）—— 同步附加每位盘点人的概览统计；
    //   管理员/有 stocktakeAssign 权限者可点【结束季度盘点】锁定本批次。
    const adminBlock = isAdmin ? this._renderAdminBatchBlock(sheetId, sd, ed, counter, allBatch, batchNo) : '';

    area.innerHTML = `
      <div style="margin-top:8px;">
        <div style="background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;margin-bottom:12px;">
          <!-- 🟢 v227.27：顶部冗余状态行精简为一行 chip -->
          <div class="quarter-status-bar" style="margin-bottom:10px;">
            <span>👤 作业身份：<b>${escH(counter || '未登录')}</b></span>
            ${roundBadge ? `<span>${roundBadge}</span>` : ''}
            <span title="其他盘点人保存/结束盘点后，本视图通过云端 + BroadcastChannel 自动刷新">
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#16a34a;animation:pulse 2s infinite;"></span>
              实时同步
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:600;">📋 我的任务</span>
            <button id="stTaskRefresh" class="btn--ghost as-refresh-btn" onclick="StocktakeModule.refreshMyTasks()" title="从云端同步他人（管理员）分派给我的任务" style="padding:3px 9px;font-size:12px;line-height:1.3;">🔄 刷新任务</button>
          </div>
          ${myRows}
        </div>
        ${overviewBlock}
        ${closedBlock}
        ${adminBlock}
      </div>`;
  },

  /**
   * 🟢 v227.5：渲染「本次盘点概览」块 —— 仅展示「本人」的盘点进度。
   * - status='finished' 且未盘数=0 → 本次已全部盘点！
   * - status='finished' 且未盘数>0 → 本次盘点已结束，发现漏盘！
   * - status='in_progress' 或无记录 → 本次盘点未结束
   * - 期末隐藏整块（roundClosed=true）
   */
  _renderMyOverviewBlock(counter, batchNo, sheetId, sd, ed) {
    const map = this._getAllOverviews();
    const ov = map[this._overviewKey(counter, sheetId)] || null;
    // 🟢 v227.21：是否「已结束轮次」—— 补盘入口的唯一合法前提（见下方 finished 分支守卫）
    const roundClosed = this.isQuarterRoundClosed(sheetId);
    const escH = (s) => typeof esc === 'function' ? esc(s) : String(s);
    // 文案与按钮按状态分流
    let head, body, btnLabel, btnClick, btnClass, hint;
    if (!ov) {
      head = '本次盘点未开始';
      body = '<div style="font-size:13px;color:var(--text-secondary);">尚未开启本批次盘点（批次号 ' + escH(batchNo) + '）。</div>';
      btnLabel = '';
      hint = '';
    } else {
      const unfilled = (ov.unfilledCount || 0);
      const real = (ov.realCount || 0);
      const zero = (ov.zeroCount || 0);
      const counted = real + zero;
      const total = ov.totalCount || (ov.noStart && ov.noEnd ? (ov.noEnd - ov.noStart + 1) : 0);
      const rate = ov.completionRate || 0;
      const stats = `<div style="font-size:13px;margin:6px 0;line-height:1.7;">
        · 已盘数：<b style="color:#16a34a;">${real}</b> 项（实际盘点）
        ${zero ? '· 含 0 项：<b style="color:#b45309;">' + zero + '</b> 项' : ''}
        ${(ov.diffCount > 0) ? '<br>· 差异数：<b style="color:#dc2626;">' + ov.diffCount + '</b> 项（盘点 ≠ 现存量）' : ''}
        <br>· 未盘数：<b style="color:#dc2626;">${unfilled}</b> 项
        · 任务完成率：<b style="color:#2563eb;">${rate}%</b>（${counted}/${total}）
      </div>`;
      // 🟢 v227.16 修复（双补盘入口）：补盘入口统一收敛到「🧩 我的补盘」区块。
      //   概览块只在「不存在 closed 补盘任务（如从未分派过的自建盘点）」时才出补盘按钮，
      //   否则不出按钮、仅提示去下方区块，避免与任务块同时出现两个补盘入口。
      const hasClosed = !!(DataStore.getStocktakeTasks() && Object.keys(DataStore.getStocktakeTasks())
        .map(k => DataStore.getStocktakeTasks()[k])
        .find(t => t && String(t.counter || '') === String(counter) && t.status === 'closed' && this._taskInCurrentBatch(t, sd, ed)));
      if (ov.status === 'finished' && unfilled === 0) {
        head = '本次已全部盘点！';
        // 已全部完成：补盘无意义 —— 不出可点按钮（避免空 toinv 死入口）
        btnLabel = '';
        btnClick = '';
        btnClass = 'primary';
        hint = '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">✅ 本批次所有任务均已盘完，无需补盘。</div>';
        body = `<div style="font-size:13px;margin-top:4px;">你本批次的所有任务都已盘完（${real + zero}/${total}）。</div>` + stats;
      } else if (ov.status === 'finished' && unfilled > 0) {
        // 🟢 v227.21：补盘仅适用于「已结束的轮次」。新轮次（roundClosed=false）里若出现
        //   finished 概览，必是上一轮残留在云端的旧概览被同步回来（弱网/时序），绝不能当成
        //   本轮补盘入口 —— 否则「开下一轮」后上一轮漏盘会伪造成本轮补盘。
        if (!roundClosed) {
          head = '上一轮盘点已归档';
          btnLabel = ''; btnClick = ''; btnClass = 'primary';
          hint = '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">本轮为进行中的新轮次，上一轮概览不适用。开始新一轮后请由管理员重新分派任务。</div>';
          body = `<div style="font-size:13px;margin-top:4px;">盘点号 <b>${escH(batchNo)}</b> 上一轮已结束并归档，本新一轮请重新分派后再盘点。</div>` + stats;
        } else if (hasClosed) {
          // 已有「🧩 我的补盘」区块提供补盘入口 → 概览块不出重复按钮
          head = '本次盘点已结束，发现漏盘！请及时补盘';
          btnLabel = '';
          btnClick = '';
          btnClass = 'primary';
          hint = '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">请到下方「🧩 我的补盘」点击补盘，只列没盘过的编码。</div>';
          body = `<div style="font-size:13px;margin-top:4px;">盘点号 <b>${escH(batchNo)}</b> 已结束，但仍有 <b style="color:#dc2626;">${unfilled}</b> 项未盘点。</div>` + stats;
        } else {
          head = '本次盘点已结束，发现漏盘！请及时补盘';
          btnLabel = '补盘';
          btnClick = `StocktakeModule._replenishClosedQuarterFor('${escH(counter)}')`;
          btnClass = 'primary';
          hint = '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">补盘模式只会列出还没盘过的编码，已盘项不重复出现。</div>';
          body = `<div style="font-size:13px;margin-top:4px;">盘点号 <b>${escH(batchNo)}</b> 已结束，但仍有 <b style="color:#dc2626;">${unfilled}</b> 项未盘点。</div>` + stats;
        }
      } else {
        head = '本次盘点未结束！请继续';
        btnLabel = '继续盘点';
        btnClick = `StocktakeModule._resumeFromMyOverview('${escH(counter)}','${escH(sheetId)}')`;
        btnClass = 'primary';
        hint = '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">已盘点数据已保存为草稿，可直接继续；点【继续盘点】恢复现场。</div>';
        body = `<div style="font-size:13px;margin-top:4px;">盘点号 <b>${escH(batchNo)}</b> 进度：</div>` + stats;
      }
    }
    const btn = btnLabel
      ? `<button class="${btnClass}" onclick="${btnClick}" style="padding:6px 14px;font-size:13px;">${btnLabel}</button>`
      : '';
    return `
      <div style="background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;">📊 ${head}</div>
        ${body}
        ${hint}
        ${btn ? '<div style="margin-top:8px;">' + btn + '</div>' : ''}
      </div>`;
  },

  /**
   * 🟢 v227.5：渲染「本批次全部任务（管理员视图）」块 —— 每位盘点人后展示本次盘点统计。
   *   并附【结束季度盘点】按钮（管理员/stocktakeAssign 可见），点击后本批次概览隐藏。
   */
  _renderAdminBatchBlock(sheetId, sd, ed, counter, allBatch, batchNo) {
    const escH = (s) => typeof esc === 'function' ? esc(s) : String(s);
    const escA = (s) => typeof escAttr === 'function' ? escAttr(s) : String(s);
    const ovMap = this._getAllOverviews();
    const roundClosed = this.isQuarterRoundClosed(sheetId);
    // 🟢 v227.12：本函数内用到的轮次变量（picker 里另有同名局部，这里独立计算避免未定义）
    const roundNo = this._getRoundNo(sheetId);
    const closedRound = this._getClosedRound(sheetId);
    const roundBadge = roundClosed
      ? `<span class="st-pill-error" style="margin-left:8px;font-size:12px;padding:2px 8px;border-radius:6px;">⛔ 第 ${closedRound || roundNo} 轮已结束</span>`
      : `<span class="st-pill-success" style="margin-left:8px;font-size:12px;padding:2px 8px;border-radius:6px;">🟢 第 ${roundNo} 轮 · 进行中</span>`;
    const grouped = {};  // counter -> { counter, noStart, noEnd, count, codesLen, taskIds }
    (allBatch || []).forEach(t => {
      if (!t || !t.counter) return;
      const c = t.counter;
      if (!grouped[c]) grouped[c] = { counter: c, noStart: t.noStart, noEnd: t.noEnd, count: 0, codesLen: 0, taskIds: [], status: 'open', replenishAssigned: false };
      grouped[c].count++;
      grouped[c].codesLen += (t.codes || []).length;
      grouped[c].taskIds.push(t.taskId);
      if (t.replenishAssigned) grouped[c].replenishAssigned = true;
      if (t.status === 'closed') grouped[c].status = grouped[c].status === 'open' ? 'closed' : grouped[c].status;
      // 取最小 noStart / 最大 noEnd
      if (grouped[c].noStart == null || t.noStart < grouped[c].noStart) grouped[c].noStart = t.noStart;
      if (grouped[c].noEnd == null || t.noEnd > grouped[c].noEnd) grouped[c].noEnd = t.noEnd;
    });
    // 用户（counter）概览填充
    const rows = Object.keys(grouped).map(c => {
      const g = grouped[c];
      const ov = ovMap[this._overviewKey(c, sheetId)] || null;
      let statsHtml = '';
      if (ov && ov.totalCount) {
        const counted = (ov.realCount || 0) + (ov.zeroCount || 0);
        const color = ov.status === 'finished' && ov.unfilledCount === 0 ? '#16a34a'
                    : ov.status === 'finished' ? '#b45309'
                    : (ov.completionRate >= 100 ? '#2563eb' : '#6b7280');
        // 🟢 v227.7：差异数 = 盘点 ≠ 现存量的项数。红色 + 加粗，让管理员一眼看到差异在哪里
        const diffHtml = (ov.diffCount > 0) ? ` <span style="color:#dc2626;font-weight:700;">· 差异 ${ov.diffCount}</span>` : '';
        statsHtml = ` <span style="color:${color};">已盘 ${ov.realCount || 0}/${ov.totalCount}（${ov.completionRate || 0}%${ov.unfilledCount ? ' · 漏 ' + ov.unfilledCount : ''}${diffHtml}${ov.status === 'finished' ? ' · 已结束' : ''}）</span>`;
      } else {
        statsHtml = ` <span style="opacity:.6;">尚未开启</span>`;
      }
      // 🟢 v227.14：有漏盘 → 管理员可「指派补盘」（原盘点人本人补，归属不变）
      const unfilledN = (ov && ov.unfilledCount) || 0;
      // 🟢 v227.14：仅在「批次已结束」后提供（未结束时盘点人自己就有进入/补盘入口，无需指派）
      const replenishBtn = !roundClosed ? '' : (g.replenishAssigned
        ? `<span style="font-size:12px;color:#2563eb;margin-left:8px;">🔧 已指派补盘</span>`
        : (unfilledN > 0
          ? `<button class="btn--ghost" onclick="StocktakeModule.assignReplenish('${escA(g.counter)}','${escA(sheetId)}')" ` +
            `style="padding:3px 10px;font-size:12px;margin-left:8px;">🔧 指派补盘（漏 ${unfilledN}）</button>`
          : ''));
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px dashed var(--border-color,#eee);font-size:13px;flex-wrap:wrap;">
        <span style="min-width:90px;"><b>${escH(g.counter)}</b></span>
        <span style="color:var(--text-secondary);">${g.noStart || '-'}–${g.noEnd || '-'} · ${g.count} 个区间 · ${g.codesLen} 项</span>
        ${statsHtml}
        <span style="margin-left:auto;color:var(--text-secondary);font-size:11px;">${roundClosed ? '⛔ 已结束' : (g.status === 'closed' ? '✅ 已完成' : '🟡 进行中')}</span>
        ${replenishBtn}
      </div>`;
    }).join('');
    const endBatchBtn = roundClosed
      ? `<span style="font-size:12px;color:#dc2626;">⛔ 第 ${closedRound || roundNo} 轮已结束（${escH(batchNo)}）</span>`
      : `<button class="btn--danger" onclick="StocktakeModule.endQuarterRound('${escA(sheetId)}')" style="padding:6px 14px;font-size:13px;">结束季度盘点</button>`;
    // 🟢 v227.12：已结束 → 提供「开下一轮」入口（解闸 + 重置任务），解决「结束后再也开不了下一轮」
    const nextRoundBtn = roundClosed
      ? `<button class="btn--primary" onclick="StocktakeModule.startNextRound('${escA(sheetId)}')" style="padding:6px 14px;font-size:13px;">🔄 开下一轮盘点</button>`
      : '';
    // 🟢 v227.21：批次已结束且有漏盘 → 顶部加一条醒目提示，明确「指派补盘」入口就在一行最右侧，
    //   解决管理员反馈「结束季度盘点后找不到分配补盘任务的地方」。
    const leakCounters = Object.keys(grouped).filter(c => ((ovMap[this._overviewKey(c, sheetId)] || {}).unfilledCount || 0) > 0);
    const leakHint = (roundClosed && leakCounters.length)
      ? `<div class="st-banner-warning" style="margin:8px 0 4px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.6;">
           ⚠️ 本批次已结束，仍有 <b>${leakCounters.length}</b> 人漏盘（${leakCounters.map(c => escH(c)).join('、')}）。<br>
           点其所在行最右侧的 <b>🔧 指派补盘（漏 N）</b> 按钮，即可指定该盘点人回来补录未盘编码（归属不变、不产生重复行）。
         </div>`
      : '';
    return `
      <div style="background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;">👑 本批次全部任务（管理员视图）${roundBadge}</div>
        ${leakHint}
        ${rows || `<div style="display:flex;align-items:center;gap:10px;padding:14px 8px;color:var(--text-secondary);font-size:13px;">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 28px;color:var(--text-muted);opacity:0.65;">
            <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z"/><path d="M3 7l9 4 9-4"/><line x1="12" y1="11" x2="12" y2="21"/>
          </svg>
          <div style="flex:1 1 auto;">
            <div>本批次暂无任务</div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">在「分派任务」中创建后会自动出现在这里</div>
          </div>
        </div>`}
        <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button class="btn--primary" onclick="StocktakeModule.openAssignDialog()" style="padding:6px 14px;font-size:13px;">➕ 分派任务</button>
          ${endBatchBtn}
          ${nextRoundBtn}
        </div>
      </div>`;
  },

  /**
   * 概览 → 【继续盘点】—— 续盘入口：复用 _detectUnfinished（命中 session/draft 任一就续盘）
   */
  async _resumeFromMyOverview(counter, sheetId) {
    this._anchorRangeToOpenSession();   // 🟢 v227.9：跨天后 picker 上的 sheetId（ov.sheetId）已和 query 漂开，先锚定区间再算
    this._ensureDefaultRange();
    const sd = this.query.startDate, ed = this.query.endDate;
    // 🟢 v227.9：优先用本机 session 的 sheetId（更可靠），其次用入参，否则按当前 query 算
    let effectiveSheetId = sheetId;
    try {
      const s = this._getOpenSession();
      if (s && s.sheetType === 'quarter' && (!s.counter || s.counter === counter)) effectiveSheetId = s.sheetId || effectiveSheetId;
    } catch (e) { /* 忽略 */ }
    if (!effectiveSheetId) effectiveSheetId = 'quarter_' + sd.slice(5) + '_' + ed.slice(5);

    const info = await this._detectUnfinished(effectiveSheetId, 'quarter', counter);
    if (info) {
      this._entrySheetType = 'quarter';
      await this._resumeToSheet(info);
      return;
    }
    // 没有未结束的 session → 找该 counter 在本批次的 open 任务（继续则取第一个）
    // 🟢 v227.9：改用 _taskInCurrentBatch 统一判定（兼容跨天锚定后的区间漂移）
    const tasks = (DataStore.getStocktakeTasks() || {});
    const myOpen = Object.keys(tasks)
      .map(k => tasks[k])
      .filter(t => t && t.sheetType === 'quarter' && t.counter === counter &&
        t.status !== 'closed' && this._taskInCurrentBatch(t, sd, ed))
      .sort((a, b) => (a.noStart || 0) - (b.noStart || 0));
    if (myOpen[0]) {
      this._entrySheetType = 'quarter';
      await this._claimQuarterTask(myOpen[0].taskId);
      return;
    }
    this.toast('该盘点已结束且无进行中任务');
  },

  /** 概览 → 【补盘】（finished 且未盘项>0）—— 进入补盘模式 */
  async _replenishClosedQuarterFor(counter) {
    this._ensureDefaultRange();
    const sd = this.query.startDate, ed = this.query.endDate;
    const sheetId = 'quarter_' + sd.slice(5) + '_' + ed.slice(5);
    const tasks = DataStore.getStocktakeTasks() || {};
    const myClosed = Object.keys(tasks)
      .map(k => tasks[k])
      .filter(t => t && t.sheetType === 'quarter' && t.counter === counter &&
        (t.startDate == null || (t.startDate === sd && t.endDate === ed)) && t.status === 'closed');
    if (!myClosed.length) {
      // 没有 closed 任务 → 可能从未分配过；尝试新建一个补盘会话
      const ov = (this._getAllOverviews())[this._overviewKey(counter, sheetId)];
      if (!ov) { this.toast('未找到对应的已结束任务'); return; }
      // 用概览记录的 sheetId 开始补盘（通过 _continueQuarterInternal）
      const info = { sheetId: ov.sheetId, sheetType: 'quarter', counter, reason: 'replenish' };
      this._entrySheetType = 'quarter';
      await this._continueQuarterInternal(info);
      return;
    }
    // 🟢 v227.5：优先挑「还有漏盘编码」的任务（否则会进到一个全盘完的任务，列表空 = 体感无反应）
    let picked = myClosed[0];
    try {
      const counted = await this._countedCodesForQuarter(sheetId, counter);
      let best = -1;
      for (const t of myClosed) {
        const remain = (t.codes || []).filter(c => c && !counted.has(c)).length;
        if (remain > best) { best = remain; picked = t; }
        if (remain > 0) break;   // 找到有漏盘的就够了
      }
    } catch (e) { /* 忽略，沿用第一个 */ }
    this._entrySheetType = 'quarter';
    await this._claimQuarterTask(picked.taskId);
  },

  /** 概览 → 【补盘】（finished 且全部完成）—— 重新开始界面，给一个空概览或提示 */
  _reopenMyQuarterOverview(counter, batchNo) {
    this.toast(counter + ' · 本批次已全部完成，无需补盘');
  },

  // 🟢 v224 重写：领取某个季度盘点任务 → 建 sheet + 拉全库 + 按任务固化的编码清单过滤 + 渲染。
  //   原实现误调 claimRange(...)，而 claimRange 不接受参数、只从 DOM 读 #stNoStart/#stNoEnd，
  //   任务选择器渲染后这些输入框并不存在 → 点「进入盘点」静默无反应，季度盘点完全进不去。
  async _claimQuarterTask(taskId) {
    const t = (DataStore.getStocktakeTasks() || {})[taskId];
    if (!t) { this.toast('任务不存在或已撤销'); this._refreshTaskBar(); return; }
    // 🟢 v227.9：批次已强制结束 → 盘点人不能再进入盘点（管理员视角的【本次季度盘点结束】）
    const _sd0 = t.startDate || this.query.startDate, _ed0 = t.endDate || this.query.endDate;
    const _sid0 = t.sheetId || ('quarter_' + _sd0.slice(5) + '_' + _ed0.slice(5));
    // 🟢 v227.14：被管理员「指派补盘」的任务例外放行 —— 否则批次一结束就永远补不了漏盘。
    //   未带标记的任务行为完全不变（照样拦住）。
    if (this.isQuarterRoundClosed(_sid0) && !t.replenishAssigned) {
      WBModal.alert('本次季度盘点已被管理员强制结束，不可再进入盘点。\n\n盘点号：' + (this.batchNo || _sid0));
      return;
    }
    // 🟢 v224：任务已结束仍允许进入，走「补盘」模式（漏盘补录）。
    //    旧逻辑直接 return，导致结束后发现漏盘也进不去，只能让管理员取消分派重来。
    //    这里重建 sheet/行集后，_applyResumeFilter() 会自动剔除本人已盘编码，只留没盘过的。
    // 🟢 v227.14：管理员指派补盘的任务（可能仍是 open，因为是被强制结束、本人没点过结束）
    //   同样走补盘模式 —— 只列未盘编码，而不是把完整区间再摊一遍。
    const replenish = t.status === 'closed' || t.replenishAssigned === true;

    // 🟢 v227：季度盘点不需要筛选日期 → 区间只作批次标识，缺失时自动兜底（不再阻断）
    this._ensureDefaultRange();
    const sd = this.query.startDate, ed = this.query.endDate;

    // 🟢 归属保护：季度任务属分派制，非本人不得领取（防止盘到别人名下，与 v223 同类风险）
    const cur = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '').trim();
    const isAdmin = (typeof AppConfig !== 'undefined' && typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin());
    if (cur && t.counter !== cur && !isAdmin) {
      this.toast('该任务已分派给「' + t.counter + '」，无法由你领取');
      return;
    }

    const area = document.getElementById('stArea');
    if (area) area.innerHTML = '<div class="empty-state"><div class="empty-text">正在加载全库存货…</div></div>';
    try {
      const stock = await DataStore.getRows('stock');
      // 🟢 v226：复用本批次（sheetId）的盘点号 —— 同一批次所有领取人共用一个号
      const _qSheetId = 'quarter_' + sd.slice(5) + '_' + ed.slice(5);
      this.batchNo = this._genBatchNo('quarter', _qSheetId);
    this.sheet = { sheetId: _qSheetId, batchNo: this.batchNo, sheetType: 'quarter', startDate: sd, endDate: ed };
      this._sheetTouched = null;   // 🟢 v227.5：领取/续盘季度任务 = 新开一轮 → 清空痕迹
      this._markOpenSession(_qSheetId, 'quarter', t.counter || cur, sd, ed);
      // 🟢 v227.5：记住入口类型（quarter）—— 返回按钮 / 结束盘点回到季度任务选择器
      this._entrySheetType = 'quarter';
      // 🟢 v224：季度盘点 = 全库清点（不经出库筛选，也不显示出入库列）
      this.allRowsFull = this.buildRows(stock || [], {}, {}, null);
      this.allRows = this.allRowsFull.slice();
      this.showInOut = false;
      this.task.started = false;
      this.task.counter = t.counter;          // 先锁定归属人，供 _applyResumeFilter 剔除本人已盘
      if (replenish) {
        // 🟢 v227.16 修复：补盘模式下若剩余未盘编码 = 0，不进入空表（只剩一张 0 行表 + 一闪而过的 toast），
        //   直接提示并退回任务视图。否则全盘完后「补盘」按钮会让人进到空白盘点表。
        let remain = 0;
        try {
          const counted = await this._countedCodesForQuarter(t.sheetId, t.counter);
          remain = (t.codes || []).filter(c => c && !counted.has(c)).length;
        } catch (e) { /* 忽略，沿用下方渲染兜底 */ }
        if (remain === 0) {
          this.toast('该任务下的编码你都已盘过，无需补盘');
          this._skipResumePrompt = true;
          this.startQuarter();
          return;
        }
        // 🟢 v227.5：补盘模式 —— 任务清单 ∩ (尚未盘过)，避免已盘项重复出现
        await this._setAssignedRowsReplenish(t);
      } else {
        await this._applyResumeFilter();          // 先：剔除本人已盘的（基于全库，序号沿用全集编号）
        this._setAssignedRows(t);                // 后：按任务固化编码清单过滤（覆盖上面结果，最终生效）
      }
      this._restoreDraft();
      this.renderTable();
      // 🟢 v227.5：进入任务后立即更新概览（status 仍 in_progress，但 entrySheetType 已定）
      try { await this._publishQuarterOverview({ finished: false }); } catch (e) { /* 忽略 */ }
      // 🟢 v227.5+：离开 picker 进入填表 → 停止轮询（填表内靠保存/结束广播 + 退出时拉一次即可）
      this._stopOverviewPolling();
      const left = this.allRows.length;
      if (replenish) {
        if (left === 0) { this.toast('该任务下的编码你都已盘过，无需补盘'); return; }
        // 🟢 v227.9：去掉补盘模式 toast —— 用户反馈进入时不需要弹窗
      } else {
        // 🟢 v227.9：去掉「已领取」toast —— 进入填表本身就是确认，无需二次提示
      }
    } catch (e) {
      console.error('[stocktake] 季度盘点进入失败:', e);
      if (area) area.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败：' + esc(e.message || e) + '</div></div>';
    }
  },

  // 按存货编码聚合数量（容错：数量可能是字符串/空）
  _aggByCode(items, qtyField) {
    const map = {};
    (items || []).forEach(it => {
      const code = String(it.存货编码 == null ? '' : it.存货编码).trim();
      if (!code) return;
      const n = parseFloat(it[qtyField]);
      map[code] = (map[code] || 0) + (isNaN(n) ? 0 : n);
    });
    return map;
  },

  // 构建盘点行：按编码聚合现存量 → 过滤 → 稳定排序 → 赋序号
  buildRows(stock, outMap, inMap, onlyCodes) {
    const agg = new Map();
    (stock || []).forEach(s => {
      const code = String(s.存货编码 == null ? '' : s.存货编码).trim();
      if (!code) return;
      if (onlyCodes && !onlyCodes.has(code)) return;   // 日常盘点：仅保留出过库的
      const qty = parseFloat(s.现存数量) || 0;
      if (agg.has(code)) {
        agg.get(code).现存量 += qty;                    // 同编码多行 → 现存量求和
      } else {
        agg.set(code, {
          存货编码: code,
          存货名称: s.存货名称 || '',
          规格型号: s.规格型号 || '',
          现存量: qty,
          入库量: inMap[code] || 0,
          出库量: outMap[code] || 0,
          盘点数量: '',
          差异量: ''
        });
      }
    });
    const rows = Array.from(agg.values());
    // 稳定排序：简单字符串比较（避免 localeCompare 的跨环境差异，保证多设备序号一致）
    rows.sort((a, b) => (a.存货编码 < b.存货编码 ? -1 : (a.存货编码 > b.存货编码 ? 1 : 0)));
    rows.forEach((r, i) => { r.no = i + 1; });
    return rows;
  },

  // ---------------- 认领区间 ----------------
  async claimRange() {
    const nameEl = document.getElementById('stCounter');
    let counter = nameEl ? String(nameEl.value || '').trim() : '';
    // 登录态下强制使用当前账号（防止绕过只读锁手动改 input 值）
    if (typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn && AppConfig.isLoggedIn()) {
      const u = AppConfig.getCurrentUser();
      counter = u ? u.username : counter;
    }
    if (!counter) { this.toast('请先填写盘点人'); return; }
    const sEl = document.getElementById('stNoStart');
    const eEl = document.getElementById('stNoEnd');
    if (!sEl || !eEl) return;
    const s = parseInt(sEl.value, 10);
    const e = parseInt(eEl.value, 10);
    if (isNaN(s) || isNaN(e) || s < 1 || e < s) { this.toast('序号区间无效（起始需 ≥1 且 ≤ 结束）'); return; }
    this.task.counter = counter;
    this.task.noStart = s;
    this.task.noEnd = e;
    this.task.started = true;
    const removed = await this._applyResumeFilter();  // 认领人确定 → 剔除该人已盘的
    this.renderTable();
    this.toast('已认领：' + counter + ' · 序号 ' + s + '-' + e +
      (removed ? '（已剔除本人已盘 ' + removed + ' 条）' : ''));
  },

  // 重选区间（回到全集，已填数量不丢）
  resetRange() {
    this.task.started = false;
    this.task.noStart = null;
    this.task.noEnd = null;
    this.task.assignedTaskId = null;
    this.renderTable();
  },

  /**
   * 🟢 v227.3：填表界面顶部【返回】按钮。
   *   行为：若自开局以来从未点过「保存 / 盘点结束 / 放弃」，则弹窗提示保存
   *   （防用户误退造成未落库数据丢失），确认后回工作台；否则直接回工作台。
   *   返回后 sheet 清空，进入【日常盘点】工作台。
   */
  async goBackFromSheet() {
    const saved = !!(this._sheetTouched && this._sheetTouched.saved);
    const finished = !!(this._sheetTouched && this._sheetTouched.finished);
    const abandoned = !!(this._sheetTouched && this._sheetTouched.abandoned);
    const touched = saved || finished || abandoned;
    // 🟢 v227.5：已保存过的盘点，用户明确确认过保存意图 → 不弹提示，直接返回初始界面
    //   （"未改动"隐含由 saved 标记保证：保存后无改动触发不到输入事件，行状态不会变）
    if (this.sheet && saved && !finished && !abandoned) {
      // 🟢 v227.5：已保存 → 不弹提示、也不自动续盘；直接回季度初始界面（展示本次盘点概览）
      this._skipResumePrompt = true;
      this._backToWorkbench();
      return;
    }
    // 🟢 v227.3→v227.11：未保存过 → 单次确认即自动保存并返回（合并原「提示保存」+「确认暂停保存」两次弹窗为一次）。
    //   选择「直接返回」才丢弃现场；默认「保存并返回」安全不丢数。
    if (this.sheet && !touched) {
      const all = this.visibleRows ? this.visibleRows() : [];
      const n = (all || []).filter(r => r.盘点数量 !== '' && r.盘点数量 != null).length;
      const ok = await WBModal.confirm(
        '返回将自动保存当前进度（' + n + ' 条未结束的盘点数量），下次进入可继续盘点。',
        { title: '⚠ 自动保存并返回', okText: '保存并返回', cancelText: '直接返回' }
      );
      if (ok) {
        await this.saveToRecords({ skipConfirm: true });
        this._backToWorkbench();  // 保存并返回：真正导航回工作台（展示本次盘点概览）
        return;
      }
      // 用户选择「直接返回」→ 丢弃现场
    }
    // 🟢 v227.3：返回工作台前清空现场（不调 finish/abandon —— 它们会写记录/同步云端）
    this._backToWorkbench();
  },

  _backToWorkbench() {
    // 🟢 v227.5：先记住入口类型（this.sheet 在下面会被清空，不能用 sheet.sheetType 判断）
    const entry = this._entrySheetType;
    this.sheet = null;
    this.allRows = [];
    this.allRowsFull = [];
    this.task.started = false;
    this.task.noStart = null;
    this.task.noEnd = null;
    this.task.assignedTaskId = null;
    this.task.counter = '';
    this._sheetTouched = null;
    // 🟢 v227.5：按入口类型导航回对应初始界面（季度入口 → 季度任务选择器；日常入口 → 日常日期选择）
    if (entry === 'quarter') this.startQuarter();
    else this.startDaily();
  },

  _markSheetTouched(kind) {
    if (!this._sheetTouched) this._sheetTouched = { saved: false, finished: false, abandoned: false };
    this._sheetTouched[kind] = true;
  },

  // ===== v217 任务分派 / 领取（固化编码清单）=====
  // 全库存货编码升序（与 buildRows 同排序，保证多设备序号一致）
  async _allStockCodesSorted() {
    const stock = await DataStore.getRows('stock');
    const codes = (stock || []).map(s => String(s.存货编码 == null ? '' : s.存货编码).trim()).filter(Boolean);
    codes.sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
    return codes;
  },
  // 登录态下自动领用分配给本人的第一个 open 任务
  async _applyAssignedIfAny() {
    if (!(typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn && AppConfig.isLoggedIn())) return;
    const u = AppConfig.getCurrentUser();
    if (!u || !u.username) return;
    // v217：管理员在别的设备分派的任务，本地看不到 —— 先拉一次云端再领用
    await this._syncAssignedTasks(4000);
    const tasks = DataStore.getMyOpenTasks(u.username);
    if (tasks.length) this._setAssignedRows(tasks[0]);
  },
  // 🟢 v225.2：拉取「他人分派给我的任务」的统一入口。
  //   为什么必须存在：任务写在分派人的 localStorage 里，靠云端 settings 通道跨设备传递。
  //   带超时 + 吞异常 —— 同步是增强，失败只影响任务可见性，绝不能阻断盘点本身。
  async _syncAssignedTasks(timeoutMs) {
    try {
      const r = await Promise.race([
        DataStore.pullStocktakeTasksFromCloud(),
        new Promise(res => setTimeout(() => res(-1), timeoutMs || 3000))
      ]);
      this._lastTaskSyncAt = Date.now();
      return r;
    } catch (e) {
      return 0;   // 离线/异常都不影响进入模块
    }
  },
  // v225.2：任务栏手动刷新（网络慢导致进入模块那次超时时的自愈入口）
  async refreshMyTasks(silent) {
    const btn = document.getElementById('stTaskRefresh');
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      if (typeof SyncManager !== 'undefined' && !SyncManager.isOnline) {
        if (!silent) this.toast('当前离线，无法从云端同步任务');
        return;
      }
      const n = await this._syncAssignedTasks(8000);
      this._refreshTaskBar();
      const my = (AppConfig.getCurrentUser() || {}).username;
      const cnt = my ? (DataStore.getMyOpenTasks(my) || []).length : 0;
      if (!silent) {
        this.toast(n > 0 ? ('已同步 ' + n + ' 项任务变更，你有 ' + cnt + ' 个待办任务')
                         : (cnt ? ('云端无新变更，你有 ' + cnt + ' 个待办任务') : '云端暂无分配给你的任务'));
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 刷新任务'; }
    }
  },
  // 仅设置数据（不渲染），供自动领用复用
  _setAssignedRows(task) {
    const codes = (task.codes || []).filter(Boolean);
    if (codes.length && this.allRowsFull && this.allRowsFull.length) {
      const map = {};
      this.allRowsFull.forEach(r => { map[r.存货编码] = r; });
      const rows = codes.map(c => map[c]).filter(Boolean);
      this.allRows = rows.length ? rows : this.allRowsFull.slice();
    }
    this.task.counter = task.counter;
    this.task.noStart = task.noStart;
    this.task.noEnd = task.noEnd;
    this.task.started = true;
    this.task.assignedTaskId = task.taskId;
  },
  // 🟢 v227.5：补盘专用的「按任务编码 + 已盘编码过滤」 —— 只保留任务清单中、本人尚未盘过的编码
  //   （确保补盘入口进入后不会再次呈现已盘项，避免重复盘点）
  async _setAssignedRowsReplenish(task) {
    const codes = (task.codes || []).filter(Boolean);
    const counted = await this._countedCodesForQuarter(task.sheetId || (this.sheet && this.sheet.sheetId) || '', task.counter);
    const remain = codes.filter(c => !counted.has(c));
    if (remain.length && this.allRowsFull && this.allRowsFull.length) {
      const map = {};
      this.allRowsFull.forEach(r => { map[r.存货编码] = r; });
      const rows = remain.map(c => map[c]).filter(Boolean);
      this.allRows = rows.length ? rows : [];
    } else {
      this.allRows = [];
    }
    this.task.counter = task.counter;
    this.task.noStart = task.noStart;
    this.task.noEnd = task.noEnd;
    this.task.started = true;
    this.task.assignedTaskId = task.taskId;
  },
  // 手动在「我的任务」下拉切换
  // 🟢 v227：任务框「点击任务 → 直接进入季度盘点」（无需先点季度盘点再领取）。
  //   正在盘点中时先确认，避免误点切换导致现场丢失。
  async onMyTaskChange() {
    const sel = document.getElementById('stMyTask');
    if (!sel || !sel.value) return;                 // 「无任务」→ 不动作
    const task = DataStore.getStocktakeTasks()[sel.value];
    if (!task) return;

    // 若已开盘且有未填数据 → 先确认（_setAssignedRows 只在已开盘时做局部切换）
    const busy = this.allRows && this.allRows.length && this._isFilledSomething();
    if (busy) {
      const ok = await WBModal.confirm(
        '当前盘点尚未结束，切换到该任务会离开现在的盘点现场。\n\n未结束的数据仍会保留在本地草稿中，可从盘点记录继续。确认切换？',
        { title: '⚠ 切换盘点任务' });
      if (!ok) { this._refreshTaskBar(); return; }
    }
    await this._claimQuarterTask(sel.value);
  },

  /** 当前现场是否已填过数量（用于切换任务前的确认判断） */
  _isFilledSomething() {
    return (this.allRows || []).some(r => r.盘点数量 !== '' && r.盘点数量 != null);
  },
  // ---------------- v217 任务栏（常驻模块顶部）----------------
  // 登录后才出现；无需先加载盘点数据即可分派。
  // 🟢 v227.68：顶部常驻任务栏（#stTaskBar）已整体删除 —— 刷新任务按钮改置于季度作业视图
  //   「📋 我的任务」卡片标题旁（见 _renderQuarterTaskPicker）；分派任务在 _renderAdminBatchBlock 内。
  //   故此 _taskBarHtml() 不再需要，已移除，避免遗留已删除 UI 的死代码。



  /**
   * 🟢 v227：进入盘点模块时，若有新分派给自己的季度盘点任务 → 弹窗提示。
   *   已提示过的 taskId 记入 localStorage，避免每次进模块重复弹。
   */
  _notifyNewTasks() {
    try {
      if (typeof WBModal === 'undefined' || typeof WBModal.alert !== 'function') return;
      if (typeof AppConfig === 'undefined' || !AppConfig.getCurrentUser) return;
      const u = AppConfig.getCurrentUser();
      const c = u ? u.username : '';
      if (!c) return;
      const tasks = (typeof DataStore !== 'undefined' && DataStore.getMyOpenTasks)
        ? (DataStore.getMyOpenTasks(c) || []) : [];
      if (!tasks.length) return;

      let seen = [];
      try { seen = JSON.parse(localStorage.getItem(this.TASK_SEEN_KEY) || '[]') || []; } catch (e) { seen = []; }
      const fresh = tasks.filter(t => t && t.taskId && seen.indexOf(t.taskId) < 0);
      if (!fresh.length) return;
      try { localStorage.setItem(this.TASK_SEEN_KEY, JSON.stringify(seen.concat(fresh.map(t => t.taskId)))); } catch (e) { /* 忽略 */ }

      const lines = fresh.map(t => `· ${t.counter} · 序号 ${t.noStart}-${t.noEnd} · ${(t.codes || []).length} 项`).join('\n');
      WBModal.alert('你有新分配季度盘点任务：\n\n' + lines +
        '\n\n请在季度盘点「我的任务」中点击该任务，即可直接进入季度盘点。',
        { title: '🔔 新分配任务' });
    } catch (e) { console.warn('[stocktake] 新任务提示失败(已忽略):', e && e.message); }
  },

  /**
   * 🟢 v227：进入盘点模块时，若存在未结束的盘点会话 → 弹窗提醒。
   *   会话标记（OPEN_KEY）在开局时写入，只有点【盘点结束】/【放弃本次盘点】才清除。
   */
  _notifyUnfinished() {
    try {
      if (typeof WBModal === 'undefined' || typeof WBModal.alert !== 'function') return;
      const raw = localStorage.getItem(this.OPEN_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s || !s.sheetId) return;
      const typeCn = s.sheetType === 'quarter' ? '季度' : '日常';
      // 🟢 v228.0（P1-8 修复）：WBModal 用 textContent 渲染正文（modal.js 第 83 行），不解析 HTML，
      //   这里原写的是 '你有<b>未结束</b>的…'，用户会直接看到裸的 <b> 标签。改为纯文本强调。
      WBModal.alert(
        '你有「未结束」的' + typeCn + '盘点（盘点号 ' + esc(s.batchNo || s.sheetId) + '）。\n\n' +
        '· 点【保存】= 暂停，数据只存本地草稿，下次可继续；\n' +
        '· 全部盘完请点【盘点结束】才算完成，并写入盘点记录、同步云端。',
        { title: '⏸ 未结束的盘点' });
    } catch (e) { console.warn('[stocktake] 未结束提醒失败(已忽略):', e && e.message); }
  },

  // 🟢 v227.68：顶部任务栏已删除，刷新语义改为「重新渲染季度作业视图（选择器）」。
  // 仅当当前正处于季度作业视图、且 picker 已渲染时生效；日常盘点 / 初始工作台下为空操作。
  _refreshTaskBar() {
    if (this._entrySheetType !== 'quarter') return;
    const area = document.getElementById('stArea');
    if (!area || !area.querySelector('.quarter-status-bar')) return; // picker 未渲染
    this._renderQuarterTaskPickerFromState();
  },

  // 🟢 v227.68：依据上次作业视图上下文，从本地数据重算任务列表并重渲染「我的任务 / 本批次全部任务 / 补盘」，
  // 让分派、取消、结束、刷新等操作即时反映在视图上（不重触发续盘检测 / 概览轮询）。
  _renderQuarterTaskPickerFromState() {
    const ctx = this._pickerCtx;
    if (!ctx) return;
    const { sd, ed, sheetId, counter, batchNo } = ctx;
    const allTasks = DataStore.getStocktakeTasks() || {};
    const myTasks = counter ? (DataStore.getMyOpenTasks(counter) || []) : [];
    const myClosed = counter
      ? Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
          t && t.counter === counter && t.status === 'closed' && this._taskInCurrentBatch(t, sd, ed))
      : [];
    const sameBatchAll = Object.keys(allTasks)
      .map(k => allTasks[k])
      .filter(t => this._taskInCurrentBatch(t, sd, ed));
    this._renderQuarterTaskPicker(sd, ed, sheetId, myTasks, sameBatchAll, counter, myClosed, batchNo);
  },

  // ===== v227.5：本次盘点概览（quarter）=====
  // —— 每人每次季度盘点一条，本地 localStorage + 云端 stocktake.json 共用一个对象。
  // —— 结构：{ counter, batchNo, sheetId, sd, ed, totalCount, realCount, zeroCount, unfilledCount,
  //         completionRate, status, finishedAt, noStart, noEnd, updatedAt }
  // —— status: 'in_progress' 保存阶段 / 'finished' 盘点结束 / 'abandoned' 放弃本次
  // 🟢 身份用 sheetId（季度批次的稳定标识），不用 batchNo —— 批次号每轮会自增后缀（-2/-3…）
  _overviewKey(counter, sheetId) { return String(counter || '') + '::' + String(sheetId || ''); },

  _getAllOverviews() {
    try { return JSON.parse(localStorage.getItem(this.OVERVIEW_KEY) || '{}') || {}; } catch (e) { return {}; }
  },

  _saveOverviews(map) {
    try { localStorage.setItem(this.OVERVIEW_KEY, JSON.stringify(map || {})); } catch (e) { /* 忽略 */ }
  },

  // ===== v227.16：仓库离线容错 —— 跨设备 key-value 推送（批次状态/概览/轮次）本地待推队列 =====
  // 背景：SyncManager.setSetting 离线时直接 return false 且无线下重试，断网期间管理员点的
  //   「结束批次 / 开下一轮 / 指派补盘 / 概览更新」推云端全部静默失败，恢复网络后也不补推，
  //   其他设备长时间看不到最新状态（仓库弱网常态）。用本地队列承接失败推送，联网后自动补推。
  //   注：盘点记录本身的 recId 重试走 _markPending/retryPendingSync，本队列专管 settings 通道的 key-value。
  CLOUD_Q: 'wb_stocktake_cloud_q',

  _getCloudQueue() {
    try { return JSON.parse(localStorage.getItem(this.CLOUD_Q) || '[]') || []; } catch (e) { return []; }
  },
  _saveCloudQueue(arr) {
    try { localStorage.setItem(this.CLOUD_Q, JSON.stringify(arr || [])); } catch (e) { /* 忽略 */ }
  },
  // 入队（同 key 只保留最新一份，避免堆积）
  _enqueueCloud(key, value) {
    try {
      const q = this._getCloudQueue();
      const i = q.findIndex(x => x.key === key);
      const item = { key, value, ts: Date.now() };
      if (i >= 0) q[i] = item; else q.push(item);
      this._saveCloudQueue(q);
    } catch (e) { /* 忽略 */ }
  },
  // 统一推送入口：在线则直推，离线/失败则入队
  async _setCloud(key, value) {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline || typeof SyncManager.setSetting !== 'function') {
      this._enqueueCloud(key, value); return false;
    }
    try {
      const ok = await SyncManager.setSetting(key, value);
      if (!ok) this._enqueueCloud(key, value);
      return ok;
    } catch (e) { this._enqueueCloud(key, value); return false; }
  },
  // 联网后补推队列（由 online 事件 + picker 打开时触发）
  async _flushCloudQueue() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline || typeof SyncManager.setSetting !== 'function') return 0;
    const q = this._getCloudQueue();
    if (!q.length) return 0;
    const remain = [];
    let n = 0;
    for (const it of q) {
      try {
        let value = it.value;
        // 🟢 v227.67：ROUND_CLOSED_KEY 是聚合态，离线回放整包覆盖会抹掉其他设备已结束轮次 → 先与云端并集
        if (it.key === this.ROUND_CLOSED_KEY && value && typeof value === 'object') {
          try {
            const remote = await SyncManager.getSettings();
            const rmap = (remote && remote[this.ROUND_CLOSED_KEY]) || null;
            if (rmap && typeof rmap === 'object') value = Object.assign({}, rmap, value);
          } catch (e) { /* 忽略 */ }
        }
        const ok = await SyncManager.setSetting(it.key, value); if (ok) n++; else remain.push(it);
      }
      catch (e) { remain.push(it); }
    }
    this._saveCloudQueue(remain);
    if (n > 0) console.log('[stocktake] 离线队列补推 ' + n + ' 条云端设置');
    return n;
  },

  /** 计算当前 sheet 的概览数据（已盘/任务总数/任务完成率） */
  async _computeQuarterOverview() {
    const sheet = this.sheet;
    if (!sheet || sheet.sheetType !== 'quarter') return null;
    const counter = String(this.task.counter ||
      ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '')
    ).trim();
    if (!counter) return null;
    // 🟢 v227.5 稳健取数：退出填表（结束/放弃）后 allRows 已被清空，
    //   必须从分派任务的固化编码清单取总数，否则 total 会算成 0。
    let taskCodes = [];
    if (this.task.assignedTaskId) {
      const t = (DataStore.getStocktakeTasks() || {})[this.task.assignedTaskId];
      if (t && Array.isArray(t.codes) && t.codes.length) taskCodes = t.codes.slice();
    }
    if (!taskCodes.length && this.allRowsFull && this.allRowsFull.length) {
      taskCodes = this.allRowsFull.map(r => r.存货编码).filter(Boolean);
    }
    let totalCount = taskCodes.length;
    if (!totalCount && this.task.noStart && this.task.noEnd) totalCount = this.task.noEnd - this.task.noStart + 1;
    // ③ 当前会话未落库的编辑值 —— 【保存】只是存草稿不落库，
    //    不合并草稿的话「保存后概览」已盘数会一直是 0。
    //    ⚠️ 必须在 await 之前抓取：_resetStocktakingSession 调用本方法后会立刻清空 allRows。
    const liveMap = new Map();
    try {
      const rows = (this.allRows && this.allRows.length) ? this.allRows : (this.visibleRows ? this.visibleRows() : []);
      (rows || []).forEach(r => { if (r && r.存货编码) liveMap.set(r.存货编码, r.盘点数量); });
    } catch (e) { /* 忽略 */ }
    // 实盘 / 0 / 未盘 / 差异：从落库记录统计（已落库的才算"盘点过"，未盘点的不算）
    let realCount = 0, zeroCount = 0, unfilledCount = 0, diffCount = 0;
    const recMap = new Map();
    try {
      const recs = (await DataStore.getStocktakeRecordsBySheet(sheet.sheetId)) || [];
      recs.forEach(r => {
        if (r.voided || !r.存货编码) return;
        if (String(r.盘点人 || '').trim() !== counter) return;
        const prev = recMap.get(r.存货编码);
        if (!prev || String(r.updatedAt || '') >= String(prev.updatedAt || '')) recMap.set(r.存货编码, r);
      });
    } catch (e) { console.warn('[stocktake] 概览统计失败:', e && e.message); }
    const classify = (q) => {
      if (q === '' || q == null) { unfilledCount++; return; }
      if (parseFloat(q) === 0) zeroCount++; else realCount++;
    };
    if (taskCodes.length) {
      const seen = new Set();
      taskCodes.forEach(code => {
        if (seen.has(code)) return;
        seen.add(code);
        const rec = recMap.get(code);
        if (rec && !rec.unfilled) { classify(rec.盘点数量); return; }
        if (liveMap.has(code)) { classify(liveMap.get(code)); return; }
        unfilledCount++;
      });
    } else {
      // 无固化清单（自建区间）→ 直接按本人落库记录 + 当前编辑值统计
      const merged = new Map(recMap);
      liveMap.forEach((q, code) => { if (!merged.has(code)) merged.set(code, { 盘点数量: q }); });
      merged.forEach(rec => {
        if (rec.unfilled) unfilledCount++;
        else classify(rec.盘点数量);
      });
    }
    const countedCount = realCount + zeroCount;
    if (!totalCount) totalCount = countedCount + unfilledCount;
    const completionRate = totalCount > 0 ? Math.round((countedCount / totalCount) * 100) : 0;
    // 🟢 v227.7：差异数 = 盘点数量 − 现存量 不为 0 的项数（含溢余与盘亏）
    //   现存量必须从 stock 表取真实账面值，不能用 recs.现存量（分派任务下 allRows 的现存量可能是 0）
    try {
      const stockMap = new Map();
      try {
        const stocks = (DataStore && typeof DataStore.getStock === 'function') ? await DataStore.getStock() : [];
        (stocks || []).forEach(s => { if (s && s.存货编码 != null) stockMap.set(s.存货编码, s.现存量); });
      } catch (e) { /* 忽略：getStock 失败时差异数退化为 0 */ }
      recMap.forEach((rec, code) => {
        if (rec.unfilled) return;
        const q = rec.盘点数量;
        if (q === '' || q == null) return;
        const stock = stockMap.has(code) ? stockMap.get(code) : (rec.现存量);
        const d2 = Math.round((parseFloat(q) - (parseFloat(stock) || 0)) * 100) / 100;
        if (d2 !== 0) diffCount++;
      });
      // 补：仅 liveMap 有而未落库的当前编辑值（保存阶段但还没落库的场景）
      if (taskCodes.length) {
        taskCodes.forEach(code => {
          if (recMap.has(code)) return;
          if (!liveMap.has(code)) return;
          const q = liveMap.get(code);
          if (q === '' || q == null) return;
          const stock = stockMap.get(code);
          if (stock == null) return;
          const d2 = Math.round((parseFloat(q) - (parseFloat(stock) || 0)) * 100) / 100;
          if (d2 !== 0) diffCount++;
        });
      }
    } catch (e) { /* 忽略 */ }
    return {
      counter,
      batchNo: sheet.batchNo || '',
      sheetId: sheet.sheetId,
      sd: sheet.startDate || '',
      ed: sheet.endDate || '',
      totalCount,
      realCount,
      zeroCount,
      unfilledCount,
      diffCount,
      countedCount,
      completionRate,
      status: 'in_progress',
      finishedAt: '',
      noStart: this.task.noStart || null,
      noEnd: this.task.noEnd || null,
      updatedAt: new Date().toISOString()
    };
  },

  /**
   * 落地概览：本地 + 同步到云端。
   * - finished 用于区分"盘点结束"（finished=true）与"放弃"（finished=false）
   * - 自动聚合本次盘点的真实盘点数据，覆盖 any older entry（同 counter+batchNo 同 key）
   */
  async _publishQuarterOverview({ finished = false, finishedAt = '' } = {}) {
    const sheet = this.sheet;
    if (!sheet || sheet.sheetType !== 'quarter') return null;
    const data = await this._computeQuarterOverview();
    if (!data) return null;
    data.status = finished ? 'finished' : (data.status || 'in_progress');
    if (finished) data.finishedAt = finishedAt || new Date().toISOString();
    const map = this._getAllOverviews();
    map[this._overviewKey(data.counter, data.sheetId)] = data;
    this._saveOverviews(map);
    // 推云端（写入 settings.json 中的 stocktake 段）
    try {
      if (typeof SyncManager !== 'undefined' && typeof SyncManager.setSetting === 'function') {
        // 🟢 v227.16：走统一推送入口（离线自动入队，联网后补推）
        await this._setCloud(this.OVERVIEW_KEY, map);
      }
    } catch (e) { console.warn('[stocktake] 概览推云端失败(已忽略):', e && e.message); }
    // 🟢 v227.5+：本端保存/结束落地概览后，广播给其它打开 picker 的标签/窗口即时刷新；
    //   同浏览器多管理员视图能秒级看到新进度；不同浏览器靠 8s 轮询兜底
    try { this._broadcastOverviewUpdate({ counter: data.counter, sheetId: data.sheetId, status: data.status, updatedAt: data.updatedAt }); } catch (e) { /* 忽略 */ }
    return data;
  },

  /** 从云端拉概览，合并到本地（最新 updatedAt 胜出）。返回 true 表示有变更 */
  async _pullQuarterOverviews() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    if (typeof SyncManager.getSettings !== 'function') return false;
    try {
      const remote = await SyncManager.getSettings();
      const rmap = (remote && remote[this.OVERVIEW_KEY]) || null;
      if (!rmap || typeof rmap !== 'object') return false;
      const local = this._getAllOverviews();
      // 🟢 v227.5+：判定「是否有新变更」—— 比较远端每个 key 的 updatedAt 与本地
      let hasNew = false;
      const merged = Object.assign({}, local, rmap);
      Object.keys(merged).forEach(k => {
        const a = local[k], b = rmap[k];
        if (a && b) {
          const pick = (String(b.updatedAt || '') >= String(a.updatedAt || '')) ? b : a;
          merged[k] = pick;
          if (!hasNew && a !== pick) hasNew = true;
        } else if (b && !a) { merged[k] = b; hasNew = true; }
      });
      if (hasNew) {
        this._saveOverviews(merged);
        // 同步批次结束标记
        const rcMap = (remote && remote[this.ROUND_CLOSED_KEY]) || null;
        if (rcMap && typeof rcMap === 'object') {
          const localRc = this._getRoundClosed();
          const mergedRc = Object.assign({}, localRc, rcMap);
          this._saveRoundClosed(mergedRc);
        }
      }
      return hasNew;
    } catch (e) { console.warn('[stocktake] 拉云端概览失败(已忽略):', e && e.message); return false; }
  },

  // ===== v227.5+：BroadcastChannel 实时同步 =====
  /** 注册一次（同浏览器多标签用）—— 接收「其他标签的概览落地」消息后，重渲 picker */
  _ensureOverviewChannel() {
    try {
      // 🟢 v227.16：绑定一次「最近交互」标记 —— 供轻量重渲守卫使用，避免轮询在用户操作时被挡死
      if (!this._pickerInputBound) {
        const mark = () => {
          this._pickerInteracting = true;
          clearTimeout(this._pickerInputTimer);
          this._pickerInputTimer = setTimeout(() => { this._pickerInteracting = false; }, 1200);
        };
        document.addEventListener('mousedown', (e) => { if (e && e.target && e.target.closest && e.target.closest('#stArea')) mark(); });
        document.addEventListener('keydown', (e) => { if (e && e.target && e.target.closest && e.target.closest('#stArea')) mark(); }, true);
        // 🟢 v227.16：联网后自动补推离线队列（批次状态/概览/任务）与盘点记录
        window.addEventListener('online', () => { try { this._flushCloudQueue(); this.retryPendingSync(); } catch (e) {} });
        this._pickerInputBound = true;
      }
      if (this._overviewChannel) return;
      if (typeof BroadcastChannel === 'undefined') return;
      const ch = new BroadcastChannel('wb_stocktake_overview');
      ch.onmessage = async (ev) => {
        // 🟢 收到其他标签的广播 → 拉云端（在线时）+ 本地轻量重渲
        //   离线也要重渲：同浏览器多标签共享 localStorage，本机进度照样能同步
        try { await this._refreshQuarterPickerIfShown(); } catch (e) { /* 忽略 */ }
      };
      this._overviewChannel = ch;
      // storage 事件兜底（部分浏览器对 BroadcastChannel 支持不一致，且仅同源多窗口）
      if (!this._overviewStorageBound) {
        window.addEventListener('storage', (ev) => {
          if (ev && (ev.key === this.OVERVIEW_KEY || ev.key === this.ROUND_CLOSED_KEY)) {
            try { this._refreshQuarterPickerIfShown(); } catch (e) {}
          }
        });
        this._overviewStorageBound = true;
      }
    } catch (e) { /* 忽略 —— 降级为纯轮询 */ }
  },

  /** 推送一次广播；同浏览器其他标签会立即收到并刷新 */
  _broadcastOverviewUpdate(payload) {
    try {
      if (this._overviewChannel) this._overviewChannel.postMessage(Object.assign({ type: 'overviewUpdated' }, payload || {}));
    } catch (e) { /* 忽略 */ }
  },

  /** 如果当前在季度任务选择器（picker），按最新数据重渲（不刷新整个模块） */
  async _refreshQuarterPickerIfShown() {
    try {
      const area = document.getElementById('stArea');
      if (!area) return false;
      const inPicker = /季度盘点需由管理员分派/.test(area.innerText || '');
      const inSheet = !!(this.sheet && this.sheet.sheetType === 'quarter');
      if (!inPicker || inSheet) return false;
      // 在线才拉云端；离线时纯靠本地数据重渲（同浏览器多标签/本机多账号仍可实时）
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
        try { await this._pullQuarterOverviews(); } catch (e) { /* 忽略 */ }
        try { await this._pullRoundClosed(); } catch (e) { /* 忽略 */ }
      }
      return this._refreshQuarterPickerLight();
    } catch (e) { return false; }
  },

  /**
   * 🟢 v227.5+：picker 轻量重渲 —— 纯本地取数、零网络、不触发续盘检测。
   *   不能复用 startQuarter()：它内含 _syncAssignedTasks(4s) 网络等待 + 续盘弹窗判定，
   *   8 秒轮询扛不住，且会把停在 picker 上的用户莫名弹走。
   */
  _refreshQuarterPickerLight() {
    try {
      const area = document.getElementById('stArea');
      if (!area) return false;
      if (this.sheet && this.sheet.sheetType === 'quarter') return false;
      if (!/季度盘点需由管理员分派/.test(area.innerText || '')) return false;
      // 🟢 v227.16 修复：原 `:hover` 守卫会让「鼠标停在盘点区域」时 8s 轮询永远跳过重渲，
      //    导致结束/保存后的概览迟迟不刷新（用户最需要时反而不工作）。改为仅「最近 1.2s 内有
      //    点击/键盘交互」才跳过重渲，避免点按钮瞬间 DOM 重建使点击落空，其余时刻正常刷新。
      if (this._pickerInteracting) return false;
      // 🟢 v227.8：轮询重渲也要锚定未结束会话，否则跨天后 picker 会漂到新区间（与 startQuarter 不一致）
      this._anchorRangeToOpenSession();
      this._ensureDefaultRange();
      const sd = this.query.startDate, ed = this.query.endDate;
      const sheetId = 'quarter_' + sd.slice(5) + '_' + ed.slice(5);
      const counter = String(((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser)
        ? ((AppConfig.getCurrentUser() || {}).username || '') : '') || this.task.counter || '').trim();
      const allTasks = DataStore.getStocktakeTasks() || {};
      const myTasks = counter ? (DataStore.getMyOpenTasks(counter) || []) : [];
      const myClosed = counter
        ? Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
            t && t.counter === counter && t.status === 'closed' && this._taskInCurrentBatch(t, sd, ed))
        : [];
      const sameBatchAll = Object.keys(allTasks)
        .map(k => allTasks[k])
        .filter(t => this._taskInCurrentBatch(t, sd, ed));
      this.batchNo = this._genBatchNo('quarter', sheetId);
      this._renderQuarterTaskPicker(sd, ed, sheetId, myTasks, sameBatchAll, counter, myClosed, this.batchNo);
      return true;
    } catch (e) { return false; }
  },

  /**
   * picker 打开时启动 8s 轮询；离开 picker 时清掉。
   * 🟢 v227.5+：不再由 isOnline 门控 —— 离线/弱网（仓库常态）也要能靠本地数据刷新；
   *   在线时额外拉云端，离线时跳过云端只做本地重渲。
   */
  _startOverviewPolling() {
    this._stopOverviewPolling();
    this._overviewPollTimer = setInterval(async () => {
      try {
        if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
          try {
            const changed = await this._pullQuarterOverviews();
            if (changed) { try { await this._pullRoundClosed(); } catch (e) {} }
          } catch (e) { /* 忽略 */ }
        }
        // 无论在线与否都按最新本地数据重渲（分派任务/他人进度落在本地时同样生效）
        // 页面在后台时跳过：不可见时重渲纯属浪费，切回前台后下一轮会补上
        if (typeof document === 'undefined' || !document.hidden) this._refreshQuarterPickerLight();
      } catch (e) { /* 忽略 */ }
    }, 8000);
  },
  _stopOverviewPolling() {
    if (this._overviewPollTimer) { clearInterval(this._overviewPollTimer); this._overviewPollTimer = null; }
  },

  /** 查找某人某批次已盘过的编码集合（从 stocktake_records 聚合）
   *  🟢 v227.5：只算「真正盘过」的 —— 未盘点占位记录（unfilled / 盘点数量为空）必须排除，
   *    否则补盘时漏盘项会被当成已盘过滤掉，进去只剩一张空表（需求7）。
   */
  async _countedCodesForQuarter(sheetId, counter) {
    const map = new Set();
    try {
      const recs = (await DataStore.getStocktakeRecordsBySheet(sheetId)) || [];
      recs.filter(r => !r.voided && String(r.盘点人 || '').trim() === counter).forEach(r => {
        if (!r.存货编码) return;
        if (r.unfilled || r.盘点数量 === '' || r.盘点数量 == null) return;
        map.add(r.存货编码);
      });
    } catch (e) { /* 忽略 */ }
    return map;
  },

  // ===== v227.5：结束本批次（季度盘点 round）=====
  _getRoundClosed() {
    try { return JSON.parse(localStorage.getItem(this.ROUND_CLOSED_KEY) || '{}') || {}; } catch (e) { return {}; }
  },
  _saveRoundClosed(map) {
    try { localStorage.setItem(this.ROUND_CLOSED_KEY, JSON.stringify(map || {})); } catch (e) { /* 忽略 */ }
  },
  isQuarterRoundClosed(sheetId) {
    if (!sheetId) return false;
    return !!(this._getRoundClosed())[sheetId];
  },

  // 🟢 v227.12：当前轮次号（默认 1）—— 支撑「开下一轮」与选择器「第 N 轮」展示
  _getRoundNo(sheetId) {
    if (!sheetId) return 1;
    try {
      const m = JSON.parse(localStorage.getItem(this.ROUND_NO_KEY) || '{}') || {};
      const n = parseInt(m[sheetId], 10);
      return (n >= 1) ? n : 1;
    } catch (e) { return 1; }
  },
  async _setRoundNo(sheetId, n) {
    if (!sheetId) return;
    try {
      const m = JSON.parse(localStorage.getItem(this.ROUND_NO_KEY) || '{}') || {};
      m[sheetId] = n;
      localStorage.setItem(this.ROUND_NO_KEY, JSON.stringify(m));
      if (typeof SyncManager !== 'undefined' && typeof SyncManager.setSetting === 'function') {
        try { await this._setCloud(this.ROUND_NO_KEY, m); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
  },
  // 已结束的轮次号（endQuarterRound 写入 roundClosed[sheetId].round）；未结束返回 null
  _getClosedRound(sheetId) {
    if (!sheetId) return null;
    const rc = (this._getRoundClosed())[sheetId];
    return (rc && rc.round) ? rc.round : null;
  },

  /** 管理员或 stocktakeAssign 权限者点击【本次季度盘点结束】—— 强行收尾本批次
   *  🟢 v227.9：除标记 round closed 外，还要把本批次所有 open 任务一律标 closed
   *   （包括盘点人正在进行的），并为每位盘点人发布一份 finished 概览，保证：
   *     - 管理员视图后面所有盘点人状态立即变为「⛔ 已结束」而非「🟡 进行中」
   *     - 盘点人端 picker 拒绝再进入盘点
   *     - 已落库的盘点记录不动，未落库的随任务一并作废
   */
  async endQuarterRound(sheetId) {
    const c = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '').trim();
    const hasPerm = (typeof AppConfig !== 'undefined' && typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin())
      || ((typeof AppConfig !== 'undefined' && typeof AppConfig.getKeeperModules === 'function') && (AppConfig.getKeeperModules(c) || []).indexOf('stocktakeAssign') !== -1);
    if (!hasPerm) { this.toast('只有管理员或具备【查看/分派盘点任务】权限的库管员可结束本批次'); return; }
    if (!sheetId) { this.toast('批次标识缺失'); return; }
    const batchNo = String(this.batchNo || sheetId);

    // 统计本批次 open / 进行中情况，确认提示
    const allTasks = DataStore.getStocktakeTasks() || {};
    const batchTasks = Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
      t && t.sheetType === 'quarter' && this._taskInCurrentBatch(t,
        (allTasks[sheetId] && allTasks[sheetId].startDate) || this.query.startDate,
        (allTasks[sheetId] && allTasks[sheetId].endDate) || this.query.endDate));
    const openCount = batchTasks.filter(t => t.status !== 'closed').length;
    const counters = Array.from(new Set(batchTasks.map(t => t.counter).filter(Boolean)));

    const ok = await WBModal.confirm(
      '本次季度盘点结束（盘点号 ' + batchNo + '）？\n\n' +
      (openCount > 0
        ? '⚠️ 当前还有 ' + openCount + ' 个分派任务（含 ' + counters.length + ' 位盘点人）未结束。\n' +
          '  系统将强制结束所有盘点人的分派任务，等同于盘点人点击「盘点结束」；\n' +
          '  已落库的盘点记录保留并汇总到清单，未落库的随任务一并结束。\n\n'
        : '所有盘点人都已完成。\n\n') +
      '结束后本批次不可再进入盘点。是否继续？',
      { title: '本次季度盘点结束', okText: '确定结束', cancelText: '取消' }
    );
    if (!ok) return;

    // 1) 标记 round closed（先写本地 + 推云端）—— 🟢 v227.12：记录被关闭的是第几轮
    const map = this._getRoundClosed();
    map[sheetId] = { closedBy: c, closedAt: new Date().toISOString(), batchNo: batchNo, round: this._getRoundNo(sheetId) };
    this._saveRoundClosed(map);
    // 🟢 v228.0（P0-1）：管理员结束整个批次 → 释放该批次的盘点号（下次同批次开局才启用 -2）
    this._markBatchFinished(sheetId);
    // 🟢 v227.67：合并式推送（不再整包覆盖），避免把其他设备已结束的轮次从云端抹掉
    try { await this._setRoundClosedCloud(sheetId, map[sheetId]); }
    catch (e) { console.warn('[stocktake] 批次结束标记推云端失败(已忽略):', e && e.message); }

    // 2) 强制收尾：所有 open 任务标 closed + 推云端（保留 createdAt，补 closedAt/updatedAt）
    //    🟢 v227.15（G4）：收口范围额外纳入 replenishAssigned 任务 —— 这类任务 status 已是 closed
    //    （v227.14 设计：保持 closed 以复用补盘模式），故原本被 `status!=='closed'` 排除，导致
    //    「管理员指派补盘后、盘点人已保存补盘草稿但未点结束、管理员又强制结束」时草稿不落库。
    //    纳入后：有草稿则补录、无草稿(_commitRows 去重幂等)则跳过，安全无副作用。
    const now = new Date().toISOString();
    const stillOpen = batchTasks.filter(t => t.status !== 'closed' || t.replenishAssigned);
    const toSaveTasks = [];
    for (const t of stillOpen) {
      // 🟢 v227.13 P0-3：强制结束前，先落库该盘点人未结束的草稿进度（共享设备本机草稿可收口）
      try {
        const n = await this._commitCountingForTask(t, batchNo);
        if (n > 0) console.log('[stocktake] 强制结束补录 ' + n + ' 条（' + t.counter + '）');
      } catch (e) { console.warn('[stocktake] 强制结束补录失败(已忽略):', e && e.message); }
      t.status = 'closed';
      t.sheetId = t.sheetId || sheetId;
      t.closedAt = now;
      t.updatedAt = now;
      toSaveTasks.push(t);
    }
    // 一次性写回
    try {
      for (const t of toSaveTasks) {
        try { await DataStore.saveStocktakeTask(t); } catch (e) { /* 忽略单个写失败 */ }
      }
    } catch (e) { /* 忽略 */ }

    // 3) 给每位盘点人发布一份 finished 概览（含 0 项的也补上，否则管理员视图会留「尚未开启」）
    const sd = (batchTasks[0] && batchTasks[0].startDate) || this.query.startDate || '';
    const ed = (batchTasks[0] && batchTasks[0].endDate) || this.query.endDate || '';
    const overviewMap = this._getAllOverviews();
    for (const counter of counters) {
      const key = this._overviewKey(counter, sheetId);
      const existing = overviewMap[key];
      if (existing) {
        // 已有概览：仅标 finished、updatedAt，统计不动（盘点人已落库的实盘/未盘数保留）
        existing.status = 'finished';
        existing.updatedAt = now;
        overviewMap[key] = existing;
      } else {
        // 尚未开启盘点：补一份「0 项 / 已结束」概览，确保管理员视图不残留「尚未开启」
        overviewMap[key] = {
          counter, batchNo, sheetId, sd, ed,
          totalCount: 0, realCount: 0, zeroCount: 0, unfilledCount: 0,
          diffCount: 0, countedCount: 0, completionRate: 100,
          status: 'finished', finishedAt: now, noStart: null, noEnd: null,
          updatedAt: now,
          forceClosed: true   // 🟢 v227.9：管理员强制结束标记，盘点人端可识别为「非本人盘点结束」
        };
      }
    }
    this._saveOverviews(overviewMap);
    // 推云端（走 settings 通道，与概览落地同一链路）
    try {
      if (typeof SyncManager !== 'undefined' && typeof SyncManager.setSetting === 'function') {
        await this._setCloud(this.OVERVIEW_KEY, overviewMap);
      }
    } catch (e) { console.warn('[stocktake] 概览推云端失败(已忽略):', e && e.message); }

    // 4) 清掉所有盘点人的未结束会话（防止 picker 走续盘路径绕过 round closed 守卫）
    try {
      const sess = this._getOpenSession();
      if (sess && sess.sheetId === sheetId) this._clearOpenSession();
    } catch (e) { /* 忽略 */ }

    // 5) 广播给所有打开 picker 的标签即时刷新
    try { this._broadcastOverviewUpdate({ sheetId, updatedAt: now, forceClosed: true }); } catch (e) { /* 忽略 */ }

    this.toast('本次季度盘点已结束：' + batchNo + '（共收 ' + counters.length + ' 位盘点人）');
    if (this._entrySheetType === 'quarter') this.startQuarter();
  },

  /**
   * 🟢 v227.12：开下一轮季度盘点 —— 解决「管理员结束本批次后没法开始下一轮」的核心痛点。
   *   结束后 roundClosed[sheetId] 闸门锁死、所有入口禁用、重新分派也显示「已结束」。
   *   本方法：轮次 +1 → 解闸（删 roundClosed）→ 本批次任务重置为「待领取」→ 同步云端 → 重渲。
   *   说明：① 已落库的盘点记录（v227.10 已闭环进盘点记录列表）不动，下一轮是独立的新一轮复核；
   *        ② 任务重置为 open 后，盘点人「我的任务」重新可见可进入、管理员可重新分派，不再卡死。
   */
  // 🟢 v227.14：管理员「指派补盘」—— 批次已强制结束、但某人仍有漏盘时，指定他回来把漏的补上。
  //   设计要点（刻意不重建归属，避免重复行）：
  //   ① 不动 status（保持 closed）→ 补盘模式判定 `status==='closed' || replenishAssigned` 天然成立，
  //      _setAssignedRowsReplenish 直接过滤出「未盘编码」，无需改任何既有语义；
  //   ② 归属不变（仍是原 counter）→ 不违反 v223/v224 归属保护，且补盘写入走 v228.0 占位 UPSERT，
  //      就地更新原来那条「未盘」占位，不会产生「占位 + 实盘」两行；
  //   ③ 只在 roundClosed 硬守卫上给「带 replenishAssigned 标记的任务」开例外，范围可控。
  async assignReplenish(counter, sheetId) {
    const cur = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '').trim();
    const hasPerm = (typeof AppConfig !== 'undefined' && typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin())
      || ((typeof AppConfig !== 'undefined' && typeof AppConfig.getKeeperModules === 'function') && (AppConfig.getKeeperModules(cur) || []).indexOf('stocktakeAssign') !== -1);
    if (!hasPerm) { this.toast('只有管理员或具备【查看/分派盘点任务】权限的库管员可指派补盘'); return; }
    if (!counter || !sheetId) { this.toast('参数缺失，无法指派补盘'); return; }

    const allTasks = DataStore.getStocktakeTasks() || {};
    const inBatch = (t) => {
      if (!t || t.deleted || t.sheetType !== 'quarter' || t.counter !== counter) return false;
      if (t.sheetId && t.sheetId === sheetId) return true;
      if (t.startDate && t.endDate &&
          ('quarter_' + String(t.startDate).slice(5) + '_' + String(t.endDate).slice(5)) === sheetId) return true;
      return this._taskInCurrentBatch(t, this.query.startDate, this.query.endDate);
    };
    const tasks = Object.keys(allTasks).map(k => allTasks[k]).filter(inBatch);
    if (!tasks.length) { this.toast('未找到「' + counter + '」在本批次的任务'); return; }
    if (tasks.every(t => t.replenishAssigned)) {
      this.toast('已指派过补盘，等待「' + counter + '」完成后再看'); return;
    }

    let codesLen = 0; tasks.forEach(t => { codesLen += (t.codes || []).length; });
    const ok = await WBModal.confirm(
      '指派「' + counter + '」补盘？\n\n' +
      '· 该盘点人进入盘点后，系统只列出其「尚未盘过的编码」，已盘项不会重复出现；\n' +
      '· 归属保持不变（仍记在「' + counter + '」名下），补盘结果就地更新原「未盘」占位，不会多出重复行；\n' +
      '· 补盘完成后正常点「盘点结束」即可；本轮其他人的数据不受影响。\n\n' +
      '涉及 ' + tasks.length + ' 个区间 / 共 ' + codesLen + ' 项。',
      { title: '🔧 指派补盘', okText: '确认指派', cancelText: '取消' }
    );
    if (!ok) return;

    const now = new Date().toISOString();
    for (const t of tasks) {
      t.replenishAssigned = true;
      t.replenishAssignedAt = now;
      t.replenishAssignedBy = cur;
      t.updatedAt = now;
      try { await DataStore.saveStocktakeTask(t); }
      catch (e) { console.warn('[stocktake] 指派补盘写任务失败(已忽略):', e && e.message); }
    }
    // 广播：让在线盘点人的 picker 立刻出现「🔧 补盘」入口
    try { this._broadcastOverviewUpdate({ sheetId, counter, updatedAt: now, replenishAssigned: true }); }
    catch (e) { /* 忽略 */ }
    this.toast('已指派「' + counter + '」补盘（' + tasks.length + ' 个区间），其进入盘点后将只看到未盘编码');
    if (this._entrySheetType === 'quarter') this.startQuarter();
  },

  async startNextRound(sheetId) {
    const c = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '').trim();
    const hasPerm = (typeof AppConfig !== 'undefined' && typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin())
      || ((typeof AppConfig !== 'undefined' && typeof AppConfig.getKeeperModules === 'function') && (AppConfig.getKeeperModules(c) || []).indexOf('stocktakeAssign') !== -1);
    if (!hasPerm) { this.toast('只有管理员或具备【查看/分派盘点任务】权限的库管员可开下一轮'); return; }
    if (!sheetId) { this.toast('批次标识缺失'); return; }
    if (!this.isQuarterRoundClosed(sheetId)) { this.toast('本批次尚未结束，无需开下一轮'); return; }

    const prevRound = this._getClosedRound(sheetId) || this._getRoundNo(sheetId);
    const nextRound = prevRound + 1;
    const ok = await WBModal.confirm(
      '开启第 ' + nextRound + ' 轮季度盘点？\n\n' +
      '· 第 ' + prevRound + ' 轮已落库的盘点记录会原样保留在「盘点记录列表」（不删除、不覆盖）；\n' +
      '· 本批次所有分派任务将重置为「待领取」，盘点人可重新进入、管理员可重新分派；\n' +
      '· 本轮（第 ' + nextRound + ' 轮）将作为新一轮独立盘点，与第 ' + prevRound + ' 轮数据分开统计。',
      { title: '开下一轮季度盘点', okText: '开启第 ' + nextRound + ' 轮', cancelText: '取消' }
    );
    if (!ok) return;

    // 1) 轮次 +1（本地 + 云端）
    await this._setRoundNo(sheetId, nextRound);
    // 2) 解闸：删 roundClosed[sheetId]（本地 + 云端）
    const map = this._getRoundClosed();
    delete map[sheetId];
    this._saveRoundClosed(map);
    // 🟢 v227.67：合并式解闸（云端并集上删除该轮次，不抹掉其他轮次）
    try { await this._clearRoundClosedCloud(sheetId); }
    catch (e) { console.warn('[stocktake] 解闸推云端失败(已忽略):', e && e.message); }

    // 3) 清空上一轮全部分派任务（墓碑删除，而非重置为「待领取」）
    //    🟢 v227.16 修复：原实现把 closed 任务改回 open，导致上一轮任务在下一轮
    //    以「我的任务 · 进入盘点」形态复活（用户反馈图3）。按用户语义，开下一轮 =
    //    清空上一轮信息与任务，管理员重新分派；已落库的盘点记录保留在「盘点记录列表」。
    const allTasks = DataStore.getStocktakeTasks() || {};
    const batchTasks = Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
      t && t.sheetType === 'quarter' && this._taskInCurrentBatch(t,
        (allTasks[sheetId] && allTasks[sheetId].startDate) || this.query.startDate,
        (allTasks[sheetId] && allTasks[sheetId].endDate) || this.query.endDate));
    const now = new Date().toISOString();
    for (const t of batchTasks) {
      if (t.deleted) continue;
      // 🟢 v227.15（G9）：清掉该盘点人本批次的分区草稿 —— 避免旧草稿被新一轮认领带进新表
      try { localStorage.removeItem(this._draftKey(t.counter, t.sheetId)); } catch (e) {}
      try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
      // 墓碑删除任务（不保留为待领取，避免复活）；skipPush 后统一推一次
      try { await DataStore.deleteStocktakeTask(t.taskId, { skipPush: true }); } catch (e) { /* 忽略 */ }
    }
    try { await this._pushStocktakeTasksToCloud(); } catch (e) { /* 忽略 */ }

    // 3b) 清空本批次上一轮概览（让下一轮回到「未开始」态，而非继续显示「已结束/漏盘」）
    //     🟢 v227.16 修复：原实现不解概览，导致下一轮 picker 仍显示上一轮的「已盘 0/未盘 3 · 100%」。
    try {
      const ov = this._getAllOverviews();
      let changed = false;
      Object.keys(ov).forEach(k => { if (k.endsWith('::' + sheetId)) { delete ov[k]; changed = true; } });
      if (changed) {
        this._saveOverviews(ov);
        if (typeof SyncManager !== 'undefined' && typeof SyncManager.setSetting === 'function') {
          await this._setCloud(this.OVERVIEW_KEY, ov);
        }
      }
    } catch (e) { console.warn('[stocktake] 清上一轮概览失败(已忽略):', e && e.message); }

    // 4) 清掉所有盘点人的未结束会话（防止 picker 走续盘路径绕过新一轮闸门）
    try {
      const sess = this._getOpenSession();
      if (sess && sess.sheetId === sheetId) this._clearOpenSession();
    } catch (e) { /* 忽略 */ }

    // 5) 广播给所有打开 picker 的标签即时刷新
    try { this._broadcastOverviewUpdate({ sheetId, updatedAt: now, nextRound }); } catch (e) { /* 忽略 */ }

    this.toast('已开启第 ' + nextRound + ' 轮季度盘点（任务已重置为待领取，可重新分派/进入）');
    if (this._entrySheetType === 'quarter') this.startQuarter();
  },

  async _pullRoundClosed() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    if (typeof SyncManager.getSettings !== 'function') return;
    try {
      const remote = await SyncManager.getSettings();
      const rmap = (remote && remote[this.ROUND_CLOSED_KEY]) || null;
      if (!rmap || typeof rmap !== 'object') return;
      const local = this._getRoundClosed();
      const merged = Object.assign({}, local, rmap);
      this._saveRoundClosed(merged);
      // 🟢 v227.12：一并拉取轮次计数器，保证其他设备看到「第 N 轮」与下一轮入口
      const rno = (remote && remote[this.ROUND_NO_KEY]) || null;
      if (rno && typeof rno === 'object') {
        const ln = JSON.parse(localStorage.getItem(this.ROUND_NO_KEY) || '{}') || {};
        const mergedNo = Object.assign({}, ln, rno);
        localStorage.setItem(this.ROUND_NO_KEY, JSON.stringify(mergedNo));
      }
    } catch (e) { /* 忽略 */ }
  },

  // 🟢 v227.67 修复：ROUND_CLOSED_KEY 是「多轮次 × 多设备」聚合态（每个 sheetId 一条 closed 记录）。
  //   原 endQuarterRound/startNextRound 用 _setCloud 直接整包 setSetting 覆盖云端，会把其他设备/其他轮次
  //   已结束的记录从云端抹掉 → 其他设备（或清缓存后）再进盘点模块看到该轮次又「🟡 进行中」。
  //   改为「读云端 → 合并并集 → 回写」，closed 记录只增不丢。
  async _setRoundClosedCloud(sheetId, info) {
    let merged = Object.assign({}, this._getRoundClosed());
    if (sheetId) merged[sheetId] = info;
    try {
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.getSettings === 'function') {
        const remote = await SyncManager.getSettings();
        const rmap = (remote && remote[this.ROUND_CLOSED_KEY]) || null;
        if (rmap && typeof rmap === 'object') merged = Object.assign({}, rmap, merged);
      }
    } catch (e) { /* 忽略，回退本机并集 */ }
    this._saveRoundClosed(merged);
    await this._setCloud(this.ROUND_CLOSED_KEY, merged);
  },
  // 开下一轮：在云端并集上删除该 sheetId（不抹掉其他轮次）
  async _clearRoundClosedCloud(sheetId) {
    let merged = Object.assign({}, this._getRoundClosed());
    if (sheetId) delete merged[sheetId];
    try {
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.getSettings === 'function') {
        const remote = await SyncManager.getSettings();
        const rmap = (remote && remote[this.ROUND_CLOSED_KEY]) || null;
        if (rmap && typeof rmap === 'object') {
          const u = Object.assign({}, rmap);
          if (sheetId) delete u[sheetId];
          merged = Object.assign({}, u, merged);
        }
      }
    } catch (e) { /* 忽略 */ }
    this._saveRoundClosed(merged);
    await this._setCloud(this.ROUND_CLOSED_KEY, merged);
  },

  // v218：取消分派 —— 仅未开始盘点（无本人实盘记录）的任务可撤销；已开始盘点提示走「放弃本次盘点」
  async cancelAssign(taskId) {
    const tasks = DataStore.getStocktakeTasks();
    const t = tasks[taskId];
    if (!t) return;
    // 是否已开始盘点：存在本人实盘记录（非作废、非结束补0）且编码在固化清单内
    const recs = await DataStore.getStocktakeRecords();
    const started = (recs || []).some(r =>
      !r.voided && !r.closedByFinish &&
      String(r.盘点人 || '').trim() === String(t.counter).trim() &&
      t.codes.indexOf(r.存货编码) >= 0);
    if (started) {
      WBModal.alert('该任务（' + t.counter + ' · 序号 ' + t.noStart + '-' + t.noEnd + '）已开始盘点，不能取消分派。\n\n请让盘点人在其盘点界面点「🗑️ 放弃本次盘点」回滚进度。');
      return;
    }
    const ok = await WBModal.confirm('确认取消分派：' + t.counter + ' · 序号 ' + t.noStart + '-' + t.noEnd + '（' + t.codes.length + '项）？\n取消后该区间可重新分派。', { title: '取消分派' });
    if (!ok) return;
    // v225.2：墓碑 + 推云端一步到位（内部完成，无需外部再 setSetting）
    await DataStore.deleteStocktakeTask(taskId);
    this._refreshTaskBar();
    this.toast('已取消分派：' + t.counter + ' ' + t.noStart + '-' + t.noEnd);
  },

  // 当前批次（同类别 + 同盘点日期区间）下尚未结束的分派任务
  _batchOpenTasks(sheetType) {
    const type = sheetType || (this.sheet && this.sheet.sheetType) || 'quarter';
    const sd = this.query.startDate || '', ed = this.query.endDate || '';
    const all = DataStore.getStocktakeTasks();
    return Object.keys(all).map(k => all[k]).filter(t =>
      t && t.status === 'open' && t.sheetType === type &&
      // 存量任务无 startDate 字段时按类别宽松匹配，避免老任务被误判为其他批次
      (t.startDate == null || t.startDate === '' || (t.startDate === sd && t.endDate === ed)));
  },

  // v217 防重复分派：返回冲突说明（有冲突）或 null（可安全分派）
  _findAssignConflict(sheetType, counter, codes) {
    const opens = this._batchOpenTasks(sheetType);
    // ① 同一人已有未结束任务 → 拒绝（一人一段，避免自己跟自己重复）
    const mine = opens.find(t => String(t.counter).trim() === String(counter).trim());
    if (mine) {
      return `${counter} 在本批次已有未结束的任务（序号 ${mine.noStart}-${mine.noEnd}，${mine.codes.length} 项）。\n` +
        `需等该任务结束盘点后再重新分派，或改派给其他人。`;
    }
    // ② 编码区间与他人任务重叠 → 拒绝，并指出被谁占用
    const codeSet = new Set(codes);
    const clashes = [];
    opens.forEach(t => {
      const hit = (t.codes || []).filter(c => codeSet.has(c));
      if (hit.length) clashes.push({ counter: t.counter, n: hit.length, sample: hit.slice(0, 3) });
    });
    if (clashes.length) {
      const detail = clashes.map(c => `${c.counter} 占用 ${c.n} 项（如 ${c.sample.join('、')}）`).join('；');
      return `序号区间与已分派任务重叠，不能重复分派：\n${detail}\n\n` +
        `本批次盘点尚未结束，请避开已派出的序号，或等其结束后重新分派。`;
    }
    return null;
  },

  // 管理员分派弹窗（盘点人含「管理员」，支持派给自己 §5.3）
  openAssignDialog() {
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!overlay || !title || !body) return;
    title.textContent = '分派季度盘点任务';
    let opts = '<option value="管理员">管理员（自己）</option>';
    if (typeof AppConfig !== 'undefined' && AppConfig.getKeepers) {
      AppConfig.getKeepers().filter(k => !k.disabled).forEach(k => {
        opts += '<option value="' + escAttr(k.username) + '">' + esc(k.username) + '</option>';
      });
    }
    body.innerHTML = `
      <input type="hidden" id="asType" value="quarter">
      <div class="as-grid">
        <div class="as-row as-row-counter">
          <label class="title">盘点人（可分配给管理员自己）</label>
          <select id="asCounter" class="as-input">${opts}</select>
        </div>
        <div class="as-row as-row-duo">
          <label class="title">序号区间（单段快捷输入）</label>
          <div class="as-duo">
            <input id="asNoStart" type="number" min="1" placeholder="起始" class="as-input">
            <span class="as-dash">—</span>
            <input id="asNoEnd" type="number" min="1" placeholder="结束" class="as-input">
          </div>
        </div>
        <div class="as-row as-row-multi">
          <label class="title">多批次非连续选号（如 <code>1-3,6-20,30-40,15</code>，覆盖起止）</label>
          <input id="asMulti" type="text" placeholder="1-3,6-20,30-40,15" class="as-input">
        </div>
        <div class="as-row full as-row-preview">
          <label class="title">区间预览（光标所在的段：起/止对应的存货名称+规格）</label>
          <div id="asInfo" class="as-preview">输入序号或多批次后，这里实时显示对应的存货名称与规格型号。</div>
        </div>
        <div class="as-actions">
          <button id="asCancelBtn" class="btn--ghost as-btn-cancel">取消</button>
          <button id="asConfirmBtn" class="btn--primary as-btn-confirm">确认分派</button>
        </div>
      </div>`;
    const m = document.getElementById('modal'); if (m) m.classList.remove('modal-compact');
    overlay.classList.add('show');

    const self = this;
    // 缓存全库排序 + 实时查表
    (async () => {
      const total = (await self._allStockCodesSorted()).length;
      const info = document.getElementById('asInfo');
      if (info && total) info.dataset.total = String(total);

      const renderInfo = async () => {
        const totalN = parseInt((document.getElementById('asInfo') || {}).dataset?.total || '0', 10);
        if (!totalN) return;
        const allCodes = await self._allStockCodesSorted();
        const sInp = document.getElementById('asNoStart');
        const eInp = document.getElementById('asNoEnd');
        const multiEl = document.getElementById('asMulti');
        // 🟢 v227.26：解析多批次取首末两段 → 同时预览首段「起」/「止」对应的存货，避免漏看结束位置。
        let ranges = [];
        try {
          if (multiEl && multiEl.value && multiEl.value.trim()) {
            ranges = self._parseAssignRanges(multiEl.value) || [];
          }
        } catch (e) {}
        if (!ranges.length) {
          const s = parseInt(sInp && sInp.value, 10);
          const e = parseInt(eInp && eInp.value, 10);
          if (!isNaN(s) && !isNaN(e) && e >= s && s >= 1) ranges = [[s, e]];
        }
        if (!ranges.length) {
          info.textContent = '全库共 ' + totalN + ' 项存货；结束序号不得超过此值。';
          return;
        }
        // 取首段起点 + 末段止点（多段时显示首段起点/末段止点，方便校验首尾两端）
        const firstStart = ranges[0][0];
        const lastSeg = ranges[ranges.length - 1];
        const lastEnd = lastSeg[1];
        // 多段时也取末段起点（用于"末段第一项"）
        const lastStart = lastSeg[0];
        const stopNos = (ranges.length === 1)
          ? [firstStart, lastEnd]                  // 单段：起 + 止
          : [firstStart, lastStart, lastEnd];      // 多段：首段起 + 末段起 + 末段止
        const stopInfos = [];
        try {
          const stock = await DataStore.getRows('stock');
          for (const no of stopNos) {
            if (!no || no < 1 || no > allCodes.length) { stopInfos.push({ no, ok:false }); continue; }
            const code = allCodes[no - 1];
            const row = (stock || []).find(r => String(r.存货编码 || '') === code) || null;
            stopInfos.push({ no, code, row });
          }
        } catch (e) {}
        const segCount = ranges.length;
        const segLabel = segCount > 1 ? ('共 ' + segCount + ' 段') : ('单段');
        const lines = [];
        stopInfos.forEach((it, idx) => {
          const tag = (segCount === 1)
            ? (idx === 0 ? '起' : '止')
            : (idx === 0 ? '首段起' : (idx === 1 ? '末段起' : '末段止'));
          if (!it.ok) { lines.push('· ' + tag + ' 序号 ' + it.no + '（越界）'); return; }
          if (it.row) {
            lines.push('· <b>' + tag + '</b> 序号 <b>' + it.no + '</b>　' + esc(it.code) + '　·　' +
                       esc(it.row.存货名称 || '（无名）') +
                       (it.row.规格型号 ? ' / ' + esc(it.row.规格型号) : ''));
          } else {
            lines.push('· <b>' + tag + '</b> 序号 <b>' + it.no + '</b>　' + esc(it.code) + '　·　（未在库存中找到）');
          }
        });
        info.innerHTML = lines.join('\n') + '\n\n全库共 ' + totalN + ' 项存货；结束序号不得超过此值；' + segLabel + '。';
      };
      // 多批次文本框变动时清空起止；起止变化时把同步到多批次；多批次变化时同步起止并刷新预览
      const multi = document.getElementById('asMulti');
      const sInp = document.getElementById('asNoStart');
      const eInp = document.getElementById('asNoEnd');
      const onRange = () => {
        const s = parseInt(sInp.value, 10), e = parseInt(eInp.value, 10);
        if (!isNaN(s) && !isNaN(e) && e >= s) multi.value = s + '-' + e;
        renderInfo();
      };
      const onMulti = () => {
        const segs = (self._parseAssignRanges(multi.value) || []);
        if (segs.length === 1) {
          sInp.value = segs[0][0]; eInp.value = segs[0][1];
        } else if (segs.length > 1) {
          // 多段：以第一段作为预览
          sInp.value = segs[0][0]; eInp.value = segs[0][1];
        }
        renderInfo();
      };
      sInp.addEventListener('input', onRange);
      eInp.addEventListener('input', onRange);
      multi.addEventListener('input', onMulti);
      renderInfo();
      // 绑定确认/取消
      document.getElementById('asCancelBtn').onclick = () => overlay.classList.remove('show');
      document.getElementById('asConfirmBtn').onclick = () => self._doAssign();
    })();
  },

  /** 🟢 v227.24：解析"1-3,6-20,30-40,15"等多批次选号 → 区间数组 [ [start,end], ... ] */
  _parseAssignRanges(text) {
    const out = [];
    if (text == null) return out;
    String(text).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean).forEach(token => {
      const m = /^(\d+)\s*[-~]\s*(\d+)$/.exec(token);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        out.push(a <= b ? [a, b] : [b, a]);
      } else {
        const one = /^\d+$/.exec(token);
        if (one) out.push([parseInt(one[0], 10), parseInt(one[0], 10)]);
        else throw new Error('"' + token + '" 不是合法选号');
      }
    });
    // 去重 + 按起始排序
    const seen = new Set();
    return out.filter(([a, b]) => {
      const k = a + '-' + b;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((x, y) => x[0] - y[0]);
  },

  async _doAssign() {
    const tEl = document.getElementById('asType');
    const cEl = document.getElementById('asCounter');
    if (!tEl || !cEl) return;
    const sheetType = tEl.value;
    const counter = cEl.value.trim();
    if (!counter) { WBModal.alert('请选择盘点人'); return; }

    // 多批次优先；没有则读起止输入框
    const multi = document.getElementById('asMulti');
    const sEl = document.getElementById('asNoStart');
    const eEl = document.getElementById('asNoEnd');
    let ranges = [];
    try {
      if (multi && multi.value && multi.value.trim()) {
        ranges = this._parseAssignRanges(multi.value) || [];
      } else {
        const s = parseInt(sEl.value, 10), e = parseInt(eEl.value, 10);
        if (!isNaN(s) && !isNaN(e) && e >= s && s >= 1) ranges = [[s, e]];
      }
    } catch (e) { WBModal.alert('选号格式错误：' + (e.message || e)); return; }

    if (!ranges.length) { WBModal.alert('请输入起止序号或多批次选号（如 1-3,6-20）'); return; }

    const allCodes = await this._allStockCodesSorted();
    // 合并所有段对应的编码（去重 + 保留排序）
    const set = new Set();
    ranges.forEach(([a, b]) => {
      if (a < 1 || b < a) { throw new Error('区间 ' + a + '-' + b + ' 无效'); }
      if (b > allCodes.length) { throw new Error('结束序号 ' + b + ' 超出全库总数 ' + allCodes.length); }
      allCodes.slice(a - 1, b).forEach(c => set.add(c));
    });
    const codes = allCodes.filter(c => set.has(c));
    if (!codes.length) { WBModal.alert('选号范围为空'); return; }

    // v217 防重复分派：任何一段都不能与已派任务重叠
    const conflict = this._findAssignConflict(sheetType, counter, codes);
    if (conflict) { WBModal.alert(conflict); return; }

    // 一个 taskId 表达多段（按段连接）
    const rangesKey = ranges.map(([a, b]) => a + '-' + b).join(',');
    const taskId = sheetType + '_' + counter + '_' + rangesKey;
    const task = {
      taskId, sheetId: null, sheetType, counter,
      noStart: ranges[0][0], noEnd: ranges[ranges.length - 1][1], ranges,
      // v217：记录分派时所属盘点区间，作为「同一批次」的判定依据（结束时才写 sheetId）
      startDate: this.query.startDate || '', endDate: this.query.endDate || '',
      codes, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: 'open', closedAt: null
    };
    await DataStore.saveStocktakeTask(task);
    const overlay = document.getElementById('modalOverlay'); if (overlay) overlay.classList.remove('show');
    WBModal.alert('已分派：' + counter + ' · 选号 ' + rangesKey + '（共 ' + codes.length + ' 项，编码已固化）');
    this._refreshTaskBar();
  },

  // 当前可见行（认领后按序号区间过滤）
  visibleRows() {
    // 🟢 v224 修复：分派任务已按「固化编码清单」过滤到位，绝不再按序号区间二次过滤。
    //   序号 no 是 buildRows 按「当前全库」排序现算的，分派任务记的 noStart/noEnd 是
    //   分派那一刻的序号。若分派之后存货数据有增减（导入新表、新增物料），全库排序会漂移，
    //   noStart-noEnd 指向的就不再是当初分派的那批编码 —— 轻则行错位，重则整批行被滤光，
    //   导致「结束盘点」一条记录都写不进去（v224 流程验证实测复现）。
    if (this.task.assignedTaskId) return this.allRows;
    if (!this.task.started) return this.allRows;
    const s = this.task.noStart, e = this.task.noEnd;
    return this.allRows.filter(r => r.no >= s && r.no <= e);
  },

  // ---------------- 表格渲染 ----------------
  renderTable() {
    const area = document.getElementById('stArea');
    if (!area) return;
    const rows = this.visibleRows();
    const typeCn = this.sheet && this.sheet.sheetType === 'quarter' ? '季度盘点' : '日常盘点';

    // v216 Step 5.4：登录态下盘点人只读锁定，自动带出当前账号
    const logged = (typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn) ? AppConfig.isLoggedIn() : false;
    const curUser = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? AppConfig.getCurrentUser() : null;
    const counterVal = logged && curUser ? curUser.username : (this.task.counter || '');
    const counterInput = logged
      ? `<label>盘点人 <input type="text" id="stCounter" value="${escAttr(counterVal)}" readonly style="width:110px;background:#f3f4f6;color:#666;cursor:not-allowed;"></label>`
      : `<label>盘点人 <input type="text" id="stCounter" value="${escAttr(counterVal)}" placeholder="填写姓名" style="width:110px;"></label>`;
    const loginWarn = logged ? '' : `<span style="opacity:.85;color:#dc2626;margin-left:6px;">⚠ 未登录，填错人将影响续盘与归属，建议先登录</span>`;

    // 🟢 v226：日常盘点为「自主盘点」，不需认领区间 —— 开始后直接进入表格，
    //   在原本认领区的位置显示「盘点号文本框」+ 自动带出的盘点人，让用户清楚自己在盘哪个盘点号。
    //   季度盘点仍按 v224 流程（认领前显示认领区，认领后显示区间 + 盘点号）。
    const isDailyStarted = this.sheet && this.sheet.sheetType === 'daily';
    const batchNoText = this.sheet && this.sheet.batchNo ? this.sheet.batchNo : '';
    const claimHtml = this.task.started ? `
      <div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:var(--status-info-bg,#eef6ff);font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>盘点人：<b>${esc(this.task.counter)}</b></span>
        <span>序号区间：<b>${this.task.noStart}-${this.task.noEnd}</b></span>
        ${batchNoText ? '<span>盘点号：<input type="text" readonly value="' + escAttr(batchNoText) + '" style="width:120px;background:#f3f4f6;color:#475569;font-weight:600;cursor:not-allowed;border:1px solid #cbd5e1;border-radius:6px;padding:2px 8px;"></span>' : ''}
        <button class="btn--primary" onclick="StocktakeModule.goBackFromSheet()" title="返回上一级（盘点工作台）" style="padding:4px 14px;font-size:12.5px;display:inline-flex;align-items:center;gap:5px;">
          <span style="font-size:14px;">◀</span>返回
        </button>
      </div>`
      : (isDailyStarted ? `
      <div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:var(--status-warning-bg,#fff7ed);border:1px solid #fed7aa;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>盘点人：<b>${esc(counterVal || '')}</b>${counterVal ? '（已自动带出）' : '<span style="color:#dc2626;">（未登录，请先登录库管员账号）</span>'}</span>
        ${batchNoText ? '<span>盘点号：<input type="text" readonly value="' + escAttr(batchNoText) + '" style="width:120px;background:#f3f4f6;color:#475569;font-weight:600;cursor:not-allowed;border:1px solid #cbd5e1;border-radius:6px;padding:2px 8px;"></span>' : ''}
        <span style="color:#b45309;font-size:12px;">⚠️ 本次盘点<b>尚未结束</b>：点【保存】= 暂停（下次进入会提醒），全部盘完请点【盘点结束】才算完成</span>
        <button class="btn--primary" onclick="StocktakeModule.goBackFromSheet()" title="返回上一级（盘点工作台）" style="padding:4px 14px;font-size:12.5px;display:inline-flex;align-items:center;gap:5px;">
          <span style="font-size:14px;">◀</span>返回
        </button>
      </div>`
      : `
      <div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:var(--status-info-bg,#eef6ff);font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        ${counterInput}
        <label>序号 <input type="number" id="stNoStart" min="1" placeholder="起始" style="width:80px;"> 至
          <input type="number" id="stNoEnd" min="1" placeholder="结束" style="width:80px;"></label>
        <button class="btn--primary" onclick="StocktakeModule.claimRange()">开始盘点</button>
        <span style="opacity:.7;">共 ${this.allRows.length} 行，可只认领自己负责的序号段</span>
        ${loginWarn}
      </div>`);

    // v217：任务栏已上移到模块顶部常驻（_taskBarHtml），表格内不再重复渲染
    const ioCols = this.showInOut
      ? '<th>入库量</th><th>出库量</th>'
      : '';

    const body = rows.map(r => {
      const io = this.showInOut
        ? `<td>${this._num(r.入库量)}</td><td>${this._num(r.出库量)}</td>`
        : '';
      // v216 Step 6.2：差异量着色（盘盈绿 / 盘亏红 / 0 灰）
      const dv = (r.差异量 === '' || r.差异量 == null) ? 0 : parseFloat(r.差异量);
      const dcolor = (dv > 0) ? 'color:#16a34a;' : (dv < 0 ? 'color:#dc2626;' : '');
      // 🟢 v226：右列「盘点人」条件渲染 —— 输入了盘点数量才自动带盘点人；未填则留空（代表未盘点）。
      const hasQty = r.盘点数量 !== '' && r.盘点数量 != null;
      const counterCell = hasQty ? esc(this.task.counter || '') : '';
      return `<tr data-code="${escAttr(r.存货编码)}">
        <td>${r.no}</td>
        <td>${esc(r.存货编码)}</td>
        <td>${esc(r.存货名称)}</td>
        <td>${esc(r.规格型号)}</td>
        <td>${this._num(r.现存量)}</td>
        ${io}
        <td><input type="number" class="st-qty" value="${escAttr(r.盘点数量)}" style="width:90px;"
              oninput="StocktakeModule.onQty(this)" onchange="StocktakeModule.onQty(this)"></td>
        <td class="st-diff" style="${dcolor}font-weight:600;">${r.差异量 === '' ? '' : this._num(r.差异量)}</td>
        <td class="st-counter">${counterCell}</td>
        <td>${typeCn}</td>
        <td><input type="text" class="st-note" value="${escAttr(r.备注 || '')}" style="width:110px;"
              oninput="StocktakeModule.onNote(this)"></td>
      </tr>`;
    }).join('');

    // 🟢 v227.3：allRows 为空时也渲染顶部信息条（让"返回"按钮可用）+ 占位空态
    const emptyNote = rows.length === 0
      ? '<div id="stEmptyNote"></div>'
      : '';
    const tableOrEmpty = rows.length === 0
      ? ''
      : `<div style="overflow:auto;max-height:68vh;border:1px solid var(--border-color,#e5e7eb);border-radius:8px;">
        <table class="data-table" style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead style="position:sticky;top:0;background:var(--bg-secondary,#f9fafb);z-index:1;">
            <tr>
              <th>序号</th><th>存货编码</th><th>存货名称</th><th>规格型号</th><th>现存量</th>
              ${ioCols}
              <th>盘点数量</th><th>差异量</th><th>盘点人</th><th>盘点类别</th><th>备注</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
    // 🟢 v227.91：删除「清空已填」/「放弃本次盘点」（未统一标准按钮形状）
    // 进度条（原「清空已填」位置）：空字符串，留作移动端列折叠按钮的目标挂载点
    const progressBar = `
      <div id="stProgressBar" style="margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span style="font-size:13px;opacity:.8;">已盘 <b id="stDone">0</b> / ${rows.length}</span>
      </div>
    `;
    area.innerHTML = `
      ${claimHtml}
      ${progressBar}
      ${tableOrEmpty}
      ${emptyNote}
      <div style="margin-top:10px;display:flex;gap:10px;">
        <button class="btn--primary" onclick="StocktakeModule.saveToRecords()">💾 保存</button>
        <button class="btn--ghost" onclick="StocktakeModule.finishStocktake()">🏁 盘点结束</button>
      </div>
    `;
    // 🟢 v227.91：移动端把表格列折叠按钮搬到原「清空已填」位置（progressBar）
    this._relocateColCollapseToProgressBar();
    if (rows.length > 0) {
      this.updateProgress();
      this._bindKeyboard();   // v216 Step 6.2：Enter/↑↓ 在数量框间流动
    } else {
      this.updateProgress();
    }
  },

  // 🟢 v227.91：移动端将表格列折叠按钮（mobile-col-toggle）从 wrap 父节点搬到
  //   原「清空已填」按钮所在的进度条位置；桌面端不操作（按钮保持隐藏/或原位均无影响）。
  //   实现：进度条 div 是唯一带 #stDone 的 div；列折叠按钮 class 为 mobile-col-toggle，
  //   由 TableUtils.installColumnCollapse 创建并挂在 wrap.parentElement（即 #contentArea，
  //   可能在 #stArea 外），所以要按表格祖先定位。只搬属于 #stArea 内表格的按钮。
  _relocateColCollapseToProgressBar() {
    try {
      const stArea = document.getElementById('stArea');
      if (!stArea) return;
      const target = stArea.querySelector('#stDone');
      const hostDiv = target ? target.closest('div') : null;
      if (!hostDiv) return;
      const isMobile = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(max-width: 769px)').matches
        : (window.innerWidth <= 769);
      const move = () => {
        // 收集所有 .mobile-col-toggle。
        // table-utils 在 installColumnCollapse 时，wrap 参数对盘点表取的是 t.closest('[id]') = #stArea
        // （因盘点表 wrap div 没有 .table-wrapper class），所以按钮被插入到 #stArea 之前、
        // 父节点 #contentArea 内；同时 wrap.parentElement = #contentArea 被加 .col-collapse-mode。
        // 判定：按钮的 nextElementSibling === #stArea → 属于本模块，搬到 progressBar。
        const all = document.querySelectorAll('.mobile-col-toggle');
        all.forEach(btn => {
          const nxt = btn.nextElementSibling;
          if (nxt && nxt.id === 'stArea') {
            if (btn.parentElement !== hostDiv) hostDiv.appendChild(btn);
          }
        });
      };
      if (isMobile) {
        move();
        // 监听：table-utils 异步挂载的按钮后续到达时立即搬
        if (!stArea._stCollapseMO) {
          const mo = new MutationObserver(move);
          mo.observe(document.getElementById('contentArea') || document.body, { childList: true, subtree: true });
          stArea._stCollapseMO = mo;
          // 5 秒后自动断开（防止长期监听）
          setTimeout(() => { try { mo.disconnect(); stArea._stCollapseMO = null; } catch (e) {} }, 5000);
        }
      }
    } catch (e) { /* 静默失败，避免阻断主流程 */ }
  },

  // v216 Step 6.2：键盘流 —— Enter / ↓ 跳下一行数量框，↑ 跳上一行；进入自动聚焦首个框
  _bindKeyboard() {
    const table = document.querySelector('#stArea table.data-table');
    if (!table) return;
    const inputs = Array.from(table.querySelectorAll('input.st-qty'));
    inputs.forEach((inp, i) => {
      inp.addEventListener('keydown', (e) => {
        let target = null;
        if (e.key === 'Enter' || e.key === 'ArrowDown') target = inputs[i + 1] || null;
        else if (e.key === 'ArrowUp') target = inputs[i - 1] || null;
        if (target) {
          e.preventDefault();
          target.focus();
          if (target.select) try { target.select(); } catch (e) {}
        }
      });
    });
    if (inputs.length) { try { inputs[0].focus(); } catch (e) {} }
  },

  // v216 Step 5.4：登录态变化时刷新盘点人输入框（仅在未认领时，已认领则保持锁定）
  refreshCounter() {
    if (this.task.started) return;
    if (document.getElementById('stArea')) this.renderTable();
  },

  _num(v) {
    if (v === '' || v == null || isNaN(v)) return '';
    // 去掉浮点误差尾巴：12.300000000000001 → 12.3
    return String(Math.round(parseFloat(v) * 1000) / 1000);
  },
  // 🟢 v226：盘点数量渲染——null/undefined → 「/」表示未盘点；其他走 _num。
  _fmtQty(v) {
    if (v == null || v === '') return '/';
    if (isNaN(parseFloat(v))) return String(v);
    return this._num(v);
  },
  // 🟢 v226：差异量渲染——null/undefined → 「/」表示未盘点（按用户需求不按 0 算盘亏）。
  _fmtDiff(v) {
    if (v == null || v === '') return '/';
    if (isNaN(parseFloat(v))) return String(v);
    const n = parseFloat(v);
    if (n === 0) return '';
    const color = (n > 0) ? 'color:#16a34a;' : 'color:#dc2626;';
    return `<span style="${color}font-weight:600;">${this._num(n)}</span>`;
  },

  // 填盘点数量 → 算差异 → 存草稿
  onQty(el) {
    const tr = el.closest('tr');
    if (!tr) return;
    const code = tr.getAttribute('data-code');
    const row = this.allRows.find(r => r.存货编码 === code);
    if (!row) return;
    const raw = el.value;
    row.盘点数量 = raw === '' ? '' : raw;
    // 差异量 = 盘点数量 − 现存量（round2 修正浮点漂移 BUG-B）
    row.差异量 = (raw === '' || raw == null || isNaN(parseFloat(raw)))
      ? '' : round2(parseFloat(raw) - (parseFloat(row.现存量) || 0));
    const diffTd = tr.querySelector('.st-diff');
    if (diffTd) {
      diffTd.textContent = row.差异量 === '' ? '' : this._num(row.差异量);
      // v216 Step 6.2：差异量实时着色
      const dv = (row.差异量 === '' || row.差异量 == null) ? 0 : parseFloat(row.差异量);
      diffTd.style.color = (dv > 0) ? '#16a34a' : (dv < 0 ? '#dc2626' : '');
      diffTd.style.fontWeight = '600';
    }
    // 🟢 v226：盘点人列条件渲染——输入数量才带盘点人（不要重渲整张表）
    const counterTd = tr.querySelector('.st-counter');
    if (counterTd) {
      const hasQty = row.盘点数量 !== '' && row.盘点数量 != null;
      counterTd.textContent = hasQty ? (this.task.counter || '') : '';
    }
    this.saveDraft();
    this._flashCounted(tr, el);
    this.updateProgress();
  },

  // 🟢 v227.71：盘点录入即时反馈 —— 行闪一下成功绿 + 输入框脉冲（600ms / 420ms）。
  //   连续录入时若只 add 类名，第二次不会再播；故 remove → 强制 reflow → add。
  _flashCounted(tr, input) {
    try {
      if (!tr) return;
      tr.classList.remove('st-just-counted');
      if (input) input.classList.remove('st-pulse');
      void tr.offsetWidth;                       // 强制 reflow，重置动画
      tr.classList.add('st-just-counted');
      if (input) input.classList.add('st-pulse');
      clearTimeout(tr.__stFlashTimer);
      tr.__stFlashTimer = setTimeout(() => {
        tr.classList.remove('st-just-counted');
        if (input) input.classList.remove('st-pulse');
      }, 620);
    } catch (e) { /* 动效失败不影响录入 */ }
  },

  onNote(el) {
    const tr = el.closest('tr');
    if (!tr) return;
    const row = this.allRows.find(r => r.存货编码 === tr.getAttribute('data-code'));
    if (row) { row.备注 = el.value || ''; this.saveDraft(); }
  },

  async clearFilled() {
    if (!(await WBModal.confirm('确认清空本次已填的盘点数量？（不可恢复）', { title: '清空数量' }))) return;
    this.allRows.forEach(r => { r.盘点数量 = ''; r.差异量 = ''; });
    this.clearDraft();
    this.renderTable();
    this.toast('已清空');
  },

  updateProgress() {
    const rows = this.visibleRows();
    const done = rows.filter(r => r.盘点数量 !== '' && r.盘点数量 != null).length;
    const el = document.getElementById('stDone');
    if (el) el.textContent = done;
    const p = document.getElementById('stProgress');
    if (p) p.textContent = `已盘 ${done} / ${rows.length}`;
  },

  // ---------------- 盘点会话标记（v226：保存=暂停，结束才算完成）----------------
  // 🟢 v227.4：额外存 startDate/endDate —— 让工作台的「继续盘点」能精确恢复到原日期区间（否则默认 30 天区间可能匹配不上，续盘检测失败）。
  _markOpenSession(sheetId, sheetType, counter, sd, ed) {
    try {
      localStorage.setItem(this.OPEN_KEY, JSON.stringify({
        sheetId: sheetId,
        sheetType: sheetType,
        counter: String(counter || '').trim(),
        batchNo: (this.sheet && this.sheet.batchNo) || '',
        startDate: sd || (this.sheet && this.sheet.startDate) || '',
        endDate: ed || (this.sheet && this.sheet.endDate) || '',
        startedAt: new Date().toISOString()
      }));
    } catch (e) { /* 忽略 */ }
  },

  _getOpenSession() {
    try { return JSON.parse(localStorage.getItem(this.OPEN_KEY) || 'null'); } catch (e) { return null; }
  },

  _clearOpenSession() {
    try { localStorage.removeItem(this.OPEN_KEY); } catch (e) { /* 忽略 */ }
  },

  // 本地日期（只取天数 YYYY-MM-DD，不用 toISOString 避免 UTC 时区把日期记成前一天）
  _today() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  // 🟢 v226：生成「盘点号」（rc/jd + YYYYMMDD[-N]）
  //   - daily → rc20260901；quarter → jd20260901
  //   - 同一批次（同一 sheetId）未结束时复用同一个盘点号：
  //       ① 日常盘点保存后再次进入续盘 → 仍是同一个号（保存 = 暂停，不是新批次）
  //       ② 季度盘点同一批次被多人领取 → 所有人共用一个号（否则同批次会散成 jd…-2/-3）
  //   - 该批次已点【盘点结束】→ 下次开局当日递增 -2、-3 ...
  //   - 同步实现：localStorage 映射表 + DataStore 缓存（避免 await 阻塞渲染）
  _genBatchNo(type, sheetId, persist = true) {
    const prefix = type === 'quarter' ? 'jd' : 'rc';
    const today = this._today().replace(/-/g, '');
    const base = prefix + today;
    const MAP_KEY = 'wb_stocktake_no_map';

    let map = {};
    try { map = JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {}; } catch (e) { map = {}; }

    // ① 同批次未结束 → 复用原号
    if (sheetId && map[sheetId] && map[sheetId].no && !map[sheetId].finished) {
      return map[sheetId].no;
    }

    // ② 新批次：算出当日下一个可用序号（next = 1 表示用无后缀的 base）
    // 🟢 v227.91：盘点号继承/复用规则 —— 删除（voided）的记录不再占用序号。
    //   只统计「非 voided」的当日同号集合，取最小未占用 N；
    //   N=1 → base（无后缀）；N>1 → base-N。保证删除前两份记录后，新号回填 rc…-1 / rc…-2。
    let next = 1;
    const used = new Set();   // 已占用的当日序号（含 N=1 即 base）
    const bump = (no) => {
      if (!no || !String(no).startsWith(base)) return;
      const m = /^.+-(\d+)$/.exec(String(no));
      used.add(m ? parseInt(m[1], 10) : 1);
    };
    Object.keys(map).forEach(k => { const it = map[k]; if (it && it.no) bump(it.no); });
    try {
      const allRecs = (DataStore._tableCache && DataStore._tableCache['stocktake_records']) || [];
      // 只 bump 未删除的记录；voided（删除墓碑）不占号 → 新批次可回填该序号
      (allRecs || []).forEach(r => { if (r && !r.voided) bump(r.batchNo); });
    } catch (e) {}
    // 旧版计数器兜底（v226 之前写过 wb_stocktake_no_* 时避免重号）
    try {
      const old = parseInt(localStorage.getItem('wb_stocktake_no_' + type + '_' + today) || '0', 10);
      if (!isNaN(old) && old > 0) used.add(old);
    } catch (e) {}
    // 取最小未占用序号：1, 2, 3…直到找到第一个不在 used 里的
    next = 1;
    while (used.has(next)) next++;

    const finalNo = next <= 1 ? base : (base + '-' + next);
    // 🟢 v227.22：仅 persist=true 时落库。渲染阶段（_renderDailySetup）传 false，
    //    避免「只是打开看了一眼日常盘点」就往 no_map 写一个 finished:false/count:0 的孤儿号，
    //    否则默认区间每天平移导致 sheetId 变化 → 下拉反复冒出「新建·未开始」。真正落库在 beginDaily。
    if (sheetId && persist) {
      map[sheetId] = { no: finalNo, type: type, finished: false, date: today };
      try { localStorage.setItem(MAP_KEY, JSON.stringify(map)); } catch (e) {}
      // 旧版计数器（v226 之前）同步推进，仅真正落库时推进，保证与历史实现不冲突
      try { localStorage.setItem('wb_stocktake_no_' + type + '_' + today, String(next <= 1 ? 1 : next)); } catch (e) {}
    }
    return finalNo;
  },

  // 🟢 v226：批次已点【盘点结束】→ 标记结束，下次同一 sheetId 开局才启用新号
  _markBatchFinished(sheetId) {
    if (!sheetId) return;
    const MAP_KEY = 'wb_stocktake_no_map';
    try {
      const map = JSON.parse(localStorage.getItem(MAP_KEY) || '{}') || {};
      if (map[sheetId]) { map[sheetId].finished = true; localStorage.setItem(MAP_KEY, JSON.stringify(map)); }
    } catch (e) {}
  },

  _uuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* 忽略，走回退 */ }
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  },

  // ---------------- 保存：已填行 → 写入盘点记录表 ----------------
  // 【保存】语义：仅写入「已填盘点数量」的行；未填的行不写、不补 0，保留继续盘。
  // 🟢 v226：保存 ≠ 完成 → 存在未盘项时点保存 = 暂停，下次进入会弹窗提醒必须点【盘点结束】才算完成本次盘点。
  async saveToRecords(opts) {
    opts = opts || {};
    if (!this.sheet) { this.toast('请先点击【日常盘点】或【季度盘点】'); return; }
    this._markSheetTouched('saved');
    // 🟢 v226：盘点人已通过登录态自动带出（renderTable 中 `counterVal` 取自 AppConfig.getCurrentUser），
    //   此处不再校验是否填写盘点人 —— 未登录时 `task.counter` 可能是空但保存仍允许（盘点人字段留空）。
    //   兜底：task.counter 为空时回落到当前登录账号，避免写入「盘点人空白」的记录。
    const counter = String(this.task.counter ||
      ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '')).trim();
    if (counter) this.task.counter = counter;
    // v226：不再弹「请填写盘点人」阻断保存（盘点人已由登录态自动带出），未登录时仅轻提示
    if (!counter) this.toast('未登录库管员账号，本次记录的盘点人将留空');
    // v217：保存前兜底重算差异量 —— 若行上的差异量尚未计算（如批量填入数量、
    // 未触发输入事件），按「盘点数量 − 现存量」补齐，避免存成 0 差异。
    this.visibleRows().forEach(r => {
      if (r.差异量 === '' || r.差异量 == null || isNaN(r.差异量)) {
        r.差异量 = round2((parseFloat(r.盘点数量) || 0) - (parseFloat(r.现存量) || 0));
      }
    });

    const all = this.visibleRows();
    const filled = all.filter(r => r.盘点数量 !== '' && r.盘点数量 != null);
    if (!filled.length) { this.toast('尚未填写任何盘点数量'); return; }
    const unfilled = all.filter(r => !(r.盘点数量 !== '' && r.盘点数量 != null));
    // 🟢 v227.11 P1-7：确认文案从 4 行压到 2 行；skipConfirm=true 时（如从「返回」自动保存）不重复弹确认
    let tip = '确认暂停保存？本次盘点尚未结束，已填 ' + filled.length + ' 条将存为本地草稿。';
    tip += unfilled.length
      ? '\n尚有 ' + unfilled.length + ' 条未盘，可继续盘点或点【盘点结束】完成。'
      : '\n所有行均已填写，可直接点【盘点结束】完成。';
    if (!opts.skipConfirm && !(await WBModal.confirm(tip, { title: '暂停保存' }))) return;

    // 🟢 v226.1 修复：保存 = 暂停盘点 → 仅存本地草稿，不写盘点记录列表、不推云端。
    //   之前实现直接 addStocktakeRecords 落库，导致三大问题：
    //   ① 保存即进「盘点记录列表」（与"暂停"语义相悖，用户以为已保存完成）；
    //   ② 落库后 finishStocktake 用 _countedCodes 对已落库编码去重，recs 被全部过滤 → 无法结束；
    //   ③ 落库后 abandon 按 sheetId+counter 删全量记录，误删该盘点人历史数据（显示"放弃8条"）。
    //   正确闭环：保存只存草稿 → 点【盘点结束】才落库 + 同步云端（见 finishStocktake）。
    try {
      this.saveDraft();
      // 确保未结束会话标记存在（开局已标记，重复标记幂等）
      this._markOpenSession(this.sheet.sheetId, this.sheet.sheetType, counter || this.task.counter,
        this.sheet.startDate, this.sheet.endDate);
      // 🟢 v227.5：保存即更新「本次盘点概览」（status=in_progress）
      //   让管理员视图 / 自己的概览反映「已盘 X / 任务完成率」
      try { if (this.sheet.sheetType === 'quarter') await this._publishQuarterOverview({ finished: false }); } catch (e) { /* 忽略 */ }
      const syncTip = (typeof SyncManager !== 'undefined' && SyncManager.isOnline)
        ? '' : '（未连接云端不影响，结束盘点时再同步）';
      this.toast('已暂停保存（本地草稿 ' + filled.length + ' 条）。下次进入将提醒点【盘点结束】完成盘点' + syncTip);
    } catch (e) {
      console.error('[stocktake] 暂停保存失败:', e);
      this.toast('暂停保存失败：' + (e.message || e));
    }
  },

  // ---------------- 云端同步（第 4 包 stocktake.json，追加合并）----------------
  async _pushToCloud(recs) {
    const ids = recs.map(r => r.recId);
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) {
      this._markPending(ids);
      return 'offline';
    }
    try {
      const res = await SyncManager.syncStocktake(recs);
      if (res && res.ok) { this._clearPending(ids); return 'ok'; }
      this._markPending(ids);
      return 'fail';
    } catch (e) {
      console.warn('[stocktake] 云端同步异常(已标待补推):', e);
      this._markPending(ids);
      return 'fail';
    }
  },

  _getPending() {
    try { return JSON.parse(localStorage.getItem(this.PENDING_KEY) || '[]'); } catch (e) { return []; }
  },
  _markPending(ids) {
    try {
      const s = new Set(this._getPending());
      (ids || []).forEach(i => s.add(i));
      localStorage.setItem(this.PENDING_KEY, JSON.stringify(Array.from(s)));
    } catch (e) { /* 忽略 */ }
  },
  _clearPending(ids) {
    try {
      const s = new Set(this._getPending());
      (ids || []).forEach(i => s.delete(i));
      localStorage.setItem(this.PENDING_KEY, JSON.stringify(Array.from(s)));
    } catch (e) { /* 忽略 */ }
  },

  // ===== v227：删除墓碑队列（【盘点记录】删除记录时用）=====
  // 墓碑格式：{ recId, __deleted:1, deletedAt } —— 推到云端后覆盖原记录，
  // 他端 pullCloudRecords 见到 __deleted 即物理删本地同 recId 记录。
  _getTombs() {
    try { return JSON.parse(localStorage.getItem(this.TOMB_KEY) || '[]'); } catch (e) { return []; }
  },
  _addTombs(tombs) {
    try {
      const cur = this._getTombs();
      const have = new Set(cur.map(t => t.recId));
      (tombs || []).forEach(t => { if (t && t.recId && !have.has(t.recId)) cur.push(t); });
      localStorage.setItem(this.TOMB_KEY, JSON.stringify(cur));
    } catch (e) { /* 忽略 */ }
  },
  _clearTombs(recIds) {
    try {
      const left = this._getTombs().filter(t => (recIds || []).indexOf(t.recId) < 0);
      localStorage.setItem(this.TOMB_KEY, JSON.stringify(left));
    } catch (e) { /* 忽略 */ }
  },
  async _retryTombs() {
    const tombs = this._getTombs();
    if (!tombs.length) return 0;
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return 0;
    try {
      const res = await SyncManager.syncStocktake(tombs);
      if (res && res.ok) { this._clearTombs(tombs.map(t => t.recId)); return tombs.length; }
    } catch (e) { console.warn('[stocktake] 墓碑补推失败(保留待推):', e && e.message); }
    return 0;
  },

  // 联网后补推（连接成功 / 进入模块时自动调用；失败保留待推列表，下次再试）
  async retryPendingSync() {
    await this._retryTombs();
    const ids = this._getPending();
    if (!ids.length) return 0;
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return 0;
    try {
      const all = await DataStore.getStocktakeRecords();
      const recs = all.filter(r => ids.indexOf(r.recId) >= 0);
      if (!recs.length) { this._clearPending(ids); return 0; }
      const res = await SyncManager.syncStocktake(recs);
      if (res && res.ok) { this._clearPending(ids); return recs.length; }
      return 0;
    } catch (e) {
      console.warn('[stocktake] 补推异常(保留待推):', e);
      return 0;
    }
  },

  // 🟢 v227.13：落库核心（镜像 finishStocktake 的 commit 逻辑，供「管理员强制结束补录」共用）。
  //   把一组盘点行写入盘点记录列表：real/zero/unfilled 三类细分、按 sheetId+counter+存货编码 去重
  //   upsert（补盘就地更新占位不插重复行）、推云端。
  //   ⚠️ 本方法不负责清草稿/清会话/释放批次号/关任务 —— 由调用方按场景处理，
  //      以此保证 finishStocktake 原有已验证路径不被改动（小步快跑、不碰已闭环逻辑）。
  async _commitRows(rows, ctx) {
    const counter = String(ctx.counter || '').trim();
    const sheetId = ctx.sheetId;
    const filledReal = rows.filter(r => r.盘点数量 !== '' && r.盘点数量 != null && parseFloat(r.盘点数量) !== 0);
    const filledZero = rows.filter(r => r.盘点数量 !== '' && r.盘点数量 != null && parseFloat(r.盘点数量) === 0);
    const unfilled = rows.filter(r => !(r.盘点数量 !== '' && r.盘点数量 != null));
    const rangeTxt = (ctx.noStart != null && ctx.noEnd != null) ? ('序号 ' + ctx.noStart + '-' + ctx.noEnd) : '全部';
    const batchNoText = ctx.batchNo || sheetId;
    const today = this._today();
    const typeCn = ctx.sheetType === 'quarter' ? '季度' : '日常';
    const build = (r, kind) => ({
      recId: this._uuid(), sheetId: sheetId, batchNo: ctx.batchNo || '', sheetType: ctx.sheetType,
      存货编码: r.存货编码, 存货名称: r.存货名称 || '', 规格型号: r.规格型号 || '',
      现存量: parseFloat(r.现存量) || 0,
      盘点数量: kind === 'unfilled' ? null : (parseFloat(r.盘点数量) || 0),
      差异量: kind === 'unfilled' ? null : round2((parseFloat(r.盘点数量) || 0) - (parseFloat(r.现存量) || 0)),
      入库量: r.入库量 || 0, 出库量: r.出库量 || 0, 盘点日期: today, 盘点人: counter, 盘点类别: typeCn,
      开始日期: ctx.startDate, 结束日期: ctx.endDate,
      备注: kind === 'real' ? (r.备注 || '')
        : (kind === 'zero' ? ((r.备注 || '') + (r.备注 ? '；' : '') + '已盘为 0')
          : ((r.备注 || '') + (r.备注 ? '；' : '') + '未盘点')),
      noStart: ctx.noStart, noEnd: ctx.noEnd, countedAt: new Date().toISOString(),
      voided: 0, closedByFinish: kind === 'real' ? 0 : 1, unfilled: kind === 'unfilled' ? 1 : 0,
      updatedAt: new Date().toISOString()
    });
    // 🟢 v228.0（P0-2）：去重 —— 已落库编码跳过；未盘占位走 upsert 更新而非再插
    const done = await this._countedCodes(sheetId, counter);
    const realRecs = filledReal.filter(r => !done.has(r.存货编码)).map(r => build(r, 'real'));
    const zeroRecs = filledZero.filter(r => !done.has(r.存货编码)).map(r => build(r, 'zero'));
    const unfilledRecs = unfilled.filter(r => !done.has(r.存货编码)).map(r => build(r, 'unfilled'));
    const placeholders = new Map();
    try {
      const exist = await DataStore.getStocktakeRecords();
      (exist || []).forEach(r => {
        if (r.voided || r.sheetId !== sheetId) return;
        if (String(r.盘点人 || '').trim() !== counter) return;
        if (r.unfilled === 1 || r.盘点数量 == null || r.盘点数量 === '') placeholders.set(r.存货编码, r);
      });
    } catch (e) { /* 退化全插 */ }
    const inserts = [], updates = [];
    realRecs.concat(zeroRecs, unfilledRecs).forEach(rec => {
      const ph = placeholders.get(rec.存货编码);
      if (ph && ph.id != null) {
        if (rec.unfilled === 1) return;                 // 仍是未盘 → 占位已存在，无需重复写
        const patch = Object.assign({}, rec);
        patch.recId = ph.recId || rec.recId;
        delete patch.id;
        updates.push({ id: ph.id, patch });
      } else {
        inserts.push(rec);
      }
    });
    const recs = inserts.concat(updates.map(u => u.patch));
    if (!recs.length) return { inserted: 0, updated: 0, recs: [], skipped: true, counts: { real: filledReal.length, zero: filledZero.length, unfilled: unfilled.length }, rangeTxt, counter, batchNoText };
    let syncTip = '';
    try {
      if (inserts.length) await DataStore.addStocktakeRecords(inserts);
      for (const u of updates) { try { await DataStore.updateStocktakeRecord(u.id, u.patch); } catch (e) { console.warn('[stocktake] 补盘更新失败(已忽略):', e && e.message); } }
      const taskId = ctx.taskId || (sheetId + '_' + counter + '_' + (ctx.noStart != null ? ctx.noStart : 'all') + '-' + (ctx.noEnd != null ? ctx.noEnd : 'all'));
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
        const res = await SyncManager.syncStocktake(recs, {
          taskId, sheetId, sheetType: ctx.sheetType, counter,
          noStart: ctx.noStart, noEnd: ctx.noEnd, status: 'closed',
          createdAt: ctx.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
          closedAt: new Date().toISOString(), deviceId: this._deviceId()
        });
        if (res && res.ok) syncTip = '，已同步云端';
        else { this._markPending(recs.map(r => r.recId)); try { await this.retryPendingSync(); } catch (e) {} syncTip = '（云端同步失败，将在后台自动重试）'; }
      } else {
        this._markPending(recs.map(r => r.recId));
        syncTip = '（未连接云端，已存本地待补推）';
      }
    } catch (e) {
      console.error('[stocktake] 落库失败:', e);
      this._markPending((recs || []).map(r => r.recId));
      syncTip = '（落库异常，已存本地待补推）';
    }
    return { inserted: inserts.length, updated: updates.length, recs, syncTip, skipped: false, counts: { real: filledReal.length, zero: filledZero.length, unfilled: unfilled.length }, rangeTxt, counter, batchNoText };
  },

  // 🟢 v227.13 P0-3：管理员强制结束某盘点人任务时，若该盘点人在本机有未结束的草稿进度，
  //   把这部分进度真正落库到盘点记录列表（而非静默丢弃）。共享设备场景下所有盘点人的分区草稿都在本机，
  //   故管理员强制结束即可把各人未点「盘点结束」的进度一并收口；跨设备草稿（非本机）则无法补录（属 草稿上云 范畴，本期未做）。
  // 🟢 v227.15（G1·数据完整）：强制结束必须让【记录列表覆盖全部已分派编码】。
  //   旧实现：`!d.qty.length → return 0` —— 完全没保存/认领的盘点人其分派编码在记录列表里
  //   一条都不出现（连「/」占位都没有），与用户「完全未盘→变/」的要求冲突，也无法核对完整性。
  //   新实现：始终按 task.codes 全量构建行 —— 草稿有值的按实值/0，草稿缺失的按「未盘(/)」占位，
  //   交 _commitRows 走「已盘去重 + 未盘占位 upsert」：① 已落库编码跳过（幂等）② 未盘编码补「/」占位。
  //   这样无论盘点人「全填/部分保存/完全没动」，强制结束后记录列表都能完整覆盖其分派区间。
  async _commitCountingForTask(task, batchNo) {
    const codes = task.codes || [];
    if (!codes.length) return 0;
    const d = this.loadDraft(task.counter, task.sheetId) || {};
    const qty = d.qty || {};
    const stock = await DataStore.getRows('stock');
    const stockMap = {};
    (stock || []).forEach(s => { stockMap[String(s.存货编码).trim()] = s; });
    const rows = codes.map(code => {
      const s = stockMap[code] || {};
      const q = qty[code];
      return {
        存货编码: code, 存货名称: s.存货名称 || '', 规格型号: s.规格型号 || '',
        现存量: parseFloat(s.现存数量) || 0,
        盘点数量: (q === '' || q == null) ? null : q,
        入库量: s.入库量 || 0, 出库量: s.出库量 || 0,
        备注: (d.remarks && d.remarks[code]) || ''
      };
    });
    // 🟢 v227.15（G1 配套）：批次号必须统一 —— 完全未动的人没有草稿（d.sheet.batchNo 为空），
    //   若此处再调 _genBatchNo 会因 endQuarterRound 已 _markBatchFinished 释放批次号而生成 -2 后缀，
    //   导致同批次盘点号分裂（v227.10 P0-1 回潮）。故优先用调用方传入的本批次统一号 batchNo。
    const bn = batchNo || (d.sheet && d.sheet.batchNo) || this._genBatchNo('quarter', task.sheetId);
    const res = await this._commitRows(rows, {
      counter: task.counter, sheetId: task.sheetId, batchNo: bn, sheetType: 'quarter',
      noStart: task.noStart, noEnd: task.noEnd, startDate: task.startDate, endDate: task.endDate,
      taskId: task.taskId, createdAt: task.createdAt, forceClosed: true
    });
    if (res.skipped) return 0;
    // 已落库 → 清该盘点人的分区草稿，避免下次续盘重复收口
    try { localStorage.removeItem(this._draftKey(task.counter, task.sheetId)); } catch (e) {}
    return res.inserted + res.updated;
  },

  // ---------------- 结束盘点 ----------------
  // 【结束】vs【保存】的区别（你的规则）：
  //   保存：只写「已填」的行，未填的留着继续盘；
  //   结束：已填的写入 + 未填的按「盘点数量=0」写入（差异 = −现存量，记盘亏），
  //        并结束「本人 + 该序号区间」的任务，该区间不再出现。
  // 结束是【个人区间级】的，不是批次级 —— 张三结束自己的 1-45，不影响李四的 46-92。
  _taskId() {
    const c = String(this.task.counter || '').trim() || '未命名';
    const s = this.task.started ? this.task.noStart : 'all';
    const e = this.task.started ? this.task.noEnd : 'all';
    return (this.sheet ? this.sheet.sheetId : 'sheet') + '_' + c + '_' + s + '-' + e;
  },

  async finishStocktake() {
    if (!this.sheet) { this.toast('请先点击【日常盘点】或【季度盘点】'); return; }
    this._markSheetTouched('finished');
    const u = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser && AppConfig.getCurrentUser()) || null;
    const counter = String((u && u.username) || this.task.counter || '').trim();
    if (!counter) {
      WBModal.alert('盘点人未指定。请先登录库管员账号（盘点人会自动锁定为登录账号），或在「盘点人」输入框填写姓名后再结束。\n\n如不想保留本次盘点，请点「🗑️ 放弃本次盘点」。');
      return;
    }
    if (this.task.counter !== counter) this.task.counter = counter;   // v226：作业身份与登录态对齐

    const rows = this.visibleRows();
    // 🟢 v226：三类细分——已盘为非零、已盘为 0、未盘（空）。未盘 = 未输入盘点数量（盘点人列也留空）。
    const filledReal = rows.filter(r => r.盘点数量 !== '' && r.盘点数量 != null && parseFloat(r.盘点数量) !== 0);
    const filledZero = rows.filter(r => r.盘点数量 !== '' && r.盘点数量 != null && parseFloat(r.盘点数量) === 0);
    const unfilled = rows.filter(r => !(r.盘点数量 !== '' && r.盘点数量 != null));
    const rangeTxt = this.task.started
      ? ('序号 ' + this.task.noStart + '-' + this.task.noEnd) : '全部';
    const batchNoText = this.sheet.batchNo || this.sheet.sheetId;

    // 🟢 v226：未盘的也写记录，但盘点数量以「/」留空（不再按 0 计入盘亏）——
    //   「盘点数量」字段存 null，UI 渲染时显示「/」；差异量同样存 null。
    //   已盘为 0 的如实记为 0（不记负差异），备注标「已盘为 0」以保留审计痕迹。
    const ok = await WBModal.confirm(
      '确认结束本次盘点？\n\n' +
      '盘点号：' + batchNoText + '\n' +
      '盘点人：' + counter + '\n' +
      '区间：' + rangeTxt + '\n' +
      '已盘（含为 0）：' + (filledReal.length + filledZero.length) + ' 条\n' +
      '未盘点：' + unfilled.length + ' 条（以「/」保存，不计入盘亏）',
      { title: '结束盘点' }
    );
    if (!ok) return;

    const today = this._today();
    const typeCn = this.sheet.sheetType === 'quarter' ? '季度' : '日常';
    // kind: 'real' 已盘非零 / 'zero' 已盘为 0 / 'unfilled' 未盘
    const build = (r, kind) => ({
      recId: this._uuid(),
      sheetId: this.sheet.sheetId,
      batchNo: this.sheet.batchNo || '',
      sheetType: this.sheet.sheetType,
      存货编码: r.存货编码,
      存货名称: r.存货名称 || '',
      规格型号: r.规格型号 || '',
      现存量: parseFloat(r.现存量) || 0,
      // 🟢 v226：只有「未盘点」才存 null（UI 显示「/」，不计盘亏）；
      //   「已盘为 0」是真实盘过的 —— 必须存 0 并如实记盘亏（0 − 现存量），不能与未盘混为一谈。
      盘点数量: kind === 'unfilled' ? null : (parseFloat(r.盘点数量) || 0),
      差异量: kind === 'unfilled' ? null : round2((parseFloat(r.盘点数量) || 0) - (parseFloat(r.现存量) || 0)),
      入库量: r.入库量 || 0,
      出库量: r.出库量 || 0,
      盘点日期: today,
      盘点人: counter,
      盘点类别: typeCn,
      开始日期: this.query.startDate,
      结束日期: this.query.endDate,
      备注: kind === 'real'
        ? (r.备注 || '')
        : (kind === 'zero'
          ? ((r.备注 || '') + (r.备注 ? '；' : '') + '已盘为 0')
          : ((r.备注 || '') + (r.备注 ? '；' : '') + '未盘点')),
      noStart: this.task.noStart,
      noEnd: this.task.noEnd,
      countedAt: new Date().toISOString(),
      voided: 0,
      closedByFinish: kind === 'real' ? 0 : 1,   // zero/unfilled 均视为结束补 0（保留审计痕迹）
      unfilled: kind === 'unfilled' ? 1 : 0,     // 🟢 v226：未盘标记，UI 显示「/」
      updatedAt: new Date().toISOString()        // 🟢 v227.5：概览统计按时间取最新一条
    });

    // 🟢 v224 关键变化：未盘的不再写记录（按用户需求"留空"）—— 任务栏汇总里通过「未盘清单」呈现
    const done = await this._countedCodes(this.sheet.sheetId, counter);
    const realRecs = filledReal.filter(r => !done.has(r.存货编码)).map(r => build(r, 'real'));
    const zeroRecs = filledZero.filter(r => !done.has(r.存货编码)).map(r => build(r, 'zero'));
    const unfilledRecs = unfilled.filter(r => !done.has(r.存货编码)).map(r => build(r, 'unfilled'));

    // 🟢 v228.0（P0-2 修复）：补盘 upsert —— 上次留下的「未盘占位」记录，补盘时应就地更新，不能再插一条。
    //   原实现无条件 addStocktakeRecords，导致同一编码出现「1 条未盘(盘点数量=null) + 1 条实盘」两条记录：
    //   盘点记录列表重复行、汇总时同一物料被算两次。
    //   注意 _countedCodes 刻意把未盘占位排除在「已盘」之外（供补盘重盘），所以这里必须显式处理占位。
    const placeholders = new Map();     // 存货编码 -> 已存在的未盘占位记录
    try {
      const exist = await DataStore.getStocktakeRecords();
      (exist || []).forEach(r => {
        if (r.voided || r.sheetId !== this.sheet.sheetId) return;
        if (String(r.盘点人 || '').trim() !== String(counter).trim()) return;
        if (r.unfilled === 1 || r.盘点数量 == null || r.盘点数量 === '') placeholders.set(r.存货编码, r);
      });
    } catch (e) { /* 读取失败则退化为原行为（全量插入） */ }

    const inserts = [];                 // 真正新增
    const updates = [];                 // 就地更新占位：{ id, patch }
    realRecs.concat(zeroRecs, unfilledRecs).forEach(rec => {
      const ph = placeholders.get(rec.存货编码);
      if (ph && ph.id != null) {
        if (rec.unfilled === 1) return;                 // 仍是未盘 → 占位已存在，无需重复写
        const patch = Object.assign({}, rec);
        patch.recId = ph.recId || rec.recId;            // 沿用原 recId → 云端按 recId 覆盖，不产生新行
        delete patch.id;                                // 主键不能出现在 update 的 patch 里
        updates.push({ id: ph.id, patch });
      } else {
        inserts.push(rec);
      }
    });
    // recs = 本次最终生效的全部记录（新增 + 更新后的完整内容），供后续云端同步复用
    const recs = inserts.concat(updates.map(u => u.patch));
    if (!recs.length) { this.toast('本次无可结束的盘点行'); return; }

    try {
      if (inserts.length) await DataStore.addStocktakeRecords(inserts);
      for (const u of updates) {
        try { await DataStore.updateStocktakeRecord(u.id, u.patch); }
        catch (e) { console.warn('[stocktake] 补盘更新失败(已忽略):', e && e.message); }
      }
      this.clearDraft();
      // 🟢 v226：本次盘点正式结束 → 清会话标记
      // 🟢 v228.0（P0-1 修复）：盘点号是「批次级」的，只有管理员结束整个批次才释放。
      //   原实现在这里无条件调 _markBatchFinished，导致第一个完成的人就把批次号"用掉"，
      //   后续盘点人拿到 jd…-2 / -3 —— 同一次季度盘点被拆成 N 个号，管理员按号查只看到 1/N。
      //   季度盘点：个人完成不释放批次号（留给 endQuarterRound）；日常盘点：本就是一次性，照旧释放。
      this._clearOpenSession();
      if (this.sheet.sheetType !== 'quarter') this._markBatchFinished(this.sheet.sheetId);
      // v217：分派任务 → 标记 closed（保留分配时的 createdAt，补上 sheetId；审查 #5）
      let patchCreatedAt = new Date().toISOString();
      if (this.task.assignedTaskId) {
        const at = DataStore.getStocktakeTasks()[this.task.assignedTaskId];
        if (at) {
          at.status = 'closed';
          at.sheetId = this.sheet.sheetId;
          at.closedAt = new Date().toISOString();
          at.updatedAt = new Date().toISOString();
          // 🟢 v227.14：补盘完成 → 清掉指派标记（若这一轮仍留有未盘，管理员可再次指派）
          if (at.replenishAssigned) {
            delete at.replenishAssigned;
            delete at.replenishAssignedAt;
            delete at.replenishAssignedBy;
          }
          // createdAt 不动（分配时写入，命名取分配日）
          await DataStore.saveStocktakeTask(at);
          patchCreatedAt = at.createdAt;
        }
      }
      // 任务置 closed 并连同记录一起推云端
      const taskId = this._taskId();
      let syncTip = '';
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
        const res = await SyncManager.syncStocktake(recs, {
          taskId, sheetId: this.sheet.sheetId, sheetType: this.sheet.sheetType,
          counter, noStart: this.task.noStart, noEnd: this.task.noEnd,
          status: 'closed', createdAt: patchCreatedAt, updatedAt: new Date().toISOString(),
          closedAt: new Date().toISOString(), deviceId: this._deviceId()
        });
        if (res && res.ok) {
          syncTip = '，已同步云端';
        } else {
          // 🟢 v227.5：联网但 sync 返回失败（除本端记录外的乐观锁冲突/服务端错误）也要标待补推，
          //   否则 "将自动重试" 不会真的触发 —— 必须加入 PENDING 才能被 retryPendingSync 拉起来
          try { this._markPending(recs.map(r => r.recId)); } catch (e) { /* 忽略 */ }
          // 立即再次尝试后台补推一次（解决"失败后不重试"的体感问题）
          try { await this.retryPendingSync(); } catch (e) { /* 忽略 */ }
          syncTip = '（云端同步失败，将在后台自动重试）';
        }
      } else {
        this._markPending(recs.map(r => r.recId));
        syncTip = '（未连接云端，已存本地待补推）';
      }
      this.toast(counter + ' · ' + rangeTxt + ' 已结束：' +
        filledReal.length + ' 条实盘 + ' + filledZero.length + ' 条 0 + ' + unfilled.length + ' 条未盘' + syncTip);
      // 🟢 v226：日常盘点不写批次快照（日常结果/过程不出现在盘点批次模块中）——
      //   仅季度盘点（多人协作）需要批次汇总。
      if (this.sheet.sheetType === 'quarter') {
        try { await this._generateBatchSummary(); } catch (err) { console.error('[stocktake] 批次汇总生成失败:', err); }
      }
      await this._resetStocktakingSession();
    } catch (e) {
      console.error('[stocktake] 结束盘点失败:', e);
      this.toast('结束失败：' + (e.message || e));
    }
  },

  // v218：放弃本次盘点（中途不盘了）—— 回滚本人该批次全部记录，不生成垃圾批次汇总
  // 边界：若该批次还有其他盘点人的记录，则仅删本人记录并重算批次汇总；否则连批次快照一起删
  // 未登录态：直接清现场（不删 Dexie 真实记录，因为没有归属人，避免误删）
  async abandonStocktake() {
    if (!this.sheet) { this.toast('请先点击【日常盘点】或【季度盘点】'); return; }
    this._markSheetTouched('abandoned');
    const u = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser && AppConfig.getCurrentUser()) || null;
    const loggedIn = !!(u && u.username);
    // v219：取归属人（登录用户优先，否则用本次已锁定的 counter）
    const counter = String((u && u.username) || this.task.counter || '').trim();

    const sheetId = this.sheet.sheetId;

    if (!loggedIn && !counter) {
      // 未登录 + 本次盘点也没指定归属人 → 只清现场（in-memory 草稿 + 任务状态），不碰数据库
      const ok = await WBModal.confirm('当前未登录库管员账号，盘点人会无法归属。\n确认放弃本次盘点？（只清空当前页面状态，不删除任何已存在的盘点记录）', { title: '放弃盘点' });
      if (!ok) return;
      await this._resetStocktakingSession();
      this.toast('已放弃本次盘点（未登录态，未删除任何记录）');
      return;
    }

    const d = this.loadDraft();
    const draftCount = d && d.qty ? Object.keys(d.qty).length : 0;
    const ok = await WBModal.confirm(
      '确认放弃本次盘点？\n\n' +
      '盘点人：' + counter + '\n' +
      '盘点号：' + (this.sheet.batchNo || sheetId) + '\n\n' +
      '仅清空本机本地草稿（' + draftCount + ' 条未结束的盘点数量），' +
      '不删除任何已落库 / 已结束的盘点记录。' +
      (this.task.assignedTaskId ? '\n（将同时取消你认领的该分派任务）' : ''),
      { title: '放弃盘点' }
    );
    if (!ok) return;

    try {
      // 🟢 v226.1 修复：放弃 = 丢弃未结束的本地草稿，不删已落库记录。
      //   保存只是「暂停」（数据存草稿，未落库），因此放弃只需清草稿即可，
      //   之前按 sheetId+counter 删全量记录会误删历史数据（如显示"放弃8条"）。
      // 1) 关联的分派任务：🟢 v227.11 P1-6 改为「重置为待领取」而非删除——
      //    保留管理员的派活意图（counter / 序号 / codes 不动），让盘点人可重新进入、
      //    管理员视图本批次仍见该分派（🟡 进行中），不再因放弃而凭空消失。
      if (this.task.assignedTaskId) {
        const _t = (DataStore.getStocktakeTasks() || {})[this.task.assignedTaskId];
        if (_t && !_t.deleted) {
          _t.status = 'open';
          _t.started = false;
          _t.closedAt = null;
          _t.claimedAt = null;
          _t.updatedAt = new Date().toISOString();
          await DataStore.saveStocktakeTask(_t);
        }
      }
      // 2) 清空本地草稿 + 清会话标记 + 重置现场（回到未开始状态）
      this.clearDraft();
      this._clearOpenSession();
      await this._resetStocktakingSession();
      this.toast('已放弃本次盘点（清空本地草稿 ' + draftCount + ' 条，未删除任何已落库记录）');
    } catch (e) {
      console.error('[stocktake] 放弃盘点失败:', e);
      this.toast('放弃失败：' + (e.message || e));
    }
  },

  // v219：盘点现场重置（提取出来给 abandon / finish 复用）
  async _resetStocktakingSession() {
    // 🟢 v227.5：先保留入口类型（this.sheet 会清空）
    const entry = this._entrySheetType;
    const finishedAt = new Date().toISOString();
    // 🟢 v227.5：本次盘点结束/放弃 → 把概览落地（含已盘/未盘/任务完成率）。
    //   只有 quarter 才有"概览"语义（日常盘点每次一个区间一个快照，无协作价值，不需要挂出来）；
    //   finished 区分结束 vs 中途放弃（finished=true=点过盘点结束, false=放弃）。
    try {
      const finished = !!(this._sheetTouched && this._sheetTouched.finished);
      // 🟢 v227.16 修复：原实现此处未 await，渲染（startQuarter）抢在概览落地之前，
      //    导致盘点人点【盘点结束】返回后任务视图显示过期的「已盘 0/5 · 未结束」。
      //    改为 await，保证返回时即渲染最新概览（已盘/未盘/完成率/已结束 状态都对）。
      await this._publishQuarterOverview({ finished, finishedAt });
    } catch (e) { console.warn('[stocktake] 概览落地失败(已忽略):', e && e.message); }
    this.allRowsFull = [];
    this.allRows = [];
    this.sheet = null;
    this.task.started = false;
    this.task.noStart = null;
    this.task.noEnd = null;
    this.task.assignedTaskId = null;
    this.task.counter = null;
    this._sheetTouched = null;   // 🟢 v227.5：本次盘点已收尾 → 清痕迹，避免污染下一轮
    this.clearDraft();
    this._clearOpenSession();   // 🟢 v226：放弃本次盘点 → 会话标记一并清除
    // 🟢 v227.5：按入口类型导航回对应初始界面（季度进入 → 季度选择器；日常进入 → 日常日期选择）
    // 🟢 v227.16 修复：finish/abandon 后必须跳过续盘检测（_skipResumePrompt）。否则 abandon 把任务
    //   重置为 open 且其已有实盘记录时，startQuarter 内的 _detectUnfinished 第 3 分支命中 → 自动
    //   resume 进表而非回任务视图（用户反馈"放弃后没回任务视图，反而直接进表"）。
    this._skipResumePrompt = true;
    if (entry === 'quarter') this.startQuarter();
    else if (entry === 'daily') this.startDaily();
    else this.render();
    this._refreshTaskBar();
  },

  // ===== v217 批次汇总生成（结束即快照；进行中批次由汇总模块实时计算 §2.6）=====
  // v217：把云端其他设备上传的盘点记录拉到本地（按 recId 去重，只补缺失的）
  // 只在有网络时生效；失败静默，不影响本地使用。
  async pullCloudRecords() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return 0;
    if (typeof SyncManager.pullStocktake !== 'function') return 0;
    try {
      const cloud = await SyncManager.pullStocktake();
      const list = (cloud && cloud.records) || [];
      if (!list.length) return 0;
      const local = await DataStore.getStocktakeRecords();
      const have = new Map();
      (local || []).forEach(r => { if (r && r.recId) have.set(r.recId, r); });

      // 🟢 v227：云端墓碑（__deleted=1）+ 本地待推墓碑 → 物理删本地同 recId 记录。
      //   他人在【盘点记录】里删除记录后，本机 pull 到此墓碑即同步删除；
      //   本机离线删除的墓碑也在此生效，避免云端原记录被重新拉回（删除失效）。
      const tombs = list.filter(r => r && r.recId && r.__deleted).concat(this._getTombs());
      const tombIds = new Set(tombs.map(t => t.recId));
      let deleted = 0;
      for (const rid of tombIds) {
        const hit = have.get(rid);
        if (hit && hit.id != null) {
          await DataStore.deleteStocktakeRecord(hit.id);
          have.delete(rid);
          deleted++;
        }
      }

      const missing = list.filter(r => r && r.recId && !r.__deleted && !tombIds.has(r.recId) && !have.has(r.recId));
      if (!missing.length) {
        if (deleted && typeof showToast === 'function') showToast('已同步删除 ' + deleted + ' 条他人删除的盘点记录');
        return deleted;
      }
      await DataStore.addStocktakeRecords(missing.map(r => {
        const c = Object.assign({}, r);
        delete c.id;                 // 交给本地 Dexie 自增主键
        return c;
      }));
      if (typeof showToast === 'function') {
        showToast('已同步 ' + missing.length + ' 条他人盘点记录' + (deleted ? '、删除 ' + deleted + ' 条' : ''));
      }
      return missing.length + deleted;
    } catch (e) {
      console.warn('[stocktake] 云端记录拉取失败(已忽略):', e && e.message);
      return 0;
    }
  },

  async _generateBatchSummary() {
    if (!this.sheet) return;
    // 🟢 v226：日常盘点不写批次快照——日常结果不出现在盘点批次模块
    if (this.sheet.sheetType === 'daily') return;
    // v217：汇总前确保已拿到所有人的记录（审查 #1），否则会漏盘他人进度
    await this.pullCloudRecords();
    const sheetId = this.sheet.sheetId;
    // ① v224 修复：改为「按全量记录重算」，不再防覆盖。
    //    旧逻辑（已有快照就直接 return）会让第 2 个结束的人的记录永远进不了汇总：
    //    甲先结束 → 快照定格为甲的 2 条；乙再结束 → 记录落库了但快照不动，
    //    于是「盘点记录列表 4 条、批次汇总 counted=2」——两处对不上（相悖状态）。
    //    快照本就是从记录实时算出来的，而 pullCloudRecords() 已确保拿到所有人的记录，
    //    重算只会更全、不会丢数据。
    //    仅保留「已作废」保护：管理员手动作废的批次不因有人结束而自动复活。
    const exist = await DataStore.getStocktakeBatch(sheetId);
    if (exist && exist.voided) {
      this.toast('该批次汇总已作废，未自动重算。如需恢复，请到「盘点批次汇总」点「重新生成」');
      return;
    }
    if (exist) this.toast('已根据最新记录重算该批次汇总');
    // ② 应盘全集：按 sheetId 重算（不依赖 allRowsFull —— 审查 #2）
    const totalCodes = await this._calcBatchTotalCodes();
    // ③ 已盘：读该批次全量记录（pull 合并后含所有人的 —— 审查 #1）
    const allRecs = await DataStore.getStocktakeRecordsBySheet(sheetId);
    // v224：把记录列表挂到模块实例上，供 _genBatchName() 取真实盘点日期
    this._batchAllRecs = allRecs || [];
    // ③b 存量去重：同编码保留最新一条（审查 #10，防覆盖率/盈亏虚高）
    const validRecs = window.dedupStocktakeRecords((allRecs || []).filter(r => !r.voided));
    // 🟢 v224：v223 起未盘不再按 0 写入，所以「已盘 = 全部有效记录」（含已盘为 0）；
    //   closedByFinish 仅是审计标记，不影响是否计入已盘
    // 🟢 v226：新增「未盘点」占位记录（盘点数量=null，UI 显示「/」）—— 它不是已盘，
    //   必须排除，否则 done/counted/zeroFilled 全部虚高（盘 1 条显示 3/3 完成）。
    const countedRecs = validRecs.filter(r => !(r.unfilled === 1 || r.盘点数量 == null || r.盘点数量 === ''));
    const countedSet = new Set(countedRecs.map(r => r.存货编码));
    const realSet = countedSet;
    // 🟢 v224：已盘为 0 的记录集合（用于覆盖统计与未盘清单剔除）
    const zeroFilledCodes = countedRecs.filter(r => r.closedByFinish).map(r => r.存货编码);
    // ④ 盘盈 / 盘亏（差异量已 round2 修过精度）
    let profit = 0, loss = 0;
    validRecs.forEach(r => {
      const d = Number(r.差异量) || 0;
      if (d > 0) profit += d; else if (d < 0) loss += Math.abs(d);
    });
    // ⑤ 各人进度：done 只统计「真人实盘」，结束时补的 0 不计入（否则进度虚高 —— 审查 #9）
    const byCounter = {};
    countedRecs.forEach(r => {
      const c = r.盘点人 || '未知';
      byCounter[c] = byCounter[c] || { done: 0 };
      byCounter[c].done++;
    });
    const batchTasks = await DataStore.getTasksBySheet(sheetId);
    this._batchTasks = batchTasks || [];        // 供 _genBatchName() 取分配日（§2.7）
    (batchTasks || []).forEach(t => {
      if (!byCounter[t.counter]) byCounter[t.counter] = { done: 0 };
      byCounter[t.counter].assigned = t.codes ? t.codes.length : (t.noEnd - t.noStart + 1);
      byCounter[t.counter].status = t.status;
    });
    // ⑥ 未盘清单（分派可判归属，认领诚实标 unknown —— 审查 #4）
    const uncounted = [...totalCodes].filter(c => !countedSet.has(c));
    const openTasks = (batchTasks || []).filter(t => t.status === 'open');
    const uncountedCodes = uncounted.map(code => {
      const t = openTasks.find(t => t.codes && t.codes.includes(code));
      if (t) return { code, reason: 'assigned', assignee: t.counter };
      return { code, reason: openTasks.length ? 'unassigned' : 'unknown', assignee: null };
    });
    // ⑥b 已盘为 0 的清单（便于一眼看出"账面有但实盘为 0"项）
    const zeroFilledList = countedRecs.filter(r => r.closedByFinish).map(r => ({ code: r.存货编码, assignee: r.盘点人 || null }));

    const summary = {
      sheetId,
      batchName: this._genBatchName(),
      sheetType: this.sheet.sheetType,
      startDate: this.sheet.startDate, endDate: this.sheet.endDate,
      total: totalCodes.size,
      counted: realSet.size,
      zeroFilled: zeroFilledList.length,
      uncounted: uncounted.length,
      realCoverage: totalCodes.size ? realSet.size / totalCodes.size : 0,
      bookCoverage: totalCodes.size ? countedSet.size / totalCodes.size : 0,
      profit: round2(profit), loss: round2(loss),
      byCounter, uncountedCodes, zeroFilledCodes: zeroFilledList,
      savedAt: new Date().toISOString(),
      generatedBy: this.task.counter,
      deviceId: this._deviceId(),
      voided: 0
    };
    await DataStore.addStocktakeBatch(summary);
    await this._pushBatchToCloud(summary);
  },

  async _calcBatchTotalCodes() {
    const { sheetType, startDate, endDate } = this.sheet;
    const stock = await DataStore.getRows('stock');
    const codes = (stock || []).map(s => String(s.存货编码 == null ? '' : s.存货编码).trim()).filter(Boolean);
    if (sheetType === 'quarter') return new Set(codes);   // 季度 = 全库
    const out = await DataStore.getOutbound({ startDate, endDate }, 1, 1000000);
    const outMap = this._aggByCode(out && out.items ? out.items : (out || []), '出库数量');
    return new Set(codes.filter(c => outMap[c] > 0));
  },

  _genBatchName() {
    const typeCn = this.sheet.sheetType === 'quarter' ? '季度盘点' : '日常盘点';
    let d;
    if (this.sheet.sheetType === 'quarter') {
      const t = (this._batchTasks || []).find(t => t.counter === this.task.counter);
      d = (t && t.createdAt) ? String(t.createdAt).slice(0, 10) : this._today();
    } else {
      // 🟢 v224：日常盘点的批次日期取该批次实际盘点动作的日期（盘点记录里的「盘点日期」字段），
      //   而不是「生成汇总的今天」。用户反馈：批次汇总写「2026-09-01」但实际是更早或更晚盘的，怀疑不准。
      //   取该 sheet 下所有未作废记录的 盘点日期 最小值（最真实的最早一次盘点）。
      try {
        const recs = (this._batchAllRecs || []).filter(r => !r.voided && r.盘点日期);
        if (recs.length) {
          const dates = recs.map(r => String(r.盘点日期).slice(0, 10)).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
          d = dates[0] || this._today();
        } else {
          d = this._today();
        }
      } catch (e) { d = this._today(); }
    }
    return d + ' ' + typeCn;
  },

  async _pushBatchToCloud(summary) {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    try { await SyncManager.pushStocktakeBatch(summary); } catch (e) { console.warn('[stocktake] 批次汇总上云失败(已忽略):', e && e.message); }
  },

  _deviceId() {
    try {
      let id = localStorage.getItem('wb_device_id');
      if (!id) { id = 'd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); localStorage.setItem('wb_device_id', id); }
      return id;
    } catch (e) { return 'unknown'; }
  },

  // ---------------- 续盘过滤 ----------------
  // 本次批次中「本人已盘」的编码集合（含结束时补 0 的那些，它们也在记录里）
  // 已盘过的编码集合（用于续盘/补盘时剔除、以及结束时避免重复写记录）
  // 🟢 v226：只认「实盘」记录 —— 盘点数量为 null 的「未盘点」占位记录（UI 显示「/」）
  //    不算已盘，否则补盘/续盘时会误判全部盘完，导致漏盘的编码再也点不到。
  async _countedCodes(sheetId, counter) {
    try {
      const rows = await DataStore.getStocktakeRecords();
      const s = new Set();
      (rows || []).forEach(r => {
        if (r.sheetId !== sheetId || r.盘点人 !== counter || r.voided) return;
        if (r.unfilled === 1 || r.盘点数量 == null || r.盘点数量 === '') return;  // 未盘点占位 → 不算
        s.add(r.存货编码);
      });
      return s;
    } catch (e) { return new Set(); }
  },

  // 🟢 v224：检测是否存在未结束的盘点
  //   条件：① 草稿属于该 sheetId 且有填写 ② 或 该 sheetId 下 counter 还有任务 open 且有真实已盘记录（未盘完）
  //   返回：null 或 {sheetId, sheetType, counter, reason:'draft'|'open'}
  async _detectUnfinished(sheetId, sheetType, counter) {
    try {
      // ① 本地草稿（🟢 v227.11：按 counter+sheetId 分区读取，避免共享设备串稿）
      const d = this.loadDraft(counter, sheetId);
      if (d && d.sheet && d.sheet.sheetId === sheetId) {
        const qtyCount = Object.keys((d && d.qty) || {}).length;
        // 🟢 v224 归属校验：草稿是全局单份，若属于别的人（换账号登录同一台设备）绝不能恢复，
        //    否则会把当前人的盘点结果记到别人名下（与 v223 同类的归属错乱）。
        const dCounter = String((d.task && d.task.counter) || '').trim();
        const mine = !dCounter || !counter || dCounter === counter;
        if (mine && qtyCount > 0) return { sheetId, sheetType, counter: dCounter || counter, reason: 'draft' };
      }
      // ①b 🟢 v226：存在「未结束的盘点会话」→ 保存只是暂停，必须点【盘点结束】才算完成。
      //     只要该会话属于同一 sheetId + 同一作业身份，无论有没有草稿都要提醒。
      const s = this._getOpenSession();
      if (s && s.sheetId === sheetId) {
        const sCounter = String((s && s.counter) || '').trim();
        const sMine = !sCounter || !counter || sCounter === counter;
        if (sMine) return { sheetId, sheetType, counter: sCounter || counter, reason: 'session' };
      }
      // ② 该 sheetId 下本人有任务 open 且非 closedByFinish 全部完成
      if (counter) {
        const recs = (await DataStore.getStocktakeRecordsBySheet(sheetId)) || [];
        const myRecs = recs.filter(r => r.盘点人 === counter && !r.voided);
        const realDone = myRecs.filter(r => !r.closedByFinish).length;
        let total = 0;
        if (sheetType === 'quarter') {
          // 季度：找到本人在本批次区间内的 open 任务，任务编码数即应盘总数
          const allTasks = DataStore.getStocktakeTasks() || {};
          const tid = Object.keys(allTasks).find(k => {
            const x = allTasks[k];
            return x && x.counter === counter && x.status === 'open' &&
              (x.startDate == null || (x.startDate === this.query.startDate && x.endDate === this.query.endDate));
          });
          const t = tid ? allTasks[tid] : null;
          total = t ? (t.codes ? t.codes.length : (t.noEnd - t.noStart + 1)) : 0;
        }
        // 日常盘点没有分派任务，总数未知 → 只靠草稿判断（上面分支）
        if (total > 0 && realDone > 0 && realDone < total) {
          return { sheetId, sheetType, counter, reason: 'open' };
        }
      }
    } catch (e) { console.warn('[stocktake] 续盘检测异常:', e); }
    return null;
  },

  // 🟢 v224：跳回未结束的盘点现场（弹窗确认）
  async _resumeToSheet(info) {
    // 🟢 v227.14：批次已强制结束 → 禁止「自动续盘」绕过闸门。
    //   旧行为：只要本机残留 open session / 草稿，盘点人一进季度盘点（或点工作台「继续盘点」）
    //   就被直接带回填表界面，管理员的「本次季度盘点结束」形同虚设（v227.9 只禁了 picker 入口，
    //   续盘这条旁路没堵）。收口后统一回 picker：未指派 → ⛔ 已结束；已指派补盘 → 🔧 补盘按钮。
    if (info && info.sheetType === 'quarter' && this.isQuarterRoundClosed(info.sheetId)) {
      this._clearOpenSession();
      this._skipResumePrompt = true;   // 防止 startQuarter 再次命中续盘检测 → 无限递归
      await this.startQuarter();
      return;
    }
    // 🟢 v226：明确语义 —— 保存 ≠ 完成；本次盘点只有点【盘点结束】才算完成。
    // 🟢 v226：三种来源都是「未结束」：session（保存后暂停）/ draft（有草稿）/ open（季度任务未完成）
    const msg = info.reason === 'open'
      ? '上次分配给你的季度盘点任务尚未完成（保存≠结束，必须点盘点结束才算完成）。是否继续？'
      : '上次盘点处于「暂停」状态（未点【盘点结束】）。\n\n要点【盘点结束】才算完成本次盘点；点【取消】则放弃本次未完成的盘点（已保存的记录会保留）。\n\n是否继续上次盘点？';
    const ok = await WBModal.confirm(msg, { title: '检测到未结束的盘点' });
    if (!ok) {
      // 取消 = 放弃本次未结束的盘点：清会话标记 + 清草稿（已落库的记录保留）
      this.clearDraft();
      this._clearOpenSession();
      // 🟢 v227.5：取消续盘后必须回到对应初始界面（否则界面一片空白，看不到概览/任务）
      this._skipResumePrompt = true;
      if (info.sheetType === 'quarter') await this.startQuarter();
      else await this.startDaily();
      return;
    }
    // 继续：触发原 startDaily/startQuarter 的后续逻辑
    if (info.sheetType === 'daily') {
      this._continueDailyInternal(info);
    } else {
      this._continueQuarterInternal(info);
    }
  },

  // 续盘：跳过 detect，直接走取数+渲染+草稿恢复（startDaily 的下半部分）
  async _continueDailyInternal(info) {
    const sd = this.query.startDate, ed = this.query.endDate;
    const area = document.getElementById('stArea');
    if (area) area.innerHTML = '<div class="empty-state"><div class="empty-text">正在恢复上次盘点…</div></div>';
    try {
      const [obRes, inRes, stock] = await Promise.all([
        DataStore.getOutbound({ startDate: sd, endDate: ed }, 1, 'all'),
        DataStore.getInbound({ startDate: sd, endDate: ed }, 1, 'all'),
        DataStore.getRows('stock')
      ]);
      const outMap = this._aggByCode(obRes.items || [], '出库数量');
      const outCodes = new Set(Object.keys(outMap));
      if (outCodes.size === 0) { this.clearDraft(); return this.startDaily(); }
      const inMap = this._aggByCode(inRes.items || [], '数量');
      // 🟢 v226：续盘沿用原批次盘点号（草稿里带了就直接用，否则按 sheetId 复用/生成）
      const _d = this.loadDraft();
      const _dSheetId = 'daily_' + sd.slice(5) + '_' + ed.slice(5);
      this.batchNo = (_d && _d.sheet && _d.sheet.batchNo) || this._genBatchNo('daily', _dSheetId);
      this.sheet = { sheetId: _dSheetId, batchNo: this.batchNo, sheetType: 'daily', startDate: sd, endDate: ed };
      this.allRowsFull = this.buildRows(stock || [], outMap, inMap, outCodes);
      this.allRows = this.allRowsFull.slice();
      this.showInOut = true;
      this.task.started = false;
      // 🟢 v224：归属人以「当前登录账号」为准，绝不沿用草稿里可能属于他人的 counter
      const cur = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '').trim();
      this.task.counter = String(cur || info.counter || '').trim();
      this._sheetTouched = null;   // 🟢 v227.5：续盘 = 新一轮 → 清空痕迹
      this._markOpenSession(_dSheetId, 'daily', this.task.counter, sd, ed);
      await this._applyResumeFilter();
      this._restoreDraft();
      await this._applyAssignedIfAny();
      this._entrySheetType = 'daily';
      this.renderTable();
    } catch (e) { console.error('[stocktake] 续盘失败:', e); }
  },

  // 续盘：季度盘点
  async _continueQuarterInternal(info) {
    const sd = this.query.startDate, ed = this.query.endDate;
    const sheetId = info.sheetId;
    const allTasks = DataStore.getStocktakeTasks() || {};
    const myTasks = info.counter ? (DataStore.getMyOpenTasks(info.counter) || []) : [];
    this.batchNo = this._genBatchNo('quarter', sheetId);

    // 🟢 v227.3：续盘时点「确定」后直接进入正式盘点界面，跳过任务选择器。
    //   找到本人在本批次第一个 open 任务 → 直接 _claimQuarterTask；找不到再回退到选择器
    //   （理论上 _detectUnfinished 命中说明一定有未完成任务，回退路径为防御）。
    const openTask = myTasks.find(t => t && t.sheetType === 'quarter' &&
      (t.startDate == null || (t.startDate === sd && t.endDate === ed)) && t.status !== 'closed');
    if (openTask) {
      this._entrySheetType = 'quarter';
      await this._claimQuarterTask(openTask.taskId);
      return;
    }

    // 🟢 v227.16 修复：补盘（任务已 closed）场景也应能从「继续盘点」回到现场
    //   原实现只认 open 任务，补盘任务恰好是 closed → 走回退渲染一个缺「我的补盘」块的残缺 picker
    const closedTask = info.counter
      ? Object.keys(allTasks).map(k => allTasks[k]).find(t => t && t.sheetType === 'quarter'
        && String(t.counter || '') === String(info.counter)
        && (t.startDate == null || (t.startDate === sd && t.endDate === ed))
        && t.status === 'closed')
      : null;
    if (closedTask) {
      this._entrySheetType = 'quarter';
      await this._claimQuarterTask(closedTask.taskId);
      return;
    }

    // 回退：本批次所有任务列表（季度 = 全库清点，旧调用方仍可走选择器）
    // 🟢 v227.16：回退分支传真实 myClosed，否则「🧩 我的补盘」块会整块消失
    const myClosed = info.counter
      ? Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
        t && t.counter === info.counter && t.status === 'closed' && this._taskInCurrentBatch(t, sd, ed))
      : [];
    const sameBatchAll = Object.keys(allTasks)
      .map(k => allTasks[k])
      .filter(t => t && t.sheetType === 'quarter' && (t.startDate == null || (t.startDate === sd && t.endDate === ed)));
    this._renderQuarterTaskPicker(sd, ed, sheetId, myTasks, sameBatchAll, info.counter, myClosed, this.batchNo);
  },

  // 剔除本人已盘的行。
  // ⚠️ 序号保持「全集编号」不重排 —— 否则张三盘完 1-20 后剩下的会重排成 1-25，
  //    与李四/其他设备的编号对不上，认领区间就乱了。跳号是正确行为。
  async _applyResumeFilter() {
    const counter = String(this.task.counter || '').trim();
    if (!counter || !this.sheet || !this.allRowsFull) return 0;
    const done = await this._countedCodes(this.sheet.sheetId, counter);
    const before = this.allRows.length;
    this.allRows = done.size
      ? this.allRowsFull.filter(r => !done.has(r.存货编码))
      : this.allRowsFull.slice();
    return before - this.allRows.length;
  },

  // ---------------- 扫码定位 ----------------
  // 扫码是「独立按钮」：识别后定位到盘点表格对应行，不跳转档案页。
  openScan() {
    if (!this.allRows || !this.allRows.length) { this.toast('请先开始盘点（日常/季度）再扫码'); return; }
    if (typeof QRScan === 'undefined' || typeof QRScan.open !== 'function') {
      this.toast('扫码组件未加载'); return;
    }
    try { QRScan.open('stocktake'); } catch (e) { this.toast('打开扫码失败：' + (e.message || e)); }
  },

  // 扫码命中：定位到对应行 → 高亮 → 聚焦【盘点数量】输入框
  // 规则：命中但不在当前可见区间 → 提示后取消操作（不填数、不跳行、不自动扩大区间）
  focusRowByCode(code) {
    const c = String(code == null ? '' : code).trim();
    if (!c) return;
    const row = (this.allRows || []).find(r => r.存货编码 === c);
    if (!row) { this.toast('该编码不在盘点范围内'); return; }

    const vis = this.visibleRows();
    if (!vis.some(r => r.存货编码 === c)) {
      const range = this.task.started ? `当前区间 ${this.task.noStart}-${this.task.noEnd}` : '当前列表';
      this.toast(`该编码（序号 ${row.no}）不在${range}内，已取消`);
      return;
    }

    const tr = document.querySelector(`tr[data-code="${c}"]`);
    if (!tr) { this.toast('未找到该行，请确认列表已渲染'); return; }
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
    tr.style.transition = 'background-color .3s';
    tr.style.backgroundColor = 'rgba(255,215,0,.45)';
    setTimeout(() => { tr.style.backgroundColor = ''; }, 1200);
    const inp = tr.querySelector('.st-qty');
    if (inp) { inp.focus(); inp.select(); }
  },

  // ---------------- 空态 ----------------
  renderEmptyState() {
    // 🟢 v226：未结束的盘点会话（保存=暂停）→ 首屏直接提醒，避免用户忘了还有一次盘点没结束
    const s = this._getOpenSession();
    const openTip = s ? `
      <div style="margin-top:10px;padding:10px 14px;border-radius:8px;background:var(--status-warning-bg,#fff7ed);border:1px solid #fed7aa;font-size:13px;">
        ⚠️ 有未结束的盘点：盘点号 <b>${esc(s.batchNo || s.sheetId)}</b>（${s.sheetType === 'quarter' ? '季度' : '日常'} · 盘点人 ${esc(s.counter || '未填写')} · 始于 ${esc(String(s.startedAt || '').slice(0, 16).replace('T', ' '))}）<br>
        点击【${s.sheetType === 'quarter' ? '季度盘点' : '日常盘点'}】继续；盘完必须点【盘点结束】才算完成本次盘点。
        <button class="btn--ghost" style="margin-left:8px;" onclick="StocktakeModule._clearOpenSession();App.go('stocktake')">放弃本次</button>
      </div>` : '';

    const d = this.loadDraft();
    const draftTip = d ? `
      <div style="margin-top:10px;padding:10px 14px;border-radius:8px;background:var(--status-info-bg,#eef6ff);font-size:13px;">
        💾 检测到未完成的盘点草稿（盘点人：${esc((d.task && d.task.counter) || '未填写')}
        · 已填 ${Object.keys(d.qty || {}).length} 条
        · 更新于 ${esc(String(d.updatedAt || '').slice(0, 16).replace('T', ' '))}）
        <button class="btn--ghost" style="margin-left:8px;" onclick="StocktakeModule.clearDraft();App.go('stocktake')">清空草稿</button>
      </div>` : '';
    return `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <div class="empty-text">请选择日期区间，然后点击【日常盘点】或【季度盘点】开始</div>
        <div class="empty-sub" style="margin-top:6px;font-size:13px;opacity:.75;">
          日常盘点：核对区间内出过库的物料 · 季度盘点：全库清点
        </div>
      </div>
      ${openTip}
      ${draftTip}
    `;
  },

  // ---------------- 本地草稿 ----------------
  // 🟢 v227.11 P1-5：草稿按「盘点人 + 批次(sheetId)」分区，杜绝共享设备互相覆盖。
  //   旧版用单一全局槽 wb_stocktake_draft，甲保存后乙保存会直接覆盖甲的草稿。
  _draftKey(counter, sheetId) {
    const c = String(counter || '').trim();
    const s = String(sheetId || '').trim();
    if (c && s) return 'wb_stocktake_draft_' + c + '_' + s;
    return this.DRAFT_KEY; // 兜底：无归属/无 sheet 时用全局单槽（兼容无登录或极早期路径）
  },

  saveDraft() {
    try {
      const qty = {};
      (this.allRows || []).forEach(r => {
        if (r && r.存货编码 != null && r.盘点数量 !== '' && r.盘点数量 != null) qty[r.存货编码] = r.盘点数量;
      });
      const key = this._draftKey(this.task.counter, this.sheet && this.sheet.sheetId);
      localStorage.setItem(key, JSON.stringify({
        sheet: this.sheet, task: this.task, qty: qty, updatedAt: new Date().toISOString()
      }));
    } catch (e) { console.warn('[stocktake] 草稿保存失败(已忽略):', e); }
  },

  // counter / sheetId 显式传入时优先（用于 _detectUnfinished 等 sheet 尚未挂到 this.sheet 的场景）
  loadDraft(counter, sheetId) {
    try {
      const key = this._draftKey(
        counter != null ? counter : this.task.counter,
        sheetId != null ? sheetId : (this.sheet && this.sheet.sheetId)
      );
      const raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
      // 🟢 v227.11：兼容升级前写入的全局单槽草稿（一次性迁移到分区键）
      if (key !== this.DRAFT_KEY) {
        const legacy = localStorage.getItem(this.DRAFT_KEY);
        if (legacy) return JSON.parse(legacy);
      }
      return null;
    } catch (e) { return null; }
  },

  clearDraft() {
    try {
      const key = this._draftKey(this.task.counter, this.sheet && this.sheet.sheetId);
      if (key !== this.DRAFT_KEY) localStorage.removeItem(key);
      localStorage.removeItem(this.DRAFT_KEY); // 同时清全局单槽（升级迁移清理，无害）
    } catch (e) { /* 忽略 */ }
  },

  // 开始盘点后，若草稿属于同一 sheetId 则恢复已填数量
  _restoreDraft() {
    const d = this.loadDraft();
    if (!d || !d.sheet || !this.sheet) return;
    if (d.sheet.sheetId !== this.sheet.sheetId) return;
    // 🟢 v224 归属校验：草稿属于别人（换账号登录）时绝不恢复，避免把数量盘到别人名下
    const dCounter = String((d.task && d.task.counter) || '').trim();
    const cur = String(this.task.counter ||
      ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '')).trim();
    if (dCounter && cur && dCounter !== cur) return;
    const qty = d.qty || {};
    let n = 0;
    this.allRows.forEach(r => {
      if (Object.prototype.hasOwnProperty.call(qty, r.存货编码)) {
        r.盘点数量 = qty[r.存货编码];
        const f = parseFloat(r.盘点数量);
        r.差异量 = isNaN(f) ? '' : (f - (parseFloat(r.现存量) || 0));
        n++;
      }
    });
    if (n > 0) this.toast('已恢复上次未完成的 ' + n + ' 条盘点数量');
  },

  onLeave() { /* 不清数据：草稿已在 localStorage，切换模块回来保留现场 */ }
};
