/* ============================================================================
 * 工作任务 · 云端同步独立分包（v229.39 新增）
 * ----------------------------------------------------------------------------
 * 职责（从 work-tasks.js 抽出的「传输 / 拉取 / 冲突合并 / 轻轮询」）：
 *   · load()/save()/getCache()/setCache()  —— 云端读写 + localStorage 镜像兜底
 *   · start(onChange)/stop()/pullOnce()   —— 独立轻轮询（进入即拉 + 回前台补拉）
 *   · _mergeById()                        —— per-item 合并（按 id + updatedAt 新者胜）
 *
 * 🟢 v230.08（P0 数据安全加固，事故驱动）：
 *   事故：2026-10-15 12:26 云端 settings/workTasks.json 被写成 []（2 字节），
 *   用户历史任务全丢。根因是四处缺陷叠加：
 *     ① 假空读 —— DataStore.getSetting 在 !SyncManager.isOnline（初始即 false）
 *        时返回 undefined；_readSettingFile 遇网络抖动也返回 undefined，
 *        与「云端真没有这个键」无法区分 → load() 拿到空；
 *     ② 无保护整数组覆盖写 —— save(arr) 把本地（可能是空）状态整包推上云；
 *     ③ 云端非空即压镜像 —— load() 见云非空就用云，幸存镜像无法自愈；
 *     ④ 合并不墓碑 —— _mergeById 只增不减，删除不跨端（且读-合并-写会复活）。
 *   对策（本版落地）：
 *     · load()：云端与镜像【并集合并】（云镜互救），读不到才退镜像；
 *     · save()：改为【读-合并-写】——先破缓存拉远端，按 id+updatedAt 合并后才写；
 *       远端读不到（网络/未就绪）→ 只写镜像并【挂起】，稍后自动重试，
 *       绝不用可疑的本地状态覆盖云端；
 *     · 墓碑：删除 = 打 `_del` 墓碑（保留 id + updatedAt），跨端合并时较新者胜，
 *       删除可传播、合并不复活；撤销删除 = 清墓碑 + 刷新 updatedAt；
 *     · 30 天前的墓碑自动清理（所有设备早已知晓）；
 *     · 区分「云端真空」与「网络读不到」：list 探测成功且无该键 = 真空（合法空），
 *       list/直读失败 = 读不到（挂起保守处理）。
 *
 * 复用（搭 SyncManager 底层读基元的车，不搭 StocktakeModule 私有轮询循环）：
 *   · SyncManager.getSettingsMeta()  —— 廉价变更探测（list settings 拿 updated_at）
 *   · SyncManager.beginReadRound()   —— 开 1200ms CDN 绕过窗口（绕过 Storage 旧值）
 *   · SyncManager.getSettingsKeys() —— 单键直读（根治读放大）
 *   · DS.setSetting('workTasks', …)  —— 写云端（→ upsert settings/workTasks.json）
 *
 * 设计纪律（对齐 stocktake 轮询）：
 *   · 递归 setTimeout（非 setInterval），单例 start/stop，离开模块即 stop 清定时器
 *   · 动态节奏：可见 4s / 隐藏 30s（v230.09 由 1.5s 放宽至 4s，降低空转 list 请求量）
 *   · 每轮先 getSettingsMeta 只盯 workTasks.json 的 updated_at，无变更立即跳过
 *   · 回前台 visibilitychange 立即补拉一次对齐
 * ========================================================================== */

const WorkTasksSync = (function () {
  'use strict';

  const KEY = 'workTasks';
  const DS = (typeof DataStore !== 'undefined') ? DataStore : (typeof db !== 'undefined' ? db : null);
  const MIRROR_KEY = 'wb_worktasks_mirror';
  const PENDING_KEY = 'wb_worktasks_pending';   // 🟢 v230.12：挂起写入的持久化（刷新不丢删除意图）
  const TOMBSTONE_TTL_MS = 30 * 86400000;   // 墓碑保留 30 天（之后所有设备必已知晓）
  const FLUSH_RETRY_MS = 3000;              // 挂起写入的重试间隔

  // ---------- 本地权威缓存（原始数组，可能含墓碑） ----------
  let _cache = null;
  // ---------- v230.08：远端读失败时挂起的写入（镜像已保底，云稍后补） ----------
  let _pendingSave = null;
  let _flushTimer = 0;

  // ---------- 墓碑工具 ----------
  function _isTomb(t) { return !!(t && t._del); }
  // 对外（业务层）只暴露活任务；墓碑仅存在于 _cache / 镜像 / 云端合并过程
  function _live(arr) { return (arr || []).filter((t) => !_isTomb(t)); }
  // 清理过期墓碑（30 天）
  function _pruneTombstones(arr) {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    return (arr || []).filter((t) => !_isTomb(t) || (t.updatedAt || 0) > cutoff);
  }

  // ---------- per-item 合并：按 id，updatedAt 新者胜（解决两设备并发互丢） ----------
  // 双方均可含墓碑：墓碑也是「较新的删除意图」，天然参与胜负判定。
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

  // ---------- localStorage 镜像兜底（云端断连/项目暂停时不丢） ----------
  // 镜像存【原始数组】（含墓碑）：撤销删除、跨端删除传播都依赖它。
  function _writeMirror(arr) {
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(arr || _cache || [])); } catch (e) { /* 隐私模式忽略 */ }
  }
  function _readMirror() {
    try { const s = localStorage.getItem(MIRROR_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  // ---------- v230.12：挂起写入持久化（含墓碑） ----------
  // v230.08 的挂起只活在内存里：删除任务时若远端读不到 → 挂起等 3s 重试；
  // 用户此时刷新/关闭页面 → 挂起丢失 → 云端停留在「含已删任务」的旧值 →
  // 其他设备（或本机破缓存直读）拉回旧值 → 任务「被同步回来」。
  // 现把挂起的【完整合并数组（含墓碑）】落 localStorage，页面重开即恢复并继续重试。
  function _writePending(arr) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(arr || [])); } catch (e) { /* 隐私模式忽略 */ }
  }
  function _readPending() {
    try { const s = localStorage.getItem(PENDING_KEY); const v = s ? JSON.parse(s) : null; return Array.isArray(v) ? v : null; } catch (e) { return null; }
  }
  function _clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* 忽略 */ }
  }
  _pendingSave = _readPending();   // 页面加载即恢复（若有）——删除意图不因刷新丢失

  // ---------- v230.08：等 SyncManager 就绪（治 isOnline 初始 false 的启动竞态） ----------
  async function _awaitSyncReady(maxMs) {
    if (typeof SyncManager === 'undefined') return false;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (SyncManager.isOnline && SyncManager.client) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return !!(SyncManager.isOnline && SyncManager.client);
  }

  // ---------- v230.08：远端新鲜读（破 CDN 缓存） ----------
  // @returns {Array|undefined} 数组 = 云端终态（[] = 验证过的真空）；
  //          undefined = 读不到（网络抖动 / 未就绪）——调用方必须保守处理。
  async function _readRemoteFresh() {
    if (typeof SyncManager === 'undefined') return undefined;
    let exists = null;   // null = 键存在性未知；true/false = list 探测结论
    try {
      const meta = await SyncManager.getSettingsMeta();
      if (Array.isArray(meta)) exists = meta.some((x) => x && x.name === KEY + '.json');
    } catch (e) { /* list 失败 → 保持未知 */ }
    if (exists === false) return [];   // list 成功且无此键 → 云端真空（合法空数组）
    try {
      try { if (typeof SyncManager.beginReadRound === 'function') SyncManager.beginReadRound(); } catch (e) { console.warn('[js/worktasks-sync.js:129] 异常(已忽略):', e); }
      const got = await SyncManager.getSettingsKeys([KEY]);
      const v = got && got[KEY];
      if (Array.isArray(v)) return v;
    } catch (e) { /* 直读异常 → 落下 */ }
    return undefined;   // 键应在但读不到 / 存在性未知 → 保守视为读不到
  }

  // ---------- 读写 ----------
  async function load() {
    if (_cache) return _live(_cache);
    let cloud;
    try { cloud = await DS.getSetting(KEY); } catch (e) { /* 落下走重试 */ }
    if (!Array.isArray(cloud)) {
      // ① isOnline 竞态 / ② 网络抖动：等同步就绪后再试，仍不行走破缓存直读
      if (await _awaitSyncReady(2500)) {
        try { cloud = await DS.getSetting(KEY); } catch (e) { console.warn('[js/worktasks-sync.js:145] 异常(已忽略):', e); }
        if (!Array.isArray(cloud)) cloud = await _readRemoteFresh();
      }
    }
    if (Array.isArray(cloud)) {
      // 🟢 v230.08：云端与镜像并集（互救）——
      //   · 云端被误写小 + 镜像幸存 → 并集补全，下一次 save 自动修复云端；
      //   · 本地有未同步改动（镜像较新）→ 本地胜，不被云端旧值盖掉。
      const mirror = _readMirror();
      const merged = _pruneTombstones(_mergeById(cloud, mirror || []));
      _cache = merged;
      _writeMirror(merged);
      // 🟢 v230.12：删除意图传播自愈——cloud（DataStore 缓存，可能陈旧）里某 id 是活记录、
      //   而合并后是较新墓碑 → 删除从未传播到云端 → 异步读-合并-写补上，
      //   避免别端拉回旧值让任务「被同步回来」。fire-and-forget，不阻塞 load。
      if (_needsTombRepair(cloud, merged)) {
        (async () => {
          try {
            const remote = await _readRemoteFresh();
            if (remote === undefined) return;   // 仍读不到，等轮询/挂起机制处理
            if (_needsTombRepair(remote, _cache)) await _writeMerged(_live(_cache), remote);
          } catch (e) { /* 自愈失败无副作用，下轮再来 */ }
        })();
      }
      return _live(merged);
    }
    // 云端不可读：镜像兜底（可能为空）
    const local = _pruneTombstones(_readMirror() || []);
    _cache = local;
    return _live(local);
  }

  // ---------- v230.08：读-合并-写 ----------
  // 先破缓存拉远端，与本地按 id+updatedAt 合并（含墓碑）后才写云。
  // 远端读不到 → 只保镜像 + 挂起，绝不用可疑本地态覆盖云端。
  async function _writeMerged(arr, remote) {
    // 本地已知墓碑重新挂回（防「刚删的项被远端旧值合并复活」）。
    // 合并顺序（平局语义是关键）：远端为底 → 本地业务数组覆盖 → 本地墓碑再覆盖。
    //   · _mergeById(remote, arr)：本地是「刚发生的最新意图」，平局时本地胜
    //     （撤销删除与删除常落在同一毫秒，若让远端胜会把已撤销的删除又删掉）；
    //   · 再 _mergeById(·, tombs)：本端墓碑平局也胜，保证删除意图不被旧值复活。
    const tombs = (_cache || []).filter(_isTomb);
    // arr 自身也可能带墓碑（v230.12 持久化恢复的挂起就是完整合并数组）——一并参与
    const tombsInArr = (arr || []).filter(_isTomb);
    const allTombs = tombs.concat(tombsInArr.filter((t) => !tombs.some((x) => x.id === t.id)));
    let merged = _pruneTombstones(_mergeById(_mergeById(remote, arr), allTombs));
    _cache = merged;
    _writeMirror(merged);
    try { const ok = await DS.setSetting(KEY, merged); if (ok !== false) _clearPending(); return ok; }
    catch (e) { console.warn('[worktasks-sync] 云端写入失败(已本地镜像):', e && e.message); return false; }
  }

  async function save(arr) {
    // 本地镜像保底（先于云）：业务数组 + 本地已知墓碑一起落镜像，
    // 防止挂起期间墓碑丢失 → 下次 load 时已删任务被云端旧值复活。
    const tombs = (_cache || []).filter(_isTomb);
    const full = _mergeById(arr, tombs);          // 含墓碑的完整态（挂起持久化用）
    _writeMirror(full);
    const remote = await _readRemoteFresh();
    if (remote === undefined) {
      // 远端读不到：挂起等重试。镜像已含本次数据，绝不上传可疑状态。
      // 🟢 v230.12：挂起内容落 localStorage（完整合并数组，含墓碑）——刷新页面后
      //   恢复并继续重试，删除意图不再因刷新/关页而丢失（此前挂起只活在内存）。
      _pendingSave = full;
      _writePending(full);
      _scheduleFlush();
      console.warn('[worktasks-sync] 远端暂不可读，写入已挂起（本地镜像已保底，将自动重试）');
      return false;
    }
    _pendingSave = null;
    _clearPending();
    return _writeMerged(arr, remote);
  }

  // ---------- v230.08：挂起写入的重试（独立于 start/stop 轮询） ----------
  function _scheduleFlush() {
    if (_flushTimer || !_pendingSave) return;
    _flushTimer = setTimeout(async () => {
      _flushTimer = 0;
      await _flushPending();
    }, FLUSH_RETRY_MS);
  }
  async function _flushPending() {
    if (!_pendingSave) return;
    const arr = _pendingSave;
    const remote = await _readRemoteFresh();
    if (remote === undefined) { _scheduleFlush(); return; }   // 还不行，继续等
    _pendingSave = null;
    await _writeMerged(arr, remote);
    if (typeof App !== 'undefined' && App.currentModule === 'workTasks' && typeof WorkTasksModule !== 'undefined') {
      try { WorkTasksModule.render(); } catch (e) { console.warn('[js/worktasks-sync.js:235] 异常(已忽略):', e); }
    }
  }

  function getCache() { return _live(_cache || []); }
  function setCache(arr) { _cache = arr || []; }

  // ---------- v230.08：墓碑操作（删除 / 撤销删除） ----------
  // 删除：把 id 标记为 _del 墓碑（保留 id + updatedAt=now），父删子级联由调用方给全量 ids。
  function markDeleted(ids) {
    const set = new Set(ids || []);
    if (!set.size) return;
    const ts = Date.now();
    const raw = _cache || [];
    const seen = new Set();
    const next = raw.map((t) => {
      seen.add(t.id);
      if (set.has(t.id)) return Object.assign({}, t, { _del: true, updatedAt: ts });
      return t;
    });
    set.forEach((id) => { if (!seen.has(id)) next.push({ id, _del: true, updatedAt: ts }); });
    _cache = next;
    _writeMirror(next);
  }
  // 撤销删除：清掉这些 id 的墓碑（恢复记录由调用方以新 updatedAt 写回）。
  function clearDeleted(ids) {
    const set = new Set(ids || []);
    if (!set.size || !_cache) return;
    const next = _cache.filter((t) => !(set.has(t.id) && _isTomb(t)));
    _cache = next;
    _writeMirror(next);
  }

  // ====================================================================
  // 独立轻轮询（进入即拉 + 回前台补拉 + 无变更跳过）
  // ====================================================================
  let _timer = null, _sig = null, _onChange = null, _active = false;
  // 🟢 v230.09：可见轮询由 1.5s 放宽至 4s——每轮无变更也要发 1 次 list 探测，
  //   1.5s 长期停留约 40 请求/分钟偏密；4s ≈ 15 次/分钟，多端协同延迟略增但可接受。
  const PERIOD_VISIBLE = 4000, PERIOD_HIDDEN = 30000;

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
    let keyExists = null;   // list 探测结论：null=未知 / true=键在 / false=真空
    try {
      const meta = await SyncManager.getSettingsMeta();
      const m = meta && meta.find((x) => x.name === KEY + '.json');
      if (Array.isArray(meta)) keyExists = !!m;
      const newSig = m ? (KEY + ':' + (m.updated_at || '')) : 'missing';
      if (newSig === _sig && !_pendingSave) return false; // 无变更 → 跳过（与 stocktake skipHeavy 同思路）
      _sig = newSig;
      // ② 真变了才下读：开 CDN 绕过 + 单键直读
      try { if (typeof SyncManager.beginReadRound === 'function') SyncManager.beginReadRound(); } catch (e) { console.warn('[js/worktasks-sync.js:309] 异常(已忽略):', e); }
      const got = await SyncManager.getSettingsKeys([KEY]);
      remote = got && got[KEY];
    } catch (e) {
      return false; // 任何异常静默降级，不引入新失败面
    }
    if (!Array.isArray(remote)) {
      // 读不到值：只有「list 成功且确认无此键」才是云端真空（合法空）；
      // 键应在但读失败 / list 也失败 → 一律不动本地（保守，防假空）。
      if (keyExists !== false) return false;
      remote = [];
    }
    // ③ 合并：本地未同步改动（_cache 已含）与远端按 id 新者胜
    const merged = _pruneTombstones(_mergeById(_cache, remote));
    if (_changed(_cache, merged)) {
      _cache = merged;
      _writeMirror(merged);
      if (_onChange) { try { _onChange(merged); } catch (e) { console.warn('[js/worktasks-sync.js:326] 异常(已忽略):', e); } }
    }
    // 🟢 v230.12：删除意图主动传播（自愈云端）——
    //   场景：删除时远端读不到 → 挂起；刷新页面后挂起已由持久化恢复，但若持久化也失败
    //   （旧版本页面挂起、隐私模式 localStorage 被清），云端会长期停留在「含已删任务」的旧值，
    //   别端拉回去 → 任务「被同步回来」。此处检测：merged 有墓碑、remote 同 id 是较旧活记录
    //   → 本地删除意图比云端新 → 用读-合并-写把墓碑传播上去（不动别端其他新数据）。
    if (_needsTombRepair(remote, merged)) {
      try { await _writeMerged(_live(merged), remote); } catch (e) { console.warn('[js/worktasks-sync.js:334] 异常(已忽略):', e); }
    }
    // ④ 有挂起的写入且远端已可读 → 立即补写（自愈云端）
    if (_pendingSave) { try { await _flushPending(); } catch (e) { console.warn('[js/worktasks-sync.js:337] 异常(已忽略):', e); } }
    return true;
  }

  // 🟢 v230.12：远端是否存在「比本地墓碑更旧的活记录」（删除意图尚未传播到云端）
  function _needsTombRepair(remote, merged) {
    if (!Array.isArray(remote) || !Array.isArray(merged)) return false;
    const rMap = new Map(remote.map((t) => [t.id, t]));
    return merged.some((t) => {
      if (!_isTomb(t)) return false;
      const r = rMap.get(t.id);
      return !!r && !_isTomb(r) && (t.updatedAt || 0) > (r.updatedAt || 0);
    });
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
    // 🟢 v230.12：页面重开后恢复的挂起写入（含墓碑）→ 立即尝试补写
    if (_pendingSave) { _flushPending().catch(() => {}); }
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
    markDeleted, clearDeleted, _flushPending,
  };
})();
if (typeof window !== 'undefined') window.WorkTasksSync = WorkTasksSync;
