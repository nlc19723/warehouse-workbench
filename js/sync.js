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

  // 初始化：仅当用户此前手动连接并保存过配置（localStorage.supabase_config）时才自动重连。
  // ⚠️ 不再因内置的 AppConfig.supabase 而自动"上线"——那份是公开共享配置，若默认连线会让
  //    "仅导入本地"的数据在刷新后自作主张回写云端，违背"未连接就不碰云端"的预期。
  //    内置 AppConfig.supabase 仅作为「云配置」对话框的预填默认值，需用户主动点「保存并连接」才生效。
  init() {
    try {
      const saved = localStorage.getItem('supabase_config');
      if (saved) {
        this.config = JSON.parse(saved);
        this._connect();
      }
      // 注意：AppConfig.supabase 不在此处自动连接（只作为手动连接对话框的预填值）。
    } catch (e) {
      console.warn('Sync config load failed:', e);
    }
    this.updateUI();
  },

  // 供「云配置」对话框预填：返回内置默认配置（如有），否则空
  getDefaultConfig() {
    if (typeof AppConfig !== 'undefined' && AppConfig.supabase && AppConfig.supabase.url) {
      return { url: AppConfig.supabase.url, key: AppConfig.supabase.anonKey };
    }
    return { url: '', key: '' };
  },

  // 内部连接（不暴露给外部，仅 init 内部调用）
  _connect() {
    if (!this.config || !this.config.url || !this.config.key) return;
    try {
      this.client = supabase.createClient(this.config.url, this.config.key, {
        auth: { persistSession: false },
        global: { headers: { 'x-client-info': 'warehouse-workbench' } }
      });
      this.isOnline = true;
    } catch (e) {
      console.error('Supabase connect failed:', e);
      this.isOnline = false;
    }
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
      this.updateUI();
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
    try { localStorage.removeItem('supabase_config'); } catch (e) {
    /* 隐私模式可能抛错，忽略 */ console.warn('[sync.js:106] 异常(已忽略):', e);
  }
    this.updateUI();
  },

  // 更新同步状态UI
  updateUI() {
    const el = document.getElementById('syncStatus');
    const textEl = document.getElementById('syncStatusText');
    if (!el || !textEl) return;

    if (this.isOnline) {
      el.classList.add('online');
      textEl.textContent = '已同步';
    } else {
      el.classList.remove('online');
      textEl.textContent = '未连接';
    }
  },

  // 显示配置对话框
  showConfigDialog() {
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
        <div class="btn-group" style="border-top:none;margin-top:14px;padding-top:0;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
          ${this.isOnline ? `<button onclick="SyncManager.disconnect();SyncManager.hideConfigDialog();" style="flex:1;max-width:120px;padding:9px 0;border:none;border-radius:10px;background:linear-gradient(135deg,rgba(244,63,94,0.22),rgba(244,63,94,0.08));color:#be123c;border:1px solid rgba(244,63,94,0.25);box-shadow:0 2px 8px rgba(244,63,94,0.08);cursor:pointer;font-size:12.5px;font-weight:600;backdrop-filter:blur(8px);transition:all 0.2s;text-align:center;" onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 12px rgba(244,63,94,0.15)'" onmouseout="this.style.transform='';this.style.boxShadow='0 2px 8px rgba(244,63,94,0.08)'">断开连接</button>` : ''}
          ${this.isOnline ? `<button onclick="SyncManager.manualPush()" style="flex:1;max-width:120px;padding:9px 0;border:none;border-radius:10px;background:linear-gradient(135deg,rgba(14,165,233,0.22),rgba(2,132,199,0.08));color:#0369a1;border:1px solid rgba(14,165,233,0.25);box-shadow:0 2px 8px rgba(14,165,233,0.08);cursor:pointer;font-size:12.5px;font-weight:600;backdrop-filter:blur(8px);transition:all 0.2s;text-align:center;" onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 12px rgba(14,165,233,0.15)'" onmouseout="this.style.transform='';this.style.boxShadow='0 2px 8px rgba(14,165,233,0.08)'">📤 上传工作数据</button>` : ''}
          ${this.isOnline ? `<button onclick="DataLoader.markCurrentAsBase()" style="flex:1;max-width:140px;padding:9px 0;border:none;border-radius:10px;background:linear-gradient(135deg,rgba(34,197,94,0.22),rgba(16,185,129,0.08));color:#15803d;border:1px solid rgba(34,197,94,0.28);box-shadow:0 2px 8px rgba(34,197,94,0.10);cursor:pointer;font-size:12.5px;font-weight:600;backdrop-filter:blur(8px);transition:all 0.2s;text-align:center;" onmouseover="this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 12px rgba(34,197,94,0.18)'" onmouseout="this.style.transform='';this.style.boxShadow='0 2px 8px rgba(34,197,94,0.10)'">📌 标记为基准</button>` : ''}
          <button onclick="SyncManager.saveConfig()" class="btn-primary" style="flex:1;max-width:120px;padding:9px 0;font-size:12.5px;">💾 保存并连接</button>
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

  async saveConfig() {
    const url = document.getElementById('sbUrl').value.trim();
    const key = document.getElementById('sbKey').value.trim();
    if (!url || !key) {
      WBModal.alert('请填写完整的配置信息');
      return;
    }
    const ok = await this.connect(url, key);
    if (ok) {
      this.hideConfigDialog();
      WBModal.alert('连接成功！数据将自动同步到云端。');
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

  // 把全量数据打包推送到云端（覆盖式）
  // 🟢 v208 AUDIT-303 乐观锁：
  //   opts.expectedSavedAt —— 本机的同步基准（最后一次与云端对齐的 savedAt）。
  //     · 传 null 表示本机从未同步过：若云端已有数据则拒绝（防止本地旧数据抹掉云端）
  //     · 传具体值：云端 savedAt 不一致 → 返回 'conflict'，由调用方提示用户先拉取
  //   opts._existing      —— 调用方已拉取的云端 bundle，复用以免二次往返
  //   返回值：true 成功 / false 失败 / 'conflict' 版本冲突（未写入）
  async pushData(dataObj, opts) {
    if (!this.isOnline || !this.client) return false;
    const options = opts || {};
    if (options.expectedSavedAt !== undefined) {
      const existing = options._existing !== undefined
        ? options._existing
        : await this.pullDataPrivate();
      const cloudSavedAt = (existing && existing.savedAt) || null;
      if (options.expectedSavedAt === null) {
        if (cloudSavedAt) {
          console.warn('[乐观锁] 本机无同步基准，而云端已有数据（savedAt=' + cloudSavedAt + '），已拒绝覆盖');
          return 'conflict';
        }
      } else if (cloudSavedAt && cloudSavedAt !== options.expectedSavedAt) {
        console.warn('[乐观锁] 云端 savedAt=' + cloudSavedAt + ' ≠ 本机基准 ' + options.expectedSavedAt + '，已拒绝覆盖');
        return 'conflict';
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // 30s 超时，避免一直转圈
    try {
      const json = JSON.stringify(dataObj);
      const { error } = await this.client.storage
        .from(this.BUCKET)
        .upload(this.FILE, json, {
          contentType: 'application/json',
          upsert: true,
          cacheControl: '0',
          signal: controller.signal
        });
      if (error) {
        console.error('云端推送失败:', error.message);
        return false;
      }
      console.log('数据已推送到云端');
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') console.warn('云端推送超时(30s)');
      else console.error('云端推送异常:', e);
      return false;
    } finally {
      clearTimeout(timer);
    }
  },

  // 把"基准数据"单独推送到云端（与 data.json 工作数据分离存放）
  async pushBase(dataObj) {
    if (!this.isOnline || !this.client) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // 30s 超时，避免一直转圈
    try {
      const json = JSON.stringify(dataObj);
      const { error } = await this.client.storage
        .from(this.BUCKET)
        .upload(this.BASE_FILE, json, {
          contentType: 'application/json',
          upsert: true,
          cacheControl: '0',
          signal: controller.signal
        });
      if (error) { console.error('基准数据推送失败:', error.message); return false; }
      console.log('基准数据已推送到云端 (' + this.BASE_FILE + ')');
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') console.warn('基准数据推送超时(30s)');
      else console.error('基准数据推送异常:', e);
      return false;
    } finally {
      clearTimeout(timer);
    }
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
    const readFile = (path) => store[path] ? JSON.parse(store[path]) : null;
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
    console.log('[SyncManager] 已切换到 localStorage 模拟云端（测试模式）');
  },

  // ===== 设置数据层（settings.json，用户长期偏好/非导入数据）=====
  // 读取整个 settings 对象（不存在返回 {}）
  // v166 修复：改用「私有下载」绕过 Supabase 公开对象 CDN 缓存，
  // 否则刚写入的第三部分数据（出库列表/搜索历史）在启动恢复时读不到旧缓存 → 下行同步失效。
  // 公开 URL 仅作为 SDK 不可用时的降级。
  async getSettings() {
    if (!this.isOnline || !this.client || !this.config) return {};
    try {
      const { data, error } = await this.client.storage.from(this.BUCKET).download('settings.json');
      if (error || !data) {
        // 降级：公开 URL（可能命中旧缓存，仅兜底）
        try {
          const url = `${this.config.url}/storage/v1/object/public/${this.BUCKET}/settings.json`;
          const resp = await fetch(url, { headers: { 'apikey': this.config.key } });
          if (!resp.ok) return {};
          return await resp.json();
        } catch (e) { return {}; }
      }
      return JSON.parse(await data.text());
    } catch (e) {
      console.warn('设置读取异常（降级公开 URL）:', e.message || e);
      try {
        const url = `${this.config.url}/storage/v1/object/public/${this.BUCKET}/settings.json`;
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

// 点击同步状态打开配置
document.addEventListener('DOMContentLoaded', () => {
  const syncStatus = document.getElementById('syncStatus');
  if (syncStatus) {
    syncStatus.addEventListener('click', () => SyncManager.showConfigDialog());
  }
  SyncManager.init();
});
