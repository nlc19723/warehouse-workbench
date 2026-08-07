// ============================================
// Supabase 云端同步接口（预留）
// ============================================

const SyncManager = {
  client: null,
  isOnline: false,
  config: null,
  BUCKET: 'workbench-data',
  FILE: 'data.json',

  // 内置默认配置（部署后让所有访问者自动连接，anon key 本就是公开的）
  // 留空 {} 则用用户手动输入的配置；填入后分享链接零配置
  DEFAULT_CONFIG: {
    url: 'https://audzjztaffbtmxshwadn.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1ZHpqenRhZmZidG14c2h3YWRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4OTU5ODksImV4cCI6MjEwMTQ3MTk4OX0.RPPyThgZZMBldysxkuIMBqP6E8WRKhpEOZNQe5itJAg'
  },

  // 初始化（优先 localStorage，其次内置默认配置）—— 不自动连接，由 DataLoader 按需触发
  init() {
    try {
      const saved = localStorage.getItem('supabase_config');
      if (saved) {
        this.config = JSON.parse(saved);
        this._connect();
      } else if (this.DEFAULT_CONFIG && this.DEFAULT_CONFIG.url) {
        this.config = this.DEFAULT_CONFIG;
        this._connect();
      }
    } catch (e) {
      console.warn('Sync config load failed:', e);
    }
    this.updateUI();
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

  // 手动连接（从配置对话框保存时调用）
  connect(url, key) {
    if (!url || !key) return false;
    try {
      this.client = supabase.createClient(url, key, {
        auth: { persistSession: false },
        global: { headers: { 'x-client-info': 'warehouse-workbench' } }
      });
      this.config = { url, key };
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
    localStorage.removeItem('supabase_config');
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

    modalTitle.textContent = '云端同步配置';
    modalBody.innerHTML = `
      <div style="max-width:400px;">
        <p style="font-size:12.5px;color:var(--text-secondary);margin-bottom:14px;line-height:1.5;">
          配置 Supabase 项目信息以启用云端数据同步。所有数据将在本地和云端之间自动双向同步。
        </p>
        <div style="margin-bottom:10px;">
          <label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:3px;">Project URL</label>
          <input type="text" id="sbUrl" placeholder="https://xxxx.supabase.co" value="${this.config?.url || ''}"
            style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;">
        </div>
        <div style="margin-bottom:14px;">
          <label style="display:block;font-size:11.5px;color:var(--text-secondary);margin-bottom:3px;">Anon Key</label>
          <input type="password" id="sbKey" placeholder="eyJ..." value="${this.config?.key || ''}"
            style="width:100%;height:34px;border:1px solid var(--border-color);border-radius:8px;padding:0 10px;font-size:13px;">
        </div>
        <div class="btn-group" style="border-top:none;margin-top:14px;padding-top:0;display:flex;gap:8px;justify-content:flex-end;">
          <button onclick="SyncManager.hideConfigDialog()" class="btn-secondary" style="padding:7px 18px;font-size:12.5px;">取消</button>
          ${this.isOnline ? `<button onclick="SyncManager.disconnect();SyncManager.hideConfigDialog();" style="padding:7px 14px;border:none;border-radius:10px;background:linear-gradient(135deg,rgba(212,149,149,0.6),rgba(212,149,149,0.25));color:#993333;cursor:pointer;font-size:12px;font-weight:600;backdrop-filter:blur(8px);transition:all 0.2s;" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform=''">断开连接</button>` : ''}
          ${this.isOnline ? `<button onclick="SyncManager.manualPush()" class="btn-primary" style="padding:7px 16px;">📤 上传数据</button>` : ''}
          <button onclick="SyncManager.saveConfig()" class="btn-primary" style="padding:7px 18px;">保存并连接</button>
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

  saveConfig() {
    const url = document.getElementById('sbUrl').value.trim();
    const key = document.getElementById('sbKey').value.trim();
    if (!url || !key) {
      alert('请填写完整的配置信息');
      return;
    }
    const ok = this.connect(url, key);
    if (ok) {
      this.hideConfigDialog();
      alert('连接成功！数据将自动同步到云端。');
    } else {
      alert('连接失败，请检查配置信息是否正确。');
    }
  },

  // ===== 云端数据存储（Supabase Storage 当文件柜）=====
  // 手动把当前本地数据上传到云端（已连接时可用）
  async manualPush() {
    if (!this.isOnline) { alert('请先连接云端'); return; }
    if (typeof DataLoader === 'undefined' || !DataLoader.pushAllToCloud) {
      alert('数据模块未就绪，请刷新页面后重试');
      return;
    }
    showLoading('正在上传数据到云端...');
    const ok = await DataLoader.pushAllToCloud();
    hideLoading();
    if (ok) {
      alert('当前数据已上传到云端，部署/分享链接打开即自动更新。');
    } else {
      alert('上传失败，请检查网络连接或存储桶权限（需开启 anon 可写）。');
    }
  },

  // 把全量数据打包推送到云端（覆盖式）
  async pushData(dataObj) {
    if (!this.isOnline || !this.client) return false;
    try {
      const json = JSON.stringify(dataObj);
      const { error } = await this.client.storage
        .from(this.BUCKET)
        .upload(this.FILE, json, {
          contentType: 'application/json',
          upsert: true,
          cacheControl: '0'
        });
      if (error) {
        console.error('云端推送失败:', error.message);
        return false;
      }
      console.log('数据已推送到云端');
      return true;
    } catch (e) {
      console.error('云端推送异常:', e);
      return false;
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
