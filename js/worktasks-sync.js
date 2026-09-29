/* ============================================================================
 * 工作任务 · 云端同步独立分包（v229.39 新增）
 * ----------------------------------------------------------------------------
 * 职责（从 work-tasks.js 抽出的「传输 / 拉取 / 冲突合并 / 轻轮询」）：
 *   · load()/save()/getCache()/setCache()  —— 云端读写 + localStorage 镜像兜底
 *   · start(onChange)/stop()/pullOnce()   —— 独立轻轮询（进入即拉 + 回前台补拉）
 *   · _mergeById()                        —— per-item 合并（按 id + updatedAt 新者胜）
 *
 * 复用（搭 SyncManager 底层读基元的车，不搭 StocktakeModule 私有轮询循环）：
 *   · SyncManager.getSettingsMeta()  —— 廉价变更探测（list settings 拿 updated_at）
 *   · SyncManager.beginReadRound()   —— 开 1200ms CDN 绕过窗口（绕过 Storage 旧值）
 *   · SyncManager.getSettingsKeys() —— 单键直读（根治读放大）
 *   · DS.setSetting('workTasks', …)  —— 写云端（→ upsert settings/workTasks.json）
 *
 * 设计纪律（对齐 stocktake 轮询）：
 *   · 递归 setTimeout（非 setInterval），单例 start/stop，离开模块即 stop 清定时器
 *   · 动态节奏：可见 1.5s / 隐藏 30s
 *   · 每轮先 getSettingsMeta 只盯 workTasks.json 的 updated_at，无变更立即跳过
 *   · 回前台 visibilitychange 立即补拉一次对齐
 * ========================================================================== */

const WorkTasksSync = (function () {
  'use strict';

  const KEY = 'workTasks';
  const DS = (typeof DataStore !== 'undefined') ? DataStore : (typeof db !== 'undefined' ? db : null);
  const MIRROR_KEY = 'wb_worktasks_mirror';

  // ---------- 本地权威缓存 ----------
  let _cache = null;

  // ---------- localStorage 镜像兜底（云端断连/项目暂停时不丢） ----------
  function _writeMirror(arr) {
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(arr || _cache || [])); } catch (e) { /* 隐私模式忽略 */ }
  }
  function _readMirror() {
    try { const s = localStorage.getItem(MIRROR_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  // ---------- per-item 合并：按 id，updatedAt 新者胜（解决两设备并发互丢） ----------
  function _mergeById(local, remote) {
    const map = new Map();
    (local || []).forEach((t) => map.set(t.id, t));
    (remote || []).forEach((t) => {
      const ex = map.get(t.id);
      // 远端新（或本地无）→ 覆盖；否则保留本地（含本地未同步改动）
      if (!ex || (t.updatedAt || 0) >= (ex.updatedAt || 0)) map.set(t.id, t);
    });
    return Array.from(map.values());
  }

  // ---------- 读写 ----------
  async function load() {
    if (_cache) return _cache;
    try {
      const v = await DS.getSetting(KEY);
      if (Array.isArray(v) && v.length) { _cache = v; _writeMirror(v); return _cache; }
      const local = _readMirror();
      if (local && Array.isArray(local) && local.length) { _cache = local; return _cache; }
    } catch (e) {
      console.warn('[worktasks-sync] 读取失败，尝试本地镜像:', e && e.message);
      const local = _readMirror();
      if (local && Array.isArray(local)) { _cache = local; return _cache; }
    }
    _cache = [];
    return _cache;
  }
  async function save(arr) {
    _cache = arr;
    _writeMirror(arr); // 本地镜像兜底（先于云，确保即使云写失败也不丢）
    try { await DS.setSetting(KEY, arr); }
    catch (e) { console.warn('[worktasks-sync] 云端写入失败(已本地镜像):', e && e.message); }
  }
  function getCache() { return _cache || []; }
  function setCache(arr) { _cache = arr; }

  // ====================================================================
  // 独立轻轮询（进入即拉 + 回前台补拉 + 无变更跳过）
  // ====================================================================
  let _timer = null, _sig = null, _onChange = null, _active = false;
  const PERIOD_VISIBLE = 1500, PERIOD_HIDDEN = 30000;

  function _canPull() {
    if (typeof SyncManager === 'undefined') return false;
    // 弱网容错：isOnline 可能误判 false，只要浏览器没明确离线就尝试
    return SyncManager.isOnline || (typeof navigator !== 'undefined' && navigator.onLine !== false);
  }

  // 语义变化判定：依赖「任何写都更新 updatedAt」
  function _changed(a, b) {
    a = a || []; b = b || [];
    if (a.length !== b.length) return true;
    const ma = new Map(a.map((t) => [t.id, t]));
    for (const t of b) {
      const o = ma.get(t.id);
      if (!o) return true;
      if ((o.updatedAt || 0) !== (t.updatedAt || 0)) return true;
    }
    return false;
  }

  // 单次拉取：返回 true 表示本端数据因远端变更而改变
  async function _pullOnce() {
    if (!_canPull()) return false;
    // ① 廉价探测：只盯 workTasks.json 这一键的 updated_at（比 stocktake 全 settings 签名更省）
    let remote = null;
    try {
      const meta = await SyncManager.getSettingsMeta();
      const m = meta && meta.find((x) => x.name === KEY + '.json');
      const newSig = m ? (KEY + ':' + (m.updated_at || '')) : 'missing';
      if (newSig === _sig) return false; // 无变更 → 跳过（与 stocktake skipHeavy 同思路）
      _sig = newSig;
      // ② 真变了才下读：开 CDN 绕过 + 单键直读
      try { if (typeof SyncManager.beginReadRound === 'function') SyncManager.beginReadRound(); } catch (e) {}
      const got = await SyncManager.getSettingsKeys([KEY]);
      remote = got && got[KEY];
    } catch (e) {
      return false; // 任何异常静默降级，不引入新失败面
    }
    if (!Array.isArray(remote)) return false;
    // ③ 合并：本地未同步改动（_cache 已含）与远端按 id 新者胜
    const merged = _mergeById(_cache, remote);
    if (_changed(_cache, merged)) {
      _cache = merged;
      _writeMirror(merged);
      if (_onChange) { try { _onChange(merged); } catch (e) {} }
      return true;
    }
    return false;
  }

  function _period() {
    if (typeof document !== 'undefined' && document.hidden) return PERIOD_HIDDEN;
    return PERIOD_VISIBLE;
  }
  function _loop() {
    _pullOnce().catch(() => {}).finally(() => {
      if (_active) _timer = setTimeout(_loop, _period());
    });
  }
  function _onVis() { if (!document.hidden) _pullOnce().catch(() => {}); }

  function start(onChange) {
    _onChange = onChange;
    if (_active) return;            // 单例，重复调用安全
    _active = true;
    _pullOnce().catch(() => {});    // 进入即拉（解决「同会话不拉取」）
    _timer = setTimeout(_loop, _period());
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', _onVis);
  }
  function stop() {
    _active = false;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', _onVis);
  }

  return {
    load, save, getCache, setCache,
    start, stop, pullOnce: _pullOnce, _mergeById,
  };
})();
if (typeof window !== 'undefined') window.WorkTasksSync = WorkTasksSync;
