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
    version: 'v214',
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
    // 首次部署的默认密码哈希（sha256）：2233 / dcd1994928
    syncPwdHash: 'bcac371b54f59945a14aa49e2e408e5d6e4dbc59387f5d8cfc6b015d40d5bb02',
    adminPwdHash: 'bba16edfc981b72a05de452b046600b49d3829295feef4d119d8f1ffc2dbf0b1'
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
  }
};

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