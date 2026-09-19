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
  // 🟢 v228.52：清场「全局 reset 纪元」—— 任一端点清场写云端此键（时间戳）；
  //   所有端的轮询检测到纪元比本端已应用的新，就自动把本端同步元数据清回干净起点，
  //   使"清一次 = 两端同时收敛"，根治旧清场"只清本端、另一端继续回推分歧态（清了白清）"。
  QUARTER_RESET_EPOCH_KEY: 'wb_stocktake_reset_epoch',
  QUARTER_RESET_SEEN_KEY: 'wb_stocktake_reset_epoch_seen',
  // 🟢 v227.5：本批次（季度盘点 round）结束标记 —— 一旦置为 'closed'，概览视图隐藏。
  //   key = batchNo；value = { closedBy, closedAt }
  ROUND_CLOSED_KEY: 'wb_stocktake_round_closed',
  // 🟢 v228.33：记住「上次季度批次」区间，重进工作台时优先落回它（显示「已结束」），
  //   而不是每次都从「当天」空批次开始被误显示成「第 1 轮 · 进行中」。
  //   value = { sd, ed, ts }。sheetId 仅含 MM-DD（slice(5) 丢了年），故必须存全量 sd/ed。
  LAST_QUARTER_SHEET_KEY: 'wb_stocktake_last_quarter_sheet',
  // 🟢 v227.12：季度盘点「轮次」计数器 —— 同一批次可开多轮（首轮盘点后管理员开下一轮复核）。
  //   key = sheetId；value = 当前轮次号（默认 1）。结束本轮只关当前轮闸门，开下一轮 +1 并解闸。
  ROUND_NO_KEY: 'wb_stocktake_round_no',
  // 🟢 v228.37：季度盘点「轮次命名」—— 开下一轮时由管理员命名（如「2026年第3季度」）。
  //   结构 { [sheetId]: { round, label, namedAt } }。仅展示层别名：基线/概览/闸门/归档
  //   仍以数字轮次号关联，命名不参与任何 key 计算；round 不匹配（已开更新轮次）自动回退
  //   「第 N 轮」。云端合并写，多设备共享命名。
  ROUND_LABEL_KEY: 'wb_stocktake_round_label',
  // 🟢 v228.32：季度盘点「基线快照」—— 本轮分派序号的唯一锚点。
  //   结构 { [roundKey]: { key, sheetId, round, codes[], zeroCodes[], createdAt } }
  //   roundKey = sheetId + '#r' + roundNo（开下一轮自动换新快照）。
  //   生成规则：开局对 stock 去重聚合，剔除「任一行现存数量都不是有效非零数」的编码，
  //   剩余编码升序连续重排 1..N；一经写入不再重算 —— 库存后续怎么变都不动序号。
  BASELINE_KEY: 'wb_stocktake_quarter_baseline',
  // 🟢 v228.40（一-1/一-2）：「批次号映射」的云端共享副本。
  //   历史实现 no_map 只存本机 localStorage，完全没有云端同步 —— 这是跨端不一致的核心根因之一：
  //   移动端与 PC 端各自在本机生成批次号（jd20260916-2 vs jd20260916）与批次归属，
  //   谁也看不见对方，于是同一账户两端「批次号不同、任务行不同、进度不同」。
  //   结构 { [sheetId]: { no, type, finished, date, updatedAt } }，逐键取「updatedAt 较新者」合并。
  NO_MAP_KEY: 'wb_stocktake_no_map',
  // 🟢 v228.48：当前季度**批次身份**的跨端共享锚点。
  //
  //   语义纠正：季度盘点 = 对「现存量快照」做一次多人分片盘点，**不存在日期区间概念**。
  //   旧版（v228.45）把这个键当"区间协商器"，试图让两端协商同一个 sd/ed —— 方向就错了：
  //   只要批次身份还是日期推导值，两端就永远有"各自推导"的路径；补丁越多，覆盖竞争越多。
  //
  //   本版改为：**sheetId = 开盘时间戳**，在此键上持有唯一权威身份。
  //     · 开盘端生成一次，此后永不变；
  //     · 另一端只读不生成 → 两端必然读到同一个 sheetId（时钟不同步也无影响）；
  //     · sd/ed 降级为显示字段（最近 30 天），不参与任何一致性判定。
  //   结构 { sheetId, openedAt, sd, ed, updatedAt }
  ACTIVE_QUARTER_KEY: 'wb_stocktake_active_quarter',

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
    // 🟢 v228.74：进入盘点模块时立即检查管理员的「远程结算」指令（延迟兜底）。
    //   轮询循环已常驻处理；此处额外挂一个非阻塞延迟回调，确保「刚切回就收到指令」也能即时响应。
    //   用 setTimeout 等 _pullRoundClosed（异步、未 await）落地后再读，避免读到旧 roundClosed。
    setTimeout(() => { try { this._handleRemoteSettleAll(); } catch (e) {} }, 1200);

    // 🟢 v228.64（P0-2 修复同步黑洞）：常驻守护提前到「进入模块」即启动。
    //   旧版 _startGlobalSync() 全库唯一启动点在 startQuarter() 末尾（用户点了「🗓️ 季度盘点」之后），
    //   于是「停在本模块但没进季度选择器」时同步完全停摆：实测 App.go('stocktake') 后
    //   _globalSyncTimer=false、7 秒内 0 次网络请求。修复只需在此补一次幂等启动
    //   （_startGlobalSync 自带单例保护，重复调用安全），代价是首次进入多一次 _pollOnce。
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) this._startGlobalSync();

    // 🟢 v227.5+：注册 BroadcastChannel + storage 事件「实时同步」通道
    //   即使其它标签/窗口没有打开 picker，也能立即感知到概览更新
    this._ensureOverviewChannel();

    // 🟢 v228.47（方案 2 根因修复）：这里**不再**无条件把 query 填成【本机当天】。
    //   旧实现（v228.03~v228.46）在此处落下的当天值，会把下游 _pullBatchCommonState 的
    //   `hasExplicitRange` 判定"喂"成 true，使云端批次锚点被整段跳过（机制详见
    //   _resolveActiveQuarterRange 的注释）。改为交给统一解析器：
    //   「最近有活动且未结束」的批次优先，全无历史才落到本机当天。
    //   注意：这里只做「空缺填充」，续盘/用户选定/其它入口已写入的区间不受影响。
    this._ensureDefaultRange();

    // 🟢 v227.3：识别「从其他模块切回盘点模块」—— 不再弹"新分配任务"/"未结束盘点"，
    //   避免反复进/出模块被连续弹窗骚扰。仅在「真首次进入盘点模块」时弹。
    // 判定：app 记录的上一次 currentModule 不是 stocktake（或从未记录），视为"首次进入"。
    const lastMod = (typeof App !== 'undefined' && App._lastStocktakeModule) || null;
    const isReturningFromOtherModule = (lastMod === 'stocktake');
    App._lastStocktakeModule = 'stocktake';

    // 🟢 v228.03：切回盘点时，若现场（sheet / allRows）在离开期间被中途清空（如返回工作台、
    //   盘点收尾等路径），用离开前的快照补回 —— 保证「离开前在哪，切回还在哪」。
    //   原实现仅依赖内存残留，一旦被清空就只能回到初始界面。
    if (isReturningFromOtherModule && !this.sheet && this._viewSnapshot && this._viewSnapshot.sheet) {
      const snap = this._viewSnapshot;
      this.sheet = snap.sheet;
      this.allRows = snap.allRows || [];
      this.allRowsFull = snap.allRowsFull || [];
      if (snap.query) this.query = Object.assign({}, this.query, snap.query);
      if (snap.sheetTouched) this._sheetTouched = snap.sheetTouched;
    }

    // 🟢 v227.35：先即时渲染模块壳（任务栏 + 日常/季度/扫码按钮），不再等云同步（最多 3s）才出现界面，
    //   消除「进入盘点模块要等很久」的体感。任务栏初态不含云端分派任务，同步完成后再刷新。
    if (isReturningFromOtherModule && this.sheet && this.allRows && this.allRows.length) {
      // 返回且现场仍在内存：直接复用 _renderTable，不弹任何模态（截图 4、5 场景）
      this._sheetTouched = this._sheetTouched || { saved: true, finished: false, abandoned: false };
      content.innerHTML = this._rootHtml();
      this.renderTable();
      this._restoreScroll();  // 🟢 v228.03：回到离开前的滚动位置
      this._syncAssignedTasks(3000).then(() => this._refreshTaskBar()); // 后台补同步任务栏
      return;
    }
    content.innerHTML = this._rootHtml();
    // 🟢 v228.47：contentArea 重建后 stArea 是**新节点**，此前打的视图标记（data-st-view）随之丢失，
    //   而 _refreshQuarterPickerIfShown / _refreshQuarterPickerLight 的守卫正是读这个属性 ——
    //   标记一丢，后续 3s 轮询的轻量重渲全部静默失效（界面停止跟随云端，用户以为"不同步了"）。
    //   这里按内存中的视图状态补回标记：有盘点现场 → 'sheet'，否则按记忆恢复。
    // 🟢 v228.74（子视图记忆修复）：旧版对「无现场」一律回落 'quarter-picker'，导致用户停在
    //   【日常盘点】选择界面时切走模块再回来，被 3s 轮询按标记补渲成季度工作台（用户截图实锤）。
    //   现按 _lastStView 恢复：日常选择器 → 直接重渲日常界面；其余无现场场景维持季度兜底。
    if (this.sheet) {
      // 有未结束现场（日常/季度）：标记为 sheet，防止轮询把季度选择器盖到进行中的盘点上
      this._setStocktakeView('sheet');
    } else if (this._lastStView === 'daily-picker') {
      this._setStocktakeView('daily-picker');
      // 直接重渲日常盘点选择界面（纯本地取数，不 await —— 不阻塞任务栏同步链路）
      try { this._renderDailySetup(); } catch (e) { console.warn('[stocktake] 恢复日常盘点界面失败(已忽略):', e && e.message); }
    } else {
      this._setStocktakeView('quarter-picker');
    }

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
      // 🟢 v228.35（P2）：横幅带出进度与上次暂存时间。
      //   旧版只播报「你有 1 次未结束的盘点」，用户没有判断依据，容易误点「放弃」把工作丢掉。
      //   这里读一次草稿统计已填条数（同步、纯本地，无网络开销），把"盘了多少"说到字面上。
      let prog = '';
      try {
        const counter = String((s && s.counter) || '').trim();
        const d = this.loadDraft(counter, s.sheetId);
        const n = Object.keys((d && d.qty) || {}).length;
        const at = this._draftSavedAt(d);
        const hhmm = at && at.length >= 16 ? at.slice(11, 16) : '';
        if (n > 0) prog += ` 已暂存 <b>${n}</b> 条`;
        if (hhmm) prog += (prog ? ' · ' : ' ') + `上次暂存 ${hhmm}`;
      } catch (e) { /* 忽略：进度拿不到就只显示基本提示 */ }
      return `<div class="st-unfinished-banner" role="alert">
        <span class="st-ub-icon">⏸️</span>
        <span class="st-ub-text">你有 1 次<b>未结束</b>的${typeCn}盘点（盘点号 <b>${esc(no)}</b>）。${prog}<br>
          <span style="font-size:12px;opacity:.85;">数据仍在，点「继续盘点」即可接着盘；<b>未点【结束本次盘点】不算完成</b>，不会写入盘点记录、也不会同步云端。</span></span>
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

  /**
   * 🟢 v228.36：记录「#stArea 当前处于哪种视图」。
   *   背景：轻量重渲的守卫原先靠正则匹配页面文案，而所匹配的那句话全库从未渲染，
   *   守卫恒为 false → 轻量重渲从未生效 → 点「开下一轮」后界面不更新（线上反馈根因）。
   *   改为结构标记后，文案改动不再影响刷新链路；清除由本方法统一负责，
   *   避免每个 innerHTML 重写点各写一遍而漏掉。
   *   取值：'quarter-picker' | 'daily-picker' | 'sheet' | ''（空态/其他）
   */
  _setStocktakeView(view) {
    try {
      // 🟢 v228.74：同步记忆「最后停留的子视图」，供模块切回时恢复（修复：离开前是日常盘点
      //   选择界面，切模块回来却落到季度盘点 —— 旧版 render() 对无现场场景硬编码回季度）。
      //   取值与 data-st-view 一致：'quarter-picker' | 'daily-picker' | 'sheet' | ''
      this._lastStView = view;
      const area = document.getElementById('stArea');
      if (!area) return;
      if (view) area.setAttribute('data-st-view', view);
      else area.removeAttribute('data-st-view');
    } catch (e) { /* 忽略：标记只服务于重渲优化，失败不影响功能 */ }
  },

  async loadData(token) {
    if (token !== undefined && token !== App._goToken) return;
    const area = document.getElementById('stArea');
    if (!area) return;
    // 已有盘点数据则渲染表格（切换模块回来时保留现场），否则空态
    if (this.allRows && this.allRows.length) this.renderTable();
    else { this._setStocktakeView(''); area.innerHTML = this.renderEmptyState(); }
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

  /**
   * 🟢 v228.48：批次身份的解析器 —— **大幅简化**（旧版 60 行 → 现在 25 行）。
   *
   *   旧版（v228.47「方案 2 最近活跃批次优先」）为什么要按「日期区间」做排序和权威判定？
   *   因为那时批次身份 = 日期推导出的 sheetId，两端各推各的，只能靠"看谁的日期更活跃"
   *   来猜对方在哪一批。**这个前提已经不存在了**：批次身份现在是开盘时间戳，
   *   全球唯一、不含日期语义，他端只可能读到同一个。
   *
   *   现在的语义：**批次身份由锚点决定，不需要"解算"。**
   *     · 本机未结束会话（用户正在盘的那一批）→ 最强意图，直接用它的身份
   *     · 本机/云端批次锚点 → 权威身份
   *     · 都不存在 → 返回 null，交给 _ensureActiveQuarter() **开盘**
   *
   *   sd/ed 仅作为显示字段随身份一起带出，不再参与任何比较。
   *
   *   @returns {{sheetId:string, sd:string, ed:string, from:string}|null}
   */
  _resolveActiveQuarterRange() {
    // a. 本机未结束会话（用户正在盘的那一批）
    try {
      const sess = this._getOpenSession();
      if (sess && sess.sheetType === 'quarter' && sess.sheetId) {
        if (!this.isQuarterRoundClosed(sess.sheetId)) {
          return { sheetId: sess.sheetId, sd: sess.startDate || '', ed: sess.endDate || '', from: 'open-session' };
        }
      }
    } catch (e) { /* 忽略 */ }
    // b. 当前批次锚点（本机缓存；云端副本由 _pullBatchCommonState 先行合并到本机）
    try {
      const aq = this._getActiveQuarter();
      if (aq && aq.sheetId) {
        return { sheetId: aq.sheetId, sd: aq.sd || '', ed: aq.ed || '', from: 'active-quarter' };
      }
    } catch (e) { /* 忽略 */ }
    // c. 跨端任务里的批次身份（任务 batchKey 是分派人写入并跨端同步的，天然一致）
    try {
      const tasks = DataStore.getStocktakeTasks() || {};
      let best = null;
      Object.keys(tasks).forEach(k => {
        const t = tasks[k];
        if (!t || t.sheetType !== 'quarter' || t.deleted || !t.batchKey) return;
        if (t.status === 'closed') return;
        const ts = Date.parse(t.updatedAt || t.createdAt || '') || 0;
        if (!best || ts > best.ts) best = { ts: ts, t: t };
      });
      if (best && best.t) {
        return { sheetId: best.t.batchKey, sd: best.t.startDate || '', ed: best.t.endDate || '', from: 'task' };
      }
    } catch (e) { /* 忽略 */ }
    // d. 全无 → null（调用方负责开盘）
    return null;
  },

  /** 日期区间兜底：仅填充**显示**字段（批次身份已与日期解耦，见 _displayRange） */
  _ensureDefaultRange() {
    // 🟢 v228.48：批次身份走锚点，这里只负责把 query 的显示区间对齐到锚点/最近 30 天。
    //   旧版在这里做「最近活跃批次优先」的复杂解算，现在已无必要 —— 身份不由日期推导。
    const pick = this._resolveActiveQuarterRange();
    if (pick && pick.sd && pick.ed) {
      this.query.startDate = pick.sd;
      this.query.endDate = pick.ed;
      return;
    }
    if (this.query.startDate && this.query.endDate) return;   // 已有显示区间，不覆盖
    this._syncQuarterRangeFromActive();
  },

  /**
   * 🟢 v228.48：续盘锚定 —— **简化为"只认身份，不再管日期"**。
   *
   *   旧版（v227.8）解决的是「跨天续盘」：sheetId 由区间推导，隔一天区间平移、sheetId 就变，
   *   于是昨天没结束的现场今天进来看不到。**这个问题的前提已经消失** —— 现在 sheetId 是
   *   开盘时间戳，跨天永远不变，会话天然能被认出来。
   *   本方法现在只做一件事：若存在未结束的季度会话，把本机批次身份与显示区间对齐到它。
   */
  _anchorRangeToOpenSession() {
    try {
      const s = this._getOpenSession();
      if (!s || s.sheetType !== 'quarter') return;
      if (s.startedAt) {
        const age = Date.now() - new Date(s.startedAt).getTime();
        if (isFinite(age) && age > 90 * 86400000) return;   // 陈旧会话不锚定
      }
      const sSheetId = s.sheetId
        || (this._isTimestampSheetId(s.startDate) ? s.startDate : null);   // 兼容旧会话字段
      if (!sSheetId) return;
      if (this.isQuarterRoundClosed(sSheetId)) return;      // 已收口的不锚定
      // 身份 + 显示区间一起对齐
      const aq = this._getActiveQuarter();
      if (!aq || aq.sheetId !== sSheetId) {
        this._saveActiveQuarter({
          sheetId: sSheetId, openedAt: s.openedAt || this._openedAtFromSheetId(sSheetId),
          sd: s.startDate || '', ed: s.endDate || '', updatedAt: new Date().toISOString()
        });
      }
      if (s.startDate && s.endDate) {
        this.query.startDate = s.startDate;
        this.query.endDate = s.endDate;
      }
    } catch (e) { /* 忽略 */ }
  },

  /**
   * 🟢 v228.48：批次连续性兜底 —— 同样简化为"只认身份"。
   *   旧版是为了让「重进工作台」不要落到一个由当天推导出的空批次；现在身份由锚点持有，
   *   本方法只剩一个作用：**无未结束会话时，确保本机身份等于"上次批次"**（若它还在）。
   *   有未结束会话时交给 _anchorRangeToOpenSession，本方法不覆盖。
   */
  _anchorQuarterToLastSheet() {
    try {
      const sess = this._getOpenSession();
      if (sess && sess.sheetType === 'quarter') return;   // 未结束会话优先
      const last = this._getLastQuarterSheet();
      if (!last || !last.sheetId) return;
      const aq = this._getActiveQuarter();
      if (aq && aq.sheetId) return;                        // 本机已有身份（含云端拉回的）→ 不覆盖
      if (!this._isTimestampSheetId(last.sheetId)) {
        // 旧日期型历史批次：仅作为显示兜底，不继承为新身份
        if (last.sd && last.ed) { this.query.startDate = last.sd; this.query.endDate = last.ed; }
        return;
      }
      if (last.ts) {
        const age = Date.now() - new Date(last.ts).getTime();
        if (isFinite(age) && age > 180 * 86400000) return;
      }
      this._saveActiveQuarter({
        sheetId: last.sheetId, openedAt: last.openedAt || this._openedAtFromSheetId(last.sheetId),
        sd: last.sd || '', ed: last.ed || '', updatedAt: new Date().toISOString()
      });
      if (last.sd && last.ed) { this.query.startDate = last.sd; this.query.endDate = last.ed; }
    } catch (e) { /* 忽略 */ }
  },

  /**
   * 🟢 v228.40（一-1/一-2/一-3）：季度盘点「跨端共享状态」统一协调器。
   *
   *   问题背景（线上反馈）：
   *     · 移动端与 PC 端同一账户进度不一致（已盘数、任务行、区间各说各话）；
   *     · PC 端「结束/重开」后与移动端仍不一致（批次号也不同：jd20260916-2 vs jd20260916）；
   *     · 管理员视图两端不一致（1-103 vs 1-5）。
   *
   *   根因：轮次号、结束闸门、命名、批次号映射（no_map）、任务、基线、概览
   *   分散在 7 个 key 上，且各端「开局前只读本机 localStorage」，无人负责把云端最新态拉齐。
   *   任意一端在本地推进轮次/生成批次号后，另一端毫不知情 → 永久分叉。
   *
   *   本方法：开局前一次性把上述共享 key 从云端拉回并合并到本地，且**先拉后算**。
   *   合并规则一律「不倒退」：轮次逐键取 max、结束闸门取并集、命名取较新、批次号取较新，
   *   保证慢端追平快端，而不是把快端抹回慢端。
   *
   *   @returns {Promise<boolean>} 是否有变更落到本地
   *
   *   🟢 v228.61（去掉轮询重复读）：内部 ⑤ 那次任务拉取的变更数写入
   *   `this._lastCommonTaskChanged`，供 _pollOnce 直接复用 —— 旧版 _pollOnce 在调用
   *   本方法后又显式调了一次 pullStocktakeTasksFromCloud，导致每轮同一张任务表被下载两遍。
   *   返回值仍保持布尔语义不变（不能改成对象：调用方用 `if (result)` 判断，
   *   对象恒为真会让 _pullRoundClosed 每轮都触发，属于行为回退）。
   */
  async _pullBatchCommonState() {
    // 🟢 v228.51（P0 读解耦）：浏览器未明确离线即允许拉取，避免移动端 isOnline 误判冻结同步
    const _online = (typeof SyncManager === 'undefined') ? false
      : (SyncManager.isOnline || (typeof navigator !== 'undefined' && navigator.onLine !== false));
    if (!_online) return false;
    if (typeof SyncManager.getSettings !== 'function') return false;
    // 🟢 v228.61（P0-A 读放大根治）：本方法只需要 6 个键，旧版 await getSettings() 却读整包
    //   （settings.json + list + 14 个分键 = 15 请求）。改用 getSettingsKeys 并发单键直读：
    //   6 个键 = 6 请求（其中若干可能命中 2s 单键缓存进一步降为 0）。
    let remote = null;
    try {
      if (typeof SyncManager.getSettingsKeys === 'function') {
        remote = await SyncManager.getSettingsKeys([
          this.ROUND_NO_KEY, this.ROUND_CLOSED_KEY, this.ROUND_LABEL_KEY,
          this.NO_MAP_KEY, this.ACTIVE_QUARTER_KEY
        ]);
      } else {
        remote = await SyncManager.getSettings();   // 老版本兜底
      }
    } catch (e) { return false; }
    if (!remote || typeof remote !== 'object') return false;
    let changed = false;
    try {
      // ① 轮次号：逐键取 max（与 _setRoundNo / _pullRoundClosed 同源规则，杜绝回跳）
      const rno = remote[this.ROUND_NO_KEY];
      if (rno && typeof rno === 'object') {
        let local = {};
        try { local = JSON.parse(localStorage.getItem(this.ROUND_NO_KEY) || '{}') || {}; } catch (e) { local = {}; }
        const merged = Object.assign({}, local);
        Object.keys(rno).forEach(k => {
          const rv = parseInt(rno[k], 10), lv = parseInt(merged[k], 10);
          if (!isNaN(rv) && (isNaN(lv) || rv > lv)) { merged[k] = rv; changed = true; }
        });
        if (changed) localStorage.setItem(this.ROUND_NO_KEY, JSON.stringify(merged));
      }
      // ② 结束闸门：并集，且云端 truthy 覆盖本地缺失（已结束不可被拉回进行中）
      const rc = remote[this.ROUND_CLOSED_KEY];
      if (rc && typeof rc === 'object') {
        const local = this._getRoundClosed();
        const merged = Object.assign({}, local);
        Object.keys(rc).forEach(k => { if (rc[k] && typeof rc[k] === 'object') { merged[k] = rc[k]; changed = true; } });
        if (changed) this._saveRoundClosed(merged);
      }
      // ③ 轮次命名：较新（namedAt/round 大者）胜，保证两端显示同一名字
      const rl = remote[this.ROUND_LABEL_KEY];
      if (rl && typeof rl === 'object') {
        let local = {};
        try { local = JSON.parse(localStorage.getItem(this.ROUND_LABEL_KEY) || '{}') || {}; } catch (e) { local = {}; }
        const merged = Object.assign({}, local);
        Object.keys(rl).forEach(k => {
          const r = rl[k], l = merged[k];
          if (!r) return;
          const rRound = parseInt(r.round, 10) || 0, lRound = l ? (parseInt(l.round, 10) || 0) : -1;
          if (!l || rRound > lRound) { merged[k] = r; changed = true; }
        });
        if (changed) localStorage.setItem(this.ROUND_LABEL_KEY, JSON.stringify(merged));
      }
      // ④ 批次号映射（no_map）：本轮修复重点 —— 逐键取「updatedAt 较新者」合并，终结两端各自生成。
      const nm = remote[this.NO_MAP_KEY];
      if (nm && typeof nm === 'object') {
        let local = {};
        try { local = JSON.parse(localStorage.getItem(this.NO_MAP_KEY) || '{}') || {}; } catch (e) { local = {}; }
        const merged = Object.assign({}, local);
        Object.keys(nm).forEach(k => {
          const r = nm[k], l = merged[k];
          if (!r || !r.no) return;
          const rTs = Date.parse(r.updatedAt || '') || 0;
          const lTs = l ? (Date.parse(l.updatedAt || '') || 0) : -1;
          if (!l || rTs > lTs) { merged[k] = r; changed = true; }
        });
        if (changed) localStorage.setItem(this.NO_MAP_KEY, JSON.stringify(merged));
      }
      // ⑤ 任务：走既有合并（本地较新者胜 + 墓碑），不重复实现
      //   🟢 v228.61：变更数记到实例字段，供 _pollOnce 复用（避免它再拉一次同一张表）
      this._lastCommonTaskChanged = 0;
      try { this._lastCommonTaskChanged = await DataStore.pullStocktakeTasksFromCloud(); } catch (e) { /* 忽略 */ }
      // ⑥ 基线：本机已有则本机优先（绝不覆盖），缺失时补齐
      try { await this._pullQuarterBaseline(); } catch (e) { /* 忽略 */ }
      // ⑦ 概览：数值 + 状态合并（含 roundClosed 同步）
      //   🟢 v228.64（去掉第二轮重复读）：变更结果记到实例字段，供 _pollOnce 复用。
      //   v228.61 的注释声称「已去掉重复读」，但只处理了 tasks（⑤），概览这一路漏了 ——
      //   _pollOnce 里仍旧 `await this._pullQuarterOverviews()`，导致每轮概览被完整下载两次
      //   （实测同一轮 _pullQuarterOverviews 成对出现，t 间隔 0~1ms）。现在与 ⑤ 同款收口。
      this._lastCommonOverviewChanged = false;
      try { this._lastCommonOverviewChanged = await this._pullQuarterOverviews(); } catch (e) { /* 忽略 */ }
      // ⑧ 🟢 v228.48：当前季度**批次身份**（sheetId / openedAt / 显示用 sd,ed）。
      //   跨端一致的关键，但实现已从「43 行日期协商」压缩为「3 行直接采用」——
      //   因为批次身份不再是本机日期推导值，云端锚点就是唯一权威，不存在"该不该跟"的判定。
      //
      //   为何旧版必须写那么复杂：那时 sheetId 由本机日期算出，两端可能各算各的，
      //   于是要比较"谁更活跃"、判断"用户是否显式选定过"、防止"本机当天覆盖云端真实批次"…
      //   现在这些判定**全部失效**：身份不含日期语义，他端只可能读到同一个 sheetId。
      //
      //   规则（三条）：
      //     ① 本机会话绑定的批次 ≠ 云端当前批次（被新一轮取代）→ 清掉本机会话、跟随云端
      //     ② 云端有身份且本机无未结束现场 → 直接采用（身份 + 显示区间一起跟）
      //     ③ 本机已有相同身份 → 只补齐可能缺失的显示区间
      //
      //   🟢🔴 v228.48-fix1：**真机实测暴露的严重缺陷**修复。
      //     缺陷现象（用户实测）：PC 端「开下一轮」并分派任务后，手机端**批次和视图都不变**；
      //       PC 端「结束季度盘点」后，手机端**收不到结束指令**；两端彻底各跑各的。
      //     根因：`endQuarterRound` 收尾时只在**本机**清 open session（localStorage 是设备本地的），
      //       手机端的 `wb_stocktake_open_session` 没人清 → 手机端 `hasLiveSession` 恒为 true
      //       → 云端锚点怎么变它都拒绝跟随 → 永久分叉。
      //     为何自动化测试没抓到：测试用的都是干净环境，两端都没有残留会话，
      //       而本缺陷恰恰**只在"手机端进过盘点、留下了残留会话"时触发**。
      //     修复语义：本系统一个时刻只有**一批**活跃季度盘点（active quarter 是单例），
      //       云端 ACTIVE_QUARTER_KEY 里那个 sheetId 就是"活着"的批次。本机会话只要绑定在**别的**
      //       批次上，就一定是陈旧的（被新一轮取代），直接清会话放行跟随，无需判断旧批次是否已结束。
      //       若本机会话绑定 == 云端当前批次，则本端就是"在场"的那一个，保留（同端续盘不丢现场）。
      const aq = remote[this.ACTIVE_QUARTER_KEY];
      // 🟢 v228.65：清场保护窗口 —— 挡住「已在飞行中」的陈旧读快照。
      //   清场（resetQuarterSyncState）会记下刚清掉的 sheetId；本轮的 remote 可能是清场前
      //   发出的请求带回来的旧值，若照旧跟随，就把刚清掉的批次又写回本机，清场等于白清。
      //   窗口取 15s（轮询周期 1.5s 的 10 倍，足够覆盖在途请求，又不会长期挡住正常跟随）。
      if (aq && typeof aq === 'object' && aq.sheetId && this._isJustResetQuarter(aq.sheetId)) {
        console.log('[stocktake] 忽略清场后回源的陈旧批次快照(' + aq.sheetId + ')，保持未开始状态');
        try {
          if (typeof SyncManager !== 'undefined' && SyncManager.isOnline
              && typeof SyncManager.setSetting === 'function') {
            SyncManager.setSetting(this.ACTIVE_QUARTER_KEY, null);   // 顺手纠正云端可能残留的旧值
          }
        } catch (e) { /* 忽略 */ }
        changed = true;
        return changed;
      }
      if (aq && typeof aq === 'object' && aq.sheetId) {
        let sess = this._getOpenSession();
        // ① 会话绑定的批次 ≠ 云端当前批次 → 陈旧，清掉让位
        let staleSession = sess && sess.sheetType === 'quarter' && sess.sheetId
                            && sess.sheetId !== aq.sheetId;
        // ①' 🟢 v228.48-fix2：会话绑定的批次**就是**云端当前批次，但该批次**云端已结束** → 同样陈旧。
        //    这是真机第二个症状（「PC 点了结束季度盘点，手机仍收不到结束指令」）的直接根因：
        //    管理员「结束本批次」后，若**尚未开盘下一轮**，云端 ACTIVE_QUARTER_KEY 里的 sheetId
        //    **没有改变**（锚点只在开盘时才改写）——于是手机端的残留会话与云端锚点"恰好相同"，
        //    规则①判不出陈旧；而结束标记 ROUND_CLOSED_KEY 属于"状态"而非"身份"，
        //    本方法早先只知道跟着身份走，于是手机端永远停在「进行中」，两端各跑各的。
        //    修复：把「云端该批次已收口」也作为陈旧判据 —— 批次都结束了，本机还攥着它的现场
        //    就没有意义（数据已由管理端强制落库），清会话放行。
        if (!staleSession && sess && sess.sheetType === 'quarter' && sess.sheetId) {
          const rc = remote[this.ROUND_CLOSED_KEY];
          const closedInfo = rc && typeof rc === 'object' ? rc[sess.sheetId] : null;
          if (closedInfo && typeof closedInfo === 'object') {
            staleSession = true;
            console.log('[stocktake] 本机会话所属批次(' + sess.sheetId
                        + ')云端已结束，清会话让位给结束态');
          }
        }
        if (staleSession) {
          const staleSid = sess.sheetId;
          this._clearOpenSession();
          sess = null;
          changed = true;
          console.log('[stocktake] 本机会话所属批次(' + staleSid
                      + ')已被云端新批次(' + aq.sheetId + ')取代，已清会话并跟随');
        }
        const hasLiveSession = sess && sess.sheetType === 'quarter';
        const localAq = this._getActiveQuarter();
        if (!hasLiveSession && (!localAq || localAq.sheetId !== aq.sheetId)) {
          this._saveActiveQuarter(aq);
          if (aq.sd && aq.ed) { this.query.startDate = aq.sd; this.query.endDate = aq.ed; }
          this._pendingBatchFollow = true;    // 通知界面重渲，跟随新批次
          changed = true;
        }
      }
    } catch (e) { console.warn('[stocktake] 拉取跨端共享状态异常(已忽略):', e && e.message); }
    return changed;
  },

  // ============================================================
  // 🟢 v228.48：季度批次身份 —— 「开盘时间戳」
  //
  //   产品语义纠正（用户第三次指出，本次是根本性的）：
  //     季度盘点 = **对当前【工作台 → 现存量】里的存货现存量快照，做一次多人分片盘点**。
  //     它跟「盘哪几天」毫无关系，日期区间从来不是业务参数。
  //
  //   旧设计（v228.45~v228.47）的致命缺陷：
  //     批次钥匙 sheetId 由**本机日期**推导 —— 'quarter_' + sd.slice(5) + '_' + ed.slice(5)。
  //     两台设备各自推导，天然可能不同 → 为了让两端"协商同一个区间"，又加了云端锚点
  //     ACTIVE_QUARTER + _hasDeliberateRange + _setActiveQuarter 的覆盖保护，
  //     三段逻辑互相打架，最终两端轮流把"本机当天"写成云端权威 → 分叉固化、静默各看各的。
  //
  //   本版设计：**批次身份不再由日期推导**。
  //     sheetId = 'quarter_' + <开盘时间戳 YYYYMMDDTHHmmss>，开盘时生成一次，此后永不变。
  //     它完全不携带日期语义，因此：
  //       · 两端不可能"各自推导出不同批次"——另一个只能读云端这一个；
  //       · 真机两端时钟不同步也无影响——时间戳只在开盘端生成一次；
  //       · sd/ed 降级为**纯显示字段**（近 30 天），不再参与任何一致性判定。
  //     这不是"修好了分叉"，是**分叉的路径本身不存在了**。
  // ============================================================

  // 批次身份生成：开盘时间戳 → quarter_20260917T143022
  //   openedAt 省略时取当前时刻（即"现在开盘"）
  _quarterSheetId(openedAt) {
    const d = openedAt ? new Date(openedAt) : new Date();
    if (isNaN(d.getTime())) return this._quarterSheetId();
    const p = n => String(n).padStart(2, '0');
    return 'quarter_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
         + 'T' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  },

  // 是否为「时间戳型」批次 ID（v228.48 起的新格式；区别于更早的日期型 quarter_MM-DD_MM-DD）
  _isTimestampSheetId(sheetId) {
    return /^quarter_\d{8}T\d{6}$/.test(String(sheetId || ''));
  },

  // 时间戳型 sheetId → 开盘时刻（ISO 本地字符串）；非时间戳型返回 ''
  _openedAtFromSheetId(sheetId) {
    const s = String(sheetId || '');
    const m = /^quarter_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
    if (!m) return '';
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6];
  },

  // 🟢 v228.48：当前季度批次的信息：{ sheetId, openedAt, sd, ed, updatedAt }
  //   云端副本见 ACTIVE_QUARTER_KEY（结构自本版起以 sheetId 为权威身份）
  _getActiveQuarter() {
    try { return JSON.parse(localStorage.getItem(this.ACTIVE_QUARTER_KEY) || 'null') || null; } catch (e) { return null; }
  },
  _saveActiveQuarter(aq) {
    try { localStorage.setItem(this.ACTIVE_QUARTER_KEY, JSON.stringify(aq || {})); } catch (e) {}
    // storage 事件靠同键名广播，供同浏览器跨标签兜底刷新
  },

  // 当前批次 ID 的唯一权威读取入口。
  // 所有需要「本批次是哪一批」的地方都必须走这里，禁止再自行拼接 sheetId。
  _currentQuarterSheetId() {
    const aq = this._getActiveQuarter();
    return (aq && aq.sheetId) ? String(aq.sheetId) : null;
  },

  // 确保本机已确立批次身份：本机锚点缺失时**开盘**（生成新时间戳并推云端）。
  //   ⚠️ 只在「本机无锚点」时开盘；已有锚点（含从云端拉回的）一律复用，
  //      保证同一批次在两端是同一个 sheetId，绝不会各开各的。
  /**
   * 🟢🔴 v228.49-fix3：**「擅自开盘」根治** —— 真机第二次反馈的根因。
   *
   *   现象（用户真机原话）：
   *     「pc端结束季度盘点，手机端仍然没有结束」
   *     「手机端盘点了然后点结束盘点，管理员视图看不到分配的人和进度」
   *
   *   根因：本方法旧版只要"本机没有锚点"就**无条件开盘** —— 生成一个新时间戳批次，
   *   并 `_setCloud(ACTIVE_QUARTER_KEY, entry)` **推上云端覆盖**。
   *   于是任何一端只要"读不到云端"（离线 / settings 通道拉取失败 / 时序落后），
   *   就会自作主张开一批，并把云端锚点抢成自己的 —— 两端各自开盘、各自记账。
   *
   *   连锁后果（一个根因解释全部现象）：
   *     · 手机盘的记录落在**另一个 sheetId** 下；
   *     · 概览 key 是 `counter::sheetId`，管理员端按自己的 sheetId 去取 → **人和进度都看不到**；
   *     · PC 结束的是**它自己**那个批次 → 手机在自己批次里，永远收不到结束指令。
   *
   *   ⚠️ 为什么之前几版没修掉：前面一直在修"拉"（跟随/重渲），而病根在"开"——
   *     只要任何一端还能凭空开盘，拉得再勤也只是在两个平行世界之间同步。
   *
   *   新语义 —— **开盘是有权限的显式动作，不是"没读到就自己开"的兜底**：
   *     ① 本机已有锚点 → 沿用（补齐显示区间），不开盘；
   *     ② 读得到云端且云端有锚点 → **跟随**，绝不开盘；
   *     ③ 读得到云端且云端**确实没有**批次 → 本端是首个开盘者，**可以开盘**；
   *     ④ 读不到云端（离线 / 拉取失败）→ **不开盘**，返回 null 并给出原因。
   *        宁可让用户看到"暂时无法确定批次"，也绝不制造一个必然分叉的平行批次。
   *
   *   @param {object} opts
   *     · force          强制开盘（管理员显式点「开下一轮」）
   *     · allowOfflineOpen 明确允许离线下开盘（仅本端自用，且**不推云端**）
   *   @returns {object|null} 锚点；无法安全开盘时返回 null
   */
  async _ensureActiveQuarter(opts) {
    opts = opts || {};
    const cur = this._getActiveQuarter();
    if (cur && cur.sheetId && !opts.force) {
      // ① 已有锚点：只补齐可能缺失的显示区间，不动身份
      if (!cur.sd || !cur.ed) {
        const r = this._displayRange();
        this._saveActiveQuarter(Object.assign({}, cur, { sd: r.sd, ed: r.ed }));
      }
      return this._getActiveQuarter();
    }

    // ② / ③ / ④：本机无锚点（或强制重开）→ 先看云端到底有没有批次
    const cloud = await this._peekCloudActiveQuarter();

    if (cloud.state === 'has') {
      // ② 云端已有批次 → 跟随，绝不开盘（这是防止分叉最关键的一道闸）
      const aq = cloud.entry;
      this._saveActiveQuarter(aq);
      if (aq.sd && aq.ed) { this.query.startDate = aq.sd; this.query.endDate = aq.ed; }
      this._pendingBatchFollow = true;
      console.log('[stocktake] 云端已有批次 ' + aq.sheetId + '，本端跟随（不开新盘）');
      return this._getActiveQuarter();
    }

    if (cloud.state === 'unknown') {
      // ④ 无法确认云端 → 不开盘。离线且调用方明确许可时例外（且不推云端）
      if (!(cloud.offline && opts.allowOfflineOpen)) {
        this._lastOpenBlockedReason = cloud.reason;
        console.warn('[stocktake] 无法确定云端批次（' + cloud.reason + '），已阻止本端擅自开盘');
        return null;
      }
    }

    // ③ 云端确实没有批次（或离线自用许可）→ 本端开盘
    const openedAt = new Date().toISOString();
    const sheetId = this._quarterSheetId(openedAt);
    const r = this._displayRange();
    const entry = { sheetId: sheetId, openedAt: openedAt, sd: r.sd, ed: r.ed, updatedAt: openedAt };
    this._saveActiveQuarter(entry);
    this._syncQuarterRangeFromActive();

    // 推云端前的**让位保护**：再确认一次云端没被别端抢先开盘。
    //   旧版无条件覆盖 —— 两端同时开局时后写者把先写者的批次抹掉，正是分叉的制造点。
    const offline = !(typeof SyncManager !== 'undefined' && SyncManager.isOnline);
    if (!offline) {
      const recheck = await this._peekCloudActiveQuarter();
      if (recheck.state === 'has' && recheck.entry.sheetId !== sheetId) {
        // 别端已先开盘 → 本端让位跟随（本机刚写的锚点作废）
        this._saveActiveQuarter(recheck.entry);
        if (recheck.entry.sd && recheck.entry.ed) {
          this.query.startDate = recheck.entry.sd; this.query.endDate = recheck.entry.ed;
        }
        this._pendingBatchFollow = true;
        console.log('[stocktake] 别端已先开盘 ' + recheck.entry.sheetId + '，本端让位跟随');
        return this._getActiveQuarter();
      }
      try { await this._setCloud(this.ACTIVE_QUARTER_KEY, entry); }
      catch (e) { try { this._enqueueCloud(this.ACTIVE_QUARTER_KEY, entry); } catch (e2) {} }
    } else {
      // 离线：只写本机，**绝不推云端** —— 否则联网后会把本端批次盖到别人头上
      console.log('[stocktake] 离线开盘 ' + sheetId + '（仅本机，联网后以云端为准）');
    }
    return entry;
  },

  /**
   * 🟢 v228.49-fix3：探测云端「当前批次锚点」，并**区分「确实没有」与「读不到」**。
   *   旧代码把这两种情况混为一谈（都当作"没有"），于是"读不到"就变成了"我来开一个"。
   *
   *   @returns {{state:'has'|'empty'|'unknown', entry?:object, offline:boolean, reason:string}}
   */
  async _peekCloudActiveQuarter() {
    const offline = !(typeof SyncManager !== 'undefined' && SyncManager.isOnline);
    if (offline) {
      return { state: 'unknown', entry: null, offline: true, reason: '离线' };
    }
    if (typeof SyncManager === 'undefined' || typeof SyncManager.getSetting !== 'function') {
      return { state: 'unknown', entry: null, offline: false, reason: '云端通道不可用' };
    }
    // 🟢 v228.61（P0-A）：只读 ACTIVE_QUARTER_KEY 一个键（单键直读，1 请求）。
    //   旧版读整包 getSettings()（15 请求），而「判断云端有没有批次」本就不需要别的键。
    //   语义仍要区分「确实没有」（→ empty）与「读不到」（→ unknown，绝不当作 empty 盲开批次）：
    //   这里用 _readSettingFile 的返回 + 缓存是否存在来判断，不依赖任何共享可变标志
    //   （v228.61-fix2：旧版靠 SyncManager._keyReadTouched，该标志会被并发读互相覆盖）。
    const TO = Symbol.for('__st_peek_timeout__');
    let aq;
    try {
      aq = await Promise.race([
        SyncManager.getSetting(this.ACTIVE_QUARTER_KEY),
        new Promise(res => setTimeout(() => res(TO), 6000))
      ]);
    } catch (e) {
      return { state: 'unknown', entry: null, offline: false, reason: '读取云端超时/异常' };
    }
    if (aq === TO) {
      return { state: 'unknown', entry: null, offline: false, reason: '读取云端超时' };
    }
    // 读不到 → 再用整包兜底一次；仍拿不到才判 unknown（宁可晚补，不可错盖）
    if (aq === undefined) {
      let fallbackOk = false;
      try {
        const all = await Promise.race([
          SyncManager.getSettings(),
          new Promise(res => setTimeout(() => res(null), 6000))
        ]);
        if (all && typeof all === 'object') { fallbackOk = true; aq = all[this.ACTIVE_QUARTER_KEY]; }
      } catch (e) { /* 忽略 */ }
      if (!fallbackOk) {
        return { state: 'unknown', entry: null, offline: false, reason: '云端返回空' };
      }
    }
    if (aq && typeof aq === 'object' && aq.sheetId) {
      return { state: 'has', entry: aq, offline: false, reason: '' };
    }
    return { state: 'empty', entry: null, offline: false, reason: '' };
  },

  // 🟢 v228.48：显示用区间 —— 「最近 30 天」，**仅用于记录列表/批次卡片展示**，
  //   不参与任何批次一致性判定（批次身份已与日期解耦）。
  _displayRange() {
    const pad = n => String(n).padStart(2, '0');
    const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 86400000);
    return { sd: ymd(start), ed: ymd(end) };
  },

  // 把 query 的显示区间对齐到当前批次锚点（无锚点则用最近 30 天）
  _syncQuarterRangeFromActive() {
    const aq = this._getActiveQuarter();
    if (aq && aq.sd && aq.ed) {
      this.query.startDate = aq.sd;
      this.query.endDate = aq.ed;
      return;
    }
    const r = this._displayRange();
    this.query.startDate = r.sd;
    this.query.endDate = r.ed;
  },

  // 🟢 v228.48：确立/切换当前季度批次并回推云端。
  //   与旧版（v228.45~47）的根本区别：**不再传日期，不再做任何"覆盖保护"判定**。
  //   批次身份由 openedAt 决定，写入即权威；他端只读不写，因此不存在覆盖竞争。
  //
  //   @param {string} [openedAt] 开盘时刻（ISO）；省略 = 现在开盘
  async _setActiveQuarter(openedAt) {
    const ts = openedAt || new Date().toISOString();
    const sheetId = this._quarterSheetId(ts);
    const r = this._displayRange();
    const entry = { sheetId: sheetId, openedAt: ts, sd: r.sd, ed: r.ed, updatedAt: new Date().toISOString() };
    this._saveActiveQuarter(entry);
    this._syncQuarterRangeFromActive();
    try {
      await this._setCloud(this.ACTIVE_QUARTER_KEY, entry);
    } catch (e) {
      try { this._enqueueCloud(this.ACTIVE_QUARTER_KEY, entry); } catch (e2) {}
    }
    return entry;
  },

  // ============================================================
  // 🟢 v228.47：跨端「同步元数据」重置工具
  //
  //   背景（用户线上反馈）：
  //     两端长期各自开局，云端锚点被反复覆盖，历史残留互相纠缠。
  //     此时再多的"跟随逻辑"也难收敛 —— 需要先把两端拉回同一个干净起点。
  //
  //   ⚠️ 安全边界（这是本工具最重要的部分）：
  //     **只清同步元数据，绝不碰业务数据。** 具体：
  //
  //   ┌─ 会清（同步元数据：决定"看哪一批、第几轮、什么名字"）─────────────┐
  //   │ ACTIVE_QUARTER_KEY     批次锚点（两端串味的核心）                   │
  //   │ ROUND_CLOSED_KEY       轮次结束闸门                                │
  //   │ ROUND_NO_KEY           轮次号                                      │
  //   │ ROUND_LABEL_KEY        轮次命名                                    │
  //   │ NO_MAP_KEY             批次号映射                                  │
  //   │ OVERVIEW_KEY           本批次进度概览（跨端串味的另一来源）        │
  //   │ LAST_QUARTER_SHEET_KEY 本机"上次批次"缓存                          │
  //   │ OPEN_KEY               本机未结束会话（否则会卡在续盘现场）        │
  //   │ DRAFT_KEY              本机草稿（防止旧草稿带进新批次）            │
  //   └────────────────────────────────────────────────────────────────────┘
  //   注：自 v228.52 起，清场额外写云端 `wb_stocktake_reset_epoch`（时间戳纪元）。
  //        所有端在 _pollOnce 中比对「云端纪元 > 本端已应用纪元」即自动清本端共享元数据，
  //        使「清一次 = 两端同时收敛」，根治旧清场「只清本端、另一端继续回推分歧态（清了白清）」。
  //        正在盘点（未结束 quarter 会话）的远程端保留 OPEN 会话，不打散在盘数据。
  //
  //   ┌─ 绝不清（业务数据）────────────────────────────────────────────────┐
  //   │ stocktakeTasks         分派任务（云端 settings 通道）              │
  //   │ stocktake_records      盘点记录（IndexedDB，本就不同步）           │
  //   │ BASELINE_KEY           基线快照（序号锚点，清了会导致序号重排）    │
  //   │ TOMB_KEY / PENDING_KEY 墓碑与补推队列（清了会"删了又回来"）        │
  //   │ TASK_SEEN_KEY          已提示过的任务（清了会重复弹窗骚扰）        │
  //   └────────────────────────────────────────────────────────────────────┘
  //
  //   用法：在任一端控制台执行 `await StocktakeModule.resetQuarterSyncState()`，
  //        或界面点「🧹 清场重置」。自 v228.52 起，清场会写云端 reset 纪元，
  //        所有端轮询到纪元更新会自动清本端 → **只需在一端点一次，两端即收敛**；
  //        正在盘点（未结束 quarter 会话）的远程端会保留其 OPEN 会话，不打散在盘数据。
  // ============================================================
  QUARTER_SYNC_KEYS_CLEARABLE: [
    'ACTIVE_QUARTER_KEY', 'ROUND_CLOSED_KEY', 'ROUND_NO_KEY', 'ROUND_LABEL_KEY',
    'NO_MAP_KEY', 'OVERVIEW_KEY', 'LAST_QUARTER_SHEET_KEY', 'OPEN_KEY', 'DRAFT_KEY'
  ],
  QUARTER_SYNC_KEYS_KEEP: [
    'BASELINE_KEY', 'TOMB_KEY', 'PENDING_KEY', 'TASK_SEEN_KEY'
  ],

  /** 读取某键的本机原值（用于备份与审计） */
  _readSyncKey(keyName) {
    const k = this[keyName];
    if (!k) return null;
    try { return localStorage.getItem(k); } catch (e) { return null; }
  },

  /**
   * 🟢 v228.47：重置跨端同步元数据。
   * @param {object} [opt]
   * @param {boolean} [opt.silent]  不弹确认框（供脚本/自动化调用）
   * @param {boolean} [opt.dryRun]  只报告将清什么，不实际清（默认 false）
   * @returns {Promise<object>} 审计报告 { cleared:[], kept:[], backupKey, errors:[] }
   */
  async resetQuarterSyncState(opt) {
    opt = opt || {};
    const KEEP_PREFIX = 'wb_stocktake_sync_reset_backup_';
    const report = { at: new Date().toISOString(), dryRun: !!opt.dryRun,
                     cleared: [], kept: [], errors: [], backupKey: null };

    // ① 安全前置：正在盘点中不重置（会把用户现场打散）
    try {
      const sess = this._getOpenSession();
      if (sess && sess.sheetType === 'quarter' && !opt.silent) {
        const go = await WBModal.confirm(
          '本机存在【未结束的季度盘点会话】：\n\n' +
          '· ' + (sess.batchNo || sess.sheetId || '') + '（' + (sess.startDate || '') + ' ~ ' + (sess.endDate || '') + '）\n\n' +
          '重置会清除这个未结束现场（已落库的盘点记录与任务不受影响）。\n' +
          '确认继续？',
          { title: '⚠️ 重置前确认', okText: '继续重置', cancelText: '取消' });
        if (!go) { report.aborted = true; return report; }
      }
    } catch (e) { /* 忽略：会话读取失败不阻断 */ }

    // ② 备份（可回滚）—— 备份内容只含"要清的键"，供事故回退
    const backup = {};
    this.QUARTER_SYNC_KEYS_CLEARABLE.forEach(n => {
      const raw = this._readSyncKey(n);
      if (raw !== null) backup[this[n]] = raw;
    });
    const backupKey = KEEP_PREFIX + Date.now();
    try { localStorage.setItem(backupKey, JSON.stringify(backup)); report.backupKey = backupKey; }
    catch (e) { report.errors.push('备份失败（可能超出配额）：' + (e && e.message)); }

    if (opt.dryRun) {
      report.cleared = Object.keys(backup);
      report.kept = this.QUARTER_SYNC_KEYS_KEEP.map(n => this[n]).filter(Boolean);
      return report;
    }

    // ②-b 🟢 v228.65：清场保护窗口 —— **必须在清本机之前**就立起来。
    //   时序坑（实测踩到）：本方法 ③ 清本机是同步的，但 ④ 清云端是 await 循环，
    //   一让出控制权，轮询就可能插进来把「清场前发出、此刻才返回」的陈旧云端快照写回本机。
    //   若把守卫放在 ④ 之后，这段窗口就完全没保护 —— 表现是清场点了却没效果。
    //   故：先记下「即将被清掉的批次」并作废读缓存，再动手清。
    try {
      const willClearSid = (JSON.parse(String(backup[this.ACTIVE_QUARTER_KEY] || 'null')) || {}).sheetId;
      this._resetGuard = { at: Date.now(), sheetIds: willClearSid ? [String(willClearSid)] : [] };
    } catch (e) { this._resetGuard = { at: Date.now(), sheetIds: [] }; }
    try {
      if (typeof SyncManager !== 'undefined') {
        this.QUARTER_SYNC_KEYS_CLEARABLE.forEach(n => {
          const k = this[n];
          if (!k) return;
          if (SyncManager._settingsKeyCache) SyncManager._settingsKeyCache[k] = null;
          if (SyncManager._keyTsCache) SyncManager._keyTsCache[k] = 0;
          if (SyncManager._keyEpochCache) SyncManager._keyEpochCache[k] = -1;
        });
      }
    } catch (e) { /* 忽略：缓存作废失败不影响主流程，还有保护窗口兜底 */ }

    // ③ 清本机
    this.QUARTER_SYNC_KEYS_CLEARABLE.forEach(n => {
      const k = this[n];
      if (!k) return;
      try {
        if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); report.cleared.push(k); }
      } catch (e) { report.errors.push('清本机 ' + k + ' 失败：' + (e && e.message)); }
    });

    // ④ 清云端（同步元数据在 settings.json 通道）—— 逐键显式置空，
    //    而不是整包覆盖 settings，避免抹掉其它模块的设置（cloudConfig / 查询历史等）。
    for (const n of this.QUARTER_SYNC_KEYS_CLEARABLE) {
      const k = this[n];
      if (!k) continue;
      try {
        if (typeof SyncManager !== 'undefined' && SyncManager.isOnline
            && typeof SyncManager.setSetting === 'function') {
          await SyncManager.setSetting(k, null);
        }
        // 离线时也入队，联网后补推置空，保证最终一致
        try { this._enqueueCloud(k, null); } catch (e) {}
      } catch (e) { report.errors.push('清云端 ' + k + ' 失败：' + (e && e.message)); }
    }

    // ⑦ 🟢 v228.52：写全局 reset 纪元 —— 让清场跨端生效。
    //    这一步是「清场没大用」的根治：旧清场只清本端+云端同名键，另一端不清，
    //    且另一端任何动作都会把分歧态回推云端（_computeQuarterOverview/_closeQuarterTasks
    //    走 _setCloud(OVERVIEW_KEY,...)），被清端下一轮轮询又把旧态拉回 → 清了白清。
    //    这里写云端纪元，所有端轮询比对到「纪元更新」即自动把本端元数据清回干净起点。
    try {
      if (typeof SyncManager !== 'undefined' && typeof SyncManager.setSetting === 'function') {
        const epoch = Date.now();
        if (SyncManager.isOnline) {
          await SyncManager.setSetting(this.QUARTER_RESET_EPOCH_KEY, epoch);
        } else {
          // 离线：入队，联网后 _flushCloudQueue 补广播纪元，保证最终两端都收敛
          try { this._enqueueCloud(this.QUARTER_RESET_EPOCH_KEY, epoch); } catch (e) {}
        }
        try { localStorage.setItem(this.QUARTER_RESET_SEEN_KEY, String(epoch)); } catch (e) {}
        report.resetEpoch = epoch;
      }
    } catch (e) { report.errors.push('写 reset 纪元失败：' + (e && e.message)); }

    // ⑤ 重置内存态（否则界面仍按旧 query 渲染，看起来"没生效"）
    try {
      this.query = { startDate: '', endDate: '' };
      this.sheet = null;
      this.allRows = [];
      this.allRowsFull = [];
      this._sheetTouched = null;
      this._viewSnapshot = null;
      this._pendingBatchFollow = false;
      this.batchNo = '';
      this._pickerCtx = null;
      if (typeof this._stopOverviewPolling === 'function') this._stopOverviewPolling();
    } catch (e) { report.errors.push('重置内存态失败：' + (e && e.message)); }

    // ⑥ 🟢 v228.48：清掉本机 LAST_QUARTER_SHEET 里可能残留的**旧日期型** sheetId。
    //    批次身份已改为开盘时间戳，日期型 ID 不再有意义；留着会让 _anchorQuarterToLastSheet
    //    把一个不存在的批次当成"上次批次"。时间戳型 ID 同样清掉 —— 重置的语义就是"回到干净起点"。
    try {
      const last = this._getLastQuarterSheet();
      if (last && last.sheetId && !this._isTimestampSheetId(last.sheetId)) {
        report.errors.push('已清除旧日期型批次缓存：' + last.sheetId);
      }
    } catch (e) { /* 忽略 */ }

    report.kept = this.QUARTER_SYNC_KEYS_KEEP.map(n => this[n]).filter(Boolean);
    return report;
  },

  /**
   * 🟢 v228.65：某批次是否「本机刚清掉的那一批」（清场保护窗口内）。
   *
   *   为什么需要它：清场作废了 SyncManager 的读缓存，但**已经在飞行中**的读请求
   *   仍会带回清场前的快照。_pullBatchCommonState 若照常跟随，就把刚清掉的批次写回本机。
   *   实测调用栈：_saveActiveQuarter ← _pullBatchCommonState ← _pollOnce（清场后 0.5s 内发生）。
   *
   *   窗口 15s = 轮询周期(1.5s) × 10，既覆盖在途请求，又不会长期挡住正常的跨端跟随。
   */
  _isJustResetQuarter(sheetId) {
    try {
      const g = this._resetGuard;
      if (!g || !g.at || !sheetId) return false;
      if (Date.now() - g.at > 15000) return false;
      return (g.sheetIds || []).indexOf(String(sheetId)) >= 0;
    } catch (e) { return false; }
  },

  /**
   * 🟢 v228.52：全局 reset 纪元收敛 —— 让「清场」真正跨端生效。
   *
   *   根因（用户真机反馈「清场好像没有很大作用」）：旧清场只清【本端 + 云端同名键】，
   *   但【另一端不清】；另一端只要做任何动作（进入任务 / 结束 / 补派）就会把它的分歧态
   *   回推云端（_computeQuarterOverview / _closeQuarterTasks 走 `_setCloud(OVERVIEW_KEY,...)`），
   *   被清的那端下一轮轮询又把旧态拉回来 → 「清了白清」。
   *
   *   解法：清场额外写云端 `wb_stocktake_reset_epoch`（纪元时间戳）。本方法在每次轮询时比对
   *   本端已应用的纪元，若云端更新 → 自动把本端共享同步元数据清回干净起点，使两端收敛到同一态。
   *
   *   ⚠️ 安全：若本端正处未结束的季度盘点现场（盘点人中途），只清「共享锚点」
   *   （批次 / 轮次 / 概览 / 命名 …），保留 OPEN 会话，避免把别人正在盘的数据打散——
   *   清场的二次确认只发生在操作端，远程端无确认框，故此处必须保守。
   */
  async _applyGlobalResetIfAny() {
    try {
      if (typeof SyncManager === 'undefined' || typeof SyncManager.getSetting !== 'function') return;
      // 🟢 v228.61（P0-A）：只读 QUARTER_RESET_EPOCH_KEY 一个键，不再读整包。
      const epoch = await SyncManager.getSetting(this.QUARTER_RESET_EPOCH_KEY);
      if (epoch == null) return;
      let seen = 0;
      try { seen = parseInt(localStorage.getItem(this.QUARTER_RESET_SEEN_KEY) || '0', 10) || 0; } catch (e) {}
      if (epoch <= seen) return;   // 已应用过，不重复清
      // 检测到更新纪元 → 清本端共享元数据（不含业务数据、不含正在盘的 OPEN 会话）
      const sess = this._getOpenSession();
      const counting = !!(sess && sess.sheetType === 'quarter');
      this.QUARTER_SYNC_KEYS_CLEARABLE.forEach(n => {
        if (counting && n === 'OPEN_KEY') return;   // 保护正在盘的现场
        const k = this[n];
        if (k) { try { localStorage.removeItem(k); } catch (e) {} }
      });
      // 重置内存态（与 resetQuarterSyncState ⑤ 对齐）
      this.query = { startDate: '', endDate: '' };
      this.sheet = null; this.allRows = []; this.allRowsFull = [];
      this._sheetTouched = null; this._viewSnapshot = null; this._pendingBatchFollow = false;
      this.batchNo = ''; this._pickerCtx = null;
      try { localStorage.setItem(this.QUARTER_RESET_SEEN_KEY, String(epoch)); } catch (e) {}
    } catch (e) { /* 忽略：纪元收敛失败不应阻断轮询 */ }
  },

  /**
   * 🟢 v228.54（分叉根治②）：批次锚点自愈 —— 锚点静默丢失后自动补推云端。
   *
   *   丢失路径（真机实锤：两端同步诊断显示本机各有批次、云端锚点为空）：
   *     ① 离线开盘：设计上只写本机绝不推云，但联网后【无任何补推路径】；
   *     ② 在线开盘 _setCloud 失败虽会入队，但 _flushCloudQueue 触发时机不可靠（仅 online 事件/picker 打开）；
   *     ③ getSettings 一次 list 抖动曾让"云端锚点看起来不存在"（已在 sync.js 修复）。
   *   本方法在每轮轮询时：本机有锚点 + 云端【确实】没有锚点（state==='empty'，
   *   区别于"读不到"=unknown）→ 自动补推本机锚点。先到者赢；云端已有批次（含分叉）
   *   时绝不动 —— 分叉交由诊断面板的【强制对齐云端】人工裁决，避免覆盖他端批次。
   */
  _lastAnchorHealTs: 0,
  async _healActiveQuarterAnchor() {
    const aq = this._getActiveQuarter();
    if (!aq || !aq.sheetId) return;                       // 本机无锚点，无可自愈
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline
        || typeof SyncManager.getSettings !== 'function') return;
    const now = Date.now();
    if (now - (this._lastAnchorHealTs || 0) < 60000) return;   // 60s 节流
    // 🟢 v228.61（P0-B 读放大根治）：旧版在此 `SyncManager._settingsKeyListTs = 0`，
    //   本意是「绕过 5s 键集缓存，确保这次探锚点读到新鲜数据」——但代价是
    //   **把全局键集缓存戳清零**，于是本端（以及任何共享该 SyncManager 实例的路径）
    //   下一轮 getSettings() 必然退化成「list + 并发下载全部 14 个分键文件」的读放大。
    //   本方法 60s 节流一次，等于每 60s 给全网端各来一次读放大，收益远小于代价。
    //
    //   正解：探锚点本来只需读 ACTIVE_QUARTER_KEY 这一个键。
    //   改走 _peekCloudActiveQuarter → getSetting()（单键直读，1 请求），
    //   它天然读到的是云端真实值，不受键集缓存影响，根本不需要动那个全局戳。
    let cloud;
    try { cloud = await this._peekCloudActiveQuarter(); } catch (e) { return; }
    if (cloud.state === 'unknown') return;                // 读不到 → 绝不盲推（宁可晚补，不可错盖）
    this._lastAnchorHealTs = now;                         // has/empty 都记账：60s 内不再探测
    if (cloud.state !== 'empty') return;                  // 云端已有批次（自己或他人）→ 无需自愈
    try { await this._setCloud(this.ACTIVE_QUARTER_KEY, aq); } catch (e) { /* 失败已入队 */ }
  },

  /** 🟢 v228.47：查看当前本机同步元数据快照（排障用，只读） */
  inspectQuarterSyncState() {
    const out = { clearedScope: {}, keptScope: {} };
    this.QUARTER_SYNC_KEYS_CLEARABLE.forEach(n => {
      out.clearedScope[n] = this._readSyncKey(n);
    });
    this.QUARTER_SYNC_KEYS_KEEP.forEach(n => {
      const raw = this._readSyncKey(n);
      out.keptScope[n] = raw ? String(raw).slice(0, 80) : null;
    });
    // 任务与记录只报数量，不报内容（避免刷屏）
    try { out.taskCount = Object.keys(DataStore.getStocktakeTasks() || {}).length; } catch (e) { out.taskCount = -1; }
    out.query = { sd: this.query.startDate, ed: this.query.endDate };
    return out;
  },

  /**
   * 🟢 v228.40（一-1/一-2）：把本机协调后的批次归属（no_map）回推云端，供他端开局时拉齐。
   *   只推本批次的条目，避免整包覆盖他端批次。失败静默（下次开局/轮询会再推）。
   */
  async _pushBatchCommonState(sheetId, batchNo) {
    if (!sheetId || !batchNo) return;
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    try {
      let local = {};
      try { local = JSON.parse(localStorage.getItem(this.NO_MAP_KEY) || '{}') || {}; } catch (e) { local = {}; }
      const entry = Object.assign({}, local[sheetId] || {}, {
        no: batchNo, type: 'quarter', updatedAt: new Date().toISOString()
      });
      local[sheetId] = entry;
      localStorage.setItem(this.NO_MAP_KEY, JSON.stringify(local));
      // 云端：先读-合并（只覆盖本 sheetId 键），再整体写回，避免抹掉他端批次
      // 🟢 v228.61（P0-A）：只读 NO_MAP_KEY 一个键，不再读整包。
      let remoteMap = {};
      try {
        const rm = await SyncManager.getSetting(this.NO_MAP_KEY);
        if (rm && typeof rm === 'object') remoteMap = Object.assign({}, rm);
      } catch (e) { /* 忽略 */ }
      remoteMap[sheetId] = entry;
      await this._setCloud(this.NO_MAP_KEY, remoteMap);
    } catch (e) { console.warn('[stocktake] 推送批次号失败(已忽略):', e && e.message); }
  },


  _ymdLocal(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  /**
   * 🟢 v228.48：判断一个季度任务是否属于「当前批次」—— **收敛为两级判定**。
   *
   *   旧版有 5 级兜底（区间精确 / batchKey / 无 startDate / createdAt 当天 / 30 天兜底），
   *   之所以需要这么多层，是因为批次身份 sheetId 由日期推导、两端各推各的，只能靠
   *   「创建时间落在区间内」这类模糊判据去猜任务属于哪一批 —— 代价是**跨批次串档**
   *   （30 天内连开两批时，上一批的任务会漏进新批次）。
   *
   *   现在批次身份是开盘时间戳，任务分派时写入 `batchKey` = 当时的批次身份，
   *   因此归属判定可以严格等价于「batchKey 是否等于当前批次 ID」。两级足矣：
   *     ① `t.batchKey === 当前批次ID` → 命中（严格、唯一）
   *     ② 无 `batchKey`（v228.38 之前的历史任务）→ 走原有 30 天兜底，仅作兼容读取
   *
   *   @param {object} t  任务
   *   @param {string} sd 当前批次显示区间的开始日（仅兼容分支使用）
   *   @param {string} ed 当前批次显示区间的结束日（仅兼容分支使用）
   */
  _taskInCurrentBatch(t, sd, ed) {
    if (!t || t.sheetType !== 'quarter') return false;
    // ① 严格判定：与当前批次身份一致才算本批次
    const curId = this._currentQuarterSheetId();
    if (t.batchKey) return curId ? (t.batchKey === curId) : false;
    // ② 兼容分支：无 batchKey 的历史任务（v228.38 之前分派）
    //   🟢 v228.68 修复：旧实现 `if (t.startDate == null) return true` 会让「无 sheetId 且无 startDate」
    //       的幽灵任务永久漏进每一轮（结束盘点/开下一轮都清不掉，一直显示）。
    //       现严格锚定：必须能对应到当前批次身份——有 sheetId 则要求 === 当前批次；
    //       两者皆缺（极旧任务 / 跨端版本不一致产生的孤儿）一律视为已脱离当前批次，不再展示。
    if (!curId) return false;
    if (t.sheetId) return t.sheetId === curId;
    return false;
  },

  // 🟢 v228.68：清理「既无 batchKey 也无 sheetId」的季度幽灵任务。
  //   此类任务无法锚定到任何批次，旧兼容分支会令其永久显示在管理员视图且清不掉。
  //   墓碑化（deleted:true）后随云端任务通道传播，清除本机与云端残留。
  _gcGhostTasks() {
    try {
      const raw = (DataStore._tasksRaw && DataStore._tasksRaw()) || {};
      let changed = false;
      Object.keys(raw).forEach(k => {
        const t = raw[k];
        if (!t || t.deleted) return;
        if (t.sheetType === 'quarter' && !t.batchKey && !t.sheetId) {
          raw[k] = { taskId: t.taskId, deleted: true, updatedAt: new Date().toISOString() };
          changed = true;
        }
      });
      if (changed) {
        try { DataStore._lsSet('wb_stocktake_tasks', raw); } catch (e) {}
        try { if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) DataStore._pushStocktakeTasksToCloud(); } catch (e) {}
      }
    } catch (e) {}
  },

  /**
   * 🟢 v227：日常盘点「日期/盘点号选择界面」（仿出库单表头信息区格式）。
   *   两个日期框 + 盘点号（默认最新可用号，可下拉切换查看历史日常盘点）+【开始盘点】
   */
  async _renderDailySetup() {
    const area = document.getElementById('stArea');
    if (!area) return;
    this._setStocktakeView('daily-picker');   // 🟢 v228.36：与季度 picker 同样打标记
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
         <button class="btn--primary" onclick="StocktakeModule.saveToRecords({ thenBack: true })" title="仅暂存到本机，不计入盘点记录" style="height:36px;padding:0 18px;font-size:14px;font-family:'PingFang SC','Microsoft YaHei','黑体',sans-serif;">💾 暂存并退出</button>`
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
      <!-- 🟢 v228.13：存货编码打通存货档案（点击跳转） -->
      <td>${TableUtils.link('stock', r.存货编码 || '', r.存货编码 || '')}</td>
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
        <!-- 🟢 v228.13：存货编码打通存货档案（点击跳转） -->
        <td>${TableUtils.link('stock', r.存货编码 || '', r.存货编码 || '')}</td>
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
           <button class="btn--primary" onclick="StocktakeModule.saveToRecords({ thenBack: true })" title="仅暂存到本机，不计入盘点记录" style="height:34px;padding:0 16px;">💾 暂存并退出</button>`
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
    this.toast('已进入往期盘点号 ' + no + ' 的可修改模式：修改【盘点数量】后点【暂存并退出】或【结束本次盘点】');
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
    this._refreshDraftHint();             // 🟢 v228.35（P1）：续盘恢复草稿后同步提示条显隐
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
        <!-- 🟢 v228.13：存货编码打通存货档案（点击跳转） -->
        <td>${TableUtils.link('stock', r.存货编码 || '', r.存货编码 || '')}</td>
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
    // 🟢 v228.68：进入季度盘点即清理无法锚定批次的幽灵任务（结束/开下一轮仍清不掉的残留）
    try { this._gcGhostTasks(); } catch (e) {}
    // 🟢 v228.48：开局流程 —— **批次身份优先，日期退居显示**。
    //
    //   新顺序（旧版那套「解析器→云端→本机锚定」的三段纠葛已随批次身份重构一并消失）：
    //     ① 读云端批次身份（_pullBatchCommonState 会把云端 ACTIVE_QUARTER 合并到本机）；
    //     ② 本机锚定（续盘现场 / 上次批次）；
    //     ③ 若仍无身份 → **开盘**，生成新时间戳并回推云端（他端 3s 内跟随）。
    //   要点：身份确立后永不改变，因此两端只可能读到同一个 sheetId，不存在协商。
    this._ensureDefaultRange();
    try {
      await Promise.race([
        this._pullBatchCommonState(),     // ① 云端批次身份 + 轮次/闸门/命名/号/任务/基线/概览
        new Promise(res => setTimeout(res, 4000))
      ]);
    } catch (e) { console.warn('[stocktake] 开局拉齐跨端状态失败(已忽略):', e && e.message); }
    this._anchorRangeToOpenSession();     // ② 续盘现场
    this._anchorQuarterToLastSheet();     // ② 上次批次
    this._ensureDefaultRange();
    const counter = String(((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? (AppConfig.getCurrentUser() || {}).username : '') || this.task.counter || '').trim();

    // 🟢 v225.2：点「季度盘点」时再拉一次云端任务（进模块那次可能超时/当时离线，
    //   或用户在模块内改了日期区间后直接开季度盘点）。任务栏与选择器都依赖它。
    await this._syncAssignedTasks(4000);

    // ③ 确立批次身份：已有则复用（含从云端拉回的），确认云端无批次则开盘
    //   🟢🔴 v228.49-fix3：_ensureActiveQuarter 现在**可能返回 null**（读不到云端时拒绝擅自开盘）。
    //   旧写法 `this._currentQuarterSheetId() || this._quarterSheetId()` 里的后者会
    //   **用当前时间现造一个 sheetId** —— 等于把刚堵住的擅自开盘又放开了（换了个地方开）。
    //   故此处必须显式区分：
    //     · 拿到锚点 → 正常开局；
    //     · 拿不到（云端不可确认）→ 提示用户重试，**不进盘点**（进去了也是平行批次，盘完看不到）。
    //   🟢 v228.49-fix3-修正：离线要**放行**（仓库弱网/离线是常态，用户就是要单机盘）。
    //     区分对待——
    //       · 离线            → 允许开盘，但只写本机、**不推云端**（联网后以云端为准），不会污染别端；
    //       · 在线但读不到云端 → 拒绝开盘（这种读不到往往意味着别端正开着盘，此时开盘必然分叉）。
    //     首版把两者一律拒绝，导致离线用户根本进不去季度盘点（回归套件 C-6 抓到）。
    //
    //   🟢 v228.65（用户反馈：清场后点「季度盘点」直接变「第 1 轮 · 进行中」，预期应是
    //     「还没开始」）：在线且云端**确实没有**批次时，不再静默自动开盘 —— 先问一句。
    //     清场的目的就是回到「未开始」状态；若清完一进去就自动开一盘，清场等于白清。
    //     改后：弹确认框，用户点了「开始新的盘点」才开盘；取消则留在工作台（未开始状态）。
    //     云端已有批次（state='has'）或读不到（'unknown'）时不弹，走原逻辑。
    try {
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
        const peek = await this._peekCloudActiveQuarter();
        if (peek && peek.state === 'empty') {
          let go = false;
          try {
            go = await WBModal.confirm(
              '当前没有进行中的季度盘点。\n\n要现在开始新的一轮吗？',
              { title: '🗓️ 季度盘点', okText: '开始新的盘点', cancelText: '暂不开始' });
          } catch (e) { go = false; }
          if (!go) return;   // 用户选择「还没开始」→ 留在工作台
        }
      }
    } catch (e) { /* 探测失败不拦原流程 */ }
    let aqEntry = null;
    try { aqEntry = await this._ensureActiveQuarter({ allowOfflineOpen: true }); }
    catch (e) { /* 忽略：下方判空处理 */ }
    if (!aqEntry || !aqEntry.sheetId) {
      const why = this._lastOpenBlockedReason || '无法确定云端当前批次';
      this._lastOpenBlockedReason = null;
      try {
        await WBModal.alert(
          '能连上云端，但读不到当前批次：' + why + '\n\n' +
          '这种情况通常是另一端正在开盘。此时本端另起一批会导致：' +
          '你盘的数据在管理员视图里看不到，管理员结束的也不是你这一批。\n\n' +
          '已阻止本端开盘。请稍后重试，或先确认另一端是否已结束上一轮。',
          { title: '⚠️ 未能进入季度盘点' });
      } catch (e) { this.toast('无法确定云端批次（' + why + '），请联网后重试'); }
      return;
    }
    const sheetId = this._currentQuarterSheetId() || aqEntry.sheetId;
    // 身份确立后，把显示区间对齐（若锚点带了区间）
    this._syncQuarterRangeFromActive();
    const sd = this.query.startDate, ed = this.query.endDate;
    // 🟢 v228.48：记住本次批次（身份 + 显示区间），重进工作台优先落回。
    this._setLastQuarterSheet(sd, ed);
    // 🟢 v228.32：进入季度盘点即刻锁定本轮基线（剔除 0/空存量后的连续序号空间）。
    //   本机/云端已有则不重算 → 之后库存怎么变本轮序号都不动，分派出来的区间始终指同一批货。
    try {
      await Promise.race([
        this._ensureQuarterBaseline(sheetId),
        new Promise(res => setTimeout(res, 5000))     // 弱网兜底：超时不阻断开局
      ]);
    } catch (e) { console.warn('[stocktake] 生成季度基线失败(已忽略):', e && e.message); }
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
    // 🟢 v228.68：我的任务必须限定当前批次 —— getMyOpenTasks 只按「本人+open」过滤，
    //   旧批次遗留任务会永久挂在「我的任务」里（结束盘点/开下一轮都清不掉的直接病灶之一）。
    const myTasks = counter
      ? (DataStore.getMyOpenTasks(counter) || []).filter(t => this._taskInCurrentBatch(t, sd, ed))
      : [];
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
    // 🟢 v228.40（一-1/一-2）：把本机协调后的批次号回推云端，他端开局时即可拉齐到同一个号。
    //   并行化（不 await 阻塞渲染）：推送失败也不影响本轮界面。
    try { this._pushBatchCommonState(sheetId, this.batchNo); } catch (e) { /* 忽略 */ }

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
    // 🟢 v228.36 修复：打「当前停在季度任务选择器」的结构标记，供轻量重渲判定视图状态。
    //   旧实现靠正则匹配页面文案「季度盘点需由管理员分派」——而这句话**全库从未渲染过**，
    //   导致 _refreshQuarterPickerLight / _refreshQuarterPickerIfShown 的守卫恒为 false，
    //   轻量重渲成了死代码：点「开下一轮」后轮次与闸门都已正确解除，界面却永远停在
    //   「⛔ 第 N 轮已结束」，用户以为没生效而反复点击（本次线上反馈的根因）。
    //   标记的清除统一由 _setStocktakeView() 负责，避免遗漏某个 innerHTML 重写点。
    this._setStocktakeView('quarter-picker');
    // 🟢 v227.68：记录当前作业视图上下文，供「刷新任务」重渲染本区（我的任务/分派/补盘）
    this._pickerCtx = { sd, ed, sheetId, counter, batchNo };
    const escA = (s) => typeof escAttr === 'function' ? escAttr(s) : String(s);
    const escH = (s) => typeof esc === 'function' ? esc(s) : String(s);
    // 🟢 v227.9：批次已强制结束 → picker 内所有入口（进入盘点/补盘/认领）禁用，前端直观反映
    const roundClosed = this.isQuarterRoundClosed(sheetId);
    // 🟢 v227.12：当前轮次 + 已结束轮次（用于「第 N 轮」展示与「开下一轮」）
    const roundNo = this._getRoundNo(sheetId);
    const closedRound = this._getClosedRound(sheetId);
    // 🟢 v228.37：轮次徽标显示管理员命名（如「2026年第3季度」），未命名回退「第 N 轮」
    // 🟢 v228.65：改走 _roundBadgeHtml —— 无批次时显示「⚪ 未开始季度盘点」，
    //   不再因 roundClosed=false 被误渲染成「🟢 第 1 轮 · 进行中」。
    const roundBadge = this._roundBadgeHtml(sheetId, roundClosed, roundNo, closedRound);

    // 🟢 v228.35（P5）：改用统一判定 isTaskEntryBlocked —— 与 _claimQuarterTask 的逻辑闸门严格同源。
    //   旧版这里写的是 `roundClosed && !replenishAssigned && !isReplenish`，虽然条件等价，
    //   但两处各写一遍，任何一侧漏改就会出现「显示能点、点了没用」的错位。
    const blocked = (t) => this.isTaskEntryBlocked(t);
    // 🟢 v228.41（优化项-4）：合并行用的「该盘点人全部段编码合集」计算器（闭包内复用）
    const allSegCodesOf = (counter) => {
      try { return this._codesForCounterSegments(counter, sd, ed); } catch (e) { return []; }
    };
    const myRows = myTasks.map(t => `
      <div class="st-banner-warning" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;margin-bottom:6px;flex-wrap:wrap;">
        ${/* 🟢 v228.47：主文本在**窄屏**下独占一行，宽屏保持紧凑单行。
              修复前该行是「主文本 + 日期 + 进入盘点 + 放弃任务」四个 flex 子项挤在 390px 内，
              日期上的 margin-left:auto 把所有剩余空间吸走，主文本被压到近乎零宽 →
              浏览器逐字降列，"管理员 · 序号 1-5 · 5 项" 竖成 12 行（线上截图病根）。
              ⚠️ 不能用无条件 flex:1 1 100% —— 那会让 PC 宽屏也变成两行、卡片白白变高。
              故用 min-width:0 + 断点：窄屏强制换行，宽屏允许收缩不换行。 */ ''}
        <span class="st-my-task-main" style="font-size:13px;"><b>${escH(t.counter)}</b> · ${(() => {
          // 🟢 v228.41（优化项-4）：同一位盘点人的多段任务在同一行内「逗号串联」展示，
          //   与管理员视图（v228.40 二-2c）口径统一 —— 用户拿到 1-5、11-18 两段时，
          //   旧实现拆成两行（各带一个「进入盘点」按钮），既占空间又让人以为要分两次进入。
          //   改为：同 counter 的段合并成一行，区间逗号串联 + 项数合计 + 单一入口。
          const segs = (myTasks || []).filter(x => x.counter === t.counter)
            .map(x => [x.noStart, x.noEnd]).filter(p => p[0] != null && p[1] != null);
          const uniqSegs = segs.filter((p, i) => segs.findIndex(q => q[0] === p[0] && q[1] === p[1]) === i)
            .sort((a, b) => a[0] - b[0]);
          const totalN = (myTasks || []).filter(x => x.counter === t.counter)
            .reduce((s, x) => s + ((x.codes || []).length || 0), 0);
          const segTxt = uniqSegs.length > 1
            ? (uniqSegs.map(p => p[0] + '-' + p[1]).join('、') + ' · ' + uniqSegs.length + ' 个区间')
            : ('序号 ' + t.noStart + '-' + t.noEnd);
          return segTxt + ' · ' + totalN + ' 项';
        })()}${t.isReplenish ? ' · <span style="color:#2563eb;">补派</span>' : ''}</span>
        ${/* 🟢 v228.47：日期改「MM-DD」+ 标签 + nowrap。
              修复前是裸值 String(createdAt).slice(0,10)（如 2026-09-01）：
              ① 无标签，管理员分不清是分派日还是批次起始日；
              ② 390px 视口下被挤成两行，且折行后的 "09-01" 与下一行首字粘连易误读为编号。
              nowrap 保证日期整体换行而不是自身断行。 */ ''}
        <span style="margin-left:auto;font-size:11px;color:var(--text-secondary);white-space:nowrap;" title="任务分派时间">${t.createdAt ? escH('分派于 ' + this._fmtShortDate(t.createdAt)) : ''}</span>
        ${blocked(t)
          ? '<span class="st-btn-disabled" role="button" aria-disabled="true" title="本轮已被管理员结束，不能进入盘点；如需补录漏盘请联系管理员指派补盘" style="font-size:12px;color:#dc2626;padding:4px 12px;">⛔ 已结束</span>'
          : `<button class="btn--primary" data-allseg="${escA(JSON.stringify(allSegCodesOf(t.counter)))}" onclick="StocktakeModule._claimQuarterRow(this,'${escA(t.taskId)}')" style="padding:4px 12px;font-size:12px;">${t.replenishAssigned ? '🔧 补盘' : '进入盘点'}</button>`}
        <button class="btn--ghost" onclick="StocktakeModule.returnTask('${escA(t.taskId)}')" style="padding:4px 12px;font-size:12px;margin-left:6px;" title="放弃该任务，回退管理员处重新分派">放弃任务</button>
      </div>`).filter((row, i, arr) => {
        // 🟢 v228.41（优化项-4）：合并后去重 —— 同 counter 只保留首个（含全部区间汇总的）行。
        const counters = arr.slice(0, i).map(h => { const m = h.match(/<b>([^<]*)<\/b>/); return m ? m[1] : ''; });
        const curM = row.match(/<b>([^<]*)<\/b>/);
        const cur = curM ? curM[1] : '';
        return cur && counters.indexOf(cur) < 0;
      }).join('') || `<div style="display:flex;align-items:center;gap:10px;padding:14px 8px;color:var(--text-secondary);font-size:13px;">
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
    // 🟢 v228.40（二-2a）修复：补盘块的展示条件 —— 旧实现只在 roundClosed 时渲染，
    //   导致「盘点人刚结束盘点、管理员还没结束整轮」这个最需要补盘的窗口里，漏盘补盘入口根本不出现
    //   （线上反馈图：nx 已结束但有 2 项漏盘，nx 界面仍显示「暂无分配给你的任务」）。
    //   现改为：只要有「本人已结束且存在漏盘」的任务，就渲染该块（不论轮次是否已关闭）。
    //   roundClosed=true 时仍保留原本「本批次已被管理员结束」的语义提示。
    // 🟢 v228.69（用户反馈·移动端）：补盘行重排 —— 旧实现「信息 + 日期 + 补盘 + 放弃补盘」四个 flex
    //   子项挤一行，移动端 390px 下信息列被挤成一字一行、按钮溢出屏幕外。现改为两行布局：
    //   第一行 = 姓名/序号/项数/状态/漏盘（自然换行）+ 日期靠右；第二行 = 「补盘」「放弃补盘」并排。
    //   按钮文案「补盘（管理员指派）」→「补盘」（是否指派由区块顶部蓝色提示行说明，不再撑长按钮）。
    const closedRows = closedArr.map(t => {
      const leakSpan = (() => {
        try {
          const ov = this._getAllOverviews()[this._overviewKey(t.counter, t.sheetId || sheetId)] || null;
          const n = (ov && ov.unfilledCount) || 0;
          if (!(n > 0)) return '';
          const leakCodes = (ov && (ov.unfilledCodes || ov.leakCodes)) || [];
          const titleTxt = leakCodes.length
            ? ('漏盘编码：' + leakCodes.slice(0, 30).join('、') + (leakCodes.length > 30 ? ' …' : ''))
            : ('本任务共 ' + n + ' 项未盘，点「补盘」后只会列出这些编码');
          return ` · <span style="color:#dc2626;font-weight:600;cursor:help;" title="${escA(titleTxt)}">漏盘 ${n} 项</span>`;
        } catch (e) { return ''; }
      })();
      return `
      <div class="st-banner-info" style="padding:8px 10px;border-radius:8px;margin-bottom:6px;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <span style="font-size:13px;line-height:1.7;"><b>${escH(t.counter)}</b> · 序号 ${t.noStart}-${t.noEnd} · ${(t.codes || []).length} 项 · <span style="color:#2563eb;">已结束</span>${leakSpan}</span>
          <span style="margin-left:auto;flex:0 0 auto;font-size:11px;color:var(--text-secondary);">${t.closedAt ? escH(String(t.closedAt).slice(0, 10)) : ''}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
          ${(() => {
            // 🟢 v228.70（用户反馈·漏洞修复）：已放弃补盘（leakReturned）的任务，「补盘」「放弃补盘」
            //   两按钮仍带 onclick 可反复点击 → 造成重复退回。现改为：两按钮置灰（无 onclick、
            //   not-allowed 光标）+ 追加「🚫 已放弃补盘」状态说明；如需恢复由管理员重新指派。
            if (t.leakReturned) {
              const nRet = (t.returnedLeakCodes || []).length;
              const gray = 'display:inline-flex;align-items:center;justify-content:center;padding:4px 14px;font-size:12px;'
                + 'border-radius:8px;border:1px dashed var(--border-color,#d1d5db);color:var(--text-muted);'
                + 'opacity:.55;cursor:not-allowed;user-select:none;white-space:nowrap;';
              return '<span aria-disabled="true" style="' + gray + '" title="已放弃补盘，如需恢复请联系管理员重新指派">补盘</span>'
                + '<span aria-disabled="true" style="' + gray + '" title="已放弃补盘，不能重复操作">放弃补盘</span>'
                + '<span style="font-size:12px;color:#9ca3af;">🚫 已放弃补盘' + (nRet ? ' · ' + nRet + ' 项已退回管理员' : '') + '</span>';
            }
            return (blocked(t)
              ? '<span class="st-btn-disabled" role="button" aria-disabled="true" title="本轮已被管理员结束，不能补盘；如需补录漏盘请联系管理员指派补盘" style="font-size:12px;color:#dc2626;padding:4px 12px;">⛔ 已结束</span>'
              : `<button class="btn--ghost" onclick="StocktakeModule._claimQuarterTask('${escA(t.taskId)}')" style="padding:4px 14px;font-size:12px;">补盘</button>`)
              + `<button class="btn--ghost" onclick="StocktakeModule.returnLeak('${escA(t.taskId)}')" style="padding:4px 14px;font-size:12px;" title="放弃补盘，将漏盘项退回管理员处补派">放弃补盘</button>`;
          })()}
        </div>
      </div>`;
    }).join('');

    // 🟢 v228.40（二-2a）：只要本人有「已结束」任务就渲染补盘块（不再限定 roundClosed）。
    //   漏盘项自动归本人补盘（无需管理员指派）；本人点「放弃补盘」才退回管理员补派池。
    const closedBlock = closedRows ? `
        <div style="background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;margin-bottom:12px;">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px;">🧩 我的补盘（已结束的任务）</div>
          ${(function () {
            const anyAssigned = (closedArr || []).concat(myTasks || []).some(t => t && t.replenishAssigned);
            if (anyAssigned) return '<div style="font-size:12px;color:#2563eb;margin-bottom:6px;">🔧 管理员已指派你补盘 —— 点「补盘」后只会列出尚未盘过的编码。</div>';
            return roundClosed
              ? '<div style="font-size:12px;color:#dc2626;margin-bottom:6px;">本批次已被管理员结束，不可再补盘。</div>'
              : '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">发现漏盘可点「补盘」继续，系统只会列出你还没盘过的编码；若无需补录，可点「放弃补盘」退回管理员重派。</div>';
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
          <!-- 🟢 v227.27：顶部冗余状态行精简为一行 chip
               🟢 v228.69：诊断/清场/刷新移出状态行与「我的任务」行，集中到两排之间的工具行（靠左并排） -->
          <div class="quarter-status-bar" style="margin-bottom:8px;">
            <span>👤 作业身份：<b>${escH(counter || '未登录')}</b></span>
            ${roundBadge ? `<span>${roundBadge}</span>` : ''}
            <span title="其他盘点人保存/结束盘点后，本视图通过云端 + BroadcastChannel 自动刷新">
              <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#16a34a;animation:pulse 2s infinite;"></span>
              实时同步
            </span>
          </div>
          <!-- 🟢 v228.69：工具行 —— 刷新 / 诊断 / 清场 靠左并排（用户指定：置于「作业身份」与「我的任务」两排中间） -->
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
            <button id="stTaskRefresh" class="btn--ghost as-refresh-btn" onclick="StocktakeModule.refreshMyTasks()" title="从云端全量刷新：批次身份 / 轮次状态 / 分派给我的任务 / 管理员视图·盘点人进度" style="padding:3px 9px;font-size:12px;line-height:1.3;">🔄 刷新</button>
            ${/* 🟢 v228.48-fix2：把「清场重置」从控制台命令搬进界面。
                  用户真机反馈：「两边都没有办法清，你不能帮我清一下嘛」「电脑上这样也麻烦」——
                  原方案要求两端各开 F12 控制台敲 `resetQuarterSyncState()`，仓库场景不现实。
                  这里给出界面入口（需 stocktakeAssign 权限 + 二次确认），语义与命令完全一致。 */ ''}
            ${isAdmin ? `<button class="btn--ghost" onclick="StocktakeModule.showSyncDiagnose()" title="查看本机与云端的批次/会话/进度是否一致，分叉时可一键对齐" style="padding:3px 9px;font-size:12px;line-height:1.3;opacity:.85;">🩺 诊断</button>` : ''}
            ${isAdmin ? `<button class="btn--ghost" onclick="StocktakeModule.resetFromUI()" title="把本机的季度批次/轮次/任务/概览缓存清成干净起点（会先备份，可回滚）" style="padding:3px 9px;font-size:12px;line-height:1.3;opacity:.85;">🧹 清场</button>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:600;">📋 我的任务</span>
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
    // 🟢 v228.40（二-1a）：本批次是否存在「已派给某人」的任务。
    //   存在 → 「上一轮盘点已归档…本轮尚未分派任务」提示条必须整条隐藏（用户已确认口径）：
    //   该提示只在「上一轮已结束、本轮尚无任务」的阶段才成立；有任务还提示「尚未分派」自相矛盾
    //   （线上反馈图：明明有「管理员 1-103 · 103 项」任务卡，下面仍说本轮尚未分派）。
    const batchHasAnyTask = Object.keys(DataStore.getStocktakeTasks() || {}).some(k => {
      const t = DataStore.getStocktakeTasks()[k];
      if (!t || t.deleted) return false;
      if (t.returned || t.leakReturned) return false;   // 已退回/已放弃的不算「有任务」
      return this._taskInCurrentBatch(t, sd, ed);
    });
    // 🟢 v228.35（P11）：本批次已存在任务时不再渲染「本次盘点未开始」。
    //   旧版会出现「本次盘点未开始 / 尚未开启本批次盘点」与下方「本批次全部任务（已分派 2 人）」
    //   同时显示的自相矛盾画面，管理员看了会疑惑「到底开始没开始」。
    if (!ov && !roundClosed) {
      if (batchHasAnyTask) return '';
    }
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
          // 🟢 v228.40（二-1a）：本批次已有任务 → 该提示整条隐藏（已派任务 ≠ 尚未分派）。
          if (batchHasAnyTask) return '';
          // 🟢 v228.34：同 in_progress 分支 —— 归档提示不拼 stats，避免展示上一轮的漏盘数字误导用户。
          head = '上一轮盘点已归档';
          btnLabel = ''; btnClick = ''; btnClass = 'primary';
          hint = '';
          body = `<div style="font-size:13px;margin-top:4px;color:var(--text-secondary);">盘点号 <b>${escH(batchNo)}</b> 的上一轮已结束并归档。本新一轮尚未分派任务，请由管理员分派后再盘点。</div>`;
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
        // 🟢 v228.34：新轮次（roundClosed=false）时不应该出现 in_progress 概览，
        //   若出现则是上一轮残留（云端异步回灌 / 多设备竞争 / 清概览 push 未及时生效）。
        //   与上方 finished 分支（line 1314）保持一致的轮次防御：新轮次一律按"上一轮已归档"处理。
        if (!roundClosed) {
          // 🟢 v228.40（二-1a）：本批次已有任务 → 该提示整条隐藏（已派任务 ≠ 尚未分派）。
          if (batchHasAnyTask) return '';
          // 🟢 v228.34：不再拼 stats —— 「上一轮已归档」却展示上一轮的 0/5 进度会误导用户，
          //   让人以为本轮有 5 项待盘。新轮次下只保留归档说明，数字一律不显示。
          head = '上一轮盘点已归档';
          btnLabel = ''; btnClick = ''; btnClass = 'primary';
          hint = '';
          body = `<div style="font-size:13px;margin-top:4px;color:var(--text-secondary);">盘点号 <b>${escH(batchNo)}</b> 的上一轮已结束并归档。本新一轮尚未分派任务，请由管理员分派后再盘点。</div>`;
        } else {
          head = '本次盘点未结束！请继续';
          btnLabel = '继续盘点';
          btnClick = `StocktakeModule._resumeFromMyOverview('${escH(counter)}','${escH(sheetId)}')`;
          btnClass = 'primary';
          hint = '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">已盘点数据已保存为草稿，可直接继续；点【继续盘点】恢复现场。</div>';
          body = `<div style="font-size:13px;margin-top:4px;">盘点号 <b>${escH(batchNo)}</b> 进度：</div>` + stats;
        }
      }
    }
    const btn = btnLabel
      ? `<button class="${btnClass}" onclick="${btnClick}" style="padding:6px 14px;font-size:13px;">${btnLabel}</button>`
      : '';
    return `
      <div id="stMyOverviewBlock" style="background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;">📊 ${head}</div>
        ${body}
        ${hint}
        ${btn ? '<div style="margin-top:8px;">' + btn + '</div>' : ''}
      </div>`;
  },

  // 🟢 v228.47：相对时间文案 —— 「我的任务」与「本批次全部任务」两处共用。
  //   修复前同一屏里并存两种时间表达（我的任务给绝对日期「2026-09-01」、管理员视图给
  //   相对时长「最后活动 14 天前」），用户读同一类信息要切换心智；且裸值无标签，
  //   管理员无从判断 2026-09-01 是"分派日"还是"批次起始日"。
  _fmtRelativeTime(ms) {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 0) return '刚刚';          // 时钟漂移/未来时间：不显示"负几分钟前"
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    if (min < 1440) return Math.floor(min / 60) + ' 小时前';
    return Math.floor(min / 1440) + ' 天前';
  },

  // 🟢 v228.47：把 ISO 时间转成「MM-DD」（去掉年份）。
  //   同一批次的任务日期必然同年，年份占位却最宽 —— 截图里正是 "2026-09-01" 在
  //   390px 视口被挤成 "2026-" / "09-01" 两行，且 "09-01" 与新行首字粘连易误读为编号。
  //   解析失败回退原始字符串前 10 位，保证不渲染出 "Invalid Date"。
  _fmtShortDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso).slice(0, 10);
      return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    } catch (e) { return String(iso).slice(0, 10); }
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
    // 🟢 v228.37：管理员视图徽标同 picker —— 命名优先，未命名回退「第 N 轮」
    // 🟢 v228.65：同上改走 _roundBadgeHtml（三态：未开始 / 进行中 / 已结束）。
    const roundBadge = this._roundBadgeHtml(sheetId, roundClosed, roundNo, closedRound);
    const grouped = {};  // counter -> { counter, noStart, noEnd, count, codesLen, taskIds }
    (allBatch || []).forEach(t => {
      if (!t || !t.counter) return;
      const c = t.counter;
      if (!grouped[c]) grouped[c] = { counter: c, noStart: t.noStart, noEnd: t.noEnd, count: 0, codesLen: 0, taskIds: [], status: 'open', replenishAssigned: false,
                                      lastActiveAt: '', claimedAt: '', started: false, intervals: [] };
      grouped[c].count++;
      grouped[c].codesLen += (t.codes || []).length;
      grouped[c].taskIds.push(t.taskId);
      if (t.replenishAssigned) grouped[c].replenishAssigned = true;
      if (t.status === 'closed') grouped[c].status = grouped[c].status === 'open' ? 'closed' : grouped[c].status;
      // 🟢 v228.35（P6）：汇总「最后活动时间」与「是否已开工」，用于三态徽标
      if (t.started) grouped[c].started = true;
      const ts = t.claimedAt || t.updatedAt || t.createdAt || '';
      if (ts && String(ts) > String(grouped[c].lastActiveAt || '')) grouped[c].lastActiveAt = String(ts);
      if (t.claimedAt && String(t.claimedAt) > String(grouped[c].claimedAt || '')) grouped[c].claimedAt = String(t.claimedAt);
      // 取最小 noStart / 最大 noEnd（兜底展示用）
      if (grouped[c].noStart == null || t.noStart < grouped[c].noStart) grouped[c].noStart = t.noStart;
      if (grouped[c].noEnd == null || t.noEnd > grouped[c].noEnd) grouped[c].noEnd = t.noEnd;
      // 🟢 v228.40（二-2c）：保留「每段区间」原样 —— 旧实现只存 min/max，管理员 1-5 补派 11-18 后
      //   被合并显示成「1-18」，掩盖了两段独立分配的事实。这里收集真实区间，展示时逐段列出。
      if (t.noStart != null && t.noEnd != null) grouped[c].intervals.push([t.noStart, t.noEnd]);
    });
    // 用户（counter）概览填充
    // 🟢 v228.68：轮次已结束时，丢弃「无概览数据」的分派行——即已结束却从未盘任何项、
    //   盘点记录列表里也没有对应数据的空占位（如“本轮已结束 尚未开启”）。它们只是噪声，
    //   留着会误导管理员，且正是“结束盘点后清不掉”的那一行。有真实盘点数据的行照常保留。
    const rows = Object.keys(grouped).filter(c => {
      if (roundClosed && !ovMap[this._overviewKey(c, sheetId)]) return false;
      return true;
    }).map(c => {
      const g = grouped[c];
      const ov = ovMap[this._overviewKey(c, sheetId)] || null;
      // 🟢 v228.35（P6）：三态开工徽标 —— 未开工 / 盘点中 / 已结束。
      //   旧版只显示「已盘 x/y」，管理员分不清「没开工」「进来看了眼就走了」「暂存了 2 项」，
      //   只能打电话问「你盘了吗」，监控面板形同虚设。
      //   started/claimedAt 字段本来就有，只是从未渲染 —— 这里把它用起来。
      const lastAtMs = g.lastActiveAt ? new Date(g.lastActiveAt).getTime() : 0;
      const idleMs = lastAtMs ? (Date.now() - lastAtMs) : 0;
      const idleText = this._fmtRelativeTime(lastAtMs);
      // 「盘点中」= 有开工痕迹（认领过）且任务未全部结束
      const inProgress = !roundClosed && g.status !== 'closed' && (g.started || !!g.claimedAt);
      const isFinished = g.status === 'closed';
      let stateBadge;
      if (roundClosed) {
        stateBadge = '<span class="st-state st-state--closed">⛔ 本轮已结束</span>';
      } else if (isFinished) {
        stateBadge = '<span class="st-state st-state--done">✅ 已结束</span>';
      } else if (inProgress) {
        // 🟢 超 30 分钟无活动 → 转橙色预警，提示管理员跟进（仓库里「人走单未结」是常态）
        stateBadge = idleMs > 30 * 60000
          ? `<span class="st-state st-state--idle" title="已 ${idleText || '较长时间'}无操作，建议跟进">🟠 盘点中 · 停滞</span>`
          : '<span class="st-state st-state--ing">🟡 盘点中</span>';
      } else {
        stateBadge = '<span class="st-state st-state--todo">⚪ 未开工</span>';
      }
      const idleHtml = (lastAtMs && !isFinished && !roundClosed)
        ? `<span style="color:var(--text-muted);font-size:11px;white-space:nowrap;">最后活动 ${escH(idleText)}</span>` : '';
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
        statsHtml = inProgress ? ' <span style="opacity:.6;">已开工，暂无落库记录</span>'
                               : ' <span style="opacity:.6;">尚未开启</span>';
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
      // 🟢 v228.70（用户反馈·移动端）：不同盘点人行排版不一致 —— 旧实现所有元素挤在同一个
      //   flex-wrap 行里，换行位置随内容宽度漂移（如「管理员」行徽章落在第一行右端，
      //   「zmy」行徽章掉到第二行、按钮再掉到第三行）。现固定为两行结构，每个盘点人一致：
      //   第一行 = 姓名 + 区间信息 + 状态徽章（固定行尾右端）；
      //   第二行 = 已盘进度 + 最后活动 / 指派补盘按钮（固定行尾右端）。
      return `<div style="padding:7px 10px;border-bottom:1px dashed var(--border-color,#eee);font-size:13px;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <span style="flex:0 0 auto;"><b>${escH(g.counter)}</b></span>
          <span style="color:var(--text-secondary);font-size:12px;min-width:0;">${(() => {
            // 🟢 v228.40（二-2c）：按真实分派区间逐段展示（同行逗号串联），不再用 min-max 合并成一段。
            //   去重 + 排序，保证多端展示稳定；无区间信息时回退旧的 min-max。
            const iv = (g.intervals || []).slice()
              .map(p => [Number(p[0]), Number(p[1])])
              .filter(p => isFinite(p[0]) && isFinite(p[1]))
              .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            const uniq = [];
            iv.forEach(p => { const last = uniq[uniq.length - 1]; if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p); });
            const txt = uniq.length
              ? uniq.map(p => p[0] + '–' + p[1]).join('、')
              : ((g.noStart || '-') + '–' + (g.noEnd || '-'));
            return escH(txt) + ' · ' + uniq.length + ' 个区间 · ' + g.codesLen + ' 项';
          })()}</span>
          <span style="margin-left:auto;flex:0 0 auto;">${stateBadge}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;">
          ${statsHtml}
          <span style="margin-left:auto;display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;">${idleHtml}${replenishBtn}</span>
        </div>
      </div>`;
    }).join('');
    // 🟢 v228.69（用户反馈）：本轮结束后不再显示「⛔ xx 已结束（批次号）」文字徽章 ——
    //   「👑 本批次全部任务」标题旁已有 roundBadge 红色「已结束」标识，行内这枚纯文本徽章冗余，
    //   还把「🔄 开下一轮盘点」挤到老远。置空后按钮行自然收敛为「分派任务 + 开下一轮盘点」紧靠并排。
    // 🟢 v228.74：改名「结束本轮并归档」—— 旧名「结束季度盘点」让人误以为结束整个季度，
    //   实际只是结束本轮（一轮批次，结束后仍可「开下一轮盘点」）。
    const endBatchBtn = roundClosed
      ? ''
      : `<button class="btn--danger" onclick="StocktakeModule.endQuarterRound('${escA(sheetId)}')" style="padding:6px 14px;font-size:13px;">🏁 结束本轮并归档</button>`;
    // 🟢 v228.74（用户决策）：「🚨 紧急结束本轮」按钮已删除 —— 其"只锁盘不结算"语义与
    //   「结束本轮并归档」并存时职责混淆，且锁盘后结算入口消失、"开下一轮"会清草稿，
    //   构成数据丢失陷阱。远程自动结算协议落地后（settleReq），正常结算即可覆盖全部场景。
    const emergencyBtn = '';
    // 🟢 v227.12：已结束 → 提供「开下一轮」入口（解闸 + 重置任务），解决「结束后再也开不了下一轮」
    const nextRoundBtn = roundClosed
      ? `<button class="btn--primary" onclick="StocktakeModule.startNextRound('${escA(sheetId)}')" style="padding:6px 14px;font-size:13px;">🔄 开下一轮盘点</button>`
      : '';
    // 🟢 v227.21：批次已结束且有漏盘 → 顶部加一条醒目提示，明确「指派补盘」入口就在一行最右侧，
    //   解决管理员反馈「结束季度盘点后找不到分配补盘任务的地方」。
    const leakCounters = Object.keys(grouped).filter(c => ((ovMap[this._overviewKey(c, sheetId)] || {}).unfilledCount || 0) > 0);
    // 🟢 v228.70（用户反馈）：提示精简 —— 旧文案两行、把操作细节全部铺出，移动端观感繁杂。
    //   只保留「几个人漏盘 / 是谁 / 怎么办」三个必要信息，一行讲完（操作按钮本身就在下方行内，无需赘述）。
    const leakHint = (roundClosed && leakCounters.length)
      ? `<div class="st-banner-warning" style="margin:8px 0 4px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.6;">
           ⚠️ 本批次已结束，仍有 <b>${leakCounters.length}</b> 人漏盘（${leakCounters.map(c => escH(c)).join('、')}）—— 点其所在行的「🔧 指派补盘」安排补录。
         </div>`
      : '';
    // 🟢 v228.34：退回待分配池 + 补盘人员监控（实时取基线序号，复用现有概览）
    const _baselineCodes = (this._peekQuarterBaseline(sheetId) || {}).codes || [];
    const _serialOf = new Map(_baselineCodes.map((c, i) => [c, i + 1]));
    const returnedBlock = this._renderReturnedPoolBlock(this._returnedPool(sheetId, sd, ed, _serialOf), sheetId);
    const monitorBlock = this._renderReplenishMonitorBlock(sheetId, sd, ed, ovMap, _serialOf);
    return `
      <div id="stAdminBatchBlock" style="background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;">
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
          ${roundClosed
            // 🟢 v228.65（用户反馈）：本轮已结束、还没开下一轮时，「分派任务」不该能点 ——
            //   此时派的活没有归属的轮次。置灰禁用；补盘不受影响（走行内「指派补盘」/「补派任务」）。
            ? `<button class="btn--primary" disabled title="本轮已结束，点「🔄 开下一轮盘点」后再分派"
                 style="padding:6px 14px;font-size:13px;opacity:.45;cursor:not-allowed;">➕ 分派任务</button>`
            : `<button class="btn--primary" onclick="StocktakeModule.openAssignDialog()" style="padding:6px 14px;font-size:13px;">➕ 分派任务</button>`}
          ${endBatchBtn}
          ${emergencyBtn}
          ${nextRoundBtn}
        </div>
        ${returnedBlock}
      </div>
      ${monitorBlock}`;
  },

  // 🟢 v228.34：退回待分配池（放弃任务 + 放弃补盘 的未重派编码）—— 同步取基线序号
  _returnedPool(sheetId, sd, ed, serialOf) {
    const allTasks = DataStore.getStocktakeTasks() || {};
    const out = [];
    Object.keys(allTasks).forEach(k => {
      const t = allTasks[k];
      if (!t || (!t.returned && !t.leakReturned)) return;
      if (!this._taskInCurrentBatch(t, sd, ed)) return;
      const all = (t.returned ? (t.codes || []) : (t.returnedLeakCodes || [])).filter(Boolean);
      const replenished = new Set(t.replenishedCodes || []);
      const availCodes = all.filter(c => !replenished.has(c));
      if (!availCodes.length) return;
      const availSerials = availCodes.map(c => serialOf ? serialOf.get(c) : null).filter(Boolean).sort((a, b) => a - b);
      out.push({ taskId: t.taskId, from: t.returned ? 'task' : 'leak', originCounter: t.counter, availCodes, availSerials });
    });
    return out;
  },

  // 🟢 v228.34：渲染「📥 退回待分配」卡片（纯展示列表 + 一个「补派任务」按钮，无每行按钮）
  //   卡片始终渲染（即使无退回项也保留「补派任务」按钮），满足「管理员视图增加补派任务按钮」要求。
  _renderReturnedPoolBlock(pool, sheetId) {
    const escH = (s) => typeof esc === 'function' ? esc(s) : String(s);
    const items = (pool && pool.length) ? pool.map(p => {
      const serials = p.availSerials;
      const rangeTxt = serials.length ? (serials[0] + (serials.length > 1 ? '–' + serials[serials.length - 1] : '')) : '-';
      const fromLabel = p.from === 'task' ? '放弃任务' : '放弃补盘';
      const origin = p.originCounter ? escH(p.originCounter) : '（无）';
      const codesPreview = p.availCodes.slice(0, 8).map(escH).join('、') + (p.availCodes.length > 8 ? ' …' : '');
      // 🟢 v228.71（用户反馈·移动端）：与管理员视图进度行统一的两行结构 ——
      //   第一行 = 类型 + 原负责人 + 序号 + 「可补派 N 项」徽标（固定行尾右端）；
      //   第二行 = 编码明细（次要信息，自然换行）。旧单行 flex-wrap 在窄屏挤成竖条。
      return `<div style="padding:7px 10px;border-bottom:1px dashed var(--border-color,#eee);font-size:12.5px;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <span style="flex:0 0 auto;"><b>${fromLabel}</b></span>
          <span style="color:var(--text-secondary);font-size:12px;min-width:0;">原负责人 ${origin} · 序号 ${rangeTxt}</span>
          <span style="margin-left:auto;flex:0 0 auto;color:#2563eb;font-size:12px;">可补派 <b>${serials.length}</b> 项</span>
        </div>
        <div style="margin-top:4px;color:var(--text-secondary);font-size:11px;line-height:1.6;word-break:break-all;">编码：${codesPreview}</div>
      </div>`;
    }).join('') : `<div style="font-size:12px;color:var(--text-secondary);padding:4px 0;">当前没有退回待分配项。</div>`;
    return `
      <div style="margin-top:12px;background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;">📥 退回待分配（放弃任务 / 放弃补盘）</div>
        ${items}
        <div style="margin-top:8px;">
          <button class="btn--primary" onclick="StocktakeModule.openReplenishDialog()" style="padding:5px 14px;font-size:12.5px;">📥 补派任务</button>
        </div>
      </div>`;
  },

  // 🟢 v228.34：渲染「📥 补盘人员监控」卡片 —— 复用现有 per-counter 概览 + 颜色/差异逻辑
  _renderReplenishMonitorBlock(sheetId, sd, ed, ovMap, serialOf) {
    const allTasks = DataStore.getStocktakeTasks() || {};
    const mon = Object.keys(allTasks).map(k => allTasks[k])
      .filter(t => this._taskInCurrentBatch(t, sd, ed) && (t.isReplenish === true || t.replenishAssigned === true));
    if (!mon.length) return '';
    const escH = (s) => typeof esc === 'function' ? esc(s) : String(s);
    const rows = mon.map(t => {
      const ov = ovMap[this._overviewKey(t.counter, sheetId)] || null;
      let statsHtml = '';
      if (ov && ov.totalCount) {
        const color = ov.status === 'finished' && ov.unfilledCount === 0 ? '#16a34a'
                    : ov.status === 'finished' ? '#b45309'
                    : (ov.completionRate >= 100 ? '#2563eb' : '#6b7280');
        const diffHtml = (ov.diffCount > 0) ? ` <span style="color:#dc2626;font-weight:700;">· 差异 ${ov.diffCount}</span>` : '';
        statsHtml = ` <span style="color:${color};">已盘 ${ov.realCount || 0}/${ov.totalCount}（${ov.completionRate || 0}%${ov.unfilledCount ? ' · 漏 ' + ov.unfilledCount : ''}${diffHtml}${ov.status === 'finished' ? ' · 已结束' : ''}）</span>`;
      } else {
        statsHtml = ` <span style="opacity:.6;">尚未开启</span>`;
      }
      const fromLabel = t.isReplenish ? '补派' : '漏盘补派';
      const serials = (t.codes || []).map(c => serialOf ? serialOf.get(c) : null).filter(Boolean).sort((a, b) => a - b);
      const rangeTxt = serials.length ? (serials[0] + (serials.length > 1 ? '–' + serials[serials.length - 1] : '')) : '-';
      const statusLabel = (t.status === 'closed' || (ov && ov.status === 'finished')) ? '✅ 已完成' : '🟡 补盘中';
      // 🟢 v228.71（用户反馈·移动端）：与管理员视图进度行统一的两行结构 ——
      //   第一行 = 姓名 + 补派类型/序号/项数 + 状态徽标（固定行尾右端）；
      //   第二行 = 已盘进度。旧单行 flex-wrap 换行位置随内容漂移、不同人不一致。
      return `<div style="padding:7px 10px;border-bottom:1px dashed var(--border-color,#eee);font-size:13px;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <span style="flex:0 0 auto;"><b>${escH(t.counter)}</b></span>
          <span style="color:var(--text-secondary);font-size:12px;min-width:0;">${fromLabel} · 序号 ${rangeTxt} · ${(t.codes || []).length} 项</span>
          <span style="margin-left:auto;flex:0 0 auto;font-size:12px;">${statusLabel}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;">
          ${statsHtml}
        </div>
      </div>`;
    }).join('');
    return `
      <div style="margin-top:12px;background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:10px;padding:14px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;">📥 补盘人员监控</div>
        ${rows}
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
    if (!effectiveSheetId) effectiveSheetId = this._currentQuarterSheetId() || this._quarterSheetId();

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
    const sheetId = this._currentQuarterSheetId() || this._quarterSheetId();
    const tasks = DataStore.getStocktakeTasks() || {};
    const myClosed = Object.keys(tasks)
      .map(k => tasks[k])
      .filter(t => t && t.sheetType === 'quarter' && t.counter === counter &&
        (t.batchKey ? t.batchKey === sheetId : (t.startDate == null || (t.startDate === sd && t.endDate === ed)))
        && t.status === 'closed');
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

  /**
   * 🟢 v228.35（P5）：本轮是否「禁止进入盘点」的唯一判定入口。
   *   问题：旧版把闸门判断散落在 3 处（picker 渲染、_claimQuarterTask、_claimFirstOpenTask），
   *        各处条件写法不同，导致「UI 显示 ⛔ 已结束」与「逻辑仍放行」有机会不一致 ——
   *        用户看到还能点、点了还能进，盘完却不生效，比不让点更伤信任。
   *   方案：收敛为单一函数，UI 与逻辑共用，杜绝两套判断漂移。
   *   规则：本轮已结束 且 该任务不是管理员指派的补盘/补派任务 → 禁止。
   */
  isTaskEntryBlocked(task) {
    if (!task) return false;
    // 🟢 v228.48：批次身份优先取 task.batchKey（分派时写入，跨端一致）
    const sid = task.batchKey
      || (this._isTimestampSheetId(task.sheetId) ? task.sheetId : null)
      || this._currentQuarterSheetId();
    if (!sid) return false;
    return this.isQuarterRoundClosed(sid) && !task.replenishAssigned && !task.isReplenish;
  },

  // 🟢 v228.41（优化项-4）：合并行入口 —— 从按钮 data 属性取「全部段编码」，一次性载入。
  //   单段场景下 allSegCodes 与单任务 codes 等价，行为与旧版完全一致（向后兼容）。
  _claimQuarterRow(btn, taskId) {
    let allSeg = null;
    try {
      const raw = btn && btn.getAttribute && btn.getAttribute('data-allseg');
      if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) allSeg = arr; }
    } catch (e) { /* 解析失败 → 退回单任务模式 */ }
    return this._claimQuarterTask(taskId, allSeg);
  },

  // 🟢 v224 重写：领取某个季度盘点任务 → 建 sheet + 拉全库 + 按任务固化的编码清单过滤 + 渲染。
  //   原实现误调 claimRange(...)，而 claimRange 不接受参数、只从 DOM 读 #stNoStart/#stNoEnd，
  //   任务选择器渲染后这些输入框并不存在 → 点「进入盘点」静默无反应，季度盘点完全进不去。
  async _claimQuarterTask(taskId, allSegCodes) {
    const t = (DataStore.getStocktakeTasks() || {})[taskId];
    if (!t) { this.toast('任务不存在或已撤销'); this._refreshTaskBar(); return; }
    // 🟢 v227.9：批次已强制结束 → 盘点人不能再进入盘点（管理员视角的【本次季度盘点结束】）
    // 🟢 v228.48：批次身份优先取 task.batchKey（分派时写入的跨端一致标识）
    const _sid0 = t.batchKey
      || (this._isTimestampSheetId(t.sheetId) ? t.sheetId : null)
      || this._currentQuarterSheetId() || this._quarterSheetId();
    // 🟢 v227.14：被管理员「指派补盘」的任务例外放行 —— 否则批次一结束就永远补不了漏盘。
    //   未带标记的任务行为完全不变（照样拦住）。
    // 🟢 v228.35（P5）：改走统一判定 isTaskEntryBlocked，与 UI 的 ⛔ 显示严格同源；
    //   同时把提示写清楚「为什么不能进、找谁处理」，避免用户反复点击试错。
    if (this.isTaskEntryBlocked(t)) {
      const _round = this._getClosedRound(_sid0) || this._getRoundNo(_sid0);
      // 🟢 v228.37：提示带轮次命名（如「2026年第3季度」），未命名回退「第 N 轮」
      WBModal.alert('本次季度盘点（' + this._roundDisplay(_sid0, _round) + '）已由管理员结束，不能再进入盘点。\n\n'
        + '盘点号：' + (this.batchNo || _sid0) + '\n\n'
        + '如需继续盘点，请联系管理员「开始下一轮」；若确认本轮仍有漏盘需要补录，请管理员在「分派任务」中指派补盘。',
        { title: '⛔ 本轮已结束' });
      return;
    }
    // 🟢 v224：任务已结束仍允许进入，走「补盘」模式（漏盘补录）。
    //    旧逻辑直接 return，导致结束后发现漏盘也进不去，只能让管理员取消分派重来。
    //    这里重建 sheet/行集后，_applyResumeFilter() 会自动剔除本人已盘编码，只留没盘过的。
    // 🟢 v227.14：管理员指派补盘的任务（可能仍是 open，因为是被强制结束、本人没点过结束）
    //   同样走补盘模式 —— 只列未盘编码，而不是把完整区间再摊一遍。
    // 🟢 v228.34：补派任务（isReplenish）同样走「仅列未盘编码」模式——其 codes 本就是退回子集，
    //   再次进入应排除已盘项，避免把已确认的编码又摊一遍。
    const replenish = t.status === 'closed' || t.replenishAssigned === true || t.isReplenish === true;

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
      // 🟢 v228.48：复用本批次（sheetId）的盘点号 —— 同一批次所有领取人共用一个号
      const _qSheetId = t.batchKey || this._currentQuarterSheetId() || this._quarterSheetId();
      this.batchNo = this._genBatchNo('quarter', _qSheetId);
      // 🟢 v228.40（一-1/一-2）：进入盘点也把批次号回推云端，保证其他端同一批次号
      try { this._pushBatchCommonState(_qSheetId, this.batchNo); } catch (e) { /* 忽略 */ }
    this.sheet = { sheetId: _qSheetId, batchNo: this.batchNo, sheetType: 'quarter', startDate: sd, endDate: ed };
      this._frozen = false;   // 🟢 v228.39（P4）：进入新一轮/新会话 → 清除上一次的远程冻结锁
      this._sheetTouched = null;   // 🟢 v227.5：领取/续盘季度任务 = 新开一轮 → 清空痕迹
      this._markOpenSession(_qSheetId, 'quarter', t.counter || cur, sd, ed);
      // 🟢 v227.5：记住入口类型（quarter）—— 返回按钮 / 结束盘点回到季度任务选择器
      this._entrySheetType = 'quarter';
      // 🟢 v224：季度盘点 = 全库清点（不经出库筛选，也不显示出入库列）
      this.allRowsFull = this.buildRows(stock || [], {}, {}, null);
      // 🟢 v228.32：收敛到本轮基线 —— 表格序号与分派时用的序号严格同源、同样剔除 0 存量
      await this._applyBaselineRows(_qSheetId);
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
        this._setAssignedRows(t, allSegCodes);   // 后：按任务固化编码清单过滤（v228.41：多段合并行传全集编码）
      }
      this._restoreDraft();
      this.renderTable();
      this._refreshDraftHint();   // 🟢 v228.35（P1）：续盘恢复草稿后同步提示条显隐
      // 🟢 v228.40（二-1b）修复：盘点人「进入盘点」即视为开工 —— 管理员视图的三态徽标
      //   （未开工/盘点中/已结束）依赖 task.started || claimedAt。旧实现只在 claimRange 里置位，
      //   而季度任务是分派制（不经过 claimRange），导致「已盘 23/103 却仍显示 ⚪ 未开工」。
      //   这里在成功进入填表后落库 started/claimedAt，并随任务推云端，各端视图立即一致。
      try {
        if (!t.started || !t.claimedAt) {
          const _nowIso = new Date().toISOString();
          t.started = true;
          t.claimedAt = t.claimedAt || _nowIso;
          t.updatedAt = _nowIso;
          await DataStore.saveStocktakeTask(t);   // 自动推云端（settings 通道，跨设备同步）
        }
      } catch (e) { console.warn('[stocktake] 标记开工失败(已忽略):', e && e.message); }
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
    const finished = !!(this._sheetTouched && this._sheetTouched.finished);
    const abandoned = !!(this._sheetTouched && this._sheetTouched.abandoned);
    if (!this.sheet || finished || abandoned) { this._backToWorkbench(); return; }
    // 🟢 v228.40（二-5）按用户确认口径重构返回语义：
    //   · 一律弹「⚠ 自动保存并返回」（保存并返回 / 直接返回）；
    //   · 保存并返回 → 直接保存草稿并回初始界面；
    //   · 直接返回  → 分两种情况：
    //       ① 从未保存过草稿 → 清空本次输入、不保存，直接回初始界面（丢弃现场）；
    //       ② 之前保存过草稿 → 丢弃本次新填，仅保留上次草稿（即不覆盖旧草稿），回初始界面。
    //   实现要点：在「直接返回」分支里，若存在旧草稿（loadDraft 有内容且 _sheetTouched.saved 为真），
    //   绝对不能调 clearDraft()/saveDraft()，否则会把上次草稿一起清掉或被本次新填覆盖。
    const all = this.visibleRows ? this.visibleRows() : [];
    const n = (all || []).filter(r => r.盘点数量 !== '' && r.盘点数量 != null).length;
    const ok = await WBModal.confirm(
      '返回将自动保存当前进度（' + n + ' 条未结束的盘点数量），下次进入可继续盘点。',
      { title: '⚠ 自动保存并返回', okText: '保存并返回', cancelText: '直接返回' }
    );
    if (ok) {
      // 🟢 v228.41 修复（返回失效 bug）：saveToRecords → saveDraft() 内部会调 _markOpenSession()
      //   重建「未结束会话」标记，导致随后的 startQuarter() 又被 _detectUnfinished 的 ①b 分支
      //   （open session 命中）拽回盘点表 —— 表现就是「点保存并返回却退不出去」。
      //   这里在导航前显式置 _skipResumePrompt=true：返回的语义就是「回到初始界面、不自动续盘」。
      this._skipResumePrompt = true;
      await this.saveToRecords({ skipConfirm: true });
      this._backToWorkbench();          // 保存并返回：保存草稿后回初始界面
      return;
    }
    // 「直接返回」分支
    const hadDraft = !!(this._sheetTouched && this._sheetTouched.saved);
    // 🟢 v228.41 修复（返回失效 bug）：两条分支都必须保证「回到初始界面且不被续盘检测拽回」。
    //   旧实现只在 hadDraft 分支置 _skipResumePrompt；而 clearDraft() 并不清 OPEN_KEY 会话标记，
    //   无草稿分支清完草稿后仍会被 ①b 命中 → 同样退不出去。这里统一在导航前置位。
    this._skipResumePrompt = true;
    if (hadDraft) {
      // ② 保留上次草稿：不写、不清，直接回初始界面（本次新填随内存现场丢弃）
      this._backToWorkbench();
      return;
    }
    // ① 无草稿：清空本次输入 + 清掉未结束会话标记（否则 OPEN_KEY 残留会让续盘检测再次命中）
    this.clearDraft();
    try { this._clearOpenSession(); } catch (e) { /* 忽略 */ }
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
  // ===== v228.32 季度盘点基线快照 =====
  // 为什么必须存在：季度盘点只盘「账上有量」的存货，而任务分派是按序号切段的。
  //   若直接拿当前全库存货当序号空间，① 存量 0 的编码白白占号；② 库存一有增减序号就整体漂移，
  //   今天分派的 1-100 明天就可能指向另一批编码（正是用户否掉的「今天一个量明天一个量」）。
  //   故：本轮开局对 stock 拍一张快照，剔除 0/空存量后连续重排，本轮之内恒定不变。

  // 「任一行 > 0 即纳入」聚合：空白 / null / ' ' / NaN / 0 一律剔除；负库存属异常但确实有账，纳入兜底。
  _buildBaselineCodes(stock) {
    const seen = new Set();        // 全库出现过的有效编码（去重）
    const nonZero = new Set();     // 至少有一行 现存数量 是有限非零数
    (stock || []).forEach(s => {
      const code = String(s.存货编码 == null ? '' : s.存货编码).trim();
      if (!code) return;
      seen.add(code);
      const n = parseFloat(s.现存数量);
      if (isFinite(n) && n !== 0) nonZero.add(code);
    });
    const cmp = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
    const codes = Array.from(seen).filter(c => nonZero.has(c)).sort(cmp);
    // 被剔除的 0 存量编码留档备查（本期不做 UI，仅随快照存下来）
    const zeroCodes = Array.from(seen).filter(c => !nonZero.has(c)).sort(cmp);
    return { codes, zeroCodes };
  },

  _baselineRoundKey(sheetId) {
    return String(sheetId || '') + '#r' + this._getRoundNo(sheetId);
  },
  // 🟢 v228.44（P1）：当前盘点区间对应的基线键（供轮询短路判断「本机是否已有本轮基线」）。
  //   取不到日期区间时返回 null → 调用方不做短路，退回原有下载逻辑（保守、不丢功能）。
  _currentBaselineRoundKey() {
    try {
      const sid = this._currentQuarterSheetId();
      if (!sid) return null;
      return this._baselineRoundKey(sid);
    } catch (e) { return null; }
  },
  _getBaselineMap() {
    try { return JSON.parse(localStorage.getItem(this.BASELINE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  },
  // 🟢 v228.44：云端「基线独立文件是否存在」的本地记忆（避免每轮开局都白探一次 404）。
  //   file   = 云端已有 baseline.json（本机写过或读到过非空）→ 优先读它，快且小；
  //   legacy = 云端尚无独立文件（旧版数据还在 settings.json）→ 直接走旧路径，零额外请求；
  //   负缓存带 TTL（10 分钟）到期后重新探一次，保证「别的设备先迁移了」也能被感知。
  BASELINE_FILE_STATE_KEY: 'wb_stocktake_baseline_file_state',
  BASELINE_FILE_NEG_TTL: 10 * 60 * 1000,
  _baselineFileState() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.BASELINE_FILE_STATE_KEY) || '{}') || {};
      if (raw.s === 'file') return 'file';
      if (raw.s === 'legacy' && Date.now() - (raw.t || 0) < this.BASELINE_FILE_NEG_TTL) return 'legacy';
    } catch (e) { /* 忽略 */ }
    return 'unknown';
  },
  _markBaselineFileState(s, moved) {
    try {
      const raw = JSON.parse(localStorage.getItem(this.BASELINE_FILE_STATE_KEY) || '{}') || {};
      raw.s = s; raw.t = Date.now();
      if (moved) raw.moved = 1;
      localStorage.setItem(this.BASELINE_FILE_STATE_KEY, JSON.stringify(raw));
    } catch (e) { /* 忽略 */ }
  },
  // 旧基线是否已从 settings.json 迁走（只需做一次）
  _baselineSettingsMoved() {
    try { return !!(JSON.parse(localStorage.getItem(this.BASELINE_FILE_STATE_KEY) || '{}') || {}).moved; }
    catch (e) { return false; }
  },
  _saveBaselineMap(map) {
    return this._lsWrite(this.BASELINE_KEY, JSON.stringify(map || {}));
  },
  // 云端拉取其他设备已生成的基线（本机已有则本机优先，绝不覆盖）
  // 🟢 v228.44（P1）：改读独立文件 baseline.json —— 不再为「每轮只读一次的静态基线」
  //   去下载 189KB 的 settings.json。兼容旧云端：独立文件为空时回退读 settings.json 里的
  //   旧基线（wb_stocktake_quarter_baseline），保证升级前已生成的基线不丢。
  async _pullQuarterBaseline(opts) {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return 0;
    // 🟢 v228.44（P1 核心降载）：**先判后拉** —— 本机已有「当前批次本轮」基线时直接跳过网络请求。
    //   旧实现是「先下载 182KB 再逐键判 local[k] 已存在则跳过」，即本机明明已有、仍为不变数据买单；
    //   3s 轮询 × 182KB ≈ 3.8MB/分钟/设备。改为先查本机、命中即短路（0 网络开销）。
    //   仅当本机**缺失**本轮基线时才真正下载（开局/换轮/换设备场景，一轮最多一次）。
    const curKey = (opts && opts.roundKey) || this._currentBaselineRoundKey();
    if (curKey) {
      const have = this._getBaselineMap()[curKey];
      if (have && Array.isArray(have.codes) && have.codes.length) return 0;
    }
    let rmap = null;
    // ① 优先：独立基线文件（已知云端没有时直接跳过，省掉一次 404 往返）
    if (this._baselineFileState() !== 'legacy') {
      try {
        if (typeof SyncManager.getBaseline === 'function') {
          const b = await SyncManager.getBaseline();
          if (b && typeof b === 'object' && Object.keys(b).length) {
            rmap = b;
            this._markBaselineFileState('file');
          } else {
            this._markBaselineFileState('legacy');   // 未迁移：本轮起走旧路径
          }
        }
      } catch (e) { rmap = null; }
    }
    // ② 兜底：旧版 settings.json 里的基线（升级兼容）
    // 🟢 v228.61（P0-A）：只读 BASELINE_KEY 一个键，不再读整包。
    if ((!rmap || !Object.keys(rmap).length) && typeof SyncManager.getSetting === 'function') {
      try {
        const old = await SyncManager.getSetting(this.BASELINE_KEY);
        if (old && typeof old === 'object') rmap = old;
      } catch (e) { /* 忽略 */ }
    }
    if (!rmap || typeof rmap !== 'object') return 0;
    const local = this._getBaselineMap();
    let n = 0;
    Object.keys(rmap).forEach(k => {
      const r = rmap[k];
      if (!r || !Array.isArray(r.codes) || !r.codes.length) return;
      if (local[k]) return;                 // 先写胜：同一轮的基线只认第一份
      local[k] = r; n++;
    });
    if (n) this._saveBaselineMap(local);
    return n;
  },
  // 推云端：读-合并-写（v227.67 同款防护，避免整包覆盖抹掉其他设备/其他轮次的基线）
  // 🟢 v228.44（P1）：改写独立文件 baseline.json（不再把 182KB 基线塞进 settings.json，
  //   否则每次 3s 轮询仍要为它买单）。离线/无该方法时回退原 settings 通道，保证不丢数据。
  async _setBaselineCloud(map) {
    let merged = Object.assign({}, map || this._getBaselineMap());
    try {
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
        if (typeof SyncManager.getBaseline === 'function') {
          const rb = await SyncManager.getBaseline();
          if (rb && typeof rb === 'object') merged = Object.assign({}, rb, merged);
        } else if (typeof SyncManager.getSetting === 'function') {
          // 🟢 v228.61（P0-A）：只读 BASELINE_KEY 一个键
          const rmap = await SyncManager.getSetting(this.BASELINE_KEY);
          if (rmap && typeof rmap === 'object') merged = Object.assign({}, rmap, merged);
        }
      }
    } catch (e) { /* 忽略，回退本机并集 */ }
    this._saveBaselineMap(merged);
    // 优先写独立文件
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.setBaseline === 'function') {
      try {
        const ok = await SyncManager.setBaseline(merged);
        if (ok) {
          this._markBaselineFileState('file');
          // 🟢 v228.44：首次迁移成功后，把 settings.json 里那份 181.9KB 的旧基线清空。
          //   不做这一步的话拆分等于白拆——轮询仍会下载 189KB 的 settings.json，降载收益归零。
          //   安全性：内容已在上方并入 merged 并写进 baseline.json，且 setBaseline 内部
          //   有「回读校验」确认写入生效；这里再确认一次云端独立文件里确实有这批键，才清。
          this._purgeLegacyBaselineInSettings(Object.keys(merged));
          return true;
        }
      } catch (e) { /* 落到下方 settings 兜底 */ }
    }
    await this._setCloud(this.BASELINE_KEY, merged);
  },
  // 🟢 v228.44：把 settings.json 里的旧基线清空（内容已迁至 baseline.json）。
  //   ——不清则降载收益为零（轮询仍要下 189KB），清了才是真正的 -96%。
  //   三重保护：①仅在云端独立文件确实已含这批键后才清；②失败/异常一律不动云端；
  //   ③只做一次（本地 moved 标记）；本机 localStorage 快照不受影响，功能不回归。
  async _purgeLegacyBaselineInSettings(expectedKeys) {
    if (this._baselineSettingsMoved()) return false;
    try {
      if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
      if (typeof SyncManager.getBaseline !== 'function' || typeof SyncManager.setSetting !== 'function') return false;
      const onFile = await SyncManager.getBaseline();
      if (!onFile || typeof onFile !== 'object') return false;
      const missing = (expectedKeys || []).filter(k => k !== '_updatedAt' && !onFile[k]);
      if (missing.length) return false;                 // 云端独立文件不全 → 保守不动
      // 🟢 v228.61（P0-A）：只读 BASELINE_KEY 一个键
      const old = await SyncManager.getSetting(this.BASELINE_KEY);
      if (!old || typeof old !== 'object' || !Object.keys(old).length) {
        this._markBaselineFileState('file', true); return false;
      }
      const ok = await SyncManager.setSetting(this.BASELINE_KEY, {});
      if (ok) this._markBaselineFileState('file', true);
      return !!ok;
    } catch (e) { return false; }
  },
  // 只读取：有就返回，没有就返回 null —— 绝不新建（供「有基线才收敛」的场景使用）
  _peekQuarterBaseline(sheetId) {
    const key = this._baselineRoundKey(sheetId);
    const b = this._getBaselineMap()[key];
    return (b && Array.isArray(b.codes) && b.codes.length) ? b : null;
  },
  // 取（必要时生成）本轮基线。已存在则原样返回 —— 这就是「快照不可变」的落点。
  async _ensureQuarterBaseline(sheetId, opts) {
    const sid = String(sheetId || '').trim();
    if (!sid) return null;
    const cached = this._peekQuarterBaseline(sid);
    if (cached && !(opts && opts.force)) return cached;
    if (!(opts && opts.force)) { try { await this._pullQuarterBaseline(); } catch (e) { /* 忽略 */ } }
    if (!(opts && opts.force)) {
      const got = this._peekQuarterBaseline(sid);
      if (got) return got;              // 云端已有 → 直接用，不再本地另拍
    }
    const key = this._baselineRoundKey(sid);
    const stock = await DataStore.getRows('stock');
    const { codes, zeroCodes } = this._buildBaselineCodes(stock);
    const ts = new Date().toISOString();
    const b = { key, sheetId: sid, round: this._getRoundNo(sid), codes, zeroCodes, createdAt: ts, updatedAt: ts };
    const map = this._getBaselineMap();
    map[key] = b;
    this._saveBaselineMap(map);
    try { await this._setBaselineCloud(map); } catch (e) { /* 离线入队，联网补推 */ }
    return b;
  },
  // 本轮季度盘点的序号锚点（编码数组，下标 0 = 序号 1）
  async _quarterBaselineCodes(sheetId) {
    try {
      const b = await this._ensureQuarterBaseline(sheetId);
      return (b && Array.isArray(b.codes)) ? b.codes : null;
    } catch (e) {
      console.warn('[stocktake] 取季度基线失败(已忽略):', e && e.message);
      return null;
    }
  },
  // 把已构建的行集收敛到本轮基线：剔除非基线编码，并把序号换成基线的连续序号。
  // 只读语义 —— 取不到基线就原样放行（等于旧行为），绝不在这里临时拍快照，
  // 否则「管理员已分派、本机首次进入」时会以本机当时库存生成一个不一致的锚点。
  async _applyBaselineRows(sheetId) {
    const b = this._peekQuarterBaseline(sheetId);
    const codes = b ? b.codes : null;
    if (!codes || !codes.length) return -1;
    const idx = new Map();
    codes.forEach((c, i) => idx.set(c, i + 1));
    const rows = [];
    (this.allRowsFull || []).forEach(r => {
      const no = idx.get(String(r.存货编码 == null ? '' : r.存货编码).trim());
      if (!no) return;
      r.no = no;
      rows.push(r);
    });
    rows.sort((a, b) => a.no - b.no);
    this.allRowsFull = rows;
    return rows.length;
  },

  // 全库存货编码升序（与 buildRows 同排序，保证多设备序号一致）
  // 🟢 v228.32：quarter 走「本轮基线」—— 剔除空白/0 存量后连续重排的序号空间，本轮内恒定。
  //   顺带修掉历史缺陷：原实现直接 map 全部 stock 行、没有去重，而 buildRows 是按编码聚合的，
  //   同一编码多行时这里的序号会与表格显示的序号错位（原 bug）。现统一去重后排序。
  async _allStockCodesSorted(sheetType) {
    if (sheetType === 'quarter') {
      const codes = await this._quarterBaselineCodes(
        this._currentQuarterSheetId() || this._quarterSheetId());
      if (codes && codes.length) return codes;
    }
    const stock = await DataStore.getRows('stock');
    const set = new Set();
    (stock || []).forEach(s => {
      const c = String(s.存货编码 == null ? '' : s.存货编码).trim();
      if (c) set.add(c);
    });
    return Array.from(set).sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)));
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
  // 🟢 v228.48-fix2：手动刷新 —— 从「只刷任务」升级为「一次点击，全量拉齐云端」。
  //
  //   用户诉求（真机实测提出）：
  //     「大家都是一个云端通道，另外一端为什么不直接从云端拉取下来？」
  //     「把刷新任务按钮附加一个刷新状态的功能，我点击就可以手动刷新，
  //       不只是刷新云端任务，还可以同时把云端保存的批次、状态和管理员视图监控
  //       盘点人进度等信息同步拉取下来。」
  //
  //   为什么原来做不到：并非通道不通，而是**自动拉取链路上有两个"死结"**，
  //   它们让云端数据虽然在本地、却始终套不进界面：
  //     死结① `_pullQuarterPickerLight()` 与 `_refreshQuarterPickerIfShown()` 开头都写着
  //             `if (this.sheet && this.sheet.sheetType === 'quarter') return false;`
  //           —— 只要本机"正处于盘点现场"，任何自动重渲一律短路返回。
  //           而手机端恰恰常常停在现场里 → 云端批次、概览全都拉下来了，界面一动不动。
  //     死结② `_pullBatchCommonState()` 的批次跟随规则①只清"批次被取代"的会话，
  //           若**旧批次已结束、新一轮尚未开盘**，云端锚点仍是旧 sheetId，
  //           手机端残留会话与之相同 → 判定"非陈旧" → 不清会话、不跟随，
  //           于是管理员结束了盘点，手机端继续显示"进行中"。
  //
  //   本方法的作用：**一个人工触发的、绕过上述全部守卫的确定性"强制对齐"入口。**
  //   它不是"再试一次"，而是明确告诉系统：现在，以云端为准。
  //
  //   ⚠️ 安全边界（守住，否则会误伤用户正在填的数据）：
  //     · 绝不丢弃当前录入：现场内刷新前先 `saveDraft()` 把已填数量落进本地草稿；
  //     · 绝不静默清历史职责：强制结束旧会话时，先核对云端「批次已结束」证据，
  //       无证据绝不清（避免把"本机正在盘"误判成"陈旧残留"）；
  //     · 只读不写：除本地缓存合并外，不向云端写任何业务数据。
  async refreshMyTasks(silent) {
    const btn = document.getElementById('stTaskRefresh');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 刷新中'; }
    try {
      if (typeof SyncManager !== 'undefined' && !SyncManager.isOnline) {
        if (!silent) this.toast('当前离线，无法从云端刷新；恢复连接后请再点一次');
        return;
      }
      // ① 现场保护：先把当前录入落进本地草稿，刷新绝不会丢已填数量
      const inSheet = !!(this.sheet && this.sheet.sheetId);
      if (inSheet) { try { this.saveDraft(); } catch (e) { /* 忽略 */ } }

      // ② 全量拉云端：批次身份 + 轮次号 + 结束闸门 + 轮次命名 + 批次号 + 任务 + 基线 + 概览
      let batchFollowed = false;
      try { batchFollowed = await this._pullBatchCommonState(); } catch (e) { /* 忽略 */ }
      let taskChanged = 0;
      try { taskChanged = await DataStore.pullStocktakeTasksFromCloud(); } catch (e) { /* 忽略 */ }
      let ovChanged = false;
      try { ovChanged = await this._pullQuarterOverviews(); } catch (e) { /* 忽略 */ }
      try { await this._pullRoundClosed(); } catch (e) { /* 忽略 */ }
      try { await this._pullQuarterBaseline(); } catch (e) { /* 忽略 */ }
      this._lastTaskSyncAt = Date.now();

      // ③ 清「已完成批次的残留会话」—— 解死结②。
      //    仅当云端存在与本机会话同 sheetId 的**结束证据**（ROUND_CLOSED 闸门）时才动手，
      //    且不清草稿（用户已填数量保留，可经盘点记录找回）。
      let sessionCleared = false;
      try {
        const sess = this._getOpenSession();
        if (sess && sess.sheetType === 'quarter' && sess.sheetId
            && this.isQuarterRoundClosed(sess.sheetId)) {
          this._clearOpenSession();
          sessionCleared = true;
          console.log('[stocktake] 手动刷新：批次 ' + sess.sheetId + ' 云端已结束，清除本机残留会话以对齐');
        }
      } catch (e) { /* 忽略 */ }

      // ④ 强制重渲 —— 解死结①。
      //    现场内（inSheet）也必须刷新：这里的语义是「把云端的任务/概览/状态套进当前界面」，
      //    不是把用户弹走。只有当批次身份真的变了（batchFollowed）才回到选择器，避免现场失联。
      let rerendered = false;
      try {
        const user = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? (AppConfig.getCurrentUser() || {}) : {};
        const counter = String(user.username || this.task.counter || '').trim();
        if (inSheet && !batchFollowed) {
          // 同批次现场：就地重渲任务表 + 进度条，用户停在原处，数据换成最新的
          try { this.renderTable(); } catch (e) { /* 忽略 */ }
          rerendered = true;
        } else {
          // 不在现场，或批次已被他端取代 → 走选择器重渲（会带上新批次身份与概览）
          if (batchFollowed) this._pendingBatchFollow = true;
          await this._refreshQuarterPickerIfShown();
          if (!rerendered) this._refreshTaskBar();
          rerendered = true;
        }
        // ⑤ 概览/监控区独立重渲一次 —— 管理员视图的盘点人进度就在这一块
        try { this._renderOverviewBlocksOnly(counter); } catch (e) { /* 忽略 */ }
      } catch (e) { console.warn('[stocktake] 刷新重渲失败(已忽略):', e && e.message); }

      // ⑥ 如实汇报这一次到底刷新到了什么（不夸大，用户才知道该不该再点）
      if (!silent) {
        const cnt = this._myOpenTaskCount();
        const aq = this._getActiveQuarter();
        const bits = [];
        if (taskChanged > 0) bits.push('任务 ' + taskChanged + ' 项变更');
        if (batchFollowed) bits.push('已跟随云端最新批次');
        if (ovChanged) bits.push('盘点进度已更新');
        if (sessionCleared) bits.push('已清除上一轮残留现场');
        const head = bits.length ? ('已从云端刷新：' + bits.join('、')) : '云端无新变更';
        this.toast(head + '；当前批次 ' + ((aq && aq.sheetId) || '未开盘')
                   + '，你有 ' + cnt + ' 个待办任务');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 刷新'; }
    }
  },

  /**
   * 🟢 v228.48-fix2：界面版「清场重置」—— 免开控制台。
   *
   *   背景（用户真机反馈原话）：
   *     「两边都没有办法清，你不能帮我清一下嘛」
   *     「电脑上这样也麻烦」
   *   旧方案的清场入口只有控制台命令 `await StocktakeModule.resetQuarterSyncState()`，
   *   要求用户在 PC 按 F12、在手机远程调试 —— 仓库现场根本做不到。
   *
   *   本方法把同一套语义（resetQuarterSyncState）接到界面上：
   *     · 权限门：仅具备分派权限者可见入口（与其它管理操作一致）；
   *     · 二次确认：明确列出会被清除的内容，并说明「已落库记录不受影响」；
   *     · 自动备份：resetQuarterSyncState 内部已写 backup 键，可回滚；
   *     · 收尾：清完直接回到工作台重新开局，不留半吊子状态。
   *
   *   ⚠️ 这是**破坏性操作**（清本机缓存，非清云端业务数据）。故：
   *     不自动调用、不放进常规流程，只在用户显式点击 + 确认后执行。
   */
  async resetFromUI() {
    try {
      const u = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? (AppConfig.getCurrentUser() || {}) : {};
      const can = !!(u && (u.isAdmin || u.role === 'admin' || (u.perms && u.perms.stocktakeAssign)));
      if (!can) { this.toast('无权限执行清场（需分派权限）'); return; }
    } catch (e) { /* 权限取不到则继续走确认弹窗 */ }

    let go = false;
    try {
      // 🟢 v228.65（用户反馈：弹窗太复杂）：精简为 3 句话（旧版同一句话重复出现两次）。
      go = await WBModal.confirm(
        '将清除所有设备的季度盘点进度：批次、轮次、任务分派、概览统计。\n\n' +
        '· 已盘的盘点记录保留，不会丢；\n' +
        '· 清场前自动备份，清错可回滚。\n\n' +
        '确定清场？清场后需重新开始新的季度盘点。',
        { title: '🧹 清场', okText: '确定清场', cancelText: '取消' });
    } catch (e) { return; }
    if (!go) return;

    try {
      // 🟢 v228.65：silent —— 上方确认框已明确告知后果，内部不再对「未结束现场」二次弹窗
      //   （用户反馈弹窗太多；会话保护仍由 _applyGlobalResetIfAny 的保守规则兜底）。
      const report = await this.resetQuarterSyncState({ silent: true });
      if (report && report.aborted) { this.toast('已取消清场'); return; }
      const n = (report && report.cleared && report.cleared.length) || 0;
      const errs = (report && report.errors) || [];
      this.toast(errs.length
        ? ('清场完成，但有 ' + errs.length + ' 项未清干净，建议再点一次')
        : ('✅ 已清场。现在回到「未开始季度盘点」的状态；要开始新一轮请再点【🗓️ 季度盘点】'));
      if (typeof App !== 'undefined' && App.go) App.go('stocktake');
    } catch (e) {
      this.toast('清场失败：' + (e && e.message ? e.message : '未知错误'));
    }
  },

  /**
   * 🟢 v228.49-fix3：跨端同步诊断 —— 真机排障用。
   *
   *   为什么需要它：前面几轮修复都在"猜"真机上到底断了哪一步，而开发者看不到用户设备。
   *   本方法把**两端一致性有关的全部关键事实**一次性摊开：在线状态、云端锚点、本机锚点、
   *   会话、结束闸门、任务与概览的数量和 key。管理员点一下就能把结论贴给开发者。
   *
   *   它不修改任何数据（只读），因此可以放心在盘点进行中点。
   */
  async syncDiagnose() {
    const out = { at: new Date().toISOString() };
    try {
      const online = !!(typeof SyncManager !== 'undefined' && SyncManager.isOnline);
      out.online = online;
      out.localActiveQuarter = this._getActiveQuarter();
      out.localSession = this._getOpenSession();
      out.localRoundClosed = this._getRoundClosed();
      try {
        const ov = this._getAllOverviews() || {};
        out.localOverviewKeys = Object.keys(ov);
      } catch (e) { out.localOverviewKeys = []; }
      try {
        const ts = DataStore.getStocktakeTasks() || {};
        out.localTaskCount = Object.keys(ts).length;
      } catch (e) { out.localTaskCount = -1; }

      // 云端侧
      out.cloudReadable = false;
      if (online && typeof SyncManager !== 'undefined' && typeof SyncManager.getSetting === 'function') {
        try {
          // 🟢 v228.61（P0-A）：诊断需要 5 个键 → 批量单键直读（5 请求），不再读整包（15 请求）。
          //   诊断面板本身是低频人工入口，但走的仍是同一条读取路径，一并根治。
          const keys = [this.ACTIVE_QUARTER_KEY, this.ROUND_CLOSED_KEY, this.OVERVIEW_KEY,
                        'stocktakeTasks', 'wb_stocktake_tasks'];
          if (typeof SyncManager.getSettingsKeys === 'function') {
            remote = await Promise.race([
              SyncManager.getSettingsKeys(keys),
              new Promise(res => setTimeout(() => res(null), 8000))
            ]);
          } else {
            remote = await Promise.race([
              SyncManager.getSettings(),
              new Promise(res => setTimeout(() => res(null), 8000))
            ]);
          }
          if (remote && typeof remote === 'object') {
            out.cloudReadable = true;
            out.cloudActiveQuarter = remote[this.ACTIVE_QUARTER_KEY] || null;
            out.cloudRoundClosed = remote[this.ROUND_CLOSED_KEY] || null;
            const cov = remote[this.OVERVIEW_KEY];
            out.cloudOverviewKeys = cov && typeof cov === 'object' ? Object.keys(cov) : [];
            // 🟢 v228.54：键名对齐 —— 任务实际写入键为 'stocktakeTasks'（db.js syncStocktakeTasksToCloud），
            //   旧诊断读 'wb_stocktake_tasks' 永远 miss → 显示 -1 误导排障。两个键名都兼容读。
            const ct = (remote['stocktakeTasks'] !== undefined) ? remote['stocktakeTasks'] : remote['wb_stocktake_tasks'];
            out.cloudTaskCount = ct && typeof ct === 'object' ? Object.keys(ct).length : -1;
          } else {
            out.cloudError = '云端返回空（settings 通道不可用或被 CDN 缓存）';
          }
        } catch (e) { out.cloudError = '读取云端异常：' + (e && e.message); }
      } else {
        out.cloudError = online ? 'SyncManager.getSettings 不可用' : '离线';
      }

      // 结论
      const lSid = (out.localActiveQuarter || {}).sheetId || null;
      const cSid = (out.cloudActiveQuarter || {}).sheetId || null;
      out.localSheetId = lSid;
      out.cloudSheetId = cSid;
      if (!out.cloudReadable) {
        out.verdict = '❌ 读不到云端 —— 本端无法跟随任何批次。先查：① 网络 ② 云端是否已连接（顶部状态）③ settings.json 是否可读';
      } else if (cSid && lSid && cSid !== lSid) {
        out.verdict = '❌ 批次分叉：本机 ' + lSid + ' ≠ 云端 ' + cSid + '。本机盘的数据会记在本机批次下，管理员看不到；管理员结束的也是云端那批，本机收不到。可用【强制对齐云端】修复。';
      } else if (cSid && !lSid) {
        out.verdict = '⚠️ 云端有批次但本机没有 —— 本机还没跟随，点【🔄 刷新】或重进【季度盘点】';
      } else if (!cSid) {
        out.verdict = 'ℹ️ 云端暂无批次锚点（尚未开盘，或锚点被清过）';
      } else {
        out.verdict = '✅ 两端批次一致：' + cSid;
      }
      const sessSid = (out.localSession || {}).sheetId || null;
      if (sessSid && cSid && sessSid !== cSid) {
        out.verdict += ' ｜ ⚠️ 本机残留会话绑定在另一批次 ' + sessSid + '（陈旧会话，会阻止跟随）';
      }
    } catch (e) {
      out.error = '诊断异常：' + (e && e.message);
    }
    return out;
  },

  /** 🟢 v228.49-fix3：把上面这份诊断渲染成人类可读的文本 */
  _syncDiagnoseText(d) {
    // 🟢 v228.65（用户反馈：弹窗信息太复杂）：只保留「结论 + 必要信息」，纯中文。
    //   技术明细（sheetId / 闸门项数 / 概览键数）移到 _syncDiagnoseDetailText，仅进控制台。
    const L = [];
    const same = d.cloudReadable && d.cloudSheetId && d.localSheetId === d.cloudSheetId;
    if (!d.online) {
      L.push('⛔ 当前离线，无法读取云端');
      L.push('请恢复网络后再试');
    } else if (!d.cloudReadable) {
      L.push('⛔ 读不到云端数据');
      L.push((d.cloudError ? '原因：' + d.cloudError : '请检查网络后重试'));
    } else if (same) {
      L.push('✅ 两端一致，同步正常');
      L.push('批次任务：本机 ' + d.localTaskCount + ' 个 / 云端 ' + d.cloudTaskCount + ' 个');
    } else if (d.cloudSheetId && !d.localSheetId) {
      L.push('⚠️ 云端已开始盘点，本机还没跟上');
      L.push('点下方「一键对齐」即可跟上，已盘记录不受影响');
    } else if (d.cloudSheetId) {
      L.push('⚠️ 本机与云端的批次不一致');
      L.push('这会导致：你盘的数据管理员看不到，管理员结束的你收不到');
      L.push('点下方「一键对齐」换到云端批次，已盘记录不受影响');
    } else {
      L.push('✅ 云端当前没有进行中的批次');
    }
    if (d.error) L.push('（异常：' + d.error + '）');
    return L.join('\n');
  },

  /** 🟢 v228.65：诊断的技术明细 —— 不再进弹窗，只进控制台（showSyncDiagnose 已 console.log）。 */
  _syncDiagnoseDetailText(d) {
    const L = [];
    const sid = x => (x && x.sheetId) ? x.sheetId : '（无）';
    L.push('同步诊断  ' + (d.at || ''));
    L.push('在线: ' + (d.online ? '是' : '否') + '  云端可读: ' + (d.cloudReadable ? '是' : '否' + (d.cloudError ? '（' + d.cloudError + '）' : '')));
    L.push('本机批次: ' + sid(d.localActiveQuarter));
    L.push('云端批次: ' + sid(d.cloudActiveQuarter));
    L.push('本机残留会话: ' + (d.localSession ? (sid(d.localSession) + '（' + (d.localSession.counter || '') + '）') : '无'));
    L.push('结束闸门 本机/云端: ' + Object.keys(d.localRoundClosed || {}).length + ' / ' + Object.keys(d.cloudRoundClosed || {}).length + ' 项');
    L.push('概览键 本机/云端: ' + (d.localOverviewKeys || []).length + ' / ' + (d.cloudOverviewKeys || []).length + ' 个');
    L.push('任务数 本机/云端: ' + d.localTaskCount + ' / ' + d.cloudTaskCount);
    L.push('结论: ' + (d.verdict || '—'));
    if (d.error) L.push('异常: ' + d.error);
    return L.join('\n');
  },

  /**
   * 🟢 v228.49-fix3：强制对齐到云端批次 —— 「已分叉」状态的急救。
   *
   *   与 resetFromUI（清场）的区别：
   *     · 清场 = 清成本机干净起点，两端都要重开；
   *     · 本方法 = **保留本机已盘记录**，只把「身份」换到云端批次，并清掉陈旧会话。
   *   适合「手机盘了一批、发现管理员看不到」时救数据：记录还在，重进即可被管理员看到。
   *
   *   ⚠️ 仅对齐身份，不动盘点记录；原批次记录仍在库中（按原 sheetId 存），
   *      如需并入云端批次，走盘点记录的历史查看。
   *
   * @param {boolean} [skipConfirm] 🟢 v228.65：跳过内部确认框。诊断弹窗已让用户点过
   *   「一键对齐」，再弹一次属于重复确认（用户反馈「诊断要点 2 次弹窗，麻烦」）；
   *   控制台直调等无确认入口时省略该参数，保留原确认。
   */
  async forceAlignToCloud(skipConfirm) {
    let d = null;
    try { d = await this.syncDiagnose(); } catch (e) { this.toast('诊断失败，无法对齐'); return; }
    if (!d || !d.cloudReadable || !d.cloudSheetId) {
      this.toast('读不到云端批次，无法对齐。请先恢复网络');
      return;
    }
    if (d.localSheetId === d.cloudSheetId) { this.toast('两端批次已一致，无需对齐'); return; }
    let go = true;
    if (!skipConfirm) {
      try {
        go = await WBModal.confirm(
          '本机批次：' + (d.localSheetId || '（无）') + '\n' +
          '云端批次：' + d.cloudSheetId + '\n\n' +
          '对齐会把本机的「批次身份」换成云端那一个，并清除绑定在旧批次上的残留会话。\n\n' +
          '· 已写入的盘点记录**保留**（仍按原批次存放，可在盘点记录里查看）；\n' +
          '· 之后本端盘的新数据会记在云端批次下 → 管理员视图能看到人和进度；\n' +
          '· 管理员结束云端批次时，本端也能收到。\n\n' +
          '确认对齐？',
          { title: '🔗 强制对齐云端批次', okText: '确认对齐', cancelText: '取消' });
      } catch (e) { return; }
    }
    if (!go) return;
    try {
      const aq = d.cloudActiveQuarter;
      this._saveActiveQuarter(aq);
      if (aq.sd && aq.ed) { this.query.startDate = aq.sd; this.query.endDate = aq.ed; }
      // 清陈旧会话（绑定在别的批次上）
      const sess = this._getOpenSession();
      if (sess && sess.sheetId && sess.sheetId !== aq.sheetId) this._clearOpenSession();
      this._pendingBatchFollow = true;
      this._setLastQuarterSheet(this.query.startDate, this.query.endDate);
      this.toast('已对齐到云端批次 ' + aq.sheetId + '，请重进【季度盘点】');
      if (typeof App !== 'undefined' && App.go) App.go('stocktake');
    } catch (e) {
      this.toast('对齐失败：' + (e && e.message ? e.message : '未知错误'));
    }
  },

  /** 🟢 v228.49-fix3：诊断面板入口（界面按钮） */
  async showSyncDiagnose() {
    this.toast('正在读取云端…');
    const d = await this.syncDiagnose();
    // 🟢 v228.65（用户反馈：诊断弹窗太复杂、夹杂英文 ID、点两次麻烦）：
    //   弹窗只给「结论 + 下一步」，完整技术明细仍 console.log 供排查。
    //   旧版流程 = confirm「是否对齐」→ forceAlignToCloud 内再 confirm「确认对齐」→
    //   同一件事要确认两次；现 forceAlignToCloud 支持 skipConfirm，一步到位。
    const txt = this._syncDiagnoseText(d);
    console.log('[stocktake] 同步诊断（明细）\n' + this._syncDiagnoseDetailText(d));
    try {
      const needAlign = d.cloudReadable && d.cloudSheetId && d.localSheetId !== d.cloudSheetId;
      if (needAlign) {
        // 🟢 v228.65：不再追加引导句 —— _syncDiagnoseText 里已经写了「点下方「一键对齐」…」，
        //   再补一句就是同一件事说两遍（实机抓到文案重复，正是「太复杂」的观感来源）。
        const go = await WBModal.confirm(txt,
          { title: '🩺 诊断', okText: '一键对齐', cancelText: '关闭' });
        if (go) { await this.forceAlignToCloud(true); return; }
      } else {
        await WBModal.alert(txt, { title: '🩺 诊断' });
      }
    } catch (e) {
      this.toast(txt.split('\n').slice(-1)[0] || '诊断完成（详见控制台）');
    }
  },

  /** 🟢 v228.48-fix2：本人当前批次的待办任务数（刷新反馈用，纯本地读取） */
  _myOpenTaskCount() {
    try {
      const my = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser)
        ? ((AppConfig.getCurrentUser() || {}).username || '') : String(this.task.counter || '')).trim();
      if (!my) return 0;
      const sd = this.query.startDate, ed = this.query.endDate;
      return (DataStore.getMyOpenTasks(my) || [])
        .filter(t => !t || this._taskInCurrentBatch(t, sd, ed)).length;
    } catch (e) { return 0; }
  },

  /**
   * 🟢 v228.48-fix2：只重渲「概览 / 已结束 / 管理员监控」三块，不动上方的「我的任务」区与标题栏。
   *   用途：手动刷新后让**管理员视图的盘点人进度**立即反映云端最新数字，而不重建整个 picker
   *   （重建会重置折叠状态、滚动位置，也会打断正在进行的操作）。
   *   实现：借助 _renderMyOverviewBlock / _renderAdminBatchBlock 已生成好的 DOM，按 id 就地替换；
   *   若当前不在 picker，则静默返回（交给 ④ 的整块重渲）。
   *
   *   🟢 v228.61（P0-A′ 修复空转）：
   *     本函数依赖 `#stMyOverviewBlock` / `#stAdminBatchBlock` 两个 id 定位 DOM，
   *     但这两个 id **此前从未写进 picker 的 innerHTML**（模板里是裸插值 ${overviewBlock}），
   *     于是 querySelector 永远 miss → 本函数一直等价于空操作，
   *     「刷新后管理员视图·盘点人进度就地更新」这个优化实际从未生效（一直是靠整块重渲兜的）。
   *     已在两个渲染函数的根 div 上补 id；此处同时补「块不存在时新建插入」的兜底：
   *     _renderMyOverviewBlock 在本批次无任务时会返回 ''（该块本就不该显示），
   *     但返回非空而 DOM 缺失（如管理员视图刚被打开）时应能补上，而不是静默丢弃。
   */
  _renderOverviewBlocksOnly(counter) {
    try {
      const area = document.getElementById('stArea');
      if (!area) return false;
      if (area.getAttribute('data-st-view') !== 'quarter-picker') return false;
      const ctx = this._pickerCtx;
      if (!ctx) return false;
      const sheetId = ctx.sheetId;
      const sd = ctx.sd, ed = ctx.ed;
      const allTasks = DataStore.getStocktakeTasks() || {};
      const sameBatchAll = Object.keys(allTasks).map(k => allTasks[k])
        .filter(t => this._taskInCurrentBatch(t, sd, ed));
      const blocks = [
        { id: 'stMyOverviewBlock', html: this._renderMyOverviewBlock(counter, ctx.batchNo, sheetId, sd, ed) },
        { id: 'stAdminBatchBlock', html: this._renderAdminBatchBlock(sheetId, sd, ed, counter, sameBatchAll, ctx.batchNo) }
      ];
      let touched = 0;
      blocks.forEach(b => {
        if (!b.html) return;
        const tmp = document.createElement('div');
        tmp.innerHTML = b.html;
        const nu = tmp.firstElementChild;
        if (!nu) return;
        const cur = area.querySelector('#' + b.id);
        if (cur) { cur.replaceWith(nu); touched++; }
      });
      return touched > 0;
    } catch (e) { return false; }
  },
  // 仅设置数据（不渲染），供自动领用复用
  _setAssignedRows(task, codesOverride) {
    // 🟢 v228.41（优化项-4）：支持 codesOverride —— 多段任务合并成一行展示后，
    //   点该行「进入盘点」应载入该盘点人「全部段」的编码，而非仅首个 taskId 的那一段。
    const codes = (codesOverride && codesOverride.length ? codesOverride : (task.codes || [])).filter(Boolean);
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
  // 🟢 v228.41（优化项-4）：某盘点人在本批次的「全部段」编码合集（去重、按顺序）——
  //   供合并行「进入盘点」一次性载入全部区间，避免合并展示后又只盘到一段。
  _codesForCounterSegments(counter, sd, ed) {
    const out = [];
    const seen = new Set();
    const all = DataStore.getStocktakeTasks() || {};
    Object.keys(all).map(k => all[k])
      .filter(t => t && t.counter === counter && this._taskInCurrentBatch(t, sd, ed))
      .sort((a, b) => (a.noStart || 0) - (b.noStart || 0))
      .forEach(t => (t.codes || []).forEach(c => { if (c && !seen.has(c)) { seen.add(c); out.push(c); } }));
    return out;
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
   * 🟢 v227：进入盘点模块时，若有新分派给自己的季度盘点任务 → 轻提示。
   * 🟢 v228.35（P12）：模态弹窗改 toast。
   *   旧版每批新任务都弹一个必须点「确定」的模态框 —— 管理员连续给 5 个人分派就要点 5 次，
   *   而"有人给你分派了任务"本身并不是需要用户决策的事（任务卡片上已经能看到），
   *   用模态打断是过度打扰。改为 4 秒自动消失的 toast，信息量不减。
   */
  _notifyNewTasks() {
    try {
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

      const total = fresh.reduce((n, t) => n + ((t.codes || []).length || Math.max(0, (t.noEnd - t.noStart + 1))), 0);
      const brief = fresh.length === 1
        ? `序号 ${fresh[0].noStart}-${fresh[0].noEnd} · ${(fresh[0].codes || []).length || ''} 项`
        : `${fresh.length} 个任务 · 共 ${total} 项`;
      this.toast('🔔 你有新的季度盘点任务（' + brief + '），请在「我的任务」中进入盘点');
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
        '· 点【暂存并退出】= 暂停，数据只存本地草稿（不计入盘点记录），下次可继续；\n' +
        '· 全部盘完请点【结束本次盘点】才算完成，并写入盘点记录、同步云端。',
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
    // 🟢 v228.68：我的任务必须限定当前批次 —— getMyOpenTasks 只按「本人+open」过滤，
    //   旧批次遗留任务会永久挂在「我的任务」里（结束盘点/开下一轮都清不掉的直接病灶之一）。
    const myTasks = counter
      ? (DataStore.getMyOpenTasks(counter) || []).filter(t => this._taskInCurrentBatch(t, sd, ed))
      : [];
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

  // 🟢 AUDIT-228-03（v228.18）：localStorage 写入失败「可见化」工具。
  //   原实现一律 catch(e){/* 忽略 */}，配额超限 / 隐私模式 / 存储被禁时，
  //   待补推队列写不进去而调用方浑然不知（UI 仍提示「已存本地待补推」），
  //   联网后 retryPendingSync 找不到待推 id → 盘点数据永久停留在本地、永不补推云端。
  //   这里统一：留 console.error + 返回布尔值 + 可选 Toast；成功路径行为不变。
  _lsWrite(key, value, opt = {}) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      const msg = '[stocktake] 本地存储写入失败（' + key + '）：' + (e && (e.message || e.name || e));
      console.error(msg);
      if (opt.toast) {
        const t = typeof opt.toast === 'string' ? opt.toast : '本地存储写入失败，数据可能无法自动补推到云端';
        try { this.toast('⚠️ ' + t); } catch (_) {}
      }
      return false;
    }
  },

  _saveOverviews(map) {
    return this._lsWrite(this.OVERVIEW_KEY, JSON.stringify(map || {}));
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
    return this._lsWrite(this.CLOUD_Q, JSON.stringify(arr || []));
  },
  // 入队（同 key 只保留最新一份，避免堆积）
  // 🟢 AUDIT-228-03：写失败时返回 false，让调用方能据此改提示文案（不再假装入队成功）
  _enqueueCloud(key, value) {
    try {
      const q = this._getCloudQueue();
      const i = q.findIndex(x => x.key === key);
      const item = { key, value, ts: Date.now() };
      if (i >= 0) q[i] = item; else q.push(item);
      return this._saveCloudQueue(q);
    } catch (e) {
      console.error('[stocktake] 云端推送入队失败（' + key + '）：', e && (e.message || e));
      return false;
    }
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
            // 🟢 v228.61（P0-A）：只读该键
            const rmap = await SyncManager.getSetting(this.ROUND_CLOSED_KEY);
            if (rmap && typeof rmap === 'object') value = Object.assign({}, rmap, value);
          } catch (e) { /* 忽略 */ }
        }
        // 🟢 v228.45：任务队列项同理 —— 离线期间攒下的任务，回放时若直接整包覆盖，
        //   会抹掉「离线窗口内对端（在线设备）已分派/已结束」的任务，造成「回放反而丢任务」。
        //   规则与在线路径一致：先拉云端合并（updatedAt 较新者胜 + 墓碑），再整包推并集。
        if (it.key === 'stocktakeTasks' && value && typeof value === 'object') {
          try {
            await DataStore.pullStocktakeTasksFromCloud();
            value = DataStore._tasksRaw();
          } catch (e) { /* 合并失败则退回原值，仍尽力推送 */ }
        }
        // 🟢 v228.45：当前批次区间（ACTIVE_QUARTER_KEY）也是聚合态 —— 回放时以「较新者胜」，
        //   避免离线旧值覆盖对端刚切换的新批次。
        if (it.key === this.ACTIVE_QUARTER_KEY && value && typeof value === 'object') {
          try {
            // 🟢 v228.61（P0-A）：只读该键
            const ra = await SyncManager.getSetting(this.ACTIVE_QUARTER_KEY);
            const vTs = Date.parse((value && value.updatedAt) || '') || 0;
            const rTs = Date.parse((ra && ra.updatedAt) || '') || 0;
            if (ra && rTs > vTs) value = ra;   // 云端更新 → 丢弃本机陈旧项
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
    // 🟢 v228.51（P0 读解耦）：浏览器未明确离线即允许拉取，避免移动端 isOnline 误判冻结同步
    const _online = (typeof SyncManager === 'undefined') ? false
      : (SyncManager.isOnline || (typeof navigator !== 'undefined' && navigator.onLine !== false));
    if (!_online) return false;
    if (typeof SyncManager.getSetting !== 'function') return false;
    try {
      // 🟢 v228.61（P0-A）：只读 OVERVIEW_KEY / ROUND_CLOSED_KEY 两个键，不再读整包。
      //   本方法在 _pollOnce 里每轮都被调用，是读放大的主要贡献者之一。
      let rmap, rcMap;
      if (typeof SyncManager.getSettingsKeys === 'function') {
        const got = await SyncManager.getSettingsKeys([this.OVERVIEW_KEY, this.ROUND_CLOSED_KEY]);
        rmap = got[this.OVERVIEW_KEY] || null;
        rcMap = got[this.ROUND_CLOSED_KEY] || null;
      } else {
        const remote = await SyncManager.getSettings();
        rmap = (remote && remote[this.OVERVIEW_KEY]) || null;
        rcMap = (remote && remote[this.ROUND_CLOSED_KEY]) || null;
      }
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
        // 同步批次结束标记 —— 🟢 v228.33：本地 closed 记录优先（localRc 在后），
        //   云端只「增补」未结束轮次，绝不把本机已结束的批次覆盖回「进行中」（修复更新后重进被云拉回进行中）。
        // 🟢 v228.61：rcMap 已在函数开头随 OVERVIEW_KEY 一并读出，此处不再二次读云端。
        if (rcMap && typeof rcMap === 'object') {
          const localRc = this._getRoundClosed();
          const mergedRc = Object.assign({}, rcMap, localRc);
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
        const data = ev && ev.data;
        // 🟢 v228.39（P4）：冻结协议 —— 管理员结束本轮前广播 freeze，
        //   打开中的盘点表收到后 flush 草稿 + 锁输入，避免「正在输入未失焦」的最后一条草稿丢失。
        if (data && data.type === 'freeze') { try { await this._onRemoteFreeze(data); } catch (e) {} return; }
        // 🟢 v228.39（P4）：本端已被冻结且管理员已结束本轮 → 锁定横幅切换为「已结束」
        if (data && data.type === 'overviewUpdated' && data.forceClosed && this._frozen) {
          try { this._onRoundForceClosed(data); } catch (e) {}
          return;
        }
        // 🟢 v228.45：任务变更广播 —— 同浏览器另一标签分派/认领/放弃/结束任务后，
        //   本标签立即重渲（无需等 3s 轮询）。任务数据在 localStorage，两标签共享同一份，
        //   故先拉云端合并（在线时）再重渲。
        if (data && data.type === 'tasksUpdated') {
          try { if (typeof DataStore !== 'undefined' && DataStore.pullStocktakeTasksFromCloud) await DataStore.pullStocktakeTasksFromCloud(); } catch (e) {}
          this._schedulePickerRefresh();
          return;
        }
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
          // 🟢 v228.45：任务表 / 当前批次区间变更也要触发重渲 ——
          //   否则同浏览器另一标签分派了任务、切换了批次，本标签完全无感（只能等 3s 轮询）。
          //   注意：wb_stocktake_tasks 由 DataStore 写入，storage 事件只在「其他标签」触发，
          //   写标签自身不会收到，故不会造成自触发死循环。
          //   一次任务变更可能同时改动 wb_stocktake_tasks 与哨兵键（→ 触发 2 次），
          //   故统一走防抖调度 _schedulePickerRefresh，避免重复拉云端与重复重渲。
          if (ev && (ev.key === 'wb_stocktake_tasks' || ev.key === this.ACTIVE_QUARTER_KEY
                     || ev.key === this.NO_MAP_KEY || ev.key === this.ROUND_NO_KEY
                     || ev.key === this.ROUND_LABEL_KEY || ev.key === 'wb_stocktake_tasks_bcast')) {
            this._schedulePickerRefresh();
          }
          // 🟢 v228.39（P4）：freeze 的 storage 兜底（BroadcastChannel 不支持时的跨标签触发）
          if (ev && ev.key && ev.key.indexOf('wb_stocktake_freeze_') === 0) {
            const sid = ev.key.replace('wb_stocktake_freeze_', '');
            try { this._onRemoteFreeze({ sheetId: sid }); } catch (e) {}
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

  /** 🟢 v228.45：picker 重渲防抖调度 —— 一次任务变更常伴随多个 storage 键变化
   *  （wb_stocktake_tasks + 哨兵键 + 批次号键），逐次触发会重复拉云端（2 个网络请求/次）。
   *  合并到 120ms 窗口内的最后一次执行，既保证即时性又避免抖动风暴。 */
  _schedulePickerRefresh() {
    try {
      if (this._pickerRefreshTimer) clearTimeout(this._pickerRefreshTimer);
      this._pickerRefreshTimer = setTimeout(() => {
        this._pickerRefreshTimer = null;
        try { this._refreshQuarterPickerIfShown(); } catch (e) { /* 忽略 */ }
      }, 120);
    } catch (e) { /* 忽略 */ }
  },

  // 🟢 v228.39（P4）：广播冻结 —— 同浏览器多标签走 BroadcastChannel，并写 storage 键做跨标签兜底
  _broadcastFreeze(sheetId, sd, ed) {
    try {
      if (this._overviewChannel) this._overviewChannel.postMessage({ type: 'freeze', sheetId: sheetId, startDate: sd, endDate: ed, at: Date.now() });
    } catch (e) { /* 忽略 */ }
    try { localStorage.setItem('wb_stocktake_freeze_' + sheetId, JSON.stringify({ at: Date.now() })); } catch (e) {}
  },

  // 🟢 v228.39（P4）：接收管理员的冻结广播 —— flush 草稿 + 锁输入 + 横幅，防末条草稿丢失
  async _onRemoteFreeze(payload) {
    try {
      const sid = payload && payload.sheetId;
      if (!sid) return;
      // 仅命中「当前正在盘的同一批次」才响应；兼容 sheetId 为 null（早期任务未回填）时用区间兜底
      if (!this.sheet || this.sheet.sheetType !== 'quarter' || this.sheet.sheetId !== sid) {
        const psd = payload.startDate, ped = payload.endDate;
        if (!(psd && ped && this.sheet && this.sheet.sheetType === 'quarter' &&
              this.sheet.startDate === psd && this.sheet.endDate === ped)) return;
      }
      // 先 flush 当前在输入/内存中的草稿（saveDraft 为同步）
      try { this.saveDraft(); } catch (e) { /* 忽略 */ }
      if (this._frozen) return;
      this._frozen = true;
      this._applyFreezeLockUI();
      this.toast('本轮盘点已被管理员锁定，进度已自动保存');
    } catch (e) { /* 忽略 */ }
  },

  // 🟢 v228.39（P4）：锁定录入表（禁用输入 + 顶部横幅）
  _applyFreezeLockUI() {
    try {
      const area = document.getElementById('stArea');
      if (!area) return;
      area.querySelectorAll('input.st-qty, input.st-note').forEach(el => { el.disabled = true; el.style.opacity = '0.6'; });
      let banner = document.getElementById('stFreezeBanner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'stFreezeBanner';
        area.insertBefore(banner, area.firstChild);
      }
      banner.style.cssText = 'padding:10px 14px;margin-bottom:10px;background:var(--status-warning-bg,#fff7ed);border:1px solid var(--border-color,#fdba74);color:var(--status-warning,#9a3412);border-radius:8px;font-size:13px;';
      banner.innerHTML = '⚠️ 管理员正在结束本轮盘点，已自动保存你的进度，盘点已锁定，请稍候…';
    } catch (e) { /* 忽略 */ }
  },

  // 🟢 v228.39（P4）：管理员结束完成后，把锁定横幅切换为「已结束」
  _onRoundForceClosed(data) {
    try {
      if (!this.sheet || this.sheet.sheetId !== (data && data.sheetId)) return;
      const banner = document.getElementById('stFreezeBanner');
      if (banner) banner.innerHTML = '✅ 本轮盘点已结束，进度已保存。可返回【季度盘点】查看归档。';
    } catch (e) { /* 忽略 */ }
  },


  /** 如果当前在季度任务选择器（picker），按最新数据重渲（不刷新整个模块） */
  async _refreshQuarterPickerIfShown() {
    try {
      const area = document.getElementById('stArea');
      if (!area) return false;
      // 🟢 v228.36：改用结构标记判定（旧的正则文案全库不存在 → 恒 false，重渲失效）
      const inPicker = area.getAttribute('data-st-view') === 'quarter-picker';
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
      // 🟢 v228.36：改用结构标记判定（旧的正则文案全库不存在 → 恒 false，轻量重渲从未生效）
      if (area.getAttribute('data-st-view') !== 'quarter-picker') return false;
      // 🟢 v227.16 修复：原 `:hover` 守卫会让「鼠标停在盘点区域」时 8s 轮询永远跳过重渲，
      //    导致结束/保存后的概览迟迟不刷新（用户最需要时反而不工作）。改为仅「最近 1.2s 内有
      //    点击/键盘交互」才跳过重渲，避免点按钮瞬间 DOM 重建使点击落空，其余时刻正常刷新。
      // 🟢 v228.47：但「跨端切换了批次」属于必须立即生效的变更 —— 此时用户的停留不该成为阻碍，
      //    否则 PC 端会停在旧批次上一直显示"暂无任务"（线上复现）。该场景强制穿透交互守卫。
      const forceByBatchFollow = !!this._pendingBatchFollow;
      if (forceByBatchFollow) this._pendingBatchFollow = false;
      if (this._pickerInteracting && !forceByBatchFollow) return false;
      // 🟢 v227.8：轮询重渲也要锚定未结束会话，否则跨天后 picker 会漂到新区间（与 startQuarter 不一致）
      this._anchorRangeToOpenSession();
      // 🟢 v228.48：跟随云端「当前批次身份」—— 管理员在另一端开了新批次后，
      //   本端必须跟着落到同一个 sheetId，否则 _taskInCurrentBatch 过滤基准不同 → 各论各的。
      //   实现已大幅简化：批次身份不是本机日期推导值，云端锚点就是唯一权威，
      //   因此不再需要「本机是否有权威背书」那类判定，只在有未结束现场时不打断用户。
      try {
        const sess0 = this._getOpenSession();
        if (!(sess0 && sess0.sheetType === 'quarter')) {
          const aq = this._getActiveQuarter();
          if (aq && aq.sheetId) {
            if (aq.sd && aq.ed) { this.query.startDate = aq.sd; this.query.endDate = aq.ed; }
          }
        }
      } catch (e) { /* 忽略 */ }
      this._ensureDefaultRange();
      const sd = this.query.startDate, ed = this.query.endDate;
      const sheetId = this._currentQuarterSheetId() || this._quarterSheetId();
      const counter = String(((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser)
        ? ((AppConfig.getCurrentUser() || {}).username || '') : '') || this.task.counter || '').trim();
      const allTasks = DataStore.getStocktakeTasks() || {};
      // 🟢 v228.68：我的任务必须限定当前批次 —— getMyOpenTasks 只按「本人+open」过滤，
    //   旧批次遗留任务会永久挂在「我的任务」里（结束盘点/开下一轮都清不掉的直接病灶之一）。
    const myTasks = counter
      ? (DataStore.getMyOpenTasks(counter) || []).filter(t => this._taskInCurrentBatch(t, sd, ed))
      : [];
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
   * picker 打开时启动轮询；离开 picker 时清掉。
   * 🟢 v227.5+：不再由 isOnline 门控 —— 离线/弱网（仓库常态）也要能靠本地数据刷新；
   *   在线时额外拉云端，离线时跳过云端只做本地重渲。
   * 🟢 v228.35（P3）：固定 8s 改为「按页面可见性分级 + 切回前台立即刷新」。
   *   问题：仓库里管理员常常是「一边看监控一边打电话催人」，8 秒滞后足以让他误判对方没在盘；
   *        而页面切到后台时 8s 定时器又纯属耗电耗流量。
   *   方案：可见时 POLL_VISIBLE_MS（3s）高频轮询，隐藏时 POLL_HIDDEN_MS（30s）保活即可，
   *        并在 visibilitychange 回到前台时立即补一次，避免用户切回来还看到旧数字。
   */
  POLL_VISIBLE_MS: 3000,
  POLL_HIDDEN_MS: 30000,
  /**
   * 🟢 v228.51（P0 根治「移动端收不到 PC 端操作」）：
   *   旧版轮询仅 picker 打开时存在，手机切后台/锁屏后 OS 挂起定时器 → 同步停摆，只能靠手动刷新。
   *   改为**应用级常驻守护**：进入季度盘点即启动（单例），前台 3s、后台 30s；并在「切回前台」
   *   时立即补拉一次（移动端后台定时器被挂起，这是找回一致性的关键），不再依赖 picker 是否打开。
   *
   * 🟢 v228.64（P1-2 提速）：前台周期 3000 → 1500。
   *   实测（docs/季度盘点同步链路实机走查报告.md）端到端 13.8~14.3s，其中轮询等待占 1.5s（均值半周期），
   *   CDN 回源占 3~10s 是大头、本地改不动；而轮询是**唯一能一行改动就吃到收益**的杠杆。
   *   代价（已核对）：_KEY_TTL_MS=2000 > 新周期 1500，同键不会被缓存吞掉，新鲜度有保证；
   *   请求量按「每轮 5 键 + 任务 + 概览」估算约 8 → 16 次/3s，本轮批量已走 getSettingsKeys 并发直读。
   *   若后续实测 CDN 成本不可接受，回退此常量即可（单点收口）。
   */
  SYNC_MS_VISIBLE: 1500,
  SYNC_MS_HIDDEN: 30000,
  // 🟢 v228.66(P2/C-4)：无活跃季度轮次时的「空闲」轮询间隔。
  //   非盘点期（没开盘）根本不需要 1.5s 实时收敛，降到 30s 即可——
  //   这能把「没开盘却一直开着应用」的后台读流量砍到约 1/20。
  SYNC_MS_IDLE: 30000,
  _globalSyncTimer: null,
  _globalSyncVisBound: false,
  _startGlobalSync() {
    if (this._globalSyncTimer) return;            // 单例，重复调用安全
    const self = this;
    // 🟢 v228.66(C-3/C-4)：轮询节奏随「页面可见性 + 是否有活跃季度轮次」动态变化：
    //   · 页面隐藏            → 30s（省电省流量）
    //   · 页面可见且无活跃轮次 → 空闲 30s（非盘点期几乎零消耗）
    //   · 页面可见且有活跃轮次 → 1.5s（实时收敛，保证对账双方视图同步）
    //   用「递归 setTimeout」替代 setInterval：每次 tick 都按最新状态重算间隔，
    //   轮次从「无→有」能立即提速（旧 setInterval 写法要等 visibilitychange 才重算，会滞后）。
    const period = () => {
      if (typeof document !== 'undefined' && document.hidden) return self.SYNC_MS_HIDDEN;
      const hasActiveRound = !!(self._currentQuarterSheetId());
      return hasActiveRound ? self.SYNC_MS_VISIBLE : self.SYNC_MS_IDLE;
    };
    const loop = () => {
      try { self._pollOnce(); } catch (e) { /* 忽略 */ }
      self._globalSyncTimer = setTimeout(loop, period());
    };
    self._globalSyncTimer = setTimeout(loop, 0);   // 立即拉第一次（0ms 后）
    if (!this._globalSyncVisBound) {
      this._globalSyncVisBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;              // 进后台不动
        try { self._pollOnce(); } catch (e) {}    // 回前台立即补拉对齐
        // 重新排一期，让间隔立即按「可见」重算（无论之前是隐藏还是空闲）
        if (this._globalSyncTimer) {
          clearTimeout(this._globalSyncTimer);
          this._globalSyncTimer = setTimeout(loop, period());
        }
      });
    }
  },
  // 🟢 v228.66(C-3)：停轮询要清得干净——setTimeout/setInterval 两种都清，
  //   避免切换写法后残留的定时器继续空转烧流量。
  _stopGlobalSync() {
    if (this._globalSyncTimer) {
      clearTimeout(this._globalSyncTimer);
      clearInterval(this._globalSyncTimer);
      this._globalSyncTimer = null;
    }
  },
  // 兼容旧调用点（picker 打开/重置/进表）：统一走常驻守护，不再各自起停轮询
  _startOverviewPolling() { this._startGlobalSync(); },
  /** 🟢 v228.35（P3）：单次轮询动作 —— 抽出来供定时器与「切回前台/关键动作」复用 */
  async _pollOnce() {
    try {
      // 🟢 v228.51（P0 读解耦）：移动端弱网下 SyncManager.isOnline 可能误判 false 而冻结同步；
      //   只要浏览器未明确离线（navigator.onLine!==false）就尝试拉云端，失败自然降级本地。
      const _canPull = (typeof SyncManager === 'undefined')
        ? false
        : (SyncManager.isOnline || (typeof navigator !== 'undefined' && navigator.onLine !== false));
      if (_canPull) {
        // 🟢 v228.64（P2）：标记新一轮 —— SyncManager 的单键缓存据此**按轮次失效**，
        //   保证每轮至少下网一次拿到最新值（旧版 TTL 纯时间判定实测会跨轮命中，
        //   表现为「隔轮才更新」）。
        // 🟢 v228.66(C-2)：廉价变更探测——list('settings') 拿各文件 updated_at（一次极小请求），
        //   与上一轮签名比对；全都没变就跳过本轮「重下载」，仅保留下方不下载的轻量动作。
        //   绝大多数轮次里没有任何端改动这些共享状态，却每 1.5s 把 ~15KB 的 8 个键 + 任务表重下一遍，
        //   正是轮询流量的大头。代价：其他端刚写入的变更可能因 list 元数据传播延迟（秒级）晚几秒才被本端看到，
        //   季度盘点对账场景完全可接受（C-2 已与用户确认）。
        //   安全网：每 8 轮（≈12s@1.5s）强制一次全读，杜绝 list 元数据偶发滞后导致的「永久看不到变更」。
        let skipHeavy = false;
        try {
          const meta = (typeof SyncManager !== 'undefined' && SyncManager.getSettingsMeta)
            ? await SyncManager.getSettingsMeta() : null;
          if (meta) {
            const sig = meta.map(m => (m.name || '') + ':' + (m.updated_at || '')).sort().join('|');
            const lastSig = this._pollSettingsSig;
            this._pollSettingsSig = sig;
            this._pollCount = (this._pollCount || 0) + 1;
            if (lastSig && lastSig === sig && (this._pollCount % 8) !== 0) skipHeavy = true;
          }
        } catch (e) { /* 探测失败不阻塞，照常全读 */ }
        this._pollSkip = skipHeavy;

        if (!skipHeavy) {
          try { if (typeof SyncManager.beginReadRound === 'function') SyncManager.beginReadRound(); } catch (e) { /* 忽略 */ }
          try {
            // 🟢 v228.40（一-1/一-3）：轮询也拉齐跨端共享状态（轮次/闸门/命名/批次号/任务），
            //   让「A 端结束或开下一轮」能实时传导到 B 端，两端视图持续收敛而非各说各话。
            //
            // 🟢 v228.61（去掉重复读）：本方法内部已经拉过「任务表」(⑤)，
            //   v228.64 补齐「概览」(⑦) —— 两处均改为复用内部结果（经
            //   this._lastCommonTaskChanged / this._lastCommonOverviewChanged），
            //   仅当内部那次被异常跳过时（字段为 null 哨兵）才补拉一次。
            this._lastCommonTaskChanged = null;
            this._lastCommonOverviewChanged = null;
            const commonChanged = await this._pullBatchCommonState();
            // 复用内部概览结果；为 null 说明 ⑦ 未执行（异常跳过）→ 补拉一次兜底
            let changed = this._lastCommonOverviewChanged;
            if (changed === null || changed === undefined) {
              changed = false;
              try { changed = await this._pullQuarterOverviews(); } catch (e) { /* 忽略 */ }
            }
            // 复用内部任务变更数；为 null 说明 ⑤ 未执行（异常跳过）→ 补拉一次兜底
            let taskChanged = this._lastCommonTaskChanged;
            if (taskChanged === null || taskChanged === undefined) {
              taskChanged = 0;
              try { taskChanged = await DataStore.pullStocktakeTasksFromCloud(); } catch (e) { /* 忽略 */ }
            }
            if (changed || commonChanged || taskChanged > 0) { try { await this._pullRoundClosed(); } catch (e) {} }
          } catch (e) { /* 忽略 */ }
        } else {
          // 跳过本轮重下载：把「变更哨兵」置为「无需补拉」，避免下方 if 误触发 _pullRoundClosed
          this._lastCommonTaskChanged = 0;
          this._lastCommonOverviewChanged = false;
          console.log('[盘点轮询] settings 未变更，跳过本轮重下载（省流量）');
        }
      }
      try { await this._applyGlobalResetIfAny(); } catch (e) { /* 忽略 */ }
      // 🟢 v228.74：每轮轮询顺带处理管理员的「远程结算」指令（盘点人端自动上传归档）。
      //   仅在本机有未结算的 settleReq 时才真正干活，否则幂等 no-op（混合轮询零额外开销）。
      try { await this._handleRemoteSettleAll(); } catch (e) { /* 忽略 */ }
      // 🟢 v228.54（分叉根治②③）：每轮轮询顺带——
      //   ① 锚点自愈：本机有锚点而云端确实没有时补推（离线开盘/写入失败后联网自动恢复）；
      //   2) 补推积压队列：_flushCloudQueue 原本只在 online 事件/picker 打开时触发，
      //      队列为空时开销为零，挂在常驻守护里让「写入失败入队」真正有兜底出口。
      try { await this._healActiveQuarterAnchor(); } catch (e) { /* 忽略 */ }
      try { if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) this._flushCloudQueue(); } catch (e) { /* 忽略 */ }

      // 🟢 v228.64（P0-1，修链路 4「盘点明细跨端不同步」）：
      //   旧版 pullCloudRecords() 全库唯一调用点是 render()（stocktake.js:93）——
      //   即「进模块那一刻拉一次，之后再不管」。后果：他人在盘点中产生的明细记录，
      //   本端在常驻轮询里**永远看不到**（实测静默观察 20 秒 / 6~7 个周期零感知），
      //   必须退出重进模块或点「🔄 刷新」。而主动调用只需 648ms 就能落地，纯属没接。
      //
      //   接入策略（刻意克制，不做无条件每轮拉）：
      //     · 全量拉 cost = 1 次 stocktake.json（1.6KB / ~490ms），本身不贵；
      //       但 pullStocktake → merge → 落库是**读改写**，高频会放大 Dexie 写压力。
      //     · 因此按「本机是否真的关心」条件触发，并降频到每 3 轮一次（≈4.5s@1500ms）。
      //     · 关心 = 本机在管理员/分派视图（要看所有人进度）或手上有 open 任务（别人补的盘我要看见）。
      try {
        this._recPollTick = (this._recPollTick || 0) + 1;
        if (this._recPollTick % 3 === 0 && this._needCloudRecords()) {
          await this.pullCloudRecords();
        }
      } catch (e) { /* 忽略 */ }

      // 无论在线与否都按最新本地数据重渲（分派任务/他人进度落在本地时同样生效）
      // 页面在后台时跳过：不可见时重渲纯属浪费，切回前台后下一轮会补上
      if (typeof document === 'undefined' || !document.hidden) {
        this._refreshQuarterPickerLight();
        // 🟢 v228.64（P0-1 配套）：__deleted 墓碑只由 pullCloudRecords 从**进模块那一刻**拉取，
        //   之后记录的删除也永远传不过来。轻量重渲无法表达「某条已盘记录消失了」，
        //   故在重渲之后补一次概览块重渲（它按 _saveOverviews 之后的本地数据算完成率）。
        try { this._renderOverviewBlocksOnly(this._myCounter()); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
  },

  /**
   * 🟢 v228.64：管理员 / 分派权限判定统一入口。
   *   旧版同一套语义在库里抄了 4 份（2129 行 inline IIFE、4678、4875、4925），
   *   4 份的写法还不完全一致（有的查 u.perms，有的查 AppConfig.getKeeperModules），
   *   任何一处漏改都会造成「某入口能分派、另一入口不能」的诡异权限不一致。
   *   本方法固定口径：isAdmin() 优先，其次查 keeper 的 stocktakeAssign 模块权限。
   *   ⚠️ 老账号（getKeeperModules 返回 null = 全开）按有权限处理，与 2129 行既有语义一致。
   */
  _hasAssignPerm() {
    try {
      if (typeof AppConfig === 'undefined') return false;
      const c = this._myCounter();
      if (!c) return false;
      if (typeof AppConfig.isAdmin === 'function' && AppConfig.isAdmin()) return true;
      const mods = typeof AppConfig.getKeeperModules === 'function' ? AppConfig.getKeeperModules(c) : null;
      if (!mods) return true;                                   // 老账号（全开）
      return mods.indexOf('stocktakeAssign') !== -1;
    } catch (e) { return false; }
  },

  /**
   * 🟢 v228.64（P0-1 配套）：本机本次登录账号（与 _refreshQuarterPickerLight 内保持一致的口径）。
   *   抽成方法是为了让 _pollOnce / _needCloudRecords 复用同一份取值逻辑，避免两处各写各的。
   */
  _myCounter() {
    try {
      const u = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? (AppConfig.getCurrentUser() || {}) : {};
      return String(u.username || this.task.counter || '').trim();
    } catch (e) { return String(this.task.counter || '').trim(); }
  },

  /**
   * 🟢 v228.64（P0-1 配套）：本机是否需要拉「盘点明细记录」（stocktake.json）。
   *   命中任一即需要：
   *     ① 管理员 / 有分派权限 —— 管理员视图要显示所有人的盘点进展与记录数；
   *     ② 本人有 open 任务 —— 别人可能在本机盘的同时补盘/删除记录，需感知。
   *   都不满足（普通盘点人、手上已完成）时返回 false —— 省掉每 4.5s 一次 dexie 读改写。
   */
  _needCloudRecords() {
    try {
      if (this._hasAssignPerm()) return true;
      const counter = this._myCounter();
      const tasks = DataStore.getStocktakeTasks() || {};
      const keys = Object.keys(tasks);
      // 有作业身份 → 只看自己的 open 任务（精确、省流量）
      if (counter) {
        return keys.some(k => {
          const t = tasks[k];
          return t && t.counter === counter && t.status === 'open';
        });
      }
      // 🟢 无作业身份（未登录 / getCurrentUser 取不到 username）→ 退化为「本机有任一 open 任务」。
      //   绝不能因为取不到账号就一律返回 false：那会让「已分派了任务、只是会话信息缺失」
      //   的设备彻底收不到他人记录，恰好是这条链路最该覆盖的场景。
      //   代价仅是这类设备多一次 1.6KB 的拉取（每 4.5s 一次），可接受。
      return keys.some(k => {
        const t = tasks[k];
        return t && t.status === 'open';
      });
    } catch (e) { return false; }
  },
  /**
   * 🟢 v228.35（P3）：关键动作后立即刷新一次（不等轮询周期）。
   *   结束盘点 / 放弃任务 / 放弃补盘 / 补派 / 强制结束 —— 这类动作管理员就在盯着看结果，
   *   等 3s（旧版 8s）才变好会让人怀疑没生效而重复点击。
   *   调用点：上述动作落库 + 广播之后。
   */
  async _refreshNowAfterAction() {
    try { await this._pollOnce(); } catch (e) { /* 忽略 */ }
  },
  _stopOverviewPolling() { /* 常驻守护不随 picker 关闭而停，保持后台持续同步 */ },

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
    return this._lsWrite(this.ROUND_CLOSED_KEY, JSON.stringify(map || {}));
  },
  isQuarterRoundClosed(sheetId) {
    if (!sheetId) return false;
    if ((this._getRoundClosed())[sheetId]) return true;
    // 🟢 v228.35（P5）：紧急/强制结束通道的兜底读取。
    //   正常路径走 ROUND_CLOSED_KEY（_setCloud 写入）。这里额外读 SyncManager 的**内存配置**快照，
    //   覆盖「本轮结束信号已下发、但盘点人端还没等到轮询/拉取」的窗口 —— 否则这段时间内
    //   盘点人仍能进入盘点（盘完却不生效），正是 P5 要消除的「显示能点、点了没用」。
    //   只读内存、不发网络请求，不引入新的 IO 依赖，纯属本地竞态兜底。
    try {
      if (typeof SyncManager !== 'undefined' && SyncManager.settings
          && typeof SyncManager.settings === 'object') {
        const cloud = SyncManager.settings[this.ROUND_CLOSED_KEY];
        if (cloud && typeof cloud === 'object' && cloud[sheetId]) return true;
      }
    } catch (e) { /* 忽略：兜底失败不影响主判断 */ }
    return false;
  },

  /**
   * 🟢 v228.74：远程自动结算 —— 等待盘点人手机收到 settleReq 指令并自动落库上传。
   *   回执 = 分派任务在云端 stocktake.json 的 tasks 里变为 closed。
   *   每 1.5s 拉一次云端任务表（KB 级），全部关闭或超时即返回；
   *   超时仍未关闭的交给后续兜底强制收尾（离线/锁屏设备由「延迟结算」在下次打开时自动补传）。
   */
  async _waitForSettleReceipts(sheetId, batchTasks, timeoutMs) {
    const openCount = () => batchTasks.filter(t => t && t.status !== 'closed').length;
    const startOpen = openCount();
    if (!startOpen) return { autoClosed: 0, stillOpen: 0 };
    this.toast('已通知 ' + startOpen + ' 位盘点人的手机自动上传数据，请稍候…');
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        if (typeof SyncManager === 'undefined' || !SyncManager.isOnline
            || typeof SyncManager.pullStocktake !== 'function') continue;
        const cloud = await SyncManager.pullStocktake();
        const tasks = (cloud && cloud.tasks) || {};
        batchTasks.forEach(t => {
          if (!t || t.status === 'closed') return;
          const ct = tasks[t.taskId];
          if (ct && ct.status === 'closed') t.status = 'closed';   // 回执：同步到内存，兜底收尾自然跳过
        });
        if (openCount() === 0) return { autoClosed: startOpen, stillOpen: 0 };
      } catch (e) { /* 单轮失败继续等 */ }
    }
    return { autoClosed: startOpen - openCount(), stillOpen: openCount() };
  },

  /**
   * 🟢 v228.74：盘点人端 —— 收到管理员的结算指令（roundClosed[sheetId].settleReq）后，
   *   本机自动把已盘数据落库并上传（增量：commit 内部按已盘编码去重，不会重复上传）。
   *   分三种情况：
   *     ① 本机正在盘（sheet 开着且同批次）→ flush 草稿后走 finishStocktake(auto) 全流程；
   *     ② 本机有未提交草稿（保存退出/离线错过指令）→ 草稿直接落库 + 关闭自己的任务作回执；
   *     ③ 无现场无草稿（已点过「结束本次盘点」）→ 什么都不做（数据早已在云端）。
   *   幂等：以 settleAt 为回执标记（localStorage），处理过一次不再重复；
   *         落库失败时不打标记 → 下一轮轮询自动重试。
   */
  async _handleRemoteSettle(sheetId) {
    try {
      const rc = (this._getRoundClosed() || {})[sheetId];
      if (!rc || !rc.settleReq) return false;
      const ackKey = 'wb_stocktake_settle_ack_' + sheetId;
      let acked = '';
      try { acked = localStorage.getItem(ackKey) || ''; } catch (e) {}
      if (acked && acked === String(rc.settleAt || '')) return false;

      const me = String(((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser)
        ? ((AppConfig.getCurrentUser() || {}).username || '') : '') || this.task.counter || '').trim();

      // ① 本机正在盘同一批次 → 走完整结束流程（auto 跳过确认弹窗）
      if (this.sheet && this.sheet.sheetType === 'quarter' && this.sheet.sheetId === sheetId) {
        try { this.saveDraft(); } catch (e) { /* 忽略 */ }
        await this.finishStocktake({ auto: true });
        try { localStorage.setItem(ackKey, String(rc.settleAt || '1')); } catch (e) {}
        return true;
      }

      // ②/③：无现场 —— 按草稿/任务决定是否补传
      const allTasks = DataStore.getStocktakeTasks() || {};
      const myTask = me ? Object.keys(allTasks).map(k => allTasks[k]).find(t =>
        t && !t.deleted && t.counter === me && t.sheetType === 'quarter'
        && (t.batchKey === sheetId || t.sheetId === sheetId)) : null;
      const draft = me ? this.loadDraft(me, sheetId) : null;
      const draftN = draft && draft.qty ? Object.keys(draft.qty).length : 0;

      if (myTask && myTask.status !== 'closed') {
        if (draftN > 0) {
          // 草稿直接落库（内部按已盘编码去重，成功后清草稿）
          try {
            const n = await this._commitCountingForTask(myTask, (draft.sheet && draft.sheet.batchNo) || '');
            console.log('[stocktake] 远程结算：草稿补录 ' + n + ' 条');
          } catch (e) { console.warn('[stocktake] 远程结算草稿补录失败(下一轮重试):', e && e.message); return false; }
        }
        // 关闭任务作为回执 + 推云端
        try {
          myTask.status = 'closed';
          myTask.sheetId = myTask.sheetId || sheetId;
          myTask.closedAt = myTask.closedAt || new Date().toISOString();
          myTask.updatedAt = new Date().toISOString();
          await DataStore.saveStocktakeTask(myTask);
          if (typeof SyncManager !== 'undefined' && SyncManager.isOnline
              && typeof SyncManager.syncStocktakeTasks === 'function') {
            try { await SyncManager.syncStocktakeTasks({ taskId: myTask.taskId, status: 'closed', sheetId: myTask.sheetId, closedAt: myTask.closedAt, updatedAt: myTask.updatedAt }); } catch (e) { /* 失败由补推队列兜底 */ }
          }
        } catch (e) { console.warn('[stocktake] 远程结算关任务失败(下一轮重试):', e && e.message); return false; }
        try {
          const sess = this._getOpenSession();
          if (sess && sess.sheetType === 'quarter' && sess.sheetId === sheetId) this._clearOpenSession();
        } catch (e) { /* 忽略 */ }
        this.toast('管理员已结束本轮，你已盘的数据已自动上传归档');
      } else if (draftN > 0) {
        // 无分派任务但有草稿（自主盘点场景）→ 仅落库记录
        try {
          const stock = await DataStore.getRows('stock');
          const stockMap = {};
          (stock || []).forEach(s => { stockMap[String(s.存货编码).trim()] = s; });
          const rows = Object.keys(draft.qty).map(code => {
            const s = stockMap[code] || {};
            return {
              存货编码: code, 存货名称: s.存货名称 || '', 规格型号: s.规格型号 || '',
              现存量: parseFloat(s.现存数量) || 0,
              盘点数量: draft.qty[code],
              入库量: s.入库量 || 0, 出库量: s.出库量 || 0,
              备注: (draft.remarks && draft.remarks[code]) || ''
            };
          });
          await this._commitRows(rows, {
            counter: me, sheetId: sheetId, batchNo: (draft.sheet && draft.sheet.batchNo) || '',
            sheetType: 'quarter', forceClosed: true
          });
          try {
            const sess = this._getOpenSession();
            if (sess && sess.sheetType === 'quarter' && sess.sheetId === sheetId) this._clearOpenSession();
          } catch (e) { /* 忽略 */ }
          this.toast('管理员已结束本轮，你已盘的数据已自动上传归档');
        } catch (e) { console.warn('[stocktake] 远程结算落库失败(下一轮重试):', e && e.message); return false; }
      }
      // ③ 无现场无草稿：什么都不做（已点过「结束本次盘点」的数据早已在云端）
      try { localStorage.setItem(ackKey, String(rc.settleAt || '1')); } catch (e) {}
      return true;
    } catch (e) { console.warn('[stocktake] 远程结算处理异常(已忽略):', e && e.message); return false; }
  },

  /** 🟢 v228.74：对本机已知的所有「要求结算」轮次逐一处理（幂等，供 render 延迟兜底调用） */
  async _handleRemoteSettleAll() {
    const rcMap = this._getRoundClosed() || {};
    const sids = Object.keys(rcMap).filter(k => rcMap[k] && rcMap[k].settleReq);
    for (const sid of sids) {
      try { await this._handleRemoteSettle(sid); } catch (e) { /* 单轮失败不影响其他 */ }
    }
  },

  // 🟢 v228.33：记住 / 读取「上次季度批次」（重进工作台优先落回）
  // 🟢 v228.48：同时记录批次身份 sheetId —— 现在它是权威身份，日期只是显示字段
  _setLastQuarterSheet(sd, ed) {
    try {
      if (!sd || !ed) return;
      const aq = this._getActiveQuarter();
      localStorage.setItem(this.LAST_QUARTER_SHEET_KEY, JSON.stringify({
        sd: sd, ed: ed,
        sheetId: (aq && aq.sheetId) || this._currentQuarterSheetId() || '',
        openedAt: (aq && aq.openedAt) || '',
        ts: new Date().toISOString()
      }));
    } catch (e) { /* 忽略 */ }
  },
  _getLastQuarterSheet() {
    try { return JSON.parse(localStorage.getItem(this.LAST_QUARTER_SHEET_KEY) || 'null'); } catch (e) { return null; }
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
      const local = JSON.parse(localStorage.getItem(this.ROUND_NO_KEY) || '{}') || {};
      let m = Object.assign({}, local);
      // 🟢 v228.38（P8）：推云端前先与远端「取最大」合并，杜绝落后设备把轮次抹回旧值。
      //   场景：A 已开到第 4 轮并同步，B 久未轮询（本地仍记第 2 轮）直接开轮 →
      //   若整图覆盖会把云端第 4 轮冲掉、回跳到第 3 轮。改为逐键取 max 后推送。
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.getSetting === 'function') {
        try {
          // 🟢 v228.61（P0-A）：只读 ROUND_NO_KEY 一个键
          const rm = await SyncManager.getSetting(this.ROUND_NO_KEY);
          if (rm && typeof rm === 'object') {
            Object.keys(rm).forEach(k => {
              const rv = parseInt(rm[k], 10), lv = parseInt(m[k], 10);
              if (!isNaN(rv) && (isNaN(lv) || rv > lv)) m[k] = rm[k];
            });
          }
        } catch (e) { /* 离线降级：用本地值继续 */ }
      }
      // 本批次取 max(远端/本地/本次目标)，确保不开倒车
      const cur = parseInt(m[sheetId], 10);
      if (isNaN(cur) || n > cur) m[sheetId] = n;
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

  // ---------------- 🟢 v228.37：轮次命名（展示层别名） ----------------
  _getRoundLabels() {
    try { return JSON.parse(localStorage.getItem(this.ROUND_LABEL_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  },
  // 取某批次某轮的命名；无命名或 round 已不匹配（开了更新轮次）→ null（调用方回退「第 N 轮」）
  _getRoundLabel(sheetId, roundNo) {
    if (!sheetId) return null;
    const it = this._getRoundLabels()[sheetId];
    if (!it || !it.label) return null;
    if (roundNo != null && it.round != null && String(it.round) !== String(roundNo)) return null;
    return String(it.label);
  },
  // 轮次显示文本：有命名显示命名，否则「第 N 轮」
  _roundDisplay(sheetId, roundNo) {
    return this._getRoundLabel(sheetId, roundNo) || ('第 ' + (roundNo || 1) + ' 轮');
  },

  /**
   * 🟢 v228.65：轮次徽标 HTML —— picker 与管理员视图共用的**唯一**渲染源。
   *
   *   为什么要抽出来：原先同样的三元表达式在 _renderQuarterTaskPicker 与
   *   _renderAdminBatchBlock 各写一遍，且都只判了 `roundClosed ? 已结束 : 进行中`，
   *   漏了「根本没有批次」这第三种状态 —— 清场后 sheetId 为空，roundClosed 自然是 false，
   *   于是界面显示「🟢 第 1 轮 · 进行中」，可实际上一轮都还没开。
   *   这正是用户截图里那行「第 1 轮 · 进行中」的来源（清场后仍显示，看着像没清干净）。
   *
   *   三态：无批次 = ⚪ 未开始；已结束 = ⛔ N 已结束；否则 = 🟢 N · 进行中。
   */
  _roundBadgeHtml(sheetId, roundClosed, roundNo, closedRound) {
    const escH = (s) => typeof esc === 'function' ? esc(s) : String(s);
    const base = 'margin-left:8px;font-size:12px;padding:2px 8px;border-radius:6px;';
    // 🟢 v228.65：以**本机权威批次**为准，而不是调用方传进来的 sheetId。
    //   实测坑：入参来自 _pickerCtx.sheetId，是上一次渲染留下的上下文；清场后
    //   _currentQuarterSheetId() 已是 null，pickerCtx 却仍攥着旧 sheetId →
    //   徽标照旧渲染成「🟢 第 1 轮 · 进行中」。本机都没确立批次，谈何「第几轮」。
    const sid = this._currentQuarterSheetId() || '';
    if (!sid) {
      return `<span style="${base}background:rgba(148,163,184,0.16);color:#64748b;">⚪ 未开始季度盘点</span>`;
    }
    if (roundClosed) {
      return `<span class="st-pill-error" style="${base}">⛔ ${escH(this._roundDisplay(sid, closedRound || roundNo))} 已结束</span>`;
    }
    return `<span class="st-pill-success" style="${base}">🟢 ${escH(this._roundDisplay(sid, roundNo))} · 进行中</span>`;
  },
  // 写命名（本地 + 云端合并写，防整包覆盖其他设备的命名）
  async _setRoundLabel(sheetId, roundNo, label) {
    if (!sheetId || !label) return;
    const m = this._getRoundLabels();
    m[sheetId] = { round: roundNo, label: String(label), namedAt: new Date().toISOString() };
    try { localStorage.setItem(this.ROUND_LABEL_KEY, JSON.stringify(m)); } catch (e) { /* 忽略 */ }
    try {
      let merged = m;
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.getSetting === 'function') {
        // 🟢 v228.61（P0-A）：只读 ROUND_LABEL_KEY 一个键
        const rm = await SyncManager.getSetting(this.ROUND_LABEL_KEY);
        if (rm && typeof rm === 'object') merged = Object.assign({}, rm, m);  // 本机最新命名优先
      }
      await this._setCloud(this.ROUND_LABEL_KEY, merged);
    } catch (e) { /* 离线降级：本地已存，下次在线时轮询/再命名会补推 */ }
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
    // 🟢 v228.74：幂等守卫 —— 已结束的轮次不允许重复结算（多端竞态/双击/其他端已操作的防护）。
    //   旧版无此守卫：另一端已紧急结束/已结算而本端界面未刷新时，可对已关闭轮次重复走结算。
    if (this.isQuarterRoundClosed(sheetId)) { this.toast('本轮已处于结束状态，无需重复结束'); return; }
    const batchNo = String(this.batchNo || sheetId);

    // 统计本批次 open / 进行中情况，确认提示
    const allTasks = DataStore.getStocktakeTasks() || {};
    const batchTasks = Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
      t && t.sheetType === 'quarter' && this._taskInCurrentBatch(t,
        (allTasks[sheetId] && allTasks[sheetId].startDate) || this.query.startDate,
        (allTasks[sheetId] && allTasks[sheetId].endDate) || this.query.endDate));
    const openCount = batchTasks.filter(t => t.status !== 'closed').length;
    const counters = Array.from(new Set(batchTasks.map(t => t.counter).filter(Boolean)));

    // 🟢 v228.74：确认文案 —— 明确「远程自动结算」的新行为：盘点人手机会收到指令后自动上传，
    //   未盘完的自动增量归档，已点过「结束本次盘点」的不受影响；联系不上的由延迟结算兜底。
    const ok = await WBModal.confirm(
      '结束本轮季度盘点（盘点号 ' + batchNo + '）？\n\n' +
      (openCount > 0
        ? '⚠️ 当前还有 ' + openCount + ' 个分派任务（含 ' + counters.length + ' 位盘点人）未结束。\n' +
          '  系统将通知这些盘点人的手机自动把已盘数据落库上传（约 3~10 秒/人）；\n' +
          '  已点过「结束本次盘点」的不受影响；届时仍联系不上的（锁屏/离线），\n' +
          '  将在其打开盘点时自动补传。\n\n'
        : '所有盘点人都已完成。\n\n') +
      '结束后本批次不可再进入盘点。是否继续？',
      { title: '结束本轮并归档', okText: '确定结束', cancelText: '取消' }
    );
    if (!ok) return;

    // 🟢 v228.39（P4）：冻结协议 —— 结束前广播 freeze，给打开中的盘点表留出 flush 草稿 + 锁输入的时间窗，
    // 避免「盘点人正在单元格输入、尚未失焦保存」的最后一条草稿来不及落库。跨设备仅靠云端收口兜底，
    // 同浏览器多标签则能在此窗口内同步保存。
    try {
      const fzSd = (allTasks[sheetId] && allTasks[sheetId].startDate) || this.query.startDate || '';
      const fzEd = (allTasks[sheetId] && allTasks[sheetId].endDate) || this.query.endDate || '';
      this._broadcastFreeze(sheetId, fzSd, fzEd);
    } catch (e) { /* 忽略 */ }
    await new Promise(r => setTimeout(r, 700));

    // 1) 标记 round closed（先写本地 + 推云端）—— 🟢 v227.12：记录被关闭的是第几轮
    // 🟢 v228.74：settleReq/settleAt = 远程自动结算指令 —— 盘点人手机轮询到该标记后
    //   自动把本机已盘数据落库上传（增量去重），任务 closed 即回执；settleAt 兼作幂等标记。
    const map = this._getRoundClosed();
    const closedInfo = { closedBy: c, closedAt: new Date().toISOString(), batchNo: batchNo,
                         round: this._getRoundNo(sheetId), settleReq: true, settleAt: new Date().toISOString() };
    map[sheetId] = closedInfo;
    // 🟢 v228.33：把当前未结束会话的 sheetId 也关上 —— 防止 _anchorRangeToOpenSession
    //   把 query 漂到旧日期后，结束标记写在「错」的 sheetId 下，导致重进仍显示「进行中」。
    try {
      const sess = this._getOpenSession();
      if (sess && sess.sheetType === 'quarter' && sess.sheetId && sess.sheetId !== sheetId) {
        map[sess.sheetId] = closedInfo;
      }
    } catch (e) { /* 忽略 */ }
    this._saveRoundClosed(map);
    // 🟢 v228.0（P0-1）：管理员结束整个批次 → 释放该批次的盘点号（下次同批次开局才启用 -2）
    this._markBatchFinished(sheetId);
    // 🟢 v227.67：合并式推送（不再整包覆盖），避免把其他设备已结束的轮次从云端抹掉
    try { await this._setRoundClosedCloud(sheetId, map[sheetId]); }
    catch (e) { console.warn('[stocktake] 批次结束标记推云端失败(已忽略):', e && e.message); }

    // 🟢 v228.74：远程自动结算 —— 等待盘点人手机收到 settleReq 指令并自动落库上传
    //   （回执 = 任务 closed；每 1.5s 拉一次云端任务表，KB 级；全部关闭提前返回）。
    //   超时仍未关闭的（锁屏/离线/杀后台）由下方兜底强制收尾 + 延迟结算补传。
    let autoClosed = 0;
    try {
      const w = await this._waitForSettleReceipts(sheetId, batchTasks, 15000);
      autoClosed = w.autoClosed || 0;
    } catch (e) { console.warn('[stocktake] 等待自动结算回执异常(已忽略):', e && e.message); }

    // 2) 强制收尾：所有 open 任务标 closed + 推云端（保留 createdAt，补 closedAt/updatedAt）
    //    🟢 v227.15（G4）：收口范围额外纳入 replenishAssigned 任务 —— 这类任务 status 已是 closed
    //    （v227.14 设计：保持 closed 以复用补盘模式），故原本被 `status!=='closed'` 排除，导致
    //    「管理员指派补盘后、盘点人已保存补盘草稿但未点结束、管理员又强制结束」时草稿不落库。
    //    纳入后：有草稿则补录、无草稿(_commitRows 去重幂等)则跳过，安全无副作用。
    const now = new Date().toISOString();
    const stillOpen = batchTasks.filter(t => t.status !== 'closed' || t.replenishAssigned);
    const toSaveTasks = [];
    // 🟢 AUDIT-228-02（v228.18）：用 Map 记录改动前的原始状态（不污染任务对象本身，
    //   避免给 Dexie 记录塞入临时字段），写回失败时据此回滚，杜绝「内存已 closed、库里仍 open」。
    const prevState = new Map();
    for (const t of stillOpen) {
      // 🟢 v227.13 P0-3：强制结束前，先落库该盘点人未结束的草稿进度（共享设备本机草稿可收口）
      try {
        const n = await this._commitCountingForTask(t, batchNo);
        if (n > 0) console.log('[stocktake] 强制结束补录 ' + n + ' 条（' + t.counter + '）');
      } catch (e) { console.warn('[stocktake] 强制结束补录失败(已忽略):', e && e.message); }
      prevState.set(t, { status: t.status, closedAt: t.closedAt, updatedAt: t.updatedAt });
      t.status = 'closed';
      t.sheetId = t.sheetId || sheetId;
      t.closedAt = now;
      t.updatedAt = now;
      toSaveTasks.push(t);
    }
    // 一次性写回 —— 🟢 AUDIT-228-02：原实现内层 catch 忽略单个失败、外层再吞一次，
    //   结果「内存标 closed 但库里仍是 in_progress」，UI 显示已结束而持久状态未闭合且无任何提示。
    //   现统计失败数：失败任务回滚内存态并显式报错，成功路径行为完全不变。
    let saveFailed = 0;
    const failedTasks = [];
    try {
      for (const t of toSaveTasks) {
        try { await DataStore.saveStocktakeTask(t); }
        catch (e) {
          saveFailed++;
          failedTasks.push(t);
          console.error('[stocktake] 任务写回失败：' + t.counter + ' —— ' + (e && (e.message || e)));
        }
      }
    } catch (e) {
      saveFailed = toSaveTasks.length;
      failedTasks.length = 0;
      toSaveTasks.forEach(t => failedTasks.push(t));
      console.error('[stocktake] 任务批量写回异常：', e && (e.message || e));
    }
    if (saveFailed > 0) {
      // 回滚内存态，保证 UI 与持久状态一致（否则下次进入会误判为已结束）
      failedTasks.forEach(t => {
        const p = prevState.get(t);
        if (!p) return;
        t.status = p.status;
        t.closedAt = p.closedAt;
        t.updatedAt = p.updatedAt;
      });
      this.toast('⚠️ 强制结束：有 ' + saveFailed + ' 个任务写回失败（状态未闭合），请重试或联系管理员');
    }

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
    // 🟢 v228.33：当前操作人（如管理员自己分派给自己后进入盘点）如果没有被 batchTasks 统计到，
    //   也补一份 finished 概览，避免「我的概览」卡片继续显示「本次盘点未结束」。
    const myCounter = String(((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? (AppConfig.getCurrentUser() || {}).username : '') || '').trim();
    if (myCounter && counters.indexOf(myCounter) < 0) {
      const myKey = this._overviewKey(myCounter, sheetId);
      const myOv = overviewMap[myKey];
      if (myOv) {
        myOv.status = 'finished';
        myOv.updatedAt = now;
        overviewMap[myKey] = myOv;
      } else {
        overviewMap[myKey] = {
          counter: myCounter, batchNo, sheetId, sd, ed,
          totalCount: 0, realCount: 0, zeroCount: 0, unfilledCount: 0,
          diffCount: 0, countedCount: 0, completionRate: 100,
          status: 'finished', finishedAt: now, noStart: null, noEnd: null,
          updatedAt: now, forceClosed: true
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
      // 🟢 v228.33：结束季度盘点时把任何 quarter session 都清掉，不限于当前 sheetId。
      //   否则 session 的 sheetId 若因日期漂移和当前不一致，旧 session 会残留，下次进 picker 又锚回去。
      if (sess && sess.sheetType === 'quarter') this._clearOpenSession();
    } catch (e) { /* 忽略 */ }

    // 5) 广播给所有打开 picker 的标签即时刷新
    try { this._broadcastOverviewUpdate({ sheetId, updatedAt: now, forceClosed: true }); } catch (e) { /* 忽略 */ }
    // 🟢 v228.35（P3）：结束是管理员最需要即时反馈的动作，立即刷新一次不等轮询周期
    try { await this._refreshNowAfterAction(); } catch (e) { /* 忽略 */ }

    // 🟢 v228.74：结束文案带出自动归档人数（autoClosed = 结算等待期内手机自动上传的任务数）
    this.toast('本轮已结束并归档：' + batchNo + '（共收 ' + counters.length + ' 位盘点人'
      + (autoClosed > 0 ? '，自动归档 ' + autoClosed + ' 人' : '')
      + '）');
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
      // 🟢 v228.48：批次身份一律按 batchKey 严格判定（不再反算日期）
      if (t.batchKey && t.batchKey === sheetId) return true;
      if (t.sheetId && t.sheetId === sheetId) return true;
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
      '· 补盘完成后正常点「结束本次盘点」即可；本轮其他人的数据不受影响。\n\n' +
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
    // 🟢 v228.35（P3）：补派后立即刷新，管理员可马上看到「补盘人员监控」出现
    try { await this._refreshNowAfterAction(); } catch (e) { /* 忽略 */ }
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

    // 🟢 v228.48：**开下一轮 = 开一批新盘**（生成新的批次身份/开盘时间戳）。
    //
    //   旧版（v227.12~v228.47）在同一 sheetId 上做轮次 +1 —— 因为那时 sheetId 由日期推导，
    //   "换批次"只能是"换日期区间"，而日期对用户又毫无意义，于是被迫引入"轮次"概念去区分
    //   同一日期下的多批。现在批次身份就是开盘时间戳，**每一轮天然是一个独立批次**：
    //     · 轮次号、闸门、命名、概览全部挂在新的 sheetId 上，不再与上一轮混用同一个 key 空间；
    //     · 任务 batchKey 也跟着换成新身份，上一轮任务不会以任何形式漏进新一轮（天然无串档）；
    //     · 用户语义更直白：「这一轮盘完了 → 开新的一批」。
    //
    //   prevRound / nextRound 仍保留 —— 作为**轮次连续性的展示**（「第 N 轮」），只是不再当身份用。
    const prevRound = this._getClosedRound(sheetId) || this._getRoundNo(sheetId);
    const nextRound = prevRound + 1;
    const newOpenedAt = new Date().toISOString();
    const newSheetId = this._quarterSheetId(newOpenedAt);
    // 🟢 v228.37：开下一轮 = 命名新一轮季度盘点。默认按今天日期预填「YYYY年第Q季度」，
    //   管理员可整串改（如「2026年第3季度(返工)」）；留空则回退显示「第 N 轮」。
    const _now = new Date();
    const defLabel = _now.getFullYear() + '年第' + (Math.floor(_now.getMonth() / 3) + 1) + '季度';
    const intro = '为新一轮季度盘点命名（将显示在盘点界面与盘点记录中）：'
      + '\n\n· 第 ' + prevRound + ' 轮已落库的盘点记录会原样保留（不删除、不覆盖）；'
      + '\n· 本批次所有分派任务将重置为「待领取」，可重新分派/进入；'
      + '\n· 留空则按轮次显示为「第 ' + nextRound + ' 轮」。';
    let label = await WBModal.prompt(intro, {
      title: '开启新一轮季度盘点（内部轮次：第 ' + nextRound + ' 轮）',
      default: defLabel,
      placeholder: '如：2026年第3季度',
      okText: '开启新一轮', cancelText: '取消'
    });
    if (label === null || label === undefined) return;   // 取消
    label = String(label).trim();
    // 重名检查：任意批次/历史轮次已用过同名 → 二次确认（允许重名，底层按轮次号区分）
    if (label) {
      const labels = this._getRoundLabels();
      const dup = Object.keys(labels).some(k => labels[k] && labels[k].label === label);
      if (dup) {
        const go = await WBModal.confirm(
          '已存在同名轮次「' + label + '」。\n\n同名不影响数据（系统内部仍按轮次号区分），但盘点记录列表中会出现两条同名记录，建议命名带上区分信息（如月份或「返工」）。是否仍使用该名称？',
          { title: '同名轮次提醒', okText: '仍使用', cancelText: '重新命名' }
        );
        if (!go) return;
      }
    }

    // 1) 清空上一批的全部分派任务（墓碑删除，而非重置为「待领取」）
    //    🟢 v227.16 修复：原实现把 closed 任务改回 open，导致上一轮任务在下一轮
    //    以「我的任务 · 进入盘点」形态复活（用户反馈图3）。按用户语义，开下一轮 =
    //    清空上一轮信息与任务，管理员重新分派；已落库的盘点记录保留在「盘点记录列表」。
    //    🟢 v228.48：判定改为**严格按 batchKey === 旧批次身份**（不再依赖日期区间兜底），
    //      因此绝不会误删其他批次的任务。
    const allTasks = DataStore.getStocktakeTasks() || {};
    const batchTasks = Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
      t && !t.deleted && t.sheetType === 'quarter' && (t.batchKey === sheetId || t.sheetId === sheetId));
    const now = new Date().toISOString();
    for (const t of batchTasks) {
      // 🟢 v227.15（G9）：清掉该盘点人本批次的分区草稿 —— 避免旧草稿被新一轮认领带进新表
      try { localStorage.removeItem(this._draftKey(t.counter, t.batchKey || t.sheetId)); } catch (e) {}
      try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
      // 墓碑删除任务（不保留为待领取，避免复活）；skipPush 后统一推一次
      try { await DataStore.deleteStocktakeTask(t.taskId, { skipPush: true }); } catch (e) { /* 忽略 */ }
    }
    // 🟢 v228.50-fix：此处必须走 DataStore._pushStocktakeTasksToCloud()，
    //   原实现 this._pushStocktakeTasksToCloud() 中的 this=StocktakeModule，
    //   而该方法只定义在 DataStore 上 → 调用即抛 TypeError，被外层 try/catch 吞掉，
    //   导致「开下一轮」的墓碑删除（deleteStocktakeTask 已本地写入 deleted:true）
    //   永远推不上云端，其他设备旧批次任务无法同步清除（P5：开下一轮后另一端旧任务残留）。
    //   db.js 内部统一走 DataStore._pushStocktakeTasksToCloud()，此处对齐。
    try { await DataStore._pushStocktakeTasksToCloud(); } catch (e) { /* 忽略 */ }

    // 2) 清空旧批次的概览（让新批次回到「未开始」态，而非继续显示「已结束/漏盘」）
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
    } catch (e) { console.warn('[stocktake] 清旧批次概览失败(已忽略):', e && e.message); }

    // 3) 清掉所有盘点人的未结束会话（防止 picker 走续盘路径绕过新批次闸门）
    try {
      const sess = this._getOpenSession();
      if (sess && sess.sheetId === sheetId) this._clearOpenSession();
    } catch (e) { /* 忽略 */ }

    // 4) 🟢 v228.48：**确立新批次身份**（关键一步）—— 生成新开盘时间戳并回推云端。
    //    此前所有针对旧 sheetId 的清理都已完成，从这里开始系统进入"新的一批"。
    try {
      await this._setActiveQuarter(newOpenedAt);
    } catch (e) { console.warn('[stocktake] 确立新批次身份失败(已忽略):', e && e.message); }
    // 新批次 = 轮次从第 1 轮重新计，同时记录「第 N 轮」的连续性展示值
    try { await this._setRoundNo(newSheetId, 1); } catch (e) { /* 忽略 */ }
    // 🟢 v228.37：写入新一轮命名（本地 + 云端；留空不写 → 显示回退「第 N 轮」）
    if (label) { try { await this._setRoundLabel(newSheetId, 1, label); } catch (e) { /* 忽略 */ } }
    // 记住新批次（重进工作台落回）
    try { this._setLastQuarterSheet(this.query.startDate, this.query.endDate); } catch (e) { /* 忽略 */ }
    // 旧批次闸门保持关闭（历史批次应一直显示「已结束」）；新批次天然无闸门记录。

    // 5) 广播给所有打开 picker 的标签即时刷新
    try { this._broadcastOverviewUpdate({ sheetId: newSheetId, prevSheetId: sheetId, updatedAt: now, nextRound }); } catch (e) { /* 忽略 */ }
    // 🟢 v228.35（P3）：开下一轮后立即刷新，无需等轮询即可看到新轮次界面
    try { await this._refreshNowAfterAction(); } catch (e) { /* 忽略 */ }

    // 🟢 v228.48：成功提示 —— 已切到"新一批"语义
    this.toast('已开启「' + this._roundDisplay(newSheetId, 1) + '」季度盘点（新批次已就绪，请重新分派任务）');
    if (this._entrySheetType === 'quarter') this.startQuarter();
  },

  async _pullRoundClosed() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    if (typeof SyncManager.getSettings !== 'function') return;
    try {
      // 🟢 v228.61（P0-A）：只读 ROUND_CLOSED_KEY / ROUND_NO_KEY / ROUND_LABEL_KEY 三个键。
      //   旧版读整包（15 请求）只为挑这 3 个键；本方法在 _pollOnce 里条件触发，是热路径成员。
      let rmap, rno, rlabel;
      if (typeof SyncManager.getSettingsKeys === 'function') {
        const got = await SyncManager.getSettingsKeys(
          [this.ROUND_CLOSED_KEY, this.ROUND_NO_KEY, this.ROUND_LABEL_KEY]);
        rmap = got[this.ROUND_CLOSED_KEY] || null;
        rno = got[this.ROUND_NO_KEY] || null;
        rlabel = got[this.ROUND_LABEL_KEY] || null;
      } else {
        const remote = await SyncManager.getSettings();
        rmap = (remote && remote[this.ROUND_CLOSED_KEY]) || null;
        rno = (remote && remote[this.ROUND_NO_KEY]) || null;
        rlabel = (remote && remote[this.ROUND_LABEL_KEY]) || null;
      }
      if (!rmap || typeof rmap !== 'object') return;
      const local = this._getRoundClosed();
      // 🟢 v228.33：仅合并云端 truthy 的 closed 记录，避免远端缺失/被写成了 null
      //   的 key 把本地已结束标记误覆盖为「进行中」。
      const merged = Object.assign({}, local);
      Object.keys(rmap).forEach(k => {
        const v = rmap[k];
        if (v && typeof v === 'object') merged[k] = v;
      });
      this._saveRoundClosed(merged);
      // 🟢 v227.12：一并拉取轮次计数器，保证其他设备看到「第 N 轮」与下一轮入口
      // 🟢 v228.38（P8）：逐键取最大，避免远端返回的旧值把本地更新的轮次拉低（与 _setRoundNo 对称）
      // 🟢 v228.61：rno 已在函数开头一并读出，此处不再二次读云端。
      if (rno && typeof rno === 'object') {
        const ln = JSON.parse(localStorage.getItem(this.ROUND_NO_KEY) || '{}') || {};
        const mergedNo = Object.assign({}, ln);
        Object.keys(rno).forEach(k => {
          const rv = parseInt(rno[k], 10), lv = parseInt(mergedNo[k], 10);
          if (!isNaN(rv) && (isNaN(lv) || rv > lv)) mergedNo[k] = rno[k];
        });
        localStorage.setItem(this.ROUND_NO_KEY, JSON.stringify(mergedNo));
      }
      // 🟢 v228.37：一并拉取轮次命名 —— A 设备命名后，B 设备轮询即可看到同一名称
      // 🟢 v228.61：rlabel 已在函数开头一并读出，此处不再二次读云端。
      if (rlabel && typeof rlabel === 'object') {
        const ll = this._getRoundLabels();
        const mergedLabel = Object.assign({}, ll, rlabel);
        localStorage.setItem(this.ROUND_LABEL_KEY, JSON.stringify(mergedLabel));
      }
    } catch (e) { /* 忽略 */ }
  },

  // 🟢 v227.67 修复：ROUND_CLOSED_KEY 是「多轮次 × 多设备」聚合态（每个 sheetId 一条 closed 记录）。
  //   原 endQuarterRound/startNextRound 用 _setCloud 直接整包 setSetting 覆盖云端，会把其他设备/其他轮次
  //   已结束的记录从云端抹掉 → 其他设备（或清缓存后）再进盘点模块看到该轮次又「🟡 进行中」。
  //   改为「读云端 → 合并并集 → 回写」，closed 记录只增不丢。
  async _setRoundClosedCloud(sheetId, info) {
    let merged = Object.assign({}, this._getRoundClosed());
    // 🟢 v228.35：info 缺省时回退为「本机已记录的结束时间」，绝不写 undefined。
    //   否则紧急结束通道调用本方法会把 {sheetId: undefined} 推到云端，盘点人端读到 undefined
    //   会被判为「未结束」→ 锁盘失效（且很难排查）。
    if (sheetId) merged[sheetId] = info || merged[sheetId] || new Date().toISOString();
    try {
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.getSetting === 'function') {
        // 🟢 v228.61（P0-A）：只读 ROUND_CLOSED_KEY 一个键
        const rmap = await SyncManager.getSetting(this.ROUND_CLOSED_KEY);
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
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.getSetting === 'function') {
        // 🟢 v228.61（P0-A）：只读 ROUND_CLOSED_KEY 一个键
        const rmap = await SyncManager.getSetting(this.ROUND_CLOSED_KEY);
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

  // 🟢 v228.34：盘点人「放弃任务」—— 仅未开始（无落库实盘记录）的任务可退回管理员处重新分派。
  //   退回后编码进入「退回待分配」池，由管理员在「补派任务」中重新分派给任何人。
  async returnTask(taskId) {
    const tasks = DataStore.getStocktakeTasks();
    const t = tasks[taskId];
    if (!t) { this.toast('任务不存在或已撤销'); return; }
    if (t.status !== 'open') {
      WBModal.alert('该任务（' + (t.counter || '') + ' · 序号 ' + t.noStart + '-' + t.noEnd + '）已结束，无法放弃任务。\n\n如需回收未盘项，请在「🧩 我的补盘」中对该任务点「放弃补盘」退回漏盘项。');
      return;
    }
    const cur = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '').trim();
    // 是否已开始盘点：存在本人实盘记录（非作废、非结束补0）且编码在固化清单内
    const recs = await DataStore.getStocktakeRecords();
    const started = (recs || []).some(r =>
      !r.voided && !r.closedByFinish &&
      String(r.盘点人 || '').trim() === String(t.counter).trim() &&
      (t.codes || []).indexOf(r.存货编码) >= 0);
    if (started) {
      WBModal.alert('该任务（' + t.counter + ' · 序号 ' + t.noStart + '-' + t.noEnd + '）已进入盘点，不能放弃任务。\n\n请先点盘点界面右上角「🗑️ 放弃本次盘点」回滚已填进度，再回到此处放弃任务。');
      return;
    }
    const ok = await WBModal.confirm('确认放弃任务：' + t.counter + ' · 序号 ' + t.noStart + '-' + t.noEnd + '（' + (t.codes || []).length + ' 项）？\n放弃后该任务回退管理员处，可在「补派任务」中重新分派给他人。', { title: '放弃任务' });
    if (!ok) return;
    const now = new Date().toISOString();
    const oldCounter = t.counter;
    t.returned = true; t.returnedAt = now; t.returnedBy = cur || '未知'; t.replenishedCodes = []; t.updatedAt = now;
    t.counter = null;   // 退出本人任务池（getMyOpenTasks 按 counter 过滤）；编码保留供补派
    await DataStore.saveStocktakeTask(t);   // 自动推云端（settings 通道，跨设备同步）
    // 清本人会话 / 草稿，避免重进时续盘到已退回任务
    try { const sess = this._getOpenSession(); if (sess && sess.taskId === taskId) this._clearOpenSession(); } catch (e) {}
    try { localStorage.removeItem(this._draftKey(oldCounter, t.sheetId)); } catch (e) {}
    try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
    this.toast('已放弃任务，回退管理员处可重新分派');
    this._refreshTaskBar();   // 实时刷新当前视图（管理员跨设备靠云端任务通道同步）
  },

  // 🟢 v228.34：盘点人「放弃补盘」—— 退回该任务未盘的漏盘项给管理员补派池。
  async returnLeak(taskId) {
    const tasks = DataStore.getStocktakeTasks();
    const t = tasks[taskId];
    if (!t) { this.toast('任务不存在或已撤销'); return; }
    if (t.status !== 'closed') {
      WBModal.alert('该任务（' + (t.counter || '') + ' · 序号 ' + t.noStart + '-' + t.noEnd + '）尚未结束，无需放弃补盘；如需回收请点「放弃任务」。');
      return;
    }
    const counted = await this._countedCodesForQuarter(t.sheetId, t.counter);
    const leak = (t.codes || []).filter(c => c && !counted.has(c));
    if (!leak.length) {
      WBModal.alert('该任务（' + t.counter + ' · 序号 ' + t.noStart + '-' + t.noEnd + '）无漏盘项，无需放弃补盘。');
      return;
    }
    // 🟢 v228.70（用户反馈）：弹窗文案精简美化。旧文案把 <b> HTML 标签传进 WBModal.confirm，
    //   而 confirm 是纯文本渲染 → 真机上显示字面「<b>2</b>」。改用纯文本并只保留必要信息：
    //   谁 · 哪段序号 / 多少项漏盘将退回 / 确认语气。
    const ok = await WBModal.confirm(
      t.counter + ' · 序号 ' + t.noStart + '-' + t.noEnd + '\n' +
      '将把 ' + leak.length + ' 项漏盘退回管理员补派，确定放弃？',
      { title: '放弃补盘' });
    if (!ok) return;
    const now = new Date().toISOString();
    const cur = ((typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? ((AppConfig.getCurrentUser() || {}).username || '') : '').trim();
    t.leakReturned = true; t.returnedLeakCodes = leak; t.returnedAt = now; t.returnedBy = cur || '未知';
    t.replenishedCodes = []; t.updatedAt = now;
    await DataStore.saveStocktakeTask(t);
    this.toast('已放弃补盘，漏盘 ' + leak.length + ' 项回退管理员处可补派');
    this._refreshTaskBar();
  },

  // 当前批次（同类别 + 同盘点日期区间）下尚未结束的分派任务
  _batchOpenTasks(sheetType) {
    const type = sheetType || (this.sheet && this.sheet.sheetType) || 'quarter';
    const all = DataStore.getStocktakeTasks();
    const curId = this._currentQuarterSheetId();
    return Object.keys(all).map(k => all[k]).filter(t =>
      t && t.status === 'open' && t.sheetType === type &&
      // 🟢 v228.48：批次归属按身份严格判定；仅无 batchKey 的历史任务才宽松匹配
      (t.batchKey ? t.batchKey === curId : true));
  },

  // v217 防重复分派：返回冲突说明（有冲突）或 null（可安全分派）
  _findAssignConflict(sheetType, counter, codes) {
    // 🟢 v228.34：退回待分配项（放弃任务/放弃补盘）已退入补派池，不再占用「正常分派」的序号空间，
    //   故冲突检测排除它们（counter 已置空、reserved 给补派），避免管理员无法重新分派这些编码。
    const opens = this._batchOpenTasks(sheetType).filter(t => !(t.returned || t.leakReturned));
    // 🟢 v228.34：退回待分配项 reserved 给「补派任务」，正常分派不得抢占，否则会与补派双重分派同一编码
    const pool = this._replenishPool();
    const poolCodes = new Set(pool.serialList.map(s => pool.codeOf.get(s)).filter(Boolean));
    const grabbed = (codes || []).filter(c => poolCodes.has(c));
    if (grabbed.length) {
      return `以下序号属于「退回待分配」项，请用「📥 补派任务」重新分派（不可走正常分派，否则会与补派重复）：\n` +
        grabbed.slice(0, 6).map(c => String(c)).join('、') + (grabbed.length > 6 ? ' …' : '');
    }
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
    // 🟢 v228.65（用户反馈）：本轮已结束、还没开下一轮时禁止分派 —— 此时派的活没有归属轮次。
    //   按钮 UI 已置灰，这里是逻辑兜底（诊断/重渲等路径也可能调进来）。
    try {
      const sid = this._currentQuarterSheetId();
      if (sid && this.isQuarterRoundClosed(sid)) {
        this.toast('⛔ 本轮已结束，请先点「🔄 开下一轮盘点」再分派任务');
        return;
      }
    } catch (e) { /* 判定失败不拦正常流程 */ }
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
        <!-- 🟢 v228.35（P9）：序号含义说明 + 存货编码直查序号。
             旧版只写「序号区间」，首次使用的管理员不知道序号从哪来（以为是存货编码），
             也不知道该派到几。这里把来源、总数、换算方式一次说清，并支持粘贴编码反查。 -->
        <div class="as-row full as-row-help">
          <div class="as-help">
            ℹ️ <b>序号</b>是本轮盘点清单中的<b>连续编号</b>（不是存货编码）：本轮基线共 <b id="asTotalN">—</b> 项存货（已剔除空白/0 存量），序号从 1 连续排到 <b id="asTotalN2">—</b>。
            下方「可分配序号区间」列出了还没派出去的号。
          </div>
        </div>
        <div class="as-row full as-row-code">
          <label class="title">按存货编码查序号（可选，粘贴编码自动换算）</label>
          <div class="as-duo">
            <input id="asCodeQuery" type="text" placeholder="如 A01 或 A01,A02" class="as-input">
            <button type="button" id="asCodeBtn" class="btn--ghost as-btn-inline">查序号</button>
          </div>
          <div id="asCodeResult" class="as-preview" style="margin-top:6px;"></div>
        </div>
        <div class="as-row as-row-multi">
          <label class="title">多批次非连续选号（如 <code>1-3,6-20,30-40,15</code>，覆盖起止）</label>
          <input id="asMulti" type="text" placeholder="1-3,6-20,30-40,15" class="as-input">
        </div>
        <div class="as-row full as-row-preview">
          <label class="title">区间预览（光标所在的段：起/止对应的存货名称+规格）</label>
          <div id="asInfo" class="as-preview">输入序号或多批次后，这里实时显示对应的存货名称与规格型号。</div>
        </div>
        <div class="as-row full">
          <label class="title">可分配序号区间（未被分派的，实时计算；退回待分配项请用「📥 补派任务」）</label>
          <div id="asAvailHint" class="as-preview" style="white-space:pre-wrap;"></div>
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
      // 🟢 v228.32：本机尚无本轮基线时先从云端拉，避免各设备各自拍一张不一致的快照
      const total = (await self._allStockCodesSorted('quarter')).length;
      const info = document.getElementById('asInfo');
      if (info && total) info.dataset.total = String(total);
      // 🟢 v228.35（P9）：把本轮总数写进说明区，用户一眼知道序号上界
      try {
        const tn = document.getElementById('asTotalN');
        const tn2 = document.getElementById('asTotalN2');
        if (tn) tn.textContent = String(total || '—');
        if (tn2) tn2.textContent = String(total || '—');
      } catch (e) { /* 忽略 */ }

      const renderInfo = async () => {
        const totalN = parseInt((document.getElementById('asInfo') || {}).dataset?.total || '0', 10);
        if (!totalN) return;
        // 🟢 v228.34：分派弹窗底部实时提示可分配序号区间
        try {
          const fav = self._freeAssignSerials();
          const hint = document.getElementById('asAvailHint');
          if (hint) {
            // 🟢 v228.41（优化项-1）：把「可分配区间」与「补派池」显式分开 ——
            //   旧实现只列可分配区间、一句「退回待分配项请用补派任务」带过，
            //   管理员在弹窗里根本看不到补派池到底压了哪些号，容易误以为这些号凭空消失。
            //   现补一行「📥 补派池」：区间 + 项数 + 明确指引，让两个池子一眼分清。
            let txt = fav.serialList.length
              ? ('共 ' + fav.serialList.length + ' 项可分配，序号区间：\n' + self._toRangeText(fav.serialList))
              : '本轮基线已全部派完。';
            try {
              const rp = self._replenishPool();
              if (rp && rp.serialList && rp.serialList.length) {
                txt += '\n\n📥 补派池（放弃任务 / 放弃补盘退回）：共 ' + rp.serialList.length
                     + ' 项，序号区间：' + self._toRangeText(rp.serialList)
                     + '\n这些序号不能用本弹窗分派，请点【📥 补派任务】处理。';
              }
            } catch (e2) { /* 忽略补派池读取异常，不影响可分配展示 */ }
            hint.textContent = txt;
            // 有补派池时用一个浅色高亮块承载，避免长文本糊成一片
            hint.style.background = (function () {
              try { return self._replenishPool().serialList.length ? 'rgba(37,99,235,0.06)' : ''; } catch (e3) { return ''; }
            })();
            hint.style.padding = '8px';
            hint.style.borderRadius = '6px';
          }
        } catch (e) {}
        const allCodes = await self._allStockCodesSorted('quarter');
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
          info.textContent = '本轮基线共 ' + totalN + ' 项存货（已剔除空白/0 存量）；结束序号不得超过此值。';
          return;
        }
        // 取首段起点 + 末段止点（多段时显示首段起点/末段止点，方便校验首尾两端）
        const firstStart = ranges[0][0];
        const lastSeg = ranges[ranges.length - 1];
        const lastEnd = lastSeg[1];
        // 多段时也取末段起点（用于"末段第一项"）与首段止点（用于"首段止"）
        const lastStart = lastSeg[0];
        const firstEnd = ranges[0][1];
        // 🟢 v228.34：多段时补齐「首段止」——原实现只取 [首段起, 末段起, 末段止]，
        //   输入 1-5,6-10 时看不到序号 5 对应哪件货，恰好漏掉用户最关心的首段结束位置。
        const stopNos = (ranges.length === 1)
          ? [firstStart, lastEnd]                       // 单段：起 + 止
          : [firstStart, firstEnd, lastStart, lastEnd]; // 多段：首段起 + 首段止 + 末段起 + 末段止
        const stopInfos = [];
        try {
          const stock = await DataStore.getRows('stock');
          for (const no of stopNos) {
            if (!no || no < 1 || no > allCodes.length) { stopInfos.push({ no, ok:false }); continue; }
            const code = allCodes[no - 1];
            const row = (stock || []).find(r => String(r.存货编码 || '') === code) || null;
            // 🟢 v228.32：成功分支必须带 ok:true —— 原实现只 push {no,code,row}，
            //   下面按 !it.ok 判「越界」→ 每一个正常序号都被显示成「（越界）」，
            //   管理员在分派前根本看不到区间端点对应哪件货（v227.26 的预览功能形同失效）。
            stopInfos.push({ no, code, row, ok: true });
          }
        } catch (e) {}
        const segCount = ranges.length;
        const segLabel = segCount > 1 ? ('共 ' + segCount + ' 段') : ('单段');
        const lines = [];
        stopInfos.forEach((it, idx) => {
          const tag = (segCount === 1)
            ? (idx === 0 ? '起' : '止')
            : ['首段起', '首段止', '末段起', '末段止'][idx] || ('第' + (idx + 1) + '项');
          if (!it.ok) { lines.push('· ' + tag + ' 序号 ' + it.no + '（越界）'); return; }
          if (it.row) {
            lines.push('· <b>' + tag + '</b> 序号 <b>' + it.no + '</b>　' + esc(it.code) + '　·　' +
                       esc(it.row.存货名称 || '（无名）') +
                       (it.row.规格型号 ? ' / ' + esc(it.row.规格型号) : ''));
          } else {
            lines.push('· <b>' + tag + '</b> 序号 <b>' + it.no + '</b>　' + esc(it.code) + '　·　（未在库存中找到）');
          }
        });
        info.innerHTML = lines.join('\n') + '\n\n本轮基线共 ' + totalN + ' 项存货（已剔除空白/0 存量，序号已锁定，后续库存变动不影响本轮分配）；结束序号不得超过此值；' + segLabel + '。';
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
      // 🟢 v228.35（P9）：按存货编码查序号 —— 支持逗号/空格/换行分隔，一次查多个。
      //   价值：管理员手里拿到的往往是编码清单（来自盘点表/邮件），不是序号；
      //   能直接粘贴编码换算出序号，就不必靠肉眼在几百行清单里数位置。
      const doCodeQuery = async () => {
        const el = document.getElementById('asCodeQuery');
        const out = document.getElementById('asCodeResult');
        if (!el || !out) return;
        const raw = String(el.value || '').trim();
        if (!raw) { out.innerHTML = ''; return; }
        const codes = raw.split(/[,，\s;；\n\r\t]+/).map(s => s.trim()).filter(Boolean);
        let allCodes = [];
        try { allCodes = await self._allStockCodesSorted('quarter'); } catch (e) { allCodes = []; }
        const idxOf = new Map(allCodes.map((c, i) => [String(c), i + 1]));
        const hit = [], miss = [];
        codes.forEach(c => { idxOf.has(c) ? hit.push({ c, no: idxOf.get(c) }) : miss.push(c); });
        const parts = [];
        if (hit.length) {
          parts.push('找到 <b>' + hit.length + '</b> 项：<br>' +
            hit.map(h => '· 序号 <b>' + h.no + '</b>　' + esc(h.c)).join('<br>'));
          // 命中项若恰好是连续区间，给出可直接填入的区间文本，省去手工拼写
          const nos = hit.map(h => h.no).sort((a, b) => a - b);
          const isConsec = nos.every((n, i) => i === 0 || n === nos[i - 1] + 1);
          if (hit.length > 1 && isConsec) {
            parts.push('<span style="color:#2563eb;">这些序号连续，区间为 <b>' + nos[0] + '-' + nos[nos.length - 1] + '</b>，可直接填入上方序号区间。</span>');
          }
        }
        if (miss.length) {
          parts.push('<span style="color:#b45309;">未在本轮清单中找到：' + miss.map(esc).join('、') +
            (miss.length && raw.indexOf(',') < 0 ? '（若这是一段区间请改用「多批次」输入，如 1-3,6-20）' : '') + '</span>');
        }
        out.innerHTML = parts.join('<br>');
      };
      const codeBtn = document.getElementById('asCodeBtn');
      if (codeBtn) codeBtn.onclick = doCodeQuery;
      const codeEl = document.getElementById('asCodeQuery');
      if (codeEl) {
        codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCodeQuery(); } });
      }
      // 绑定确认/取消
      document.getElementById('asCancelBtn').onclick = () => overlay.classList.remove('show');
      document.getElementById('asConfirmBtn').onclick = () => self._doAssign();
    })();
  },

  // 🟢 v228.34：可分配序号区间（未被分派给任何人的，含退回待分配项）—— 供分派弹窗提示
  _freeAssignSerials() {
    const sd = this.query.startDate, ed = this.query.endDate;
    const sheetId = this._currentQuarterSheetId() || this._quarterSheetId();
    const b = this._peekQuarterBaseline(sheetId);
    const baselineCodes = (b && b.codes) || [];
    const assigned = new Set();
    const allTasks = DataStore.getStocktakeTasks() || {};
    Object.keys(allTasks).forEach(k => {
      const t = allTasks[k];
      if (!t || !this._taskInCurrentBatch(t, sd, ed)) return;
      // 🟢 v228.34：退回待分配项（放弃任务=returned / 放弃补盘=leakReturned）reserved 给「补派任务」，
      //   从正常分派自由池里剔除，避免与「补派」双重分派同一编码。
      if (t.returned || t.leakReturned) {
        const reserved = t.returned ? (t.codes || []) : (t.returnedLeakCodes || []);
        reserved.forEach(c => assigned.add(c));
        return;
      }
      // 🟢 v228.40（二-2b）修复：只要「已派给某人」就占号 —— 不再限定 status==='open'。
      //   旧实现只排除 open 任务，已结束（closed）任务的编码会重新出现在「可分配序号区间」，
      //   管理员可以从别人已盘完的序号重新分派（线上反馈图：nx 已结束 11-18，弹窗仍列 1-5、11-953）。
      //   已结束任务同样占号：后续轮次由 startNextRound 清空任务后自然释放。
      if (!t.counter) return;     // 无归属（已放弃归属）不占号
      (t.codes || []).forEach(c => assigned.add(c));
    });
    const serialList = [];
    baselineCodes.forEach((c, i) => { if (!assigned.has(c)) serialList.push(i + 1); });
    return { serialList, baselineCodes };
  },

  // 🟢 v228.34：退回待分配的可补派序号集合（serial -> sourceTaskId），实时计算
  _replenishPool() {
    const sd = this.query.startDate, ed = this.query.endDate;
    const sheetId = this._currentQuarterSheetId() || this._quarterSheetId();
    const b = this._peekQuarterBaseline(sheetId);
    const baselineCodes = (b && b.codes) || [];
    const serialOf = new Map(baselineCodes.map((c, i) => [c, i + 1]));
    const codeOf = new Map(baselineCodes.map((c, i) => [i + 1, c]));
    const allTasks = DataStore.getStocktakeTasks() || {};
    const map = new Map();   // serial -> sourceTaskId
    const serialList = [];
    Object.keys(allTasks).forEach(k => {
      const t = allTasks[k];
      if (!t || (!t.returned && !t.leakReturned)) return;
      if (!this._taskInCurrentBatch(t, sd, ed)) return;
      const all = (t.returned ? (t.codes || []) : (t.returnedLeakCodes || [])).filter(Boolean);
      const replenished = new Set(t.replenishedCodes || []);
      all.forEach(c => {
        if (replenished.has(c)) return;
        const ser = serialOf.get(c);
        if (ser == null) return;
        if (!map.has(ser)) { map.set(ser, t.taskId); serialList.push(ser); }
      });
    });
    serialList.sort((a, b) => a - b);
    return { map, serialList, codeOf, baselineCodes };
  },

  // 🟢 v228.34：把序号数组压缩成连续区间文本（如 1-3、6-20）
  _toRangeText(serialList) {
    if (!serialList || !serialList.length) return '';
    const segs = [];
    let s = serialList[0], prev = serialList[0];
    for (let i = 1; i < serialList.length; i++) {
      const x = serialList[i];
      if (x === prev + 1) { prev = x; continue; }
      segs.push(s + '-' + prev); s = x; prev = x;
    }
    segs.push(s + '-' + prev);
    return segs.join('、');
  },

  _replenishAvailableSerials() {
    const pool = this._replenishPool();
    if (!pool.serialList.length) return { text: '当前没有可补派的退回项。', serialList: [] };
    const text = '共 ' + pool.serialList.length + ' 项可补派，序号区间：\n' + this._toRangeText(pool.serialList);
    return { text, serialList: pool.serialList, map: pool.map, codeOf: pool.codeOf };
  },

  // 🟢 v228.34：补派退回任务弹窗（类似分派任务，仅可派「退回待分配」的编码）
  openReplenishDialog() {
    const overlay = document.getElementById('modalOverlay');
    const title = document.getElementById('modalTitle');
    const body = document.getElementById('modalBody');
    if (!overlay || !title || !body) return;
    title.textContent = '补派退回任务';
    let opts = '<option value="管理员">管理员（自己）</option>';
    if (typeof AppConfig !== 'undefined' && AppConfig.getKeepers) {
      AppConfig.getKeepers().filter(k => !k.disabled).forEach(k => {
        opts += '<option value="' + escAttr(k.username) + '">' + esc(k.username) + '</option>';
      });
    }
    body.innerHTML = `
      <input type="hidden" id="rsType" value="quarter">
      <div class="as-grid">
        <div class="as-row as-row-counter">
          <label class="title">补派给（盘点人）</label>
          <select id="rsCounter" class="as-input">${opts}</select>
        </div>
        <div class="as-row as-row-duo">
          <label class="title">序号区间（仅限退回待分配项）</label>
          <div class="as-duo">
            <input id="rsNoStart" type="number" min="1" placeholder="起始" class="as-input">
            <span class="as-dash">—</span>
            <input id="rsNoEnd" type="number" min="1" placeholder="结束" class="as-input">
          </div>
        </div>
        <div class="as-row as-row-multi">
          <label class="title">多批次非连续选号（如 <code>1-3,6-20</code>，覆盖起止）</label>
          <input id="rsMulti" type="text" placeholder="1-3,6-20" class="as-input">
        </div>
        <div class="as-row full as-row-preview">
          <label class="title">区间预览（光标所在的段：起/止对应的存货名称+规格）</label>
          <div id="rsInfo" class="as-preview">输入序号或多批次后，这里实时显示对应的存货名称与规格型号。</div>
        </div>
        <div class="as-row full as-row-preview">
          <label class="title">可补派序号区间（退回待分配，实时计算）</label>
          <div id="rsAvail" class="as-preview" style="white-space:pre-wrap;"></div>
        </div>
        <div class="as-actions">
          <button id="rsCancelBtn" class="btn--ghost as-btn-cancel">取消</button>
          <button id="rsConfirmBtn" class="btn--primary as-btn-confirm">确认补派</button>
        </div>
      </div>`;
    const m = document.getElementById('modal'); if (m) m.classList.remove('modal-compact');
    overlay.classList.add('show');
    const self = this;
    (async () => {
      const availEl = document.getElementById('rsAvail');
      const infoEl = document.getElementById('rsInfo');
      const multi = document.getElementById('rsMulti');
      const sInp = document.getElementById('rsNoStart');
      const eInp = document.getElementById('rsNoEnd');

      // 🟢 v228.34：补派弹窗也提供「区间预览」——复用本轮基线序号 → 存货编码 → 库存名/规格，
      //   与分派弹窗同款语义（单段显示 起+止；多段显示 首段起/首段止/末段起/末段止）。
      const renderInfo = async () => {
        const avail = self._replenishAvailableSerials();
        if (availEl) availEl.textContent = avail.text;
        if (!infoEl) return;
        const pool = self._replenishPool();
        const baseline = pool.codeOf || new Map();     // serial -> code（本轮基线）
        if (!baseline.size) { infoEl.textContent = '当前没有可补派的退回项。'; return; }
        let ranges = [];
        try { if (multi && multi.value && multi.value.trim()) ranges = self._parseAssignRanges(multi.value) || []; } catch (e) {}
        if (!ranges.length) {
          const s = parseInt(sInp && sInp.value, 10), e = parseInt(eInp && eInp.value, 10);
          if (!isNaN(s) && !isNaN(e) && e >= s && s >= 1) ranges = [[s, e]];
        }
        const baselineCodes = pool.baselineCodes || [];
        const baseTotal = baselineCodes.length;
        if (!ranges.length) {
          infoEl.textContent = '输入序号或多批次后，这里实时显示对应的存货名称与规格型号。本轮基线共 ' + baseTotal + ' 项（仅可补派落在退回池内的项）。';
          return;
        }
        const segCount = ranges.length;
        const lastSeg = ranges[segCount - 1];
        const stopNos = (segCount === 1)
          ? [ranges[0][0], lastSeg[1]]
          : [ranges[0][0], ranges[0][1], lastSeg[0], lastSeg[1]];
        let stock = [];
        try { stock = (await DataStore.getRows('stock')) || []; } catch (e) {}
        const serialSet = pool.serialList ? new Set(pool.serialList) : new Set();
        const lines = [];
        stopNos.forEach((no, idx) => {
          const tag = (segCount === 1) ? (idx === 0 ? '起' : '止')
                                       : (['首段起', '首段止', '末段起', '末段止'][idx] || ('第' + (idx + 1) + '项'));
          if (!no || no < 1 || no > baseTotal) { lines.push('· ' + tag + ' 序号 ' + no + '（越界）'); return; }
          const code = baseline.get(no);
          if (!code) { lines.push('· ' + tag + ' 序号 ' + no + '（无对应存货）'); return; }
          const row = stock.find(r => String(r.存货编码 || '') === code) || null;
          const inPool = serialSet.has(no) ? '' : '　<span style="color:#dc2626;">（不在退回池，不可补派）</span>';
          if (row) {
            lines.push('· <b>' + tag + '</b> 序号 <b>' + no + '</b>　' + esc(code) + '　·　' +
                       esc(row.存货名称 || '（无名）') + (row.规格型号 ? ' / ' + esc(row.规格型号) : '') + inPool);
          } else {
            lines.push('· <b>' + tag + '</b> 序号 <b>' + no + '</b>　' + esc(code) + '　·　（未在库存中找到）' + inPool);
          }
        });
        infoEl.innerHTML = lines.join('\n') + '\n\n本轮基线共 ' + baseTotal + ' 项存货；' +
          (segCount > 1 ? ('共 ' + segCount + ' 段') : '单段') + '；仅可选「退回待分配」范围内的序号。';
      };

      const onRange = () => { const s = parseInt(sInp.value, 10), e = parseInt(eInp.value, 10); if (!isNaN(s) && !isNaN(e) && e >= s) multi.value = s + '-' + e; renderInfo(); };
      const onMulti = () => { const segs = (self._parseAssignRanges(multi.value) || []); if (segs.length === 1) { sInp.value = segs[0][0]; eInp.value = segs[0][1]; } else if (segs.length > 1) { sInp.value = segs[0][0]; eInp.value = segs[0][1]; } renderInfo(); };
      sInp.addEventListener('input', onRange);
      eInp.addEventListener('input', onRange);
      multi.addEventListener('input', onMulti);
      renderInfo();
      document.getElementById('rsCancelBtn').onclick = () => overlay.classList.remove('show');
      document.getElementById('rsConfirmBtn').onclick = () => self._doReplenishAssign();
    })();
  },

  // 🟢 v228.34：执行补派 —— 复用 _doAssign 同样的区间解析，但校验全部落在退回池内
  async _doReplenishAssign() {
    const tEl = document.getElementById('rsType');
    const cEl = document.getElementById('rsCounter');
    if (!tEl || !cEl) return;
    const sheetType = tEl.value;
    const counter = cEl.value.trim();
    if (!counter) { WBModal.alert('请选择补派给谁'); return; }
    const multi = document.getElementById('rsMulti');
    const sEl = document.getElementById('rsNoStart');
    const eEl = document.getElementById('rsNoEnd');
    let ranges = [];
    try {
      if (multi && multi.value && multi.value.trim()) ranges = this._parseAssignRanges(multi.value) || [];
      else { const s = parseInt(sEl.value, 10), e = parseInt(eEl.value, 10); if (!isNaN(s) && !isNaN(e) && e >= s && s >= 1) ranges = [[s, e]]; }
    } catch (e) { WBModal.alert('选号格式错误：' + (e.message || e)); return; }
    if (!ranges.length) { WBModal.alert('请输入起止序号或多批次选号（如 1-3,6-20）'); return; }

    const pool = this._replenishPool();
    const selSerials = new Set();
    for (const [a, b] of ranges) {
      if (a < 1 || b < a) { WBModal.alert('区间 ' + a + '-' + b + ' 无效'); return; }
      for (let s = a; s <= b; s++) selSerials.add(s);
    }
    const notIn = [];
    selSerials.forEach(s => { if (!pool.map.has(s)) notIn.push(s); });
    if (notIn.length) {
      notIn.sort((a, b) => a - b);
      WBModal.alert('以下序号不属于「退回待分配」项（不可补派）：' + notIn.slice(0, 12).join('、') + (notIn.length > 12 ? ' …' : ''));
      return;
    }
    const codes = Array.from(selSerials).sort((a, b) => a - b).map(s => pool.codeOf.get(s)).filter(Boolean);
    if (!codes.length) { WBModal.alert('选号范围为空'); return; }

    // 标记消耗到源任务（退回池按 source 递减，避免被重复补派）
    const bySource = new Map();
    selSerials.forEach(s => {
      const sid = pool.map.get(s);
      if (!bySource.has(sid)) bySource.set(sid, []);
      bySource.get(sid).push(pool.codeOf.get(s));
    });
    const allTasks = DataStore.getStocktakeTasks();
    let from = 'mixed';
    for (const [sid, cs] of bySource.entries()) {
      const st = allTasks[sid];
      if (!st) continue;
      if (from === 'mixed') { from = st.returned ? 'task' : 'leak'; }
      const merged = new Set(st.replenishedCodes || []);
      cs.forEach(c => merged.add(c));
      st.replenishedCodes = Array.from(merged);
      st.updatedAt = new Date().toISOString();
      try { await DataStore.saveStocktakeTask(st); } catch (e) {}
    }
    // 新建补派任务（counter 锁定、codes 固化，概览/监控自动生效）
    const sd = this.query.startDate, ed = this.query.endDate;
    const sheetId = this._currentQuarterSheetId() || this._quarterSheetId();
    const rangesKey = ranges.map(([a, b]) => a + '-' + b).join(',');
    const taskId = 'replenish_' + sheetId + '_' + counter + '_' + rangesKey + '_' + Date.now();
    const task = {
      taskId, sheetId, sheetType, counter,
      noStart: ranges[0][0], noEnd: ranges[ranges.length - 1][1], ranges,
      startDate: sd, endDate: ed,
      codes, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: 'open', closedAt: null,
      isReplenish: true, replenishFrom: from, originTaskIds: Array.from(bySource.keys())
    };
    await DataStore.saveStocktakeTask(task);
    const overlay = document.getElementById('modalOverlay'); if (overlay) overlay.classList.remove('show');
    WBModal.alert('已补派：' + counter + ' · 选号 ' + rangesKey + '（共 ' + codes.length + ' 项，编码已固化）');
    this._refreshTaskBar();
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

    // 🟢 v228.32：分派一律以本轮基线为准（剔除 0/空存量后连续重排，且库存变动不影响）
    const allCodes = await this._allStockCodesSorted(sheetType === 'quarter' ? 'quarter' : '');
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
      // v217：记录分派时所属盘点区间（**仅显示用**；批次归属判定不再依赖它）
      startDate: this.query.startDate || '', endDate: this.query.endDate || '',
      // 🟢 v228.48：批次身份标识 = 当前批次的开盘时间戳 ID。
      //   这是「本任务属于哪一批」的**唯一权威依据**，不含日期语义、跨端天然一致。
      //   _taskInCurrentBatch 严格按它判定，从根本上消除了跨批次串档。
      batchKey: sheetType === 'quarter' ? (this._currentQuarterSheetId() || this._quarterSheetId()) : null,
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
    // 🟢 v228.36：进入填表视图 → 清掉 picker 标记，否则轻量重渲会误判「仍停在 picker」而重渲覆盖表格
    this._setStocktakeView('sheet');
    const rows = this.visibleRows();
    const typeCn = this.sheet && this.sheet.sheetType === 'quarter' ? '季度盘点' : '日常盘点';

    // v216 Step 5.4：登录态下盘点人只读锁定，自动带出当前账号
    const logged = (typeof AppConfig !== 'undefined' && AppConfig.isLoggedIn) ? AppConfig.isLoggedIn() : false;
    const curUser = (typeof AppConfig !== 'undefined' && AppConfig.getCurrentUser) ? AppConfig.getCurrentUser() : null;
    const counterVal = logged && curUser ? curUser.username : (this.task.counter || '');
    const counterInput = logged
      ? `<label>盘点人 <input type="text" id="stCounter" value="${escAttr(counterVal)}" readonly style="width:110px;background:var(--bg-input,#f3f4f6);color:var(--text-secondary,#666);cursor:not-allowed;"></label>`
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
        ${batchNoText ? '<span>盘点号：<input type="text" readonly value="' + escAttr(batchNoText) + '" style="width:120px;background:var(--bg-input,#f3f4f6);color:var(--text-secondary,#475569);font-weight:600;cursor:not-allowed;border:1px solid var(--border-color,#cbd5e1);border-radius:6px;padding:2px 8px;"></span>' : ''}
        <button class="btn--primary" onclick="StocktakeModule.goBackFromSheet()" title="返回上一级（盘点工作台）" style="padding:4px 14px;font-size:12.5px;display:inline-flex;align-items:center;gap:5px;">
          <span style="font-size:14px;">◀</span>返回
        </button>
      </div>`
      : (isDailyStarted ? `
      <div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;background:var(--status-warning-bg,#fff7ed);border:1px solid #fed7aa;font-size:13px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>盘点人：<b>${esc(counterVal || '')}</b>${counterVal ? '（已自动带出）' : '<span style="color:#dc2626;">（未登录，请先登录库管员账号）</span>'}</span>
        ${batchNoText ? '<span>盘点号：<input type="text" readonly value="' + escAttr(batchNoText) + '" style="width:120px;background:var(--bg-input,#f3f4f6);color:var(--text-secondary,#475569);font-weight:600;cursor:not-allowed;border:1px solid var(--border-color,#cbd5e1);border-radius:6px;padding:2px 8px;"></span>' : ''}
        <span style="color:#b45309;font-size:12px;">⚠️ 本次盘点<b>尚未结束</b>：点【暂存并退出】只是存到本机（不计入盘点记录），全部盘完请点【结束本次盘点】才算完成</span>
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
        <!-- 🟢 v228.13：存货编码打通存货档案（点击跳转） -->
        <td>${TableUtils.link('stock', r.存货编码 || '', r.存货编码 || '')}</td>
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
    // 🟢 v228.35（P1）：「保存」语义拆分 + 明确未计入记录。
    //   原实现只有一个「💾 保存」，用户（尤其一线仓管）普遍理解为"存进盘点记录了"，
    //   实际只写本地草稿、不落库、不推云端 → 盘点人以为盘完了，管理员看到的进度还是 0，双方互相怀疑。
    //   现在：主按钮「🏁 结束本次盘点」（真正完成），副按钮「💾 暂存并退出」（暂停），
    //   并在进度条旁常驻一行说明，消除"我明明保存了"的认知落差。
    const hasFilled = rows.some(r => r.盘点数量 !== '' && r.盘点数量 != null);
    area.innerHTML = `
      ${claimHtml}
      ${progressBar}
      <div style="margin:0 0 8px;font-size:12.5px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span>ℹ️ 全部盘完后请点 <b style="color:var(--status-success,#16a34a);">结束本次盘点</b> 才算完成；中途有事点 <b>暂存并退出</b>，下次进入可继续。</span>
      </div>
      ${tableOrEmpty}
      ${emptyNote}
      <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <button class="btn--primary" onclick="StocktakeModule.finishStocktake()" title="全部盘完后点这里：数据落库并同步云端，任务才算完成">🏁 结束本次盘点</button>
        <button class="btn--ghost" onclick="StocktakeModule.saveToRecords({ thenBack: true })" title="仅暂存到本机，不计入盘点记录；下次进入可继续">💾 暂存并退出</button>
        <!-- 🟢 v228.41（优化项-3）：结束前「差异预警」—— 把「事后告知」变「事前预防」。
             旧实现只在点【结束本次盘点】的确认弹窗里才告诉用户「还有 N 项漏盘」，
             用户点之前无从得知；结束按钮旁常驻一行实时提示，随填写即时刷新。 -->
        <span id="stLeakHint" style="font-size:12.5px;color:#b45309;display:none;"></span>
        <span id="stDraftHint" style="font-size:12.5px;color:#b45309;${hasFilled ? '' : 'display:none;'}">当前已填内容尚未计入盘点记录，点「结束本次盘点」才算完成</span>
      </div>
    `;
    // 🟢 v228.41（优化项-3）：渲染后立即按当前填写状态刷新「未盘」预警
    this._refreshLeakHint();
    // 🟢 v227.91：移动端把表格列折叠按钮搬到原「清空已填」位置（progressBar）
    // 🟢 v228.69：先显式安装列折叠，再搬按钮。旧实现只依赖全局 MutationObserver → initColumnResizers
    //   链路异步挂载，而该链路里 initColumnResize 若先抛错（真机出现过「有排序箭头、无折叠按钮」），
    //   折叠按钮就永远装不上。这里在渲染完成后同步直装（保留列配置 stArea = 存货名称/规格型号/现存量/盘点数量，
    //   默认收起、可展开），全局链路后到时会因 #stArea 已带 _colCollapseBtn 而自动跳过，不会重复挂。
    try {
      const stTable = area.querySelector('table.data-table');
      if (stTable && rows.length > 0 && window.TableStickyOverlay && window.TableStickyOverlay.installColumnCollapse) {
        const wrap = stTable.closest('[id]') || stTable.parentElement;
        window.TableStickyOverlay.installColumnCollapse(wrap, stTable);
      }
    } catch (e) { /* 折叠安装失败不阻断主流程（表格仍可横向滑动查看） */ }
    this._relocateColCollapseToProgressBar();
    if (rows.length > 0) {
      this.updateProgress();
      this._bindKeyboard();   // v216 Step 6.2：Enter/↑↓ 在数量框间流动
    } else {
      this.updateProgress();
    }
    // 🟢 v228.39（P4）：若已被远程冻结（管理员正在结束本轮），renderTable 的 innerHTML 会覆盖横幅与输入态，
    // 重渲后重新锁输入 + 补横幅，避免解冻伪象。
    if (this._frozen) this._applyFreezeLockUI();
  },

  // ⚠️ AUDIT-228-04（v228.18）复核结论：本盘点主表**不接入** TableUtils.virtualTable。
  //   原因：它是交互式录入表 —— 每行含「盘点数量」输入框、Enter/↑↓ 键盘导航（_bindKeyboard）、
  //   逐行草稿保存。虚拟滚动只保留视口内的行，会同时破坏三件事：
  //     ① 键盘 ↑↓ 跳转（目标行不在 DOM）；
  //     ② 滚出视口后未保存的输入丢失（草稿机制按 DOM 内 input 取值）；
  //     ③ 列折叠按钮的 MutationObserver 定位（依赖 table 实际挂载位置）。
  //   只读展示型大表（存货档案 / 中心出库 / 订单 / 入库）已接入虚拟滚动，本表维持整表渲染。
  //   —— 若将来要做，需先改为「受控组件 + 值存内存 Map」，届时再启用。

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
    this._refreshDraftHint();
  },

  /**
   * 🟢 v228.35（P1）：同步「尚未计入盘点记录」提示条的显隐。
   *   为什么不在 renderTable 里重渲：盘点表格是交互式录入表，重渲会丢焦点、断键盘流，
   *   这里只切换一个 span 的显隐，零重排、不影响正在输入的用户。
   */
  _refreshDraftHint() {
    try {
      const span = document.getElementById('stDraftHint');
      if (!span) return;
      const has = (this.allRows || []).some(r => r.盘点数量 !== '' && r.盘点数量 != null);
      span.style.display = has ? '' : 'none';
    } catch (e) { /* 忽略：提示条只是辅助，失败不影响录入 */ }
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
    // 🟢 v228.41（优化项-3）：进度变化同步刷新结束前「未盘」预警
    this._refreshLeakHint();
  },

  // 🟢 v228.41（优化项-3）：结束前「未盘」实时预警 —— 结束按钮旁常驻提示尚有 N 项未盘。
  //   纯展示、只读 DOM 文本，不改任何数据；rows 为空/全盘完时隐藏。
  _refreshLeakHint() {
    const el = document.getElementById('stLeakHint');
    if (!el) return;
    const rows = this.visibleRows();
    if (!rows.length) { el.style.display = 'none'; el.textContent = ''; return; }
    const unfilled = rows.filter(r => !(r.盘点数量 !== '' && r.盘点数量 != null)).length;
    if (unfilled > 0) {
      el.textContent = '⚠️ 尚有 ' + unfilled + ' 项未盘（结束后可补盘）';
      el.style.display = '';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
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
    // 🟢 v228.68：占用规则以「盘点记录列表（stocktake_records，非 voided）」为唯一权威依据 ——
    //   用户明确要求：记录列表里没有前面批次的保存记录时，新批次号应复用最小未占用号，不递增。
    //   在此之上仅保留「当前正在生成的批次」的占用（防并发开局重号）。
    //   已结束、且记录列表里无对应记录的批次号一律释放；由此根治 jd20260919-2…-10 只增不减。
    let next = 1;
    const used = new Set();   // 已占用的当日序号（含 N=1 即 base）
    const bump = (no) => {
      if (!no || !String(no).startsWith(base)) return;
      const m = /^.+-(\d+)$/.exec(String(no));
      used.add(m ? parseInt(m[1], 10) : 1);
    };
    // (a) 盘点记录列表（真源）：非 voided 的当日同号都占号
    try {
      const allRecs = (DataStore._tableCache && DataStore._tableCache['stocktake_records']) || [];
      (allRecs || []).forEach(r => { if (r && !r.voided) bump(r.batchNo); });
    } catch (e) {}
    // (b) no_map：仅「当前批次（sheetId）且未结束」占号；其余未结束条目若无记录撑着则视为孤儿，
    //     在 persist 时物理删除、释放其号（避免 jd…-N 只增不减）。finished 条目不占号（记录有则已占）。
    let mapChanged = false;
    try {
      Object.keys(map).forEach(k => {
        const it = map[k];
        if (!it || !it.no) return;
        if (k === sheetId) { if (!it.finished) bump(it.no); return; } // 当前批次：进行中则占号
        if (!it.finished) {
          const m = /^.+-(\d+)$/.exec(String(it.no));
          const num = m ? parseInt(m[1], 10) : 1;
          if (used.has(num)) bump(it.no);            // 有记录撑着 → 保留
          else if (persist) { delete map[k]; mapChanged = true; } // 孤儿 → 释放
        }
        // finished 的其他条目：不占号（记录若有数据已由 (a) 占）
      });
      if (mapChanged) try { localStorage.setItem(MAP_KEY, JSON.stringify(map)); } catch (e) {}
    } catch (e) {}
    // (c) 旧版计数器（v226 之前写过 wb_stocktake_no_*）已废弃：在「记录表为权威依据」的新方案下
    //     它只会把号一路顶高（如把 base 顶成 -2），且记录表已完整覆盖其语义，故不再纳入占用计算。
    // 取最小未占用序号：1, 2, 3…直到找到第一个不在 used 里的
    next = 1;
    while (used.has(next)) next++;

    const finalNo = next <= 1 ? base : (base + '-' + next);
    // 🟢 v227.22：仅 persist=true 时落库。渲染阶段（_renderDailySetup）传 false，
    //    避免「只是打开看了一眼日常盘点」就往 no_map 写一个 finished:false/count:0 的孤儿号，
    //    否则默认区间每天平移导致 sheetId 变化 → 下拉反复冒出「新建·未开始」。真正落库在 beginDaily。
    if (sheetId && persist) {
      // 🟢 v228.40（一-1/一-2）：写入 updatedAt —— 云端按「较新者胜」合并批次号映射，缺它无法判定。
      map[sheetId] = { no: finalNo, type: type, finished: false, date: today, updatedAt: new Date().toISOString() };
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
    // 🟢 v228.35（P1）：确认文案去掉「保存」字样，改为「暂存并退出」，并明确"不计入盘点记录"。
    //   旧文案「确认暂停保存？」仍有用户理解成"已保存完成"，必须把"未计入记录"说到字面上。
    // 🟢 v227.11 P1-7：确认文案从 4 行压到 2 行；skipConfirm=true 时（如从「返回」自动保存）不重复弹确认
    const remain = unfilled.length;
    let tip = '将暂存 ' + filled.length + ' 条到本机（不计入盘点记录），退出后可继续盘点。';
    tip += remain
      ? '\n还有 ' + remain + ' 条未盘；全部盘完请回来点【结束本次盘点】才算完成。'
      : '\n所有行均已填写，建议直接点【结束本次盘点】完成本次盘点。';
    if (!opts.skipConfirm && !(await WBModal.confirm(tip, { title: '暂存并退出' }))) return;

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
      // 🟢 v228.35（P1）：toast 明确「未计入盘点记录」，与按钮文案形成闭环，消除"我明明保存了"的误解
      const leftTip = unfilled.length ? ('，还剩 ' + unfilled.length + ' 条未盘') : '，已全部填写，可直接结束盘点';
      this.toast('已暂存 ' + filled.length + ' 条到本机（未计入盘点记录）' + leftTip + syncTip);
      // 🟢 v228.40（二-6）修复：手动点【暂存并退出】确认后必须真正退出到季度盘点初始界面。
      //   旧实现只 toast + 清现场，停留在盘点界面，与「暂存并退出」字面语义相悖。
      //   opts.thenBack=true（手动路径）→ 保存完成后导航回初始界面；
      //   skipConfirm 路径（从「返回」弹窗的「保存并返回」）由调用方自己 _backToWorkbench()，
      //   这里不重复导航（否则会二次导航导致界面错乱）。
      if (opts.thenBack) {
        this._sheetTouched = null;
        this._skipResumePrompt = true;   // 返回后停在初始界面，不自动续盘
        this._backToWorkbench();
      }
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
  // 🟢 AUDIT-228-03：待补推队列写失败必须可见 —— 否则联网后不会补推，
  //   而 UI 已提示「已存本地待补推」，用户以为数据安全，实际永久停留在本地。
  _markPending(ids) {
    try {
      const s = new Set(this._getPending());
      (ids || []).forEach(i => s.add(i));
      return this._lsWrite(this.PENDING_KEY, JSON.stringify(Array.from(s)),
        { toast: '本地待补推队列写入失败，联网后可能无法自动补推，请检查存储空间' });
    } catch (e) {
      console.error('[stocktake] 标记待补推失败：', e && (e.message || e));
      return false;
    }
  },
  _clearPending(ids) {
    try {
      const s = new Set(this._getPending());
      (ids || []).forEach(i => s.delete(i));
      return this._lsWrite(this.PENDING_KEY, JSON.stringify(Array.from(s)));
    } catch (e) {
      console.error('[stocktake] 清理待补推标记失败：', e && (e.message || e));
      return false;
    }
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
      // 🟢 AUDIT-228-03：墓碑写失败 = 删除动作不会扩散到云端，他端会「复活」已删记录
      return this._lsWrite(this.TOMB_KEY, JSON.stringify(cur),
        { toast: '删除队列写入失败，其它设备可能仍保留该记录' });
    } catch (e) {
      console.error('[stocktake] 写入删除墓碑失败：', e && (e.message || e));
      return false;
    }
  },
  _clearTombs(recIds) {
    try {
      const left = this._getTombs().filter(t => (recIds || []).indexOf(t.recId) < 0);
      return this._lsWrite(this.TOMB_KEY, JSON.stringify(left));
    } catch (e) {
      console.error('[stocktake] 清理删除墓碑失败：', e && (e.message || e));
      return false;
    }
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
      // 🟢 v228.37：季度记录带入轮次命名（如「2026年第3季度」），记录列表可直接看出是哪一轮
      roundLabel: ctx.sheetType === 'quarter' ? (this._getRoundLabel(sheetId, this._getRoundNo(sheetId)) || '') : '',
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

  async finishStocktake(opts) {
    const _auto = !!(opts && opts.auto);   // 🟢 v228.74：远程结算时跳过确认弹窗（无人工在场）
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
    // 🟢 v228.40（二-2a）：结束确认文案 —— 有漏盘时明确告知「结束后可补盘」，与结束后的补盘语义闭环。
    const _leakTip = unfilled.length
      ? ('未盘点：' + unfilled.length + ' 条（以「/」保存，不计入盘亏）\n\n'
        + 'ℹ️ 结束后如有未盘项，系统会自动为你保留补盘入口，可随时补录漏盘（只列没盘过的编码）。')
      : '未盘点：0 条（本次全部盘完 🎉）';
    const ok = _auto ? true : await WBModal.confirm(
      '确认结束本次盘点？\n\n' +
      '盘点号：' + batchNoText + '\n' +
      '盘点人：' + counter + '\n' +
      '区间：' + rangeTxt + '\n' +
      '已盘（含为 0）：' + (filledReal.length + filledZero.length) + ' 条\n' +
      _leakTip,
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
      // 🟢 v228.40（二-3）：文案简化 —— 旧版「4 条实盘 + 0 条 0 + 2 条未盘」把 0 条项也拼进去，
      //   读起来像残缺公式。改为「N 条实盘 / M 条未盘」，0 条项直接省略，语义清晰。
      const _parts = [filledReal.length + ' 条实盘'];
      if (filledZero.length) _parts.push(filledZero.length + ' 条为 0');
      _parts.push(unfilled.length + ' 条未盘');
      this.toast(counter + ' · ' + rangeTxt + ' 已结束：' + _parts.join(' / ') + syncTip);
      // 🟢 v228.60：移除批次汇总快照生成 —— 「盘点批次汇总」模块已下线（stocktake-batch.js 已删除），
      //   该快照唯一的消费方是那个页面。生成它每次要 pull + push 整包 stocktake.json（约 1.06MB），
      //   属纯浪费。季度盘点页内的进度概览走 OVERVIEW_KEY 通道，与本链路完全独立，不受影响。
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
        if (mine && qtyCount > 0) {
          // 🟢 v228.35（P2）：带出进度与时间，供续盘横幅显示「已暂存 2/5 · 上次 14:20」
          const p = await this._unfinishedProgress(sheetId, sheetType, dCounter || counter, d, qtyCount);
          return Object.assign({ sheetId, sheetType, counter: dCounter || counter, reason: 'draft' }, p);
        }
      }
      // ①b 🟢 v226：存在「未结束的盘点会话」→ 保存只是暂停，必须点【盘点结束】才算完成。
      //     只要该会话属于同一 sheetId + 同一作业身份，无论有没有草稿都要提醒。
      const s = this._getOpenSession();
      if (s && s.sheetId === sheetId) {
        const sCounter = String((s && s.counter) || '').trim();
        const sMine = !sCounter || !counter || sCounter === counter;
        if (sMine) {
          const p = await this._unfinishedProgress(sheetId, sheetType, sCounter || counter,
            d, Object.keys((d && d.qty) || {}).length);
          return Object.assign({ sheetId, sheetType, counter: sCounter || counter, reason: 'session' }, p);
        }
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
          return { sheetId, sheetType, counter, reason: 'open', done: realDone, total,
                   lastAt: this._draftSavedAt(d), batchNo: (d && d.sheet && d.sheet.batchNo) || '' };
        }
      }
    } catch (e) { console.warn('[stocktake] 续盘检测异常:', e); }
    return null;
  },

  /**
   * 🟢 v228.35（P2）：未完成盘点的进度摘要。
   *   背景：旧版只在弹窗里说「你有未结束的盘点」，用户不知道盘了多少、上次什么时候盘的，
   *        一旦误点「放弃」这份工作就白做了。横幅要给出可判断的信息，人才敢放心点「继续」。
   *   返回 { done, total, lastAt, batchNo }；total 为 0 表示总数未知（日常盘点无分派任务）。
   */
  async _unfinishedProgress(sheetId, sheetType, counter, draft, draftQty) {
    const out = { done: draftQty || 0, total: 0, lastAt: this._draftSavedAt(draft),
                  batchNo: (draft && draft.sheet && draft.sheet.batchNo) || '' };
    try {
      // 已落库的实盘记录（续盘场景：上次结束前写入的记录同样算进度）
      const recs = (await DataStore.getStocktakeRecordsBySheet(sheetId)) || [];
      const doneSet = new Set();
      recs.filter(r => !r.voided && String(r.盘点人 || '').trim() === String(counter || '').trim())
          .forEach(r => {
            if (r.unfilled) return;
            if (r.盘点数量 === '' || r.盘点数量 == null) return;
            if (r.存货编码) doneSet.add(r.存货编码);
          });
      out.done = Math.max(out.done, doneSet.size);
      if (sheetType === 'quarter') {
        const allTasks = DataStore.getStocktakeTasks() || {};
        const mine = Object.keys(allTasks).map(k => allTasks[k]).filter(t =>
          t && t.counter === counter && !t.returned && !t.deleted &&
          this._taskInCurrentBatch(t, this.query.startDate, this.query.endDate));
        const open = mine.filter(t => t.status === 'open' || t.replenishAssigned || t.isReplenish);
        out.total = open.reduce((n, t) => n + ((t.codes || []).length || Math.max(0, (t.noEnd - t.noStart + 1))), 0);
      }
    } catch (e) { /* 忽略：进度只是提示，取不到就不显示 */ }
    return out;
  },

  /** 草稿最后保存时间（取草稿里的 updatedAt/savedAt，都没有则不给） */
  _draftSavedAt(draft) {
    try {
      const t = draft && (draft.updatedAt || draft.savedAt || (draft.sheet && draft.sheet.savedAt));
      return t ? String(t) : '';
    } catch (e) { return ''; }
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
    // 🟢 v228.40（二-5）修复：删除「检测到未结束的盘点」确认弹窗（用户明确要求删除）。
    //   旧行为：点【取消】会 clearDraft() 放弃本次盘点 —— 用户只是想回来接着盘，却要先过一道弹窗，
    //   误点一下就把草稿清了。现改为：静默恢复上次草稿继续盘（与用户确认口径一致）。
    //   注意：真正的「放弃本次盘点」仍由盘点界面内的【🗑️ 放弃本次盘点】按钮承担，语义不丢。
    if (info.sheetType === 'daily') {
      await this._continueDailyInternal(info);
    } else {
      await this._continueQuarterInternal(info);
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
      this._refreshDraftHint();           // 🟢 v228.35（P1）：续盘恢复草稿后同步提示条显隐
    } catch (e) { console.error('[stocktake] 续盘失败:', e); }
  },

  // 续盘：季度盘点
  async _continueQuarterInternal(info) {
    const sd = this.query.startDate, ed = this.query.endDate;
    const sheetId = info.sheetId;
    const allTasks = DataStore.getStocktakeTasks() || {};
    // 🟢 v228.68：同上 —— 续盘路径的「我的任务」也限定当前批次
    const myTasks = info.counter
      ? (DataStore.getMyOpenTasks(info.counter) || []).filter(t => this._taskInCurrentBatch(t, sd, ed))
      : [];
    this.batchNo = this._genBatchNo('quarter', sheetId);
    // 🟢 v228.40（一-1/一-2）：续盘同样回推批次号，保证多端同一号
    try { this._pushBatchCommonState(sheetId, this.batchNo); } catch (e) { /* 忽略 */ }

    // 🟢 v227.3：续盘时点「确定」后直接进入正式盘点界面，跳过任务选择器。
    //   找到本人在本批次第一个 open 任务 → 直接 _claimQuarterTask；找不到再回退到选择器
    //   （理论上 _detectUnfinished 命中说明一定有未完成任务，回退路径为防御）。
    const openTask = myTasks.find(t => t && t.sheetType === 'quarter' &&
      this._taskInCurrentBatch(t, sd, ed) && t.status !== 'closed');
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
        && this._taskInCurrentBatch(t, sd, ed)
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
      .filter(t => t && t.sheetType === 'quarter' && this._taskInCurrentBatch(t, sd, ed));
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
        点击【${s.sheetType === 'quarter' ? '季度盘点' : '日常盘点'}】继续；盘完必须点【结束本次盘点】才算完成本次盘点。
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
      // 🟢 v228.40（二-4）修复：备注必须随草稿一起落盘。
      //   旧实现只存 qty（盘点数量），用户「保存退出再进入」后备注全部被清空 ——
      //   因为重进时按草稿重建行、remark 取不到值。remarks 与 qty 同生命周期保存。
      const remarks = {};
      (this.allRows || []).forEach(r => {
        if (!r || r.存货编码 == null) return;
        if (r.盘点数量 !== '' && r.盘点数量 != null) qty[r.存货编码] = r.盘点数量;
        const nt = (r.备注 == null ? '' : String(r.备注));
        if (nt) remarks[r.存货编码] = nt;      // 只存非空，避免草稿膨胀
      });
      const key = this._draftKey(this.task.counter, this.sheet && this.sheet.sheetId);
      localStorage.setItem(key, JSON.stringify({
        sheet: this.sheet, task: this.task, qty: qty, remarks: remarks, updatedAt: new Date().toISOString()
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
    // 🟢 v228.40（二-4）：备注与数量一并从草稿恢复 —— 旧实现只恢复数量，备注被清空。
    const remarks = d.remarks || {};
    let n = 0;
    let nr = 0;
    this.allRows.forEach(r => {
      if (Object.prototype.hasOwnProperty.call(qty, r.存货编码)) {
        r.盘点数量 = qty[r.存货编码];
        const f = parseFloat(r.盘点数量);
        r.差异量 = isNaN(f) ? '' : (f - (parseFloat(r.现存量) || 0));
        n++;
      }
      if (Object.prototype.hasOwnProperty.call(remarks, r.存货编码)) {
        r.备注 = remarks[r.存货编码];
        nr++;
      }
    });
    if (n > 0) this.toast('已恢复上次未完成的 ' + n + ' 条盘点数量' + (nr ? '、' + nr + ' 条备注' : ''));
  },

  // 🟢 v228.03：离开盘点模块时保存现场快照（当前盘点单 / 行数据 / 查询区间 / 滚动位置），
  //   切回时按快照恢复，做到「离开前在哪，切回还在哪」。
  //   仅内存快照（不落盘）：刷新页面仍按既定行为回到初始界面。
  onLeave() {
    // 🟢 v228.66(C-3)：离开盘点模块即停全局轮询。旧版轮询一旦因「进过盘点模块」启动就
    //   永远挂后台，用户在订单/出库里忙一天它仍在 1.5s 烧流量（后台白烧）。
    //   回到盘点模块时 render() 会幂等重启 _startGlobalSync()，无副作用。
    try { this._stopGlobalSync(); } catch (e) { /* 忽略 */ }
    try {
      const content = document.getElementById('contentArea');
      this._viewSnapshot = {
        sheet: this.sheet || null,
        allRows: Array.isArray(this.allRows) ? this.allRows.slice() : [],
        allRowsFull: Array.isArray(this.allRowsFull) ? this.allRowsFull.slice() : [],
        query: Object.assign({}, this.query || {}),
        scrollTop: content ? content.scrollTop : 0,
        sheetTouched: this._sheetTouched || null
      };
    } catch (e) {
      console.warn('[stocktake] 保存现场快照失败(已忽略):', e && e.message);
    }
  },

  /** 🟢 v228.03：恢复离开前的滚动位置（渲染完成后下一帧执行，等 DOM 高度就位） */
  _restoreScroll() {
    const snap = this._viewSnapshot;
    if (!snap || !snap.scrollTop) return;
    requestAnimationFrame(() => {
      try {
        const content = document.getElementById('contentArea');
        if (content) content.scrollTop = snap.scrollTop;
      } catch (e) { /* 忽略 */ }
    });
  }
};
