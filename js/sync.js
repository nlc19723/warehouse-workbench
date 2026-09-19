// ============================================
// Supabase 云端同步接口（预留）
// ============================================

const SyncManager = {
  client: null,
  isOnline: false,
  config: null,
  BUCKET: (typeof AppConfig !== 'undefined' && AppConfig.supabase) ? AppConfig.supabase.bucket : 'workbench-data',
  // 🟢 v228.56：云端存储桶缺失检测（真机事故：Supabase 项目里 workbench-data 桶被删 →
  //   所有读写 404 → 启动拉取空转 20s+（用户体感"链接打不开"）、账号/批次/任务"全部消失"假象）。
  //   anon key 无权建桶（RLS 拒绝），程序只能【检测并明确告知】，桶必须由管理员在 Supabase
  //   控制台重建（Storage → New bucket → workbench-data → Public）。
  _bucketMissing: false,
  _noteStorageError(err) {
    try {
      const msg = String((err && (err.message || err.error || err)) || '');
      const code = String((err && err.statusCode) || '');
      // 🟢 v228.59：收紧判定 —— 私有桶对【匿名/公开 URL】请求会伪装成 NoSuchBucket/404，
      //   旧逻辑据此判定"桶不存在"会产生误导性红色告警（真机上桶明明正常，数据也能读）。
      //   现在只认「认证通道」明确返回的桶缺失，且必须真的走的是私有 SDK（client 已建立）。
      const viaAuthedChannel = !!(this.client && (err && (err.statusCode !== undefined || err.__isStorageError)));
      if (/bucket not found|nosuchbucket/i.test(msg) && (viaAuthedChannel || code === '404')) {
        if (!this._bucketMissing) {
          this._bucketMissing = true;
          console.error('[SyncManager] ⚠️ 云端存储桶缺失：' + this.BUCKET + '（请管理员在 Supabase 控制台重建同名 Public 桶）');
          if (typeof showToast === 'function') showToast('⚠️ 云端存储桶缺失（' + this.BUCKET + '），云端同步不可用，请联系管理员在 Supabase 控制台重建');
        }
        return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  },
  isBucketMissing() { return !!this._bucketMissing; },
  /**
   * 🟢 v228.57：主动探测云端桶是否可用（单次轻量 list，启动时用）。
   *   为什么需要：isBucketMissing() 是个「事后标记」——只有云端请求已经失败过一次才置位，
   *   启动时恒为 false，于是应用照样白等 8s+8s 超时，用户体感"链接打不开"。
   *   本方法是「事前探测」：开局花最多 1.5s（调用方超时）问一次桶在不在，不在就整体跳过云端阶段。
   *   返回 true=可用 / false=不可用（404 NoSuchBucket、鉴权失败、网络异常都视为不可用）。
   */
  /**
   * 🟢 v228.62：桶可用性探测 —— 加 5s 结果缓存，避免启动链路上重复探测。
   *
   *   背景（实测）：启动 30s 内出现 4 次 list，其中 2 次纯属重复探测——
   *     ① _connect() 内 verifyConnection() 一次；
   *     ② _syncFromCloudInBackground() 开头的 probeBucket() 一次（list('') 仅 limit:1）。
   *   二者判定的都是「桶能不能访问」这同一件事，且间隔 <1s → 结论必然相同。
   *   缓存后同一次启动只付 1 次探测成本。
   *
   *   注意：缓存时间刻意很短（5s），因为桶被删/被暂停是低频但需快速感知的事件，
   *   缓存太久会让「桶没了」的提示延迟出现。失败结果不缓存（下次仍会真实探测）。
   */
  async probeBucket() {
    try {
      const now = Date.now();
      if (this._probeOkAt && (now - this._probeOkAt) < 5000) return true;
      if (!this.client || typeof this.client.storage === 'undefined') return false;
      const { data, error } = await this.client.storage.from(this.BUCKET).list('', { limit: 1 });
      if (error) { this._noteStorageError(error); return false; }
      if (!Array.isArray(data)) return false;
      this._probeOkAt = now;   // 仅在**成功**时记录，失败每次真实探测（快速感知桶异常）
      return true;
    } catch (e) {
      this._noteStorageError(e);
      return false;
    }
  },
  _probeOkAt: 0,   // 🟢 v228.62：上次探测成功的时间戳（5s 内直接复用结论）
  FILE: (typeof AppConfig !== 'undefined' && AppConfig.supabase) ? AppConfig.supabase.file : 'data.json',
  BASE_FILE: (typeof AppConfig !== 'undefined' && AppConfig.supabase) ? AppConfig.supabase.baseFile : 'base.json',

  // 初始化：①此前手动保存过配置（localStorage.supabase_config）→ 直接用它重连；
  //         ②🟢 v227.99：无保存配置且用户未主动断开过 → 用「管理员覆盖 > 内置默认」凭证自动连接，
  //            登录页即显示「云端已同步」，无需再手动到「云端同步」里点保存。
  //         ③用户点过「断开连接」→ 记 wb_sync_user_disconnected=1，刷新/重启不再自动重连（尊重用户意图）。
  async init() {
    try {
      const saved = localStorage.getItem('supabase_config');
      let userDisconnected = false;
      try { userDisconnected = localStorage.getItem('wb_sync_user_disconnected') === '1'; } catch (e) { /* 隐私模式忽略 */ }
      if (saved) {
        this.config = JSON.parse(saved);
      } else if (!userDisconnected) {
        // 🟢 v227.99：自动连接（预填凭证来自 getEffectiveSupabase：管理员覆盖优先，否则内置 config.js 公开配置）
        const eff = (typeof AppConfig !== 'undefined' && typeof AppConfig.getEffectiveSupabase === 'function')
          ? AppConfig.getEffectiveSupabase() : null;
        if (eff && eff.url && eff.key) {
          this.config = { url: eff.url, key: eff.key, bucket: eff.bucket };
          this.BUCKET = this.config.bucket || (AppConfig.supabase && AppConfig.supabase.bucket) || 'workbench-data';
          try { localStorage.setItem('supabase_config', JSON.stringify(this.config)); } catch (e) { /* 隐私模式忽略 */ }
        }
      }
      if (this.config) {
        // v217：异步真实探测（不阻塞首屏），探测失败即离线，不再误报"已连接"。
        // 🟢 v226-fix：必须 await 连接探测完成，否则紧跟其后的 restoreOutboundFromSettings()
        //   会在 isOnline 仍为 false 时同步 return，导致「已连云端却拉不到出库列表」的竞态
        //   （表现为：设备 A 保存能推上云，设备 B 刷新却看不到）。
        await this._connect();
        this._bindNetworkEvents();
      }
    } catch (e) {
      console.warn('Sync config load failed:', e);
    }
    this.updateUI();
  },

  // 供「云配置」对话框预填：管理员覆盖凭证 > 内置默认凭证（🟢 v227.98 修复）。
  //   v214 曾因「需同步密码解锁」而清空预填；v227.37 删除解锁机制后此处漏改，
  //   导致打开「云端同步」弹窗 URL/Key 全空、用户被迫手敲冗长凭证。
  //   现改为预填 AppConfig.getEffectiveSupabase()（localStorage 管理员覆盖优先，否则内置 config.js 凭证）。
  //   预填≠自动上线：仍需用户主动点「保存并连接」才写入 supabase_config 并连接（与 init 注释一致）。
  getDefaultConfig() {
    if (typeof AppConfig !== 'undefined' && typeof AppConfig.getEffectiveSupabase === 'function') {
      try {
        const eff = AppConfig.getEffectiveSupabase();
        if (eff && eff.url && eff.key) return { url: eff.url, key: eff.key, bucket: eff.bucket };
      } catch (e) { /* 解析失败回退空值，由用户手填 */ }
    }
    return { url: '', key: '' };
  },

  // 内部连接（不暴露给外部，仅 init / online 事件内部调用）
  // v217 BUG-C 修复：过去只 createClient 就置 isOnline=true，而 createClient 对
  //   断网/错误 URL 几乎从不抛错，于是"刷新后没网也显示已连接"。
  //   现改为：先建客户端 → 真实探测 → 只有探测通过才算在线。
  // 🟢 v228.61（P0-A 附带根治：重复初始化读放大）：
  //   SyncManager.init() 全库有 5 个调用点（sync.js DOMContentLoaded、app.js:93、
  //   data-loader.js:109/253/657），每次 init 都 await _connect() → verifyConnection()
  //   → 1 次 list 探测。实测「静置 12 秒会看到 3 次 list」正是这个重复初始化造成的
  //   —— 它不属于轮询，但同样是无谓的读放大。
  //   本字段做「连接单飞」：已在线时再次 _connect 直接返回 true，不再重复建客户端 + 探测。
  //   注意：online 事件触发的【重连】语义不受影响 —— 那种场景 isOnline 必为 false，
  //   单飞条件不成立，仍会走完整探测。
  _connectPromise: null,
  async _connect() {
    if (!this.config || !this.config.url || !this.config.key) return false;
    // 浏览器层面已断网：直接判离线，不做无谓请求
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.isOnline = false;
      this.updateUI();
      return false;
    }
    // 🟢 v228.61：已在线且已有可用 client → 无需重复探测（幂等）
    if (this.isOnline && this.client) return true;
    // 🟢 v228.61：并发调用合并 —— 同一时刻多个 init 只跑一次探测
    if (this._connectPromise) {
      try { return await this._connectPromise; } catch (e) { return false; }
    }
    const run = (async () => {
      try {
        this.client = supabase.createClient(this.config.url, this.config.key, {
          auth: { persistSession: false },
          global: { headers: { 'x-client-info': 'warehouse-workbench' } }
        });
        const v = await this.verifyConnection();
        if (!v || !v.ok) {
          console.warn('[SyncManager] 自动重连探测失败:', v && v.reason);
          this.client = null;
          this.isOnline = false;
          this.updateUI();
          return false;
        }
      this.isOnline = true;
      this.updateUI();
      // 🟢 v228.62：连接成功后延迟预热云端键集（单次幂等，不阻塞连接返回）。
      //   与首屏渲染错峰 2.5s，避免和「拉 data.json / keepers」抢带宽。
      this._schedulePrimeCloudKeySet();
      // 🟢 v228.07：自动连接（含启动自动连接）成功后也拉取云端库管员账号并与本地合并（与手动 connect 一致），
      //   修复「换设备登录管理员后，权限设置里看不到云端已配置的库管员账号」——之前只有手动 connect 才拉取，
      //   新设备启动走的 _connect() 漏掉了这一步，导致本地 wb_keepers 始终为空。
      try {
        if (typeof AppConfig !== 'undefined' && typeof AppConfig.pullKeepersFromCloud === 'function') {
          AppConfig.pullKeepersFromCloud();
        }
      } catch (e) { console.warn('[sync.js] 账号拉取异常(已忽略):', e && e.message); }
      return true;
      } catch (e) {
        console.error('Supabase connect failed:', e);
        this.client = null;
        this.isOnline = false;
        this.updateUI();
        return false;
      }
    })();
    // 🟢 v228.61：单飞收口 —— 无论成功失败都清掉 in-flight 标记，让后续重连可再次发起
    this._connectPromise = run.finally(() => { this._connectPromise = null; });
    return this._connectPromise;
  },

  // v217 BUG-C：断网/恢复网络的实时感知
  _bindNetworkEvents() {
    if (this._netBound) return;
    this._netBound = true;
    const apply = () => {
      if (navigator.onLine === false) {
        if (this.isOnline) {
          this.isOnline = false;      // 客户端保留，恢复后可自动重连
          this.updateUI();
          if (typeof showToast === 'function') showToast('网络已断开，已切换为离线模式');
        }
      } else if (!this.isOnline && this.config) {
        this._connect();              // 静默重连，不打扰用户
      }
    };
    window.addEventListener('offline', apply);
    window.addEventListener('online', apply);
  },

  // 轻量探测：验证配置能否真正访问云端（创建 client 几乎不抛错，必须用真实请求兜底，
  // 否则填入非法 URL/key 也会误报"连接成功"——M4 修复）
  async verifyConnection() {
    if (!this.client) return { ok: false, reason: '客户端未初始化' };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      // 用 SDK 列目录探测：能列到桶即说明 URL + key + 桶权限真实有效
      const { data, error } = await this.client.storage.from(this.BUCKET).list('', { limit: 1 });
      clearTimeout(timer);
      if (error) {
        // 🟢 v228.56：桶缺失专项识别 —— 给出「去 Supabase 控制台重建桶」的可执行指引
        this._noteStorageError(error);
        if (this._bucketMissing) {
          return { ok: false, reason: '存储桶 ' + this.BUCKET + ' 不存在：请在 Supabase 控制台 → Storage → New bucket 重建名为 ' + this.BUCKET + ' 的 Public bucket' };
        }
        return { ok: false, reason: (error.message || '云端拒绝访问，请检查 URL / Key / 存储桶权限') };
      }
      return { ok: true };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, reason: '连接超时（10秒），请检查网络或 URL' };
      return { ok: false, reason: (e && e.message) || '云端不可达' };
    }
  },

  // 手动连接（从配置对话框保存时调用）
  async connect(url, key, bucket) {
    if (!url || !key) return false;
    try {
      this.client = supabase.createClient(url, key, {
        auth: { persistSession: false },
        global: { headers: { 'x-client-info': 'warehouse-workbench' } }
      });
      this.config = { url, key, bucket: bucket || (AppConfig.supabase && AppConfig.supabase.bucket) || 'workbench-data' };
      this.BUCKET = this.config.bucket;
      // 先创建客户端（几乎不会失败），再真实探测是否可达（M4）
      const v = await this.verifyConnection();
      if (!v.ok) {
        console.warn('[SyncManager] 连接探测失败:', v.reason);
        this.client = null;
        this.isOnline = false;
        this.updateUI();
        return false;
      }
      localStorage.setItem('supabase_config', JSON.stringify(this.config));
      this.isOnline = true;
      this._bindNetworkEvents();
      this.updateUI();
      // 🟢 v215：连接成功后补推此前离线保存的盘点记录（失败不影响连接本身，仅后台重试）
      try {
        if (typeof StocktakeModule !== 'undefined' && typeof StocktakeModule.retryPendingSync === 'function') {
          StocktakeModule.retryPendingSync();
        }
      } catch (e) { console.warn('[sync.js] 盘点补推异常(已忽略):', e && e.message); }
      // 🟢 v216：连接成功后拉取云端库管员账号并与本地合并（失败不影响连接本身）
      try {
        if (typeof AppConfig !== 'undefined' && typeof AppConfig.pullKeepersFromCloud === 'function') {
          AppConfig.pullKeepersFromCloud();
        }
      } catch (e) { console.warn('[sync.js] 账号拉取异常(已忽略):', e && e.message); }
      // 🟢 v227.37：连接成功后拉取云端「共享云配置」(cloudConfig) — 但本连接就是该配置的源头，跳过避免覆盖刚保存的值
      return true;
    } catch (e) {
      console.error('Supabase connect failed:', e);
      this.isOnline = false;
      this.updateUI();
      return false;
    }
  },

  // 断开连接
  disconnect() {
    this.client = null;
    this.isOnline = false;
    // v217：必须清掉内存配置，否则 online 事件会把它重新连上（用户已明确断开）
    this.config = null;
    try {
      localStorage.removeItem('supabase_config');
      // 🟢 v227.99：记录「用户主动断开」——下次启动不再被内置凭证自动重连；手动「保存并连接」时清除
      localStorage.setItem('wb_sync_user_disconnected', '1');
    } catch (e) {
    /* 隐私模式可能抛错，忽略 */ console.warn('[sync.js:106] 异常(已忽略):', e);
  }
    this.updateUI();
  },

  // 更新同步状态UI
  // 🟢 v227.71：四态——offline / connecting / online / syncing / error；后两态有脉冲反馈
  // 🟢 v227.99：同步刷新登录页脚注（#loginCloud）——探测完成可能晚于登录页渲染，不能让脚注停留旧状态
  // 🟢 v228.35（P10）：三态 + 「最后同步时间」——已同步 / 同步中 / 离线（本地已保存）。
  //   仓库弱网是常态，只说「已同步/未连接」无法回答用户最关心的「我这条数据到底传上去了没有」。
  //   因此：① 离线文案明确「本地已保存」，安抚数据不会丢；② 在线显示相对时间（刚刚/N 秒前/N 分钟前），
  //   让管理员能一眼看出同步是否卡住，不必来回切页面。
  updateUI() {
    const el = document.getElementById('syncStatus');
    const textEl = document.getElementById('syncStatusText');
    if (el && textEl) {
      if (this.isOnline) {
        el.classList.add('online');
        textEl.textContent = '已同步';
        this._markSynced();
      } else {
        el.classList.remove('online');
        textEl.textContent = '离线 · 本地已保存';
        this._renderAgo(null);
      }
    }
    const lc = document.getElementById('loginCloud');
    if (lc) {
      lc.classList.toggle('online', !!this.isOnline);
      lc.innerHTML = '<span class="dot"></span>' + (this.isOnline ? '云端已同步' : '云端未连接');
    }
  },

  // 🟢 v228.35（P10）：记录最后一次成功同步时间，并按相对时间渲染到状态条
  _lastSyncedAt: 0,
  _markSynced() {
    this._lastSyncedAt = Date.now();
    this._renderAgo(this._lastSyncedAt);
    // 每 20s 只重算一次相对时间，避免高频重排；页面隐藏时不渲染（省电）
    if (this._agoTimer) return;
    this._agoTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!this.isOnline) { clearInterval(this._agoTimer); this._agoTimer = null; return; }
      this._renderAgo(this._lastSyncedAt);
    }, 20000);
  },
  _renderAgo(ts) {
    const agoEl = document.getElementById('syncStatusAgo');
    if (!agoEl) return;
    if (!ts) { agoEl.hidden = true; agoEl.textContent = ''; return; }
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    let label;
    if (s < 10) label = '刚刚';
    else if (s < 60) label = s + ' 秒前';
    else if (s < 3600) label = Math.floor(s / 60) + ' 分钟前';
    else label = Math.floor(s / 3600) + ' 小时前';
    agoEl.hidden = false;
    agoEl.textContent = '· ' + label;
  },

  // 🟢 v227.71：临时状态切换（同步中 / 错误）。不会动 isOnline，最终状态以 updateUI() 为准
  //   state ∈ 'syncing' | 'error' | 'connecting' | null
  setSyncState(state, text) {
    const el = document.getElementById('syncStatus');
    const textEl = document.getElementById('syncStatusText');
    if (!el || !textEl) return;
    ['syncing','error','connecting'].forEach(s => el.classList.remove(s));
    if (state && ['syncing','error','connecting'].indexOf(state) !== -1) {
      el.classList.add(state);
    }
    if (typeof text === 'string') textEl.textContent = text;
    // 🟢 v228.35（P10）：进入同步中 → 隐藏相对时间（避免「同步中 · 3 分钟前」这种自相矛盾的组合）
    if (state === 'syncing') this._renderAgo(null);
  },

  // 显示配置对话框
  // 🟢 v227.37：内置权限门。未登录或无「云端同步」权限者一律拒绝（双保险，挡住绕过 UI 的直接调用）
  showConfigDialog() {
    if (typeof AppConfig === 'undefined' || typeof AppConfig.canAccessEntry !== 'function'
        || !AppConfig.canAccessEntry(
          (typeof AppConfig.getCurrentUser === 'function' && AppConfig.getCurrentUser()) ? AppConfig.getCurrentUser().username : '',
          'cloud')) {
      if (typeof WBModal !== 'undefined' && WBModal.alert) WBModal.alert('无权限：请联系管理员在「权限设置 → 编辑权限」中勾选「云端同步」');
      return;
    }
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    const modalOverlay = document.getElementById('modalOverlay');

    // 预填：已手动连接过用已存配置；否则用内置默认配置（避免用户手敲），但绝不自动上线
    const prefill = this.config && this.config.url ? this.config : this.getDefaultConfig();

    modalTitle.textContent = '云端同步';
    const statusIcon = this.isOnline ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:6px;"></span>' : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#94a3b8;margin-right:6px;"></span>';
    const statusText = this.isOnline ? '已同步 · 云端连接正常' : '未连接 · 请填写下方信息后点击保存并连接';
    modalBody.innerHTML = `
      <div style="width:100%;">
        <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px;line-height:1.5;">
          配置 Supabase 项目信息以启用云端数据同步。所有数据将在本地和云端之间自动双向同步。
        </p>
        <div id="syncStatusBanner" style="background:${this.isOnline ? 'linear-gradient(135deg,rgba(34,197,94,0.08),rgba(16,185,129,0.04))' : 'linear-gradient(135deg,rgba(148,163,184,0.08),rgba(148,163,184,0.04))'};border:1px solid ${this.isOnline ? 'rgba(34,197,94,0.2)' : 'rgba(148,163,184,0.15)'};border-radius:10px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;">
          ${statusIcon}
          <span style="font-size:12.5px;color:${this.isOnline ? '#166534' : '#475569'};font-weight:500;" id="syncConfigStatusText">${statusText}</span>
        </div>
        <div style="margin-bottom:10px;">
          <label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:3px;">Project URL</label>
          <input type="text" id="sbUrl" placeholder="https://xxxx.supabase.co" value="${escAttr(prefill?.url || '')}"
            style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;">
        </div>
        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:3px;">Anon Key</label>
          <input type="password" id="sbKey" placeholder="eyJ..." value="${escAttr(prefill?.key || '')}"
            style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;">
        </div>
        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:3px;">存储桶名（留空=默认 workbench-data）</label>
          <input type="text" id="sbBucket" placeholder="workbench-data" value="${escAttr(prefill?.bucket || 'workbench-data')}"
            style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;">
        </div>
        <div style="background:linear-gradient(135deg,rgba(2,132,199,0.07),rgba(14,165,233,0.03));border:1px solid rgba(2,132,199,0.15);border-radius:10px;padding:9px 14px;margin-bottom:12px;">
          <p style="font-size:11.5px;color:#0369a1;line-height:1.5;margin:0;">
            <b>📌 数据分离存储</b>：当前数据分为「<b>工作数据</b>」(data.json，日常累积) 与「<b>基准数据</b>」(base.json，系统底账) 两份，云端独立存放、互不覆盖。
          </p>
        </div>
        <div class="sync-act-group">
          ${this.isOnline ? `<button onclick="SyncManager.disconnect();SyncManager.hideConfigDialog();" class="sync-act-btn" style="background:linear-gradient(135deg,rgba(244,63,94,0.22),rgba(244,63,94,0.08));color:#be123c;border:1px solid rgba(244,63,94,0.25);">断开连接</button>` : ''}
          ${this.isOnline ? `<button onclick="SyncManager.manualPush()" class="sync-act-btn" style="background:linear-gradient(135deg,rgba(14,165,233,0.22),rgba(2,132,199,0.08));color:#0369a1;border:1px solid rgba(14,165,233,0.25);">📤 上传工作数据</button>` : ''}
          ${this.isOnline ? `<button onclick="DataLoader.markCurrentAsBase()" class="sync-act-btn" style="background:linear-gradient(135deg,rgba(34,197,94,0.22),rgba(16,185,129,0.08));color:#15803d;border:1px solid rgba(34,197,94,0.28);">📌 标记为基准</button>` : ''}
          <button onclick="SyncManager.saveConfig()" class="sync-act-btn" style="background:var(--primary);color:#fff;border:1px solid rgba(91,155,213,0.45);">💾 保存并连接</button>
        </div>
      </div>
    `;
    // 使用紧凑弹窗宽度
    document.getElementById('modal').classList.add('modal-compact');
    modalOverlay.classList.add('show');
  },

  hideConfigDialog() {
    document.getElementById('modalOverlay').classList.remove('show');
  },

  // 🟢 v227.37：删除同步密码解锁（云端凭证改为随 keepers 自动下发到所有设备，对话框只接受 URL/Key 输入）
  // 保留 _connect（init 内部用）、connect / saveConfig / disconnect 等核心接口不变

  async saveConfig() {
    const url = document.getElementById('sbUrl').value.trim();
    const key = document.getElementById('sbKey').value.trim();
    const bucket = document.getElementById('sbBucket').value.trim();
    if (!url || !key) {
      WBModal.alert('请填写完整的配置信息');
      return;
    }
    const ok = await this.connect(url, key, bucket);
    if (ok) {
      // 🟢 v227.99：手动连接成功 → 解除「主动断开」标记，恢复开机自动连接
      try { localStorage.removeItem('wb_sync_user_disconnected'); } catch (e) { /* 忽略 */ }
      this.hideConfigDialog();
      WBModal.alert('连接成功！数据将自动同步到云端。');
      // 🟢 v227.37：管理员保存云端配置后，自动把 URL/Key 上云（settings.cloudConfig），
      //   其他设备登录时通过 pullCloudConfigFromCloud 自动拉取并连接，无需手动配置。
      try {
        if (typeof AppConfig !== 'undefined' && AppConfig.isAdmin && AppConfig.isAdmin()
            && typeof AppConfig.syncCloudConfig === 'function') {
          AppConfig.syncCloudConfig();
        }
      } catch (e) { /* 上云失败不阻断 UI 提示 */ }
    } else {
      WBModal.alert('连接失败：云端不可达或凭证无效。请检查 Project URL、Anon Key 与存储桶权限后重试。');
    }
  },

  // ===== 云端数据存储（Supabase Storage 当文件柜）=====
  // 手动把当前本地数据上传到云端（已连接时可用）
  async manualPush() {
    if (!this.isOnline) { WBModal.alert('请先连接云端'); return; }
    if (typeof DataLoader === 'undefined' || !DataLoader.pushAllToCloud) {
      WBModal.alert('数据模块未就绪，请刷新页面后重试');
      return;
    }
    showLoading('正在上传数据到云端...');
    let ok = false;
    try {
      ok = await DataLoader.pushAllToCloud();
    } finally {
      hideLoading();
    }
    if (ok) {
      WBModal.alert('当前数据已上传到云端，部署/分享链接打开即自动更新。');
    } else {
      WBModal.alert('上传失败，请检查网络连接或存储桶权限（需开启 anon 可写）。');
    }
  },

  // 🟢 AUDIT-004：可取消延时（重试退避用）
  _sleep(ms) { return new Promise(res => setTimeout(res, ms)); },

  // 🟢 AUDIT-004：上传带「有界重试」——自愈瞬时网络抖动/超时，避免一次失败就静默 return false。
  //   不在此处弹 Toast：错误提示交给用户侧边界（manualPush / 导入自动推 / 出库增量同步）统一处理，
  //   以免重试途中多次打扰，也避免与 syncStocktake 的三次合并重试叠加报警。
  async _uploadWithRetry(path, dataObj, { maxAttempts = 3, timeoutMs = 30000 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const json = JSON.stringify(dataObj);
        const { error } = await this.client.storage
          .from(this.BUCKET)
          .upload(path, json, {
            contentType: 'application/json',
            upsert: true,
            cacheControl: '0',
            signal: controller.signal
          });
        if (error) {
          lastErr = error.message;
          console.error('[云端推送] 第 ' + (attempt + 1) + '/' + maxAttempts + ' 次失败:', error.message);
        } else {
          clearTimeout(timer);
          return true;
        }
      } catch (e) {
        lastErr = (e && e.message) || e;
        if (e && e.name === 'AbortError') console.warn('[云端推送] 超时(' + (timeoutMs / 1000) + 's)，准备重试');
        else console.error('[云端推送] 第 ' + (attempt + 1) + '/' + maxAttempts + ' 次异常:', e);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts - 1) await this._sleep(250 * (attempt + 1)); // 退避：250/500ms
    }
    console.error('[云端推送] 已重试 ' + maxAttempts + ' 次仍失败，最后错误:', lastErr);
    return false;
  },

  // 把全量数据打包推送到云端（覆盖式）
  // 🟢 v208 AUDIT-303 乐观锁：
  //   opts.expectedSavedAt —— 本机的同步基准（最后一次与云端对齐的 savedAt）。
  //     · 传 null 表示本机从未同步过：若云端已有数据则拒绝（防止本地旧数据抹掉云端）
  //     · 传具体值：云端 savedAt 不一致 → 返回 'conflict'，由调用方提示用户先拉取
  //   opts._existing      —— 调用方已拉取的云端 bundle，复用以免二次往返
  //   返回值：true 成功 / false 失败 / 'conflict' 版本冲突（未写入）
  async pushData(dataObj, opts) {
    if (!this.isOnline || !this.client) return false;
    // 🟢 v227.71：同步状态条进入 syncing 脉冲；成功后回 online，失败转 error
    this.setSyncState('syncing', '同步中…');
    const options = opts || {};
    if (options.expectedSavedAt !== undefined) {
      const existing = options._existing !== undefined
        ? options._existing
        : await this.pullDataPrivate();
      const cloudSavedAt = (existing && existing.savedAt) || null;
      if (options.expectedSavedAt === null) {
        if (cloudSavedAt) {
          console.warn('[乐观锁] 本机无同步基准，而云端已有数据（savedAt=' + cloudSavedAt + '），已拒绝覆盖');
          this.setSyncState('error', '同步冲突');
          return 'conflict';
        }
      } else if (cloudSavedAt && cloudSavedAt !== options.expectedSavedAt) {
        console.warn('[乐观锁] 云端 savedAt=' + cloudSavedAt + ' ≠ 本机基准 ' + options.expectedSavedAt + '，已拒绝覆盖');
        this.setSyncState('error', '同步冲突');
        return 'conflict';
      }
    }
    // 🟢 AUDIT-004：上传带重试（自愈瞬时失败）
    const ok = await this._uploadWithRetry(this.FILE, dataObj);
    this.setSyncState(ok ? null : 'error', ok ? '已同步' : '同步失败');
    return ok;
  },

  // 把"基准数据"单独推送到云端（与 data.json 工作数据分离存放）
  async pushBase(dataObj) {
    if (!this.isOnline || !this.client) return false;
    // 🟢 v227.71：同步状态条进入 syncing 脉冲
    this.setSyncState('syncing', '同步中…');
    const ok = await this._uploadWithRetry(this.BASE_FILE, dataObj);
    this.setSyncState(ok ? null : 'error', ok ? '已同步' : '同步失败');
    return ok;
  },

  // 从云端拉取"基准数据"（base.json）
  async pullBase() {
    if (!this.isOnline || !this.client || !this.config) return null;
    try {
      const url = `${this.config.url}/storage/v1/object/public/${this.BUCKET}/${this.BASE_FILE}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        headers: { 'apikey': this.config.key },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) {
        if (resp.status === 404 || resp.status === 400) return null; // 基准文件尚不存在
        console.warn('基准数据拉取 HTTP', resp.status);
        return null;
      }
      const text = await resp.text();
      return JSON.parse(text);
    } catch (e) {
      if (e.name === 'AbortError') console.warn('基准数据拉取超时(10s)，跳过');
      else console.warn('基准数据拉取异常:', e.message || e);
      return null;
    }
  },

  // 从云端拉取全量数据（使用原生 fetch，更稳定，10 秒超时）
  async pullData() {
    if (!this.isOnline || !this.client || !this.config) return null;
    try {
      const url = `${this.config.url}/storage/v1/object/public/${this.BUCKET}/${this.FILE}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        headers: { 'apikey': this.config.key },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) {
        if (resp.status === 404 || resp.status === 400) return null; // 文件还不存在
        console.warn('云端拉取 HTTP', resp.status);
        return null;
      }
      const text = await resp.text();
      return JSON.parse(text);
    } catch (e) {
      if (e.name === 'AbortError') console.warn('云端拉取超时(10s)，回退本地');
      else console.warn('云端拉取异常:', e.message || e);
      return null;
    }
  },

  // 用 SDK 私有下载读取（绕过公开 URL 的 CDN 缓存，适合刚写入后立即读回校验）
  async pullDataPrivate() {
    if (!this.isOnline || !this.client) return null;
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download(this.FILE);
      if (error || !data) return null;
      return JSON.parse(await data.text());
    } catch (e) { console.warn('私有拉取异常:', e); return null; }
  },

  async pullSettingsPrivate() {
    if (!this.isOnline || !this.client) return null;
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download('settings.json');
      if (error || !data) return null;
      return JSON.parse(await data.text());
    } catch (e) { return null; }
  },

  // 🟢 v228.44（P1 拆基线降轮询载荷）：季度基线独立文件 baseline.json。
  //   背景（实测）：settings.json 达 189KB，其中基线 wb_stocktake_quarter_baseline 独占 181.9KB（96%），
  //   而基线「每轮锁定一次后不再变化」；盘点轮询 3s 一次 → 每分钟白下载约 3.8MB 不变数据。
  //   拆分后轮询只读 settings.json（≈7KB），基线仅在开局/换轮时读一次并缓存。
  //   基线走「读-改-写 + 回读校验」同款防护（与 setSetting 一致），保证多端不互抹。
  BASELINE_FILE: 'baseline.json',
  // 🟢 与 getSettings 同款顺序：**先走私有 SDK 通道**（bucket 为私有时公开 URL 恒定 400，
  //    还会往控制台丢一堆加载失败噪音），公开 URL 仅在 SDK 网络层失败时兜底。
  //    另：文件不存在是「尚未迁移」的正常态，识别后直接判空，不再多打一次公开 URL。
  async getBaseline() {
    if (!this.isOnline || !this.client) return null;
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download(this.BASELINE_FILE);
      if (!error && data) return JSON.parse(await data.text());
      if (error && (String(error.statusCode) === '404' || /not found/i.test(String(error.message || '')))) return null;
    } catch (e) { /* SDK 网络层失败 → 公开 URL 兜底 */ }
    try {
      const url = `${this.config.url}/storage/v1/object/public/${this.BUCKET}/${this.BASELINE_FILE}?t=${Date.now()}`;
      const resp = await fetch(url, { headers: { apikey: this.config.key } });
      if (resp && resp.ok) return JSON.parse(await resp.text());
    } catch (e) { /* 忽略 */ }
    return null;
  },
  // 读取合并（远端并本机优先由调用方决定）；写入用「读-合并-写 + 回读校验」
  async setBaseline(map) {
    if (!this.isOnline || !this.client) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cur = (await this.getBaseline()) || {};
        const merged = Object.assign({}, cur, map || {});
        const stamp = Date.now();
        merged._updatedAt = stamp;
        const { error } = await this.client.storage
          .from(this.BUCKET)
          .upload(this.BASELINE_FILE, JSON.stringify(merged),
            { contentType: 'application/json', upsert: true, cacheControl: '0' });
        if (error) { console.error('基线写入失败:', error.message); return false; }
        // 回读校验：确认没有被其他设备插队覆盖
        const back = await this.getBaseline();
        if (back && back._updatedAt === stamp) return true;
        console.warn('[基线乐观锁] 被其它设备覆盖，重试第 ' + (attempt + 1) + ' 次');
      } catch (e) { console.error('基线写入异常:', e); return false; }
    }
    return true;   // 与 setSetting 同款：重试后仍不一致不阻塞用户（基线可重算兜底）
  },

  // 测试用：将云端读写重定向到 localStorage（隔离真实 Supabase 网络污染/缓存）
  // 不影响生产逻辑——仅替换底层 put/get，双版本/设置代码路径完全相同
  useLocalMock() {
    const LS_KEY = 'wb_mock_cloud_v1';
    const store = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    this._mockStore = store;
    const fakeFile = (path, obj) => { store[path] = JSON.stringify(obj); localStorage.setItem(LS_KEY, JSON.stringify(store)); };
    // 🟢 每次现读 localStorage：模拟云端必须是「多端共享」的一份数据。
    //    若沿用闭包里的 store 快照，A 标签写入后 B 标签读到的仍是自己启动时的旧副本，
    //    跨端链路（推云端 → 另一设备轮询拉回）在测试里永远验证不了。
    const readFile = (path) => {
      const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      return s[path] ? JSON.parse(s[path]) : null;
    };
    this.pushData = async (obj) => { fakeFile(this.FILE, obj); return true; };
    this.pushBase = async (obj) => { fakeFile(this.BASE_FILE, obj); return true; };
    this.pullData = async () => readFile(this.FILE);
    this.pullDataPrivate = async () => readFile(this.FILE);
    this.pullBase = async () => readFile(this.BASE_FILE);
    this.getSettings = async () => readFile('settings.json') || {};
    this.pullSettingsPrivate = async () => readFile('settings.json');
    // 🟢 v228.44：基线独立文件的 mock（保持测试隔离，不污染真实云端）
    this.getBaseline = async () => readFile(this.BASELINE_FILE);
    this.setBaseline = async (map) => {
      const cur = (readFile(this.BASELINE_FILE) || {});
      fakeFile(this.BASELINE_FILE, Object.assign({}, cur, map || {}, { _updatedAt: Date.now() }));
      return true;
    };
    this.setSetting = async (key, value) => {
      const cur = readFile('settings.json') || {};
      cur[key] = value; cur._updatedAt = Date.now();
      fakeFile('settings.json', cur); return true;
    };
    this.getSetting = async (key) => { const a = readFile('settings.json'); return a ? a[key] : undefined; };
    // 🟢 v228.61：单键直读的 mock —— 生产路径新增了 _readSettingFile / getSettingsKeys，
    //   不补 mock 的话测试模式下这两个方法仍走真实网络 → 会污染真实云端 settings/<key>.json，
    //   与 settings.json / data.json 的隔离失效（同 v227.86 踩过的坑）。
    this._readSettingFile = async (key) => { const a = readFile('settings.json'); return a ? a[key] : undefined; };
    // 🟢 v228.62：补预热相关 mock —— 测试模式下不得触网（否则 _connect 成功排期的预热
    //   会真的去 list 生产桶）。本地模拟的"云端键集"就是 settings.json 的顶层键。
    this._listSettingsKeys = async () => Object.keys(readFile('settings.json') || {});
    this._primeCloudKeySet = async () => {
      this._cloudKeySet = {};
      Object.keys(readFile('settings.json') || {}).forEach(k => { this._cloudKeySet[k] = true; });
      return true;
    };
    this._schedulePrimeCloudKeySet = () => {};
    this.getSettingsKeys = async (keys) => {
      const a = readFile('settings.json') || {};
      const out = {};
      (keys || []).forEach(k => { if (a[k] !== undefined) out[k] = a[k]; });
      return out;
    };
    // 🟢 v227.86：补 stocktake 包的 mock（之前 pushStocktake/pullStocktake 未覆盖，
    //   测试模式下走真实网络 → 可能污染真实云端 stocktake.json，与 settings.json/data.json 隔离失效）
    this.pullStocktake = async () => readFile(this.STOCKTAKE_FILE);
    this.pushStocktake = async (obj) => { fakeFile(this.STOCKTAKE_FILE, obj); return true; };
    console.log('[SyncManager] 已切换到 localStorage 模拟云端（测试模式）');
  },

  // ===== 设置数据层（settings.json，用户长期偏好/非导入数据）=====
  // 读取整个 settings 对象（不存在返回 {}）
  // v166 修复：改用「私有下载」绕过 Supabase 公开对象 CDN 缓存，
  // 否则刚写入的第三部分数据（出库列表/搜索历史）在启动恢复时读不到旧缓存 → 下行同步失效。
  // 公开 URL 仅作为 SDK 不可用时的降级。
  // 🟢 v227.84：公开 URL 降级路径也加 ?t=Date.now() 强制破缓存，
  //   否则 A 设备刚写入的 outbound_list 在 B 设备会被 CDN 命中旧版本 → 启动恢复时拿不到。
  SETTINGS_DIR: 'settings',
  _settingsKeyCache: null,
  _settingsKeyListTs: 0,
  async getSettings() {
    // 🟢 v228.51（P0 读解耦）：只在「浏览器明确离线」时放弃；
    //   SyncManager.isOnline 在移动端弱网下可能误判为 false，据此硬放弃会让同步永久冻结。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return (this._settingsKeyCache || {});
    if (!this.client || !this.config) return (this._settingsKeyCache || {});

    // ① 兼容：旧版整文件聚合 settings.json（应用偏好等低频键）仍读取
    // 🟢 v228.55：记录「本次读取是否真实触达云端」—— list 和 base download 全都失败
    //   意味着云端项目不可达（被暂停/删除/断网），此时读到的"空"是假象。
    //   调用方（如账号恢复 pullKeepersFromCloud）据此区分「云端没有」和「云端连不上」，
    //   否则会把"项目挂了"静默伪装成"云端没数据"，管理员误以为账号/数据被删。
    let readTouched = false;
    let base = {};
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download('settings.json');
      if (!error && data) { base = JSON.parse(await data.text()) || {}; readTouched = true; }
    } catch (e) { /* 忽略 */ }
    if (!base || typeof base !== 'object') base = {};

    // ② 🟢 v228.51（P1 根治 AUDIT-303）：每个设置键独立文件 settings/<key>.json，
    //    两设备写不同键 → 写不同文件 → 不再互相整文件覆盖（旧版读-改-写整包会互抹）。
    //    通过 .list(SETTINGS_DIR) 发现键集合，带 5s 缓存降低请求量；list 不可用时回退仅用 base。
    const now = Date.now();
    let keys;
    if (now - (this._settingsKeyListTs || 0) > 5000) {
      keys = [];
      try {
        const listed = await this._listSettingsKeys();   // 🟢 v228.62：抽成公共方法（与预热共用）
        if (listed) {
          readTouched = true;   // 🟢 v228.55 触达信号
          keys = listed;
          // 🟢 v228.61-fix4：把「云端真实存在的键集」记下来，供 _readSettingFile 判断
          //   某键有没有独立文件（避免对 outbound_list 这类老键反复发起注定 404 的下载）。
          //   只在 list 真实成功时更新；失败时保留上一次的集合（与 keys 的降级口径一致）。
          this._cloudKeySet = {};
          keys.forEach(k => { this._cloudKeySet[k] = true; });
        }
      } catch (e) { this._noteStorageError(e); /* list 不可用 → 走下方降级 */ }
      // 🟢 v228.54（分叉根治①）：list 失败/返回 error 时【绝不把键集当空】——
      //   旧版 keys 保持 []，merged 会丢掉全部分文件键（锚点/闸门/概览"看起来都不存在"），
      //   开盘时 _peekCloudActiveQuarter 因此误判「云端无批次」→ 两端各自开盘 → 批次分叉。
      //   降级：用本地缓存键集继续读（值沿用上次下载内容，下一次成功 list 会校正）。
      //   注意：仅当 list 真实成功且返回空数组时才允许 keys=[]（全新云端确实没有键）。
      if (!keys || !keys.length) {
        const cachedKeys = Object.keys(this._settingsKeyCache || {});
        if (cachedKeys.length) keys = cachedKeys;
      }
      this._settingsKeyListTs = now;
      if (!this._settingsKeyCache) this._settingsKeyCache = {};
      if (keys.length) {
        await Promise.all(keys.map(async (k) => {
          try {
            const { data, error } = await this.client.storage.from(this.BUCKET)
              .download(this.SETTINGS_DIR + '/' + k + '.json');
            if (!error && data) this._settingsKeyCache[k] = JSON.parse(await data.text());
            else if (error) this._noteStorageError(error);   // 🟢 v228.56：桶缺失检测
          } catch (e) { this._noteStorageError(e); /* 忽略 */ }
        }));
      }
    } else {
      keys = Object.keys(this._settingsKeyCache || {});
    }

    const merged = Object.assign({}, base);
    for (const k of (keys || [])) {
      if (this._settingsKeyCache[k] !== undefined) merged[k] = this._settingsKeyCache[k];
    }
    // 🟢 v228.62：记下整包结果的快照与时间戳 —— 供老键（outbound_list 等）走缓存读取，
    //   避免「读一个老键 → 触发一次 19 请求整包刷新」的启动期爆发（详见 getSetting 注释）。
    this._wholeSettingsCache = merged;
    this._wholeSettingsCache.__cachedAt = Date.now();
    this._lastSettingsReadOk = readTouched;   // 🟢 v228.55：true=本次至少一次真实触达云端；false=list+download 全失败（云端不可达）
    return merged;
  },

  // 🟢 v228.51（P1 根治 AUDIT-303）：每个键写独立文件 settings/<key>.json。
  //   旧版「读-改-写整包 + 乐观锁重试」只能缓解同机并发，跨设备写不同键仍会互抹；
  //   改为按键分文件后，跨设备写不同键天然互不干扰，写同键才是 last-writer-wins（可接受）。
  //   串行队列仍保留，避免同一键的两次上传重叠。
  _settingQueue: Promise.resolve(),
  _settingPending: null,

  setSetting(key, value) {
    // ① 已有同 key 项在排队 → 合并它的值，复用同一个 Promise（不新增网络往返）
    if (this._settingPending && this._settingPending.key === key) {
      this._settingPending.value = value;
      return this._settingPending.promise;
    }
    // ② 不同 key（或队列空闲）→ 新建排队项，串到队列尾部
    let resolveFn;
    const promise = new Promise(res => { resolveFn = res; });
    const item = { key, value, promise, resolve: resolveFn };
    this._settingPending = item;
    this._settingQueue = this._settingQueue.then(async () => {
      // 执行时取最新值：排队期间可能被后续同 key 调用更新过
      const k = item.key, v = item.value;
      if (this._settingPending === item) this._settingPending = null;
      let r = false;
      try { r = await this._writeSettingFile(k, v); }
      catch (e) { console.error('[sync] 设置写入队列执行异常:', e); r = false; }
      item.resolve(r);
    });
    return promise;
  },

  async _writeSettingFile(key, value) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    if (!this.client || !this.config) return false;
    try {
      const path = this.SETTINGS_DIR + '/' + key + '.json';
      const { error } = await this.client.storage.from(this.BUCKET)
        .upload(path, JSON.stringify(value), { contentType: 'application/json', upsert: true, cacheControl: '0' });
      if (error) { this._noteStorageError(error); console.error('设置写入失败:', error.message); return false; }
      if (!this._settingsKeyCache) this._settingsKeyCache = {};
      this._settingsKeyCache[key] = value;   // 乐观本地缓存，下一次 getSettings 会校正
      return true;
    } catch (e) { this._noteStorageError(e); console.error('设置写入异常:', e); return false; }
  },

  // ==================================================================
  // 🟢 v228.61（P0-A 读放大根治）：单键直读 —— 读一个键只下一个文件
  //
  //   问题（实测数据）：
  //     旧版 getSetting(key) 直接 await getSettings()，而 getSettings() 是
  //     「下载整包 settings.json + list 目录 + 并发下载全部 14 个分键文件」。
  //     于是「要一个键」的代价 = 15 次下载。
  //     轮询 _pollOnce 一轮串了 4~5 次全量读 → 实测 19 请求 / 1.63s（每 3 秒一次）；
  //     管理员「分派任务」前置读 = 17 请求 / 837ms。
  //
  //   方案：settings/<key>.json 本来就是按键盘独立的文件（v228.51 已分文件），
  //     读单个键根本不需要 list，也不需要下载别的键。直接 download 这一个文件即可。
  //
  //   ⚠️ 与 getSettings() 的缓存关系（重要，别踩坑）：
  //     · _settingsKeyCache 仍是唯一权威缓存，单键读也写它；
  //     · _settingsKeyListTs【不再被单键读刷新】—— 5s 键集缓存只由 getSettings() 管；
  //     · navigator.onLine===false 时命中缓存则直接返回缓存（与 getSettings 同款降级）；
  //     · 云端返回错误（含私有桶伪装 NoSuchBucket / 被删）时【不清缓存】，返回缓存值，
  //       避免一次抖动把 UI 上的锚点/闸门读成 undefined → 误判「云端无批次」。
  //
  //   @returns {Promise<*>} 键值；键不存在返回 undefined；网络异常返回缓存值或 undefined
  // ==================================================================
  _keyTsCache: null,       // { [key]: 上次成功读取时间戳 } —— 单键短缓存用
  _keyEpochCache: null,    // { [key]: 写入该时间戳时所属的「轮询轮次」 } —— 见 _keyTsCache 注释
  // 🟢 v228.64（P2 修正 TTL 语义错配）：TTL 从「纯时间」改为「时间 + 轮次」双判据。
  //   旧注释写着「短于轮询周期(3s)，保证新鲜」，但实测（docs/季度盘点同步链路实机走查报告.md
  //   §四 缺陷 6-4）同一键在**一轮**内被读 14 次、其中仅 ~10 次真正下网，
  //   说明缓存有时跨轮存活 —— 表现为「本该每轮都拿到新值，实际隔轮才更新」。
  //   TTL=2000 在旧周期 3000 下勉强成立，但只要轮询周期抖动或被压缩就会穿透。
  //   现改为：同一「轮次」内允许命中缓存（省掉同轮重复请求），
  //   **轮次一变立即失效**（保证每轮至少下网一次拿最新值），语义清晰且不依赖时间精度。
  _KEY_TTL_MS: 2000,       // 保留作为「跨轮次时的最长保护期」，见下方 ② 的双判据
  /**
   * 🟢 v228.64：标记新一轮轮询开始 —— 清空同轮缓存判定基准。
   *   调用点：StocktakeModule._pollOnce() 每轮开头（其他模块不轮询，无需调用）。
   *   不使用全局时间戳，而是「轮次自增」：避免 setTimeout 被压缩/时钟漂移导致的误命中。
   */
  beginReadRound() {
    this._readRound = (this._readRound || 0) + 1;
    // 🟢 v228.64（P1-1 落地）：开启一个「绕过 CDN」的读取窗口。
    //   实测（docs 走查报告 + 本次对照实验）：写入后 Supabase Storage 的 CDN 会持续
    //   3~10s 返回旧内容，而**轮询的目的恰恰是拿最新值** —— CDN 在这里是有害的。
    //   对照实验（三轮，写入后 +0.5/+1.5/+3s 各读一次）：
    //     A) SDK download()         → 3/3 拿到旧值 ❌
    //     B) 裸 fetch + no-store    → 3/3 拿到旧值 ❌
    //     C) fetch + ?t=时间戳      → 3/3 拿到新值 ✅（+0.5s 即可，~270ms）
    //   故轮询轮次内一律走 C。窗口取 1200ms：覆盖一轮内所有并发读（一轮 1500ms），
    //   又不至于污染非轮询路径（启动/手动刷新仍吃 CDN 加速）。
    this._bustUntil = Date.now() + 1200;
    return this._readRound;
  },

  /**
   * 🟢 v228.64：绕过 CDN 直读一个分键（cache-buster）。
   *   SDK 的 download() 不接受 query 参数，故对公开可读的 bucket 直接用 fetch 打 object URL。
   *   任何一步失败都【静默降级为 null】，由调用方回落到 SDK 路径 —— 绝不引入新的失败面。
   *   @returns {Promise<*>} 解析后的值；失败返回 null
   */
  async _readSettingFileBusted(key) {
    try {
      if (!this.client || !this.config || !this.config.url || !this.config.key) return null;
      const url = this.config.url + '/storage/v1/object/' + this.BUCKET + '/'
        + this.SETTINGS_DIR + '/' + encodeURIComponent(key) + '.json?t=' + Date.now();
      const H = { apikey: this.config.key, Authorization: 'Bearer ' + this.config.key };
      const r = await fetch(url, { headers: H, cache: 'no-store' });
      if (!r.ok) return null;                       // 404 = 键真的没有，交给调用方处理
      const txt = await r.text();
      if (!txt) return null;
      return JSON.parse(txt);
    } catch (e) {
      return null;                                  // 网络/CORS/解析异常 → 静默降级
    }
  },
  // 🟢 v228.61-fix1：分键不存在的键（老键，只活在整包 settings.json 里）—— 记入名单后
  //   后续直接走整包缓存，不再每次发起注定 404 的分键请求 + 整包兜底（否则每轮多付 1 次全量读）。
  //   实测名单成因：outbound_list / temp_outbound_list 是 v228.51 分文件之前的遗留键。
  //
  //   🔴 v228.61-fix4（真机实测修正）：初版靠解析 storage error 判 404 来建名单，但
  //   Supabase SDK v55 的 StorageUnknownError 把原始错误**整个丢掉了**（实测
  //   error.originalError 是空对象 {}，statusCode/status 皆为 null，message 是 "{}"），
  //   客户端无从得知 HTTP 状态 —— 名单永远建不起来。
  //   改为**由 list 结果驱动**：getSettings() 每次成功 list 都把真实存在的键集记到
  //   _cloudKeySet，_readSettingFile 查这个集合即可准确判断「该键有没有独立文件」，
  //   零额外请求、且比逐键试错更准（list 本身已有 5s 缓存）。
  //   _legacyKeySet 仅作为「已知不在 list 里」的显式名单保留（手工兜底/跨版本兼容）。
  _legacyKeySet: null,     // { [key]: true }
  _cloudKeySet: null,      // { [key]: true } —— 由 list 结果填充（云端 settings/ 真实存在的键）
  _keyPrimePromise: null,  // 🟢 v228.62：_primeCloudKeySet 在途 Promise（并发单飞）
  _keyPrimeScheduled: false, // 🟢 v228.62：延迟预热是否已排期（避免重复排期）

  /**
   * 🟢 v228.62：惰性预热「云端真实键集」—— 单次、幂等、失败可重试。
   *
   *   背景（真机实测）：_cloudKeySet 只在 getSettings() 成功 list 后才被填充，而 v228.61 的
   *   优化目标恰恰是「把 getSettings() 移出轮询」→ 稳态下再无任何路径触发它 →
   *   键集永远为空 → _legacyKeySet 建不起来 → outbound_list / temp_outbound_list 每轮
   *   各付 1 次注定 404 的下载（实测 t=20083ms / t=20291ms 两条）。
   *
   *   修法：启动后延迟预热一次（错开首屏渲染高峰），一次 list 拿下两件事：
   *     ① 云端真实键集 _cloudKeySet（用来判老键，省掉注定 404 的下载）；
   *     ② 整包缓存 _wholeSettingsCache（老键的唯一取数来源，见 getSetting 注释）。
   *   一次预热替代「两个老键各触发一次 19 请求整包刷新」，启动期净省 38 个请求。
   *
   *   - 幂等：_cloudKeySet 已存在则直接返回；
   *   - 并发安全：在途时复用同一 Promise（_keyPrimePromise）；
   *   - 不阻塞：调用方无需 await；
   *   - 失败静默：下次 connect / 手动同步会自然重试，不引入新的失败面。
   */
  async _primeCloudKeySet() {
    if (this._cloudKeySet) return true;
    if (this._keyPrimePromise) {
      try { return await this._keyPrimePromise; } catch (e) { return false; }
    }
    const run = (async () => {
      try {
        if (!this.client || !this.config) return false;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
        const keys = await this._listSettingsKeys();
        if (!keys || !keys.length) return false;   // 空结果不认，避免误把全部键判为老键
        this._cloudKeySet = {};
        keys.forEach(k => { this._cloudKeySet[k] = true; });
        // 🟢 v228.62：顺带把整包读进缓存 —— 老键（outbound_list / temp_outbound_list）只从这里取数。
        //   放在预热里做，是因为启动链路的 restoreOutboundFromSettings() 紧接着就要用，
        //   而它自己不再触发整包刷新（否则就是本次修掉的那个 19×2 请求爆发）。
        //   失败不影响键集预热结果（老键这一次取不到值，调用方本就容忍）。
        try { await this.getSettings(); } catch (e) { /* 整包预热失败不阻断 */ }
        return true;
      } catch (e) {
        return false;
      }
    })();
    this._keyPrimePromise = run.finally(() => { this._keyPrimePromise = null; });
    return this._keyPrimePromise;
  },

  /** 🟢 v228.62：延迟 + 幂等地排一次键集预热（重复调用无副作用）。 */
  _schedulePrimeCloudKeySet() {
    if (this._keyPrimeScheduled || this._cloudKeySet) return;
    this._keyPrimeScheduled = true;
    const run = () => { this._primeCloudKeySet().catch(() => {}); };
    if (typeof setTimeout === 'function') setTimeout(run, 2500);
    else run();
  },

  /** list 出 settings/ 下的真实键名（只读 list，不下载内容）。抽出来供 getSettings 与预热共用。 */
  async _listSettingsKeys() {
    const { data, error } = await this.client.storage
      .from(this.BUCKET)
      .list(this.SETTINGS_DIR, { limit: 200 });
    if (error) { this._noteStorageError(error); return null; }
    if (!data || !Array.isArray(data)) return null;
    return data
      .map(o => (o && o.name) || '')
      .filter(n => n && n.endsWith('.json'))
      .map(n => n.slice(0, -5))
      .filter(Boolean);
  },

  /**
   * 🟢 v228.66(P2/C-2)：取 settings 目录各文件的 {name, updated_at}（不下载内容）。
   *   供轮询做「廉价变更探测」——整轮无变更则跳过重下载。
   *   失败/不可用时返回 null，调用方据此回退到「照常全读」，绝不引入新的失败面。
   */
  async getSettingsMeta() {
    if (!this.client || !this.config) return null;
    try {
      const { data, error } = await this.client.storage
        .from(this.BUCKET)
        .list(this.SETTINGS_DIR, { limit: 200 });
      if (error || !Array.isArray(data)) return null;
      return data
        .filter(o => o && o.name)
        .map(o => ({ name: o.name, updated_at: o.updated_at || null }));
    } catch (e) { return null; }
  },

  /**
   * 🟢 v228.66(P2/C-1)：廉价取单个对象的元数据（updated_at/size），不下载内容。
   *   用于「引导同步前先判断云端是否真的变了」，避免每次开机都下 18MB 整包只为读 savedAt。
   *   fileName 支持「目录/文件名」形式；失败/不存在返回 null（调用方回退到「照常全下」）。
   */
  async getObjectMeta(fileName) {
    if (!this.client || !this.config || !fileName) return null;
    try {
      const slash = fileName.indexOf('/');
      const dir = slash >= 0 ? fileName.slice(0, slash) : '';
      const name = slash >= 0 ? fileName.slice(slash + 1) : fileName;
      const { data, error } = await this.client.storage
        .from(this.BUCKET)
        .list(dir || '', { limit: 200 });
      if (error || !Array.isArray(data)) return null;
      const hit = data.find(o => o && o.name === name);
      if (!hit) return null;
      return {
        name: hit.name,
        updated_at: hit.updated_at || null,
        size: (hit.metadata && hit.metadata.size) ? Number(hit.metadata.size) : (hit.size || null)
      };
    } catch (e) { return null; }
  },

  async _readSettingFile(key) {
    if (!key) return undefined;
    if (!this._keyTsCache) this._keyTsCache = {};
    if (!this._legacyKeySet) this._legacyKeySet = {};
    const cached = this._settingsKeyCache ? this._settingsKeyCache[key] : undefined;

    // ⓪ 🟢 v228.62：键集尚未就绪且预热未排期 → 顺手排一次（幂等）。
    //   正常情况连接成功时已经排过；这里是「连接路径没跑到（如 mock / 手动 setConfig）」的兜底，
    //   保证老键名单最终一定建得起来，不会永远每轮付一次注定 404 的下载。
    if (!this._cloudKeySet && !this._keyPrimeScheduled) this._schedulePrimeCloudKeySet();

    // ⓪-1 已知没有独立文件的键（老键）→ 不发起注定 404 的请求，直接返回缓存
    //   （调用方 getSetting 会据 _legacyKeySet 走整包兜底）
    if (this._legacyKeySet[key]) return cached;

    // ⓪' 🟢 v228.61-fix4：用 list 得到的「云端真实键集」判断 —— 不在集合里说明该键
    //   没有独立文件（如 outbound_list / temp_outbound_list），直接记名单并返回缓存，
    //   省掉一次注定失败的下载。集合为空（还没 list 过）时不做判断，正常走下载。
    if (this._cloudKeySet && !this._cloudKeySet[key]) {
      this._legacyKeySet[key] = true;
      return cached;
    }

    // ① 明确离线 → 有缓存用缓存，无缓存给 undefined（不发起注定失败的网络请求）
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return cached;
    }
    if (!this.client || !this.config) return cached;

    // ② 短缓存命中：同一轮轮询里对同一键的多次读取不再重复下网
    //    🟢 v228.64：判据从「纯时间」升级为「同一轮次 **且** 未超 TTL」。
    //      · _readRound 由 StocktakeModule._pollOnce() 每轮开头 beginReadRound() 自增；
    //      · 轮次不同 → 缓存立即失效（每轮必下网一次，保证新鲜度）；
    //      · 轮次相同 → 仍受 TTL 保护（同轮内极端密集读不至于刷爆）；
    //      · _readRound 为 undefined（非轮询场景，如用户点「刷新」）→ 退回纯时间判定，行为不变。
    const now = Date.now();
    if (this._keyTsCache[key] && (now - this._keyTsCache[key]) < this._KEY_TTL_MS) {
      const sameRound = (this._readRound === undefined)
        || (this._keyEpochCache && this._keyEpochCache[key] === this._readRound);
      if (sameRound) return cached;
    }

    // 🟢 v228.64（P1-1）：轮询轮次内先试 cache-buster 直读（绕过 CDN 旧值）。
    //   拿到值就直接采用；返回 null（键不存在 / 任何异常）则**完全退回原路径**，
    //   行为与改动前一致 —— 这是一条纯增益的旁路，不改变任何失败语义。
    let val = null;
    if (this._bustUntil && Date.now() < this._bustUntil) {
      try { val = await this._readSettingFileBusted(key); } catch (e) { val = null; }
    }
    if (val === null || val === undefined) {
      try {
        const { data, error } = await this.client.storage.from(this.BUCKET)
          .download(this.SETTINGS_DIR + '/' + key + '.json');
        if (error || !data) {
          if (error) this._noteStorageError(error); // 🟢 v228.56：桶缺失检测
          // 🟢 v228.61-fix4：读取失败**不**据此判定「键不存在」（SDK 丢掉了 HTTP 状态，
          //   无法区分 404 与网络抖动/超时/权限错误，误判会导致该键永久读不到更新）。
          //   键的存在性判断已由 ⓪' 的 list 键集负责。
          return cached;                            // 🔴 读取失败绝不清缓存（避免假"空"）
        }
        val = JSON.parse(await data.text());
      } catch (e) {
        this._noteStorageError(e);
        return cached;                              // 异常同样保留缓存
      }
    }

    if (!this._settingsKeyCache) this._settingsKeyCache = {};
    this._settingsKeyCache[key] = val;
    this._keyTsCache[key] = Date.now();
    // 🟢 v228.64：记录本次下载发生在哪一轮，供 ② 的同轮判定使用
    if (this._readRound !== undefined) {
      if (!this._keyEpochCache) this._keyEpochCache = {};
      this._keyEpochCache[key] = this._readRound;
    }
    // 🟢 v228.61-fix4：下载成功 → 确信该键有独立文件，补进键集（自愈 list 未覆盖的情况）
    if (this._cloudKeySet) this._cloudKeySet[key] = true;
    return val;
  },

  /**
   * 读取单个设置键。
   * 🟢 v228.61（P0-A）：改走单键直读（1 次请求）—— 旧版走 getSettings()（15 次请求）。
   *   语义完全保持：键不存在返回 undefined；云端不可达时返回本地缓存（可能是 undefined）。
   *
   *   🟢 v228.61-fix2：旧版这里用实例级 `_keyReadTouched` 判断「云端确实没有这个键」，
   *   但那是**共享可变标志**：并发的单键读会互相覆盖它（实测一轮里它在 true/false 间乱跳），
   *   于是「明明读到了却以为没读到」→ 无谓走整包兜底（每轮多 15 请求）。
   *   改为：直接用返回值判断 —— 拿到值就返回；只有 undefined 才考虑兜底，
   *   而「undefined 且该键是已知老键」才真正走整包。彻底去掉共享标志。
   */
  async getSetting(key) {
    const v = await this._readSettingFile(key);
    if (v !== undefined) return v;
    // 走到这里 = 分键没有值。两种可能：
    //   ① 老键（只存在于整包 settings.json）→ 必须查整包，且查一次即够（_legacyKeySet 会记住）
    //   ② 云端确实没有这个键 → 查整包也拿不到，但一次整包查询是必要代价（无法预先区分）
    // 注意：这里不做「每轮都查」，因为 _settingsKeyCache 命中时 getSettings() 的 list 有 5s 缓存，
    //   但为稳妥（避免把整包查询挂在 3s 轮询上），只对【已知老键】放行整包，其余直接返回 undefined。
    //
    //   🔴 v228.62（真机实测回归修复，重要）：老键**不得**触发整包刷新，只读整包缓存。
    //     缺陷现象：启动后每约 6s 出现一次「settings.json + list + 17 个分键」的 19 请求爆发，共两轮。
    //     根因链：app.js 启动顺序里连续调用
    //         DataStore.restoreOutboundFromSettings()      → getSetting('outbound_list')
    //         DataStore.restoreTemporaryOutboundFromSettings() → getSetting('temp_outbound_list')
    //       这两个键恰恰是【没有独立文件的老键】（只活在整包 settings.json 里），于是各自
    //       落到下面这条兜底分支，各自 getSettings() 一次 —— 而 getSettings() 是
    //       「download settings.json + list + 并发下载全部 17 个分键」= 19 请求。
    //       两个老键 → 两轮 19 请求 = **每次启动白付 38 个请求**，这才是「同步慢」的真凶之一，
    //       也是 v228.61 报告里「单轮 8 请求」没能反映出来的隐藏路径。
    //
    //     修法：整包刷新是「全局一次性」的资源，不该由「读一个键」来触发。
    //       老键只读【已有的】整包缓存（_settingsKeyCache 里的 settings.json 合并结果）；
    //       缓存没有就返回 undefined —— 调用方（如出库恢复）本就允许拿不到值，
    //       而真正的整包刷新由启动链路 / 手动同步 / listen 缓存过期各自负责。
    if (this._legacyKeySet && this._legacyKeySet[key]) {
      const whole = this._wholeSettingsCache;
      if (whole && whole.__cachedAt && (Date.now() - whole.__cachedAt) < this._WHOLE_TTL_MS) {
        return whole[key];
      }
      return undefined;
    }
    return undefined;
  },

  /** 整包（settings.json + 全部分键）缓存的合并结果，由 getSettings() 写入 */
  _wholeSettingsCache: null,
  _WHOLE_TTL_MS: 30000,   // 整包缓存有效期：30s（低频老键够用，且不会被轮询反复触发）

  /**
   * 🟢 v228.61：批量读多个键（并发单键直读）—— 替代「读整包挑 N 个键」的调用点。
   *   比逐个 await 快（并发），比 getSettings() 省（只读需要的键，不读全部 14 个）。
   *   @param {string[]} keys
   *   @returns {Promise<Object>} { [key]: value }
   */
  async getSettingsKeys(keys) {
    const out = {};
    const list = (keys || []).filter(Boolean);
    if (!list.length) return out;
    await Promise.all(list.map(async (k) => {
      try {
        const v = await this._readSettingFile(k);
        if (v !== undefined) out[k] = v;
      } catch (e) { /* 单键失败不影响其他键 */ }
    }));
    return out;
  },

  // ==================================================================
  // ===== 盘点第 4 包（stocktake.json）=====
  // 与现有 3 包（data.json / base.json / settings.json）完全独立的独立文件。
  // 【追加式合并】盘点记录是「追加型数据」（每条只增不改，改=作废后新增），
  // 因此不会像整包覆盖那样互相覆盖：多设备各存各的，按 recId 去重合并即可。
  // 【不污染】本包不读写 data.json 的 10 张业务表，DataLoader.TABLES 一行未改。
  // ==================================================================
  STOCKTAKE_FILE: 'stocktake.json',

  // 拉取云端盘点包（不存在返回 null；未联网返回 null）
  async pullStocktake() {
    if (!this.isOnline || !this.client || !this.config) return null;
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download(this.STOCKTAKE_FILE);
      if (error || !data) return null;                      // 文件不存在属正常（首次盘点）
      const txt = await data.text();
      if (!txt) return null;
      const obj = JSON.parse(txt);
      return {
        savedAt: obj.savedAt || null,
        tasks: obj.tasks || {},
        // v217：新增盘点批次汇总层（每个 sheetId 一条快照，按 sheetId 去重合并）
        batches: Array.isArray(obj.batches) ? obj.batches : [],
        records: Array.isArray(obj.records) ? obj.records : []
      };
    } catch (e) {
      console.warn('[stocktake] 云端读取异常(已忽略):', e && e.message);
      return null;
    }
  },

  // 上传盘点包（整体覆盖写；配合 savedAt 乐观锁使用）
  async pushStocktake(payload) {
    if (!this.isOnline || !this.client) return false;
    try {
      const { error } = await this.client.storage
        .from(this.BUCKET)
        .upload(this.STOCKTAKE_FILE, JSON.stringify(payload),
          { contentType: 'application/json', upsert: true, cacheControl: '0' });
      if (error) { console.error('[stocktake] 云端写入失败:', error.message); return false; }
      return true;
    } catch (e) {
      console.error('[stocktake] 云端写入异常:', e && e.message);
      return false;
    }
  },

  // 回读校验（绕过公开 URL 的 CDN 缓存，确认写进去的就是自己这份）
  async _readBackSavedAt() {
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download(this.STOCKTAKE_FILE);
      if (error || !data) return null;
      const obj = JSON.parse(await data.text());
      return obj.savedAt || null;
    } catch (e) { return null; }
  },

  // 追加同步盘点记录：pull → 按 recId 去重合并 → push（最多 3 次重试）
  // newRecords: 本设备本次新增的记录；taskPatch: 可选，同时更新的任务状态
  // 🟢 v227.84：去掉 _readBackSavedAt 乐观锁回读校验。
  //   原实现：push 后立即 download 比对 savedAt，但 Supabase Storage 的 SDK 下载在
  //   某些网络中间件/CDN 下会命中缓存拿到旧 savedAt，导致「实际已写入」却 3 次重试都
  //   失败，最终把 ok=false 抛回 finishStocktake → 用户看到"云端同步失败"。
  //   盘点数据本身就是「按 recId 追加合并」，丢一次合并最坏结果是被下次同步自然补上，
  //   远比「成功写入却被报失败」影响小。push 成功即视为同步成功。
  async syncStocktake(newRecords, taskPatch) {
    if (!this.isOnline || !this.client) return { ok: false, offline: true };
    const MAX = 3;
    for (let attempt = 0; attempt < MAX; attempt++) {
      const cloud = (await this.pullStocktake()) || { savedAt: null, tasks: {}, records: [] };
      // 合并：他人的记录原样保留，同 recId 以新的为准（本地修正场景）
      const map = new Map();
      (cloud.records || []).forEach(r => { if (r && r.recId) map.set(r.recId, r); });
      (newRecords || []).forEach(r => { if (r && r.recId) map.set(r.recId, r); });

      // v217 审查#6：任务必须「合并」而非「覆盖」——
      // taskPatch 常是局部补丁（如仅含 status/closedAt），直接整体覆盖会抹掉
      // 他端已写入的 createdAt / codes / assignee 等关键字段，导致分派信息丢失。
      const tasks = Object.assign({}, cloud.tasks || {});
      if (taskPatch && taskPatch.taskId) {
        tasks[taskPatch.taskId] = Object.assign({}, tasks[taskPatch.taskId] || {}, taskPatch);
      }
      // v217：批次汇总层原样透传（本通道不改它，避免相互覆盖）
      const batches = Array.isArray(cloud.batches) ? cloud.batches.slice() : [];

      const savedAt = new Date().toISOString();
      const ok = await this.pushStocktake({ savedAt, tasks, batches, records: Array.from(map.values()) });
      if (!ok) {
        // 写入真失败（网络/权限），等下一轮重试
        if (attempt < MAX - 1) {
          await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
        return { ok: false };
      }
      return { ok: true, merged: map.size, savedAt };
    }
    return { ok: false };
  },

  // 仅同步任务状态（盘点结束标记等）
  async syncStocktakeTasks(taskPatch) {
    return this.syncStocktake([], taskPatch);
  },

  /** v217：拉取云端盘点任务（供库管员领取他人分派的任务） */
  async pullStocktakeTasks() {
    if (!this.isOnline || !this.client || !this.config) return {};
    const cloud = await this.pullStocktake();
    return (cloud && cloud.tasks) ? cloud.tasks : {};
  },

  // ===== 工作数据双版本（data.json 内部 prevWork 滚动）=====
  // 导入时：把当前云端 bundle 的 tables 存为 prevWork，新数据成为主 tables
  // 恢复上一份：tables = prevWork.tables，prevWork = null
  // 读取当前 bundle 中的 prevWork（供 UI 显示上一份日期）
  async getPrevWorkMeta() {
    const bundle = await this.pullData();
    if (bundle && bundle.prevWork) return { savedAt: bundle.prevWork.savedAt || null, hasPrev: true };
    return { hasPrev: false };
  }
};

// 🟢 v227.37：删除「点顶栏打开云配置」监听（统一走 entry 权限门，未登录/无权限者不应能打开）
//   顶栏角标仅展示云端连接状态，不提供配置入口；配置只能从侧边栏入口（管理员/授权者）打开。
// 保留 SyncManager.init() 启动一次
document.addEventListener('DOMContentLoaded', () => {
  try { SyncManager.init(); } catch (e) { /* 启动失败不阻断页面 */ }
});

