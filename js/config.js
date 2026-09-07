// ============================================
// 🔐 全站集中配置 · 令牌 · API Key
// ============================================
// 📌 所有"令牌"集中在本文件，便于查找/修改/提取
// ⚠️ 重要安全提示：
//   1. 本应用是纯前端静态站点，部署后源码 100% 公开
//   2. 因此任何写入此文件的 key 都是 PUBLIC（任何访问者都能从浏览器看到）
//   3. anon / public / publishable 类 key（如 Supabase anon key）→ ✅ 公开安全
//   4. secret / private / PAT 类凭证（如 GitHub PAT、第三方 API secret）→ ❌ 不要写入
//   5. 真正私密的密钥请放到服务端代理或 Cloudflare Worker 中转
// ============================================

// 🟢 v210 AUDIT-602：时间相关魔法数字抽成命名常量，消除 86400000 / 25569 散落各文件
//   DAY_MS           —— 一天的毫秒数
//   EXCEL_EPOCH_DAYS —— Excel 1900 日期系统下 1970-01-01 的序列号（25569）。
//                       该基准已内含 Excel 著名的「1900 闰年 bug」偏移，用于反推 JS Date 时
//                       无需再额外 +1，对 1970 年后的业务日期（合同/订单/入库）完全自洽。
const DAY_MS = 86400000;
const EXCEL_EPOCH_DAYS = 25569;

// 🔐 同步 SHA-256（纯 JS，不依赖 crypto.subtle，保证 http/localhost 与 https 环境均可运行）
//   用途：把"同步密码/管理员密码"以哈希形式比对，源码中只存哈希、不存明文（避免 F12 直接搜到密码）。
//   已用 node crypto 对 2233 / dcd1994928 / 中文 / 空串 / 长串 验证逐字节一致。
window.sha256Hex = function (msg) {
  function ror(n, s) { return (n >>> s) | (n << (32 - s)); }
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);
  const utf8 = new TextEncoder().encode(msg);
  const bitLen = utf8.length * 8;
  const padLen = ((utf8.length + 1 + 8 + 63) & ~63);
  const bytes = new Uint8Array(padLen);
  bytes.set(utf8);
  bytes[utf8.length] = 0x80;
  const dv = new DataView(bytes.buffer);
  dv.setUint32(padLen - 8, Math.floor(bitLen / 4294967296));
  dv.setUint32(padLen - 4, bitLen >>> 0);
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const w = new Uint32Array(64);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i-15],7) ^ ror(w[i-15],18) ^ (w[i-15]>>>3);
      const s1 = ror(w[i-2],17) ^ ror(w[i-2],19) ^ (w[i-2]>>>10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e,6) ^ ror(e,11) ^ ror(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ror(a,2) ^ ror(a,13) ^ ror(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+hh)|0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map(x => (x>>>0).toString(16).padStart(8,'0')).join('');
};

window.AppConfig = {

  // ────────────────────────────────────────
  // 1. Supabase 云端同步（库管系统数据备份）
  // ────────────────────────────────────────
  // anon key 本身就是为公开场景设计的，可放前端
  supabase: {
    url: 'https://audzjztaffbtmxshwadn.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1ZHpqenRhZmZidG14c2h3YWRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4OTU5ODksImV4cCI6MjEwMTQ3MTk4OX0.RPPyThgZZMBldysxkuIMBqP6E8WRKhpEOZNQe5itJAg',
    bucket: 'workbench-data',
    file: 'data.json',                       // 工作数据（日常累积，导入/手动推送）
    baseFile: 'base.json',                   // 基准数据（系统底账，与 data.json 分离）
    baseSource: ''                           // 基准数据来源：本地 Excel 已不随包分发，需经「导入 Excel」或 Supabase 同步
  },

  // ────────────────────────────────────────
  // 2. 预留：其它公开服务 key
  // ────────────────────────────────────────
  // 示例格式（不要填写真正的私密密钥）：
  // ga4: { measurementId: 'G-XXXXXXXXXX' },        // Google Analytics
  // sentry: { dsn: 'https://xxx@sentry.io/123' }, // Sentry 公开 DSN
  // mapbox: { publicToken: 'pk.xxx' },            // Mapbox public token
  // ...
  thirdParty: {
    // 在此按需添加公开 token
  },

  // ────────────────────────────────────────
  // 3. 业务参数（不是 key，但集中管理便于查找）
  // ────────────────────────────────────────
  app: {
    name: '库管系统工作台',
    // 🟢 v188：版本号改为「动态派生」——运行时由 app.js 的 syncVersionFromCss()
    //   从 index.html 中 style.css 的 ?v= 参数自动读取（如 ?v=188 → 'v188'），
    //   覆盖本处写死的兜底值。发版只需 bump CSS 版本查询参数，徽章+控制台水印全链路自动同步。
    //   本值仅作为脚本加载失败/无 ?v= 时的兜底。
    // 🟢 v201：二维码白框上下边与基础信息白框严格对齐
    // 🟢 v207：P0 安全与数据一致性修复（AUDIT-201 XSS / AUDIT-101 缓存 / AUDIT-302 事务）
    version: 'v227.91',
    beaconAppkey: '0WEB06U85YBSLJNL',          // 腾讯 beacon 分析 SDK appkey（原硬编码于 index.html，外提至此）
    dataPath: '',                           // 无内置数据文件；需经「导入 Excel」上传或 Supabase 云端同步
    kpiAllLimit: 1000000,        // 🟢 O7：出库 KPI 统计时一次性取出的全量上限（M6 修复用）
    defaultPageSize: 20,         // 🟢 AUDIT-603：分页每页默认条数（原散落 20+ 处写死 20）
    orderTrackPageSize: 50,      // 🟢 AUDIT-603：订单跟踪列表每页条数（原 order-track.js 写死 50）
    queryPageSize: 30            // 🟢 AUDIT-603：综合查询每页条数（原 query.js 写死 30）
  },

  // ────────────────────────────────────────
  // 🔐 密码 / 凭证覆盖层（v214）
  //   · 默认密码以「哈希」写死在此（不存明文），校验时实时 sha256 对比；
  //   · 同步密码可被管理员修改（存 localStorage 覆盖）；管理员密码固定不可改；
  //   · 内置 Supabase 凭证可被管理员覆盖（换项目），否则用 supabase.url/anonKey 默认值。
  // ────────────────────────────────────────
  defaultPasswords: {
    // 🟢 v224：用户反馈同步密码 1122、管理员密码 940928（按 sha256 哈希写入）
    syncPwdHash: 'b3282a2f2a28757b3a18ab833de16a9c54518c0b0cf493e3f0a7cf09386f326a',
    adminPwdHash: 'f19874b2240d959db5749d253de61bc527a1f307699816a5f1766fd7d598dce1'
  },
  // 同步密码哈希：已修改则取 localStorage，否则取默认值
  getSyncPwdHash() {
    try { return localStorage.getItem('wb_sync_pwd_hash') || this.defaultPasswords.syncPwdHash; }
    catch (e) { return this.defaultPasswords.syncPwdHash; }
  },
  setSyncPwdHash(h) { try { localStorage.setItem('wb_sync_pwd_hash', h); } catch (e) { /* 隐私模式忽略 */ } },
  // 管理员密码固定（不提供修改入口）
  getAdminPwdHash() { return this.defaultPasswords.adminPwdHash; },
  // 有效 Supabase 凭证：管理员覆盖优先，否则内置默认
  getEffectiveSupabase() {
    try {
      const o = JSON.parse(localStorage.getItem('wb_supabase_override') || 'null');
      if (o && o.url && o.key) return { url: o.url, key: o.key };
    } catch (e) { /* 解析失败回退默认 */ }
    return { url: this.supabase.url, key: this.supabase.anonKey };
  },
  setSupabaseOverride(url, key) {
    try { localStorage.setItem('wb_supabase_override', JSON.stringify({ url: url, key: key })); }
    catch (e) { /* 隐私模式忽略 */ }
  },

  // ────────────────────────────────────────
  // 🔐 库管员账号体系（v216 新增 · Step 5 登录账号与库管员管理）
  //   · 存储：本地 localStorage 为「真相源」，云端复用现有 settings.json（读-改-写 + 回读重试）同步。
  //   · 密码：独立加盐 sha256（不复用 v214 同步/管理员密码哈希，互不污染）。
  //   · 【行为保持】纯新增 API，完全不触碰 v214 的同步密码 / 管理员密码逻辑。
  //   · 设计点：①用户名创建后不可改（盘点记录按名字归属，改名会断历史）②删除=禁用（历史可查）。
  // ────────────────────────────────────────
  KEEPER_SALT: 'wb_keeper_v216_salt_9f3a',

  // 🟢 v227.39：把 4 个系统入口（云端同步 / 数据导入 / 设置 / 源码）也纳入权限体系
  //   - 与 18 个业务模块共用一份权限检查（管理员默认全开，keeper 需显式勾选）
  //   - 改动放在 MODULES 之后，KEEPER_PRESETS 之前，确保渲染权限面板时已就绪
  ENTRY_MODULES: [
    { key: 'cloud',  label: '云端同步', icon: '☁️', group: '系统' },
    { key: 'import', label: '数据导入', icon: '🔄', group: '系统' },
    { key: 'settings', label: '设置',     icon: '⚙️', group: '系统' },
    { key: 'source', label: '源码',     icon: '📦', group: '系统' }
  ],
  // 读某账号是否可访问某系统入口（云端/导入/设置/源码）。
  //   - 管理员特权优先：一旦建立 admin session 或作业身份是 admin → 直接放行
  //   - 老 keeper / 未配 entries 字段 → 默认全开（向后兼容）
  //   - 新 keeper (entries=[]) → 默认无权限
  canAccessEntry(username, entryKey) {
    if (typeof this.isAdmin === 'function' && this.isAdmin()) return true;
    const name = String(username || '').trim();
    if (!name) return false;                                                  // 🟢 v227.39：未登录一律隐藏
    const k = this.getKeepers().find(x => x.username === name);
    if (!k) return false;                                                     // 不存在的账号：无权
    if (k.disabled) return false;
    if (!Array.isArray(k.entries)) return true;                               // 老账号 / 未配 entries：默认全开（向后兼容）
    return k.entries.indexOf(entryKey) !== -1;
  },

  // ===== v217 模块权限清单（共 18 项，顺序即侧边栏顺序）=====
  // 落地页"第一个有权限模块"按此数组顺序取；分组仅用于设置界面展示。
  MODULES: [
    { key: 'dashboard',         label: '首页仪表盘',     icon: '📊', group: '总览' },
    { key: 'query',             label: '查询系统',       icon: '🔍', group: '总览' },
    { key: 'inventoryAlert',    label: '库存预警',       icon: '⚠️', group: '预警分析' },
    { key: 'orderCheck',        label: '订货核对',       icon: '📋', group: '订单' },
    { key: 'orderTrack',        label: '订单跟踪',       icon: '📦', group: '订单' },
    { key: 'stock',             label: '现存量',         icon: '🏪', group: '盘点核心' },
    { key: 'stocktake',         label: '盘点',           icon: '📋', group: '盘点核心' },
    { key: 'stocktakeRecord',   label: '盘点记录列表',   icon: '📝', group: '盘点核心' },
    { key: 'orders',            label: '订单列表',       icon: '📝', group: '订单' },
    { key: 'inbound',           label: '入库列表',       icon: '📥', group: '出入库' },
    { key: 'pricing',           label: '合同价格',       icon: '💰', group: '供应商/合同' },
    { key: 'reconciliation',    label: '对账功能',       icon: '📋', group: '供应商/合同' },
    { key: 'supplier',          label: '供应商管理',     icon: '🏭', group: '供应商/合同' },
    { key: 'lowTurnover',       label: '低周转材料',     icon: '🐢', group: '预警分析' },
    { key: 'breach',            label: '违约台账',       icon: '❌', group: '供应商/合同' },
    { key: 'outbound',          label: '临时出库',     icon: '📤', group: '出入库' },
    { key: 'outboundList',      label: '中心出库列表', icon: '🏬', group: '出入库' }
  ],
  // v224：盘点模块下的子权限「查看分派 / 分派任务」，不勾选时任务栏只显示「我的任务」。
  // 单独抽成权限项，方便库里灵活控制谁能看其他人被分派了什么。
  STOCKTAKE_SUB_MODULES: [
    { key: 'stocktakeAssign',   label: '查看/分派盘点任务', icon: '🧩', group: '盘点核心' }
  ],
  // 快速预设
  KEEPER_PRESETS: {
    // 盘点岗（只负责盘点的库管员）：可查看/分派任务（自领）、不含批次汇总（管理视角）
    stocktake: ['stocktake', 'stocktakeAssign', 'stocktakeRecord', 'query', 'outboundList'],
    // 全业务（管理员 / 自己）：含全部模块 + 子权限 + 4 个系统入口
    admin: [
      // 18 业务模块
      'dashboard','query','inventoryAlert','orderCheck','orderTrack','stock','stocktake','stocktakeAssign','stocktakeBatch','stocktakeRecord','orders','inbound','pricing','reconciliation','supplier','lowTurnover','breach','outbound','outboundList',
      // 🟢 v227.39：4 个系统入口（云端/导入/设置/源码）
      'cloud','import','settings','source'
    ]
  },
  // 读某账号的授权模块（兼容老账号：未设 modules 视为全开）
  getKeeperModules(username) {
    const name = String(username || '').trim();
    const k = this.getKeepers().find(x => x.username === name);
    if (!k) return null;
    if (!Array.isArray(k.modules)) return this.MODULES.map(x => x.key); // 老账号：全开
    return k.modules.slice();
  },

  _keeperLSKey() { return 'wb_keepers'; },
  _keeperLoginKey() { return 'wb_current_keeper'; },

  // 读全部账号（容错：解析失败返回空数组）
  getKeepers() {
    try { return JSON.parse(localStorage.getItem(this._keeperLSKey()) || '[]'); }
    catch (e) { return []; }
  },

  // 写全部账号（同步落本地）+ 异步上云（best-effort，不阻塞）
  setKeepers(arr) {
    try { localStorage.setItem(this._keeperLSKey(), JSON.stringify(Array.isArray(arr) ? arr : [])); }
    catch (e) { /* 隐私模式忽略 */ }
    this.syncKeepers();
  },

  // 加盐哈希：hash = sha256(trim(username) + ':' + pwd + ':' + SALT)
  _hashKeeper(username, pwd) {
    const raw = String(username || '').trim() + ':' + String(pwd || '') + ':' + this.KEEPER_SALT;
    return (typeof sha256Hex === 'function') ? sha256Hex(raw) : raw;
  },

  // 新增 / 修改账号（password 为明文，内部哈希存储；传 undefined 表示不改密码）
  upsertKeeper(username, pwd, opts) {
    opts = opts || {};
    const name = String(username || '').trim();
    if (!name) return { ok: false, msg: '用户名不能为空' };
    const list = this.getKeepers();
    const exist = list.find(k => k.username === name);
    const rec = exist || { username: name, createdAt: new Date().toISOString() };
    if (pwd !== undefined && pwd !== null && pwd !== '') rec.pwdHash = this._hashKeeper(name, pwd);
    if (opts.disabled !== undefined) rec.disabled = opts.disabled ? 1 : 0;
    // v217：模块权限。编辑模式传 modules 则覆盖；新增账号未指定则用盘点岗预设
    if (Array.isArray(opts.modules)) rec.modules = opts.modules.slice();
    else if (!exist && !Array.isArray(rec.modules)) rec.modules = (this.KEEPER_PRESETS.stocktake || []).slice();
    // 🟢 v227.39：系统入口权限（云端/导入/设置/源码）。编辑模式传 entries 才覆盖；新增账号不预置（默认无）
    if (Array.isArray(opts.entries)) rec.entries = opts.entries.slice();
    if (exist) { list[list.indexOf(exist)] = rec; }
    else list.push(rec);
    this.setKeepers(list);
    return { ok: true, rec: rec };
  },

  // 🟢 v227.39：单设某账号的系统入口权限（不传密码、不动 modules）
  setKeeperEntries(username, entries) {
    const list = this.getKeepers();
    const idx = list.findIndex(k => k.username === String(username || '').trim());
    if (idx === -1) return { ok: false, msg: '账号不存在' };
    list[idx].entries = Array.isArray(entries) ? entries.slice() : [];
    this.setKeepers(list);
    return { ok: true };
  },

  // 禁用 / 启用账号（默认禁用而非物理删除）
  disableKeeper(username, disabled) {
    return this.upsertKeeper(username, undefined, { disabled: disabled });
  },

  // 校验登录：成功返回账号对象，失败（无此人/禁用/密码错）返回 null
  verifyKeeper(username, pwd) {
    const name = String(username || '').trim();
    const list = this.getKeepers();
    const k = list.find(x => x.username === name);
    if (!k || k.disabled) return null;
    if (k.pwdHash !== this._hashKeeper(name, pwd)) return null;
    return k;
  },

  // ── v222：管理员特权会话（独立 key，与「当前作业身份」分离）──────────────
  // 背景：管理员会话原本也写在 wb_current_keeper 里，一旦再登录库管员就被整体覆盖，
  //   管理员的模块权限随之消失（用户反馈「同时登录两个账号后管理员就没权限了」）。
  // 现拆成两条线：
  //   wb_admin_session  —— 管理员特权（输对管理员密码即建立，只有显式退出才清）
  //   wb_current_keeper —— 当前作业身份（决定盘点记录归属谁），可被库管员登录切换
  // 特权与作业身份互不干扰：登录库管员不会抹掉管理员特权。
  _adminKey() { return 'wb_admin_session'; },
  getAdminSession() {
    try { const s = localStorage.getItem(this._adminKey()); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  },
  setAdminSession() {
    const sess = { username: '管理员', role: 'admin', loginAt: new Date().toISOString() };
    try { localStorage.setItem(this._adminKey(), JSON.stringify(sess)); } catch (e) { /* 忽略 */ }
    return this.getAdminSession();
  },
  clearAdminSession() { try { localStorage.removeItem(this._adminKey()); } catch (e) {} },
  // 是否具备管理员特权：特权会话在 → true；否则看当前作业身份是否是管理员
  isAdmin() {
    const a = this.getAdminSession();
    if (a && a.role === 'admin') return true;
    const u = this.getCurrentUser();
    return !!(u && (u.role === 'admin' || u.username === '管理员'));
  },

  // 登录：写本地会话（仅存用户名 + 时间 + 角色，不存密码）
  login(username, pwd) {
    const k = this.verifyKeeper(username, pwd);
    if (!k) return { ok: false, msg: '用户名或密码错误，或账号已禁用' };
    // v222：必须带 role —— 之前会话没有 role 字段，管理员身份在库管员登录后无法被识别
    const role = (k.role === 'admin' || k.username === '管理员') ? 'admin' : 'keeper';
    try { localStorage.setItem(this._keeperLoginKey(), JSON.stringify({ username: k.username, role: role, loginAt: new Date().toISOString() })); }
    catch (e) { /* 忽略 */ }
    return { ok: true, username: k.username };
  },
  // 退出作业身份：若管理员特权仍在，则回落到管理员（而不是变成「未登录」）
  logout() {
    try {
      const admin = this.getAdminSession();
      if (admin && admin.role === 'admin') {
        localStorage.setItem(this._keeperLoginKey(), JSON.stringify({ username: '管理员', role: 'admin', loginAt: new Date().toISOString() }));
      } else {
        localStorage.removeItem(this._keeperLoginKey());
      }
    } catch (e) {}
  },
  // 彻底退出（连管理员特权一起清）
  logoutAll() {
    try { localStorage.removeItem(this._keeperLoginKey()); } catch (e) {}
    this.clearAdminSession();
  },
  // 🟢 v227.36：本机「已联网验证过的账号」缓存（支撑「首次联网验证 / 之后离线复用」）
  //   仅记用户名+时间戳，不含密码；离线登录时据此放行，不重新走网络。
  _keeperVerifiedKey() { return 'wb_keeper_verified'; },
  getVerifiedKeepers() {
    try { return JSON.parse(localStorage.getItem(this._keeperVerifiedKey()) || '{}'); }
    catch (e) { return {}; }
  },
  markKeeperVerified(username) {
    try {
      const m = this.getVerifiedKeepers();
      m[String(username || '').trim()] = Date.now();
      localStorage.setItem(this._keeperVerifiedKey(), JSON.stringify(m));
    } catch (e) { /* 隐私模式忽略 */ }
  },
  isKeeperVerified(username) {
    const m = this.getVerifiedKeepers();
    return !!(m && m[String(username || '').trim()]);
  },
  getCurrentUser() {
    try { const s = localStorage.getItem(this._keeperLoginKey()); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  },
  isLoggedIn() { return !!this.getCurrentUser(); },

  // v222：真删除账号（历史盘点记录按用户名归属，删账号不影响已产生的记录，仍可查）
  removeKeeper(username) {
    const name = String(username || '').trim();
    if (!name) return { ok: false, msg: '用户名不能为空' };
    if (name === '管理员') return { ok: false, msg: '内置管理员账号不可删除' };
    const list = this.getKeepers();
    const idx = list.findIndex(k => k.username === name);
    if (idx === -1) return { ok: false, msg: '账号不存在' };
    list.splice(idx, 1);
    this.setKeepers(list);
    // 当前登录的正是被删账号 → 退出该身份（管理员特权保留则回落管理员）
    const u = this.getCurrentUser();
    if (u && u.username === name) this.logout();
    return { ok: true };
  },

  // 账号上云：复用现有 settings.json（key='keepers'，读-改-写 + 回读），与盘点数据包完全独立
  async syncKeepers() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    try { await SyncManager.setSetting('keepers', this.getKeepers()); }
    catch (e) { console.warn('[keepers] 上云失败(已忽略):', e && e.message); }
  },
  // 启动连接成功后拉取云端账号并与本地合并（云端独有→加入；禁用态以本地为准）
  async pullKeepersFromCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    try {
      const cloud = await SyncManager.getSetting('keepers');
      if (!Array.isArray(cloud) || !cloud.length) return;
      const local = this.getKeepers();
      const map = {};
      local.forEach(k => { map[k.username] = k; });
      cloud.forEach(k => {
        const ex = map[k.username];
        if (!ex) map[k.username] = k;                                   // 云端独有账号 → 同步到本地
        else if (!ex.disabled && k.disabled) ex.disabled = 1;           // 云端已禁用 → 同步禁用
        // 本地已禁用而云端未禁用：本地优先（管理员刚在本机禁用是最终意图）
      });
      this.setKeepers(Object.values(map));
    } catch (e) { console.warn('[keepers] 拉取失败(已忽略):', e && e.message); }
  },
  // 🟢 v227.39：从云端下发的「共享云配置」（URL + Anon Key）→ 写入 wb_supabase_override → 触发自动连
  //   - 管理员首次配好后，下发到所有 keeper 设备；新设备登录即默认连接
  //   - 本地已有 override 时不会被云端覆盖（避免管理员误改影响他人）
  async pullCloudConfigFromCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const cfg = await SyncManager.getSetting('cloudConfig');
      if (!cfg || !cfg.url || !cfg.key) return false;
      // 已有本地 override 且不同时来自本机的，不覆盖
      const haveLocal = (() => { try { return !!localStorage.getItem('wb_supabase_override'); } catch (e) { return false; } })();
      if (!haveLocal) {
        try { localStorage.setItem('wb_supabase_override', JSON.stringify({ url: cfg.url, key: cfg.key })); } catch (e) {}
        if (typeof SyncManager === 'object' && SyncManager && typeof SyncManager.connect === 'function') {
          try { await SyncManager.connect(cfg.url, cfg.key); } catch (e) { console.warn('[cloudConfig] 自动连接失败(已忽略):', e && e.message); }
        }
      }
      return true;
    } catch (e) { console.warn('[cloudConfig] 拉取失败(已忽略):', e && e.message); return false; }
  },
  // 🟢 v227.39：管理员把当前 effective 配置上云，供其他设备一键同步
  async syncCloudConfig() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    const eff = this.getEffectiveSupabase();
    if (!eff.url || !eff.key) return false;
    try { await SyncManager.setSetting('cloudConfig', { url: eff.url, key: eff.key }); return true; }
    catch (e) { console.warn('[cloudConfig] 上云失败(已忽略):', e && e.message); return false; }
  }
};

// 速查表：key → label（对象字面量内不能引用自身，定义后补全）
AppConfig.MODULES_MAP = {};
AppConfig.MODULES.forEach(function (m) { AppConfig.MODULES_MAP[m.key] = m.label; });

console.log('[AppConfig] 已加载 ' + window.AppConfig.app.version + ' · Supabase URL: ' + window.AppConfig.supabase.url);


// ============================================
// 🔧 全局安全工具函数（只做转义，不改变任何业务逻辑）
// ============================================
// esc()：HTML 文本转义 —— 正常文本渲染结果与原完全一致，
//        仅当数据含 < > & " ' 时转为实体，防止注入破坏页面。
window.esc = function (v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
// escAttr()：用于 HTML 属性值（value="..." / onclick="..."）内的转义
window.escAttr = window.esc;

// round2()：浮点精度修复（v217 BUG-B）。例：330.29 - 320 = 10.29000000000002 → 10.29
window.round2 = function (v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
};

// dedupStocktakeRecords()：v217 存量去重
// 历史数据里同一批次同一存货编码可能存在多条有效记录（重复保存/多端各存），
// 直接累加会让「已盘数、覆盖率、盘盈盘亏」全部虚高。这里按存货编码保留最新一条。
// 排序优先级：countedAt(ISO) > id(自增)，取大者胜。
window.dedupStocktakeRecords = function (list) {
  const out = new Map();
  (list || []).forEach(function (r) {
    if (!r) return;
    const k = String(r.存货编码 == null ? '' : r.存货编码).trim();
    if (!k) return;
    const prev = out.get(k);
    if (!prev) { out.set(k, r); return; }
    const seq = function (x) {
      const t = x.countedAt ? Date.parse(x.countedAt) : NaN;
      if (!isNaN(t)) return t;
      const i = Number(x.id);
      return isNaN(i) ? 0 : i;
    };
    if (seq(r) >= seq(prev)) out.set(k, r);
  });
  return Array.from(out.values());
};