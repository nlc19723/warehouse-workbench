// ============================================
// Supabase 云端同步接口（预留）
// ============================================

const SyncManager = {
  client: null,
  isOnline: false,
  config: null,
  BUCKET: (typeof AppConfig !== 'undefined' && AppConfig.supabase) ? AppConfig.supabase.bucket : 'workbench-data',
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
          this.config = { url: eff.url, key: eff.key };
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
        if (eff && eff.url && eff.key) return { url: eff.url, key: eff.key };
      } catch (e) { /* 解析失败回退空值，由用户手填 */ }
    }
    return { url: '', key: '' };
  },

  // 内部连接（不暴露给外部，仅 init / online 事件内部调用）
  // v217 BUG-C 修复：过去只 createClient 就置 isOnline=true，而 createClient 对
  //   断网/错误 URL 几乎从不抛错，于是"刷新后没网也显示已连接"。
  //   现改为：先建客户端 → 真实探测 → 只有探测通过才算在线。
  async _connect() {
    if (!this.config || !this.config.url || !this.config.key) return false;
    // 浏览器层面已断网：直接判离线，不做无谓请求
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.isOnline = false;
      this.updateUI();
      return false;
    }
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
      return true;
    } catch (e) {
      console.error('Supabase connect failed:', e);
      this.client = null;
      this.isOnline = false;
      this.updateUI();
      return false;
    }
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
      if (error) return { ok: false, reason: (error.message || '云端拒绝访问，请检查 URL / Key / 存储桶权限') };
      return { ok: true };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, reason: '连接超时（10秒），请检查网络或 URL' };
      return { ok: false, reason: (e && e.message) || '云端不可达' };
    }
  },

  // 手动连接（从配置对话框保存时调用）
  async connect(url, key) {
    if (!url || !key) return false;
    try {
      this.client = supabase.createClient(url, key, {
        auth: { persistSession: false },
        global: { headers: { 'x-client-info': 'warehouse-workbench' } }
      });
      this.config = { url, key };
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
  updateUI() {
    const el = document.getElementById('syncStatus');
    const textEl = document.getElementById('syncStatusText');
    if (el && textEl) {
      if (this.isOnline) {
        el.classList.add('online');
        textEl.textContent = '已同步';
      } else {
        el.classList.remove('online');
        textEl.textContent = '未连接';
      }
    }
    const lc = document.getElementById('loginCloud');
    if (lc) {
      lc.classList.toggle('online', !!this.isOnline);
      lc.innerHTML = '<span class="dot"></span>' + (this.isOnline ? '云端已同步' : '云端未连接');
    }
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
    if (!url || !key) {
      WBModal.alert('请填写完整的配置信息');
      return;
    }
    const ok = await this.connect(url, key);
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
    this.setSetting = async (key, value) => {
      const cur = readFile('settings.json') || {};
      cur[key] = value; cur._updatedAt = Date.now();
      fakeFile('settings.json', cur); return true;
    };
    this.getSetting = async (key) => { const a = readFile('settings.json'); return a ? a[key] : undefined; };
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
  async getSettings() {
    if (!this.isOnline || !this.client || !this.config) return {};
    const cacheBust = `?t=${Date.now()}`;
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download('settings.json');
      if (error || !data) {
        // 降级：公开 URL（可能命中旧缓存，仅兜底）—— 加 cacheBust 强制破缓存
        try {
          const url = `${this.config.url}/storage/v1/object/public/${this.BUCKET}/settings.json${cacheBust}`;
          const resp = await fetch(url, { headers: { 'apikey': this.config.key } });
          if (!resp.ok) return {};
          return await resp.json();
        } catch (e) { return {}; }
      }
      return JSON.parse(await data.text());
    } catch (e) {
      console.warn('设置读取异常（降级公开 URL）:', e.message || e);
      try {
        const url = `${this.config.url}/storage/v1/object/public/${this.BUCKET}/settings.json${cacheBust}`;
        const resp = await fetch(url, { headers: { 'apikey': this.config.key } });
        if (!resp.ok) return {};
        return await resp.json();
      } catch (e2) { return {}; }
    }
  },

  // 写入单个设置项（合并式，避免覆盖其他项）。key 为点路径不支持，直接传扁平 key
  // 🟢 v208 AUDIT-303：settings.json 是「读-改-写」整体覆盖，两台设备并发写不同 key
  //   时，后写者会把先写者的 key 整份抹掉（outbound_list / search_history 等）。
  //   这里加写后回读校验：若 _updatedAt 不是本次写入的时间戳，说明期间被插队，
  //   重新「读-合并-写」重试一次（Supabase Storage 无 CAS，只能靠回读尽力保证）。
  async setSetting(key, value) {
    if (!this.isOnline || !this.client) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const cur = (await this.getSettings()) || {};
        const stamp = Date.now();
        cur[key] = value;
        cur._updatedAt = stamp;
        const { error } = await this.client.storage
          .from(this.BUCKET)
          .upload('settings.json', JSON.stringify(cur), { contentType: 'application/json', upsert: true, cacheControl: '0' });
        if (error) { console.error('设置写入失败:', error.message); return false; }
        // 私有下载回读（绕过公开 URL 的 CDN 缓存），确认真的是自己写的那份
        const back = await this.pullSettingsPrivate();
        if (back && back._updatedAt === stamp) return true;
        console.warn('[乐观锁] 设置写入被其它设备覆盖，重试第 ' + (attempt + 1) + ' 次');
      } catch (e) { console.error('设置写入异常:', e); return false; }
    }
    // 重试后仍不一致：不阻塞用户操作，仅记录（设置类数据非核心台账）
    return true;
  },

  async getSetting(key) {
    const all = await this.getSettings();
    return all ? all[key] : undefined;
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

  // ==================================================================
  // v217：盘点批次汇总层（第 4 包内的 batches 字段）
  // 定位：汇总结果「可翻查」，因此必须与记录一样上云并跨设备可见；
  //       每个 sheetId 一条快照，按 sheetId 去重、generatedAt 新者胜。
  // 说明：与 records 同包但同层级字段，不新增第 5 个文件，避免同步通道膨胀。
  // ==================================================================
  async pushStocktakeBatch(summary) {
    if (!summary || !summary.sheetId) return { ok: false, reason: '缺少 sheetId' };
    if (!this.isOnline || !this.client) return { ok: false, offline: true };
    const MAX = 3;
    for (let attempt = 0; attempt < MAX; attempt++) {
      const cloud = (await this.pullStocktake()) ||
        { savedAt: null, tasks: {}, batches: [], records: [] };
      const bmap = new Map();
      (cloud.batches || []).forEach(b => { if (b && b.sheetId) bmap.set(b.sheetId, b); });
      const old = bmap.get(summary.sheetId);
      // generatedAt 新者胜：防止重新生成时的乱序覆盖
      if (!old || String(summary.generatedAt || '') >= String(old.generatedAt || '')) {
        bmap.set(summary.sheetId, summary);
      }
      const savedAt = new Date().toISOString();
      const ok = await this.pushStocktake({
        savedAt,
        tasks: cloud.tasks || {},
        batches: Array.from(bmap.values()),
        records: cloud.records || []
      });
      if (!ok) return { ok: false };
      const back = await this._readBackSavedAt();
      if (back === savedAt) return { ok: true, savedAt };
      console.warn('[stocktake-batch] 乐观锁冲突，重试第 ' + (attempt + 1) + ' 次');
    }
    return { ok: false, conflict: true };
  },

  /** 拉取云端批次汇总列表（未联网/无数据返回 []） */
  async pullStocktakeBatches() {
    if (!this.isOnline || !this.client || !this.config) return [];
    const cloud = await this.pullStocktake();
    return (cloud && Array.isArray(cloud.batches)) ? cloud.batches : [];
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

