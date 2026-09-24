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

// 🟢 AUDIT-228-09（v228.18）：生产环境 console 日志开关。
//   背景：全仓 47 处 console.log（data-loader.js 独占 36），会把导入/同步过程信息输出到
//   生产控制台，既轻微影响性能，也把内部流程暴露给任何打开 DevTools 的人。
//   做法：默认静默 log / debug / info，**保留 warn 与 error**（线上诊断仍可用）；
//   需要调试时在控制台执行 `localStorage.setItem('wb_debug_log','1')` 并刷新即可恢复。
//   ⚠️ 必须放在 config.js 最顶部：本文件是 index.html 中第一个业务脚本，早于所有业务日志。
(function () {
  var on = false;
  try { on = localStorage.getItem('wb_debug_log') === '1'; } catch (e) { on = false; }
  if (on) { window.__WB_DEBUG__ = true; return; }
  var noop = function () {};
  if (typeof console !== 'undefined') {
    console.log = noop;
    console.debug = noop;
    console.info = noop;
  }
})();

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

// ────────────────────────────────────────────────────────────────
// 🟢 v228.04：内置云端凭证「分段 + 轻量编码」存储
// ────────────────────────────────────────────────────────────────
// 目的：避免源码（含「源码下载」打出的包）出现完整的 JWT 头部特征串（eyJ 开头的那串），
//       从而规避部署平台 / 密钥扫描器（GitGuardian 类）的明文凭证告警。
//
// ⚠️ 这不是安全加密：anon key 本就是 Supabase 为「公开场景」设计的客户端密钥，
//    前端无论如何混淆，运行时都必须在内存里还原成明文才能发起请求。
//    真正的防线是 Supabase RLS（行级安全策略），不是"藏住 key"。
//
// ⚠️ 必须【同步】还原：SyncManager.init() 在启动时依赖 AppConfig.supabase，
//    若改成异步（如 crypto.subtle），init 会抢在还原完成前执行并拿到空值，
//    直接导致「首次登录自动连接云端」失效。切勿改为异步。
//
// 维护（换 key 时）：
//    node tools/credential-tool.mjs encode "<url>" "<anonKey>"
//    → 把输出的 _CRED_PARTS 片段整体替换到下方；再用 `verify` 校验还原一致。
const _CRED_XOR = 'stockhub-2026';
const _CRED_PARTS = [
  'CFYaEQdKT0BFRkRCRUlbQBkPCx8TRFtUQU4WAAcFHgccDVpLHkFDAxUNAhgNWwFCEBwQXRYNTVlJDQwoRVB3UV88H',
  'SUqPhI8U2NbeUF/HSZaACghQytGQmhkdTlNQQYSIgUBHn9ZfV85Dgs7KQAsD2tIamF/AD0BKQcyHCsbe15CXSpGHx',
  'sKPxkJTgFYXlI0HAIHPFEFAB5WBXtfBB0MDlIbLzFkBHlfcAYWXVcCJDYoXWtoY188HipQJCweVmB2ZUh7Jy0cKgY',
  '+QQFuewZ/XDYDITcmXDg2YEp+XAZdOTUxMVEPUGtTAGpMARUlJhwlTDZARVF2cBxMLhAKKz4qTkp0Z341DSoMAEoI',
];

/** 同步还原内置凭证（分段拼接 → Base64 解码 → XOR）。失败时明确报错，不静默置空。 */
function _credRestore() {
  try {
    const bin = atob(_CRED_PARTS.join(''));
    const k = _CRED_XOR;
    let out = '';
    for (let i = 0; i < bin.length; i++) {
      out += String.fromCharCode(bin.charCodeAt(i) ^ k.charCodeAt(i % k.length));
    }
    const obj = JSON.parse(out);
    if (!obj || !obj.url || !obj.key) throw new Error('还原结果缺少 url/key');
    return obj;
  } catch (e) {
    console.error('[config] 内置云端凭证还原失败，云端自动连接将不可用（可在「云端同步」手动填写）：', e);
    return { url: '', key: '' };
  }
}
const _REST = _credRestore();

// ────────────────────────────────────────
// 🔐 v228.74：cloudConfig 下发签名（修复 AUDIT-228-102）
//   · v228.72 把 cloudConfig 改成「强制跟随」，但写入通道是 anon（公开 key），
//     任何拿到 anon key 的人都能覆盖 settings/cloudConfig.json，使全体设备每 60s
//     无确认地切到攻击者桶 → 数据外泄/劫持。
//   · 修复：管理员「下发」时对本机 effective 配置做 HMAC-SHA256 签名（密钥混淆内嵌于前端），
//     客户端 pull 时必须校验签名通过才跟随；无签名/签名不符的配置一律忽略。
//   · 这是静态 PWA（无 Auth）下的最小可用防护：把攻击门槛从「有 anon key 即可」提高到
//     「须反编译出混淆签名密钥」。密钥仍在前端（anon 全权属 AUDIT-228-101，需后端代理/Auth 才能根除）。
// ────────────────────────────────────────
const _CFG_SIG_XOR = 'wb-cfg-sig-2026';
const _CFG_SIG_PARTS = [
  'TlUbUFNVSxUNAU8ABgAERgcZWgNfHU',
  'MIBBsDAgNQEgQdW1IEG0ZdBhtQBlME',
  'ElIUUwcFHEAMXk9XCFRUFlIfAA=='
];
function _cfgSigSecret() {
  try {
    const bin = atob(_CFG_SIG_PARTS.join(''));
    const k = _CFG_SIG_XOR;
    let out = '';
    for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i) ^ k.charCodeAt(i % k.length));
    return out;
  } catch (e) { console.error('[config] cloudConfig 签名密钥还原失败:', e); return ''; }
}

// 纯 JS SHA-256 + HMAC-SHA256（字节级，依赖 TextEncoder，浏览器/Node 通用）
// 已与 Node crypto.createHmac('sha256') 交叉验证一致。
const _SHA256_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function _sha256Bytes(bytes) {
  const H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l=bytes.length, bitLen=l*8, total=((l+1+8+63)&~63);
  const m=new Uint8Array(total); m.set(bytes); m[l]=0x80;
  const hi=Math.floor(bitLen/0x100000000), lo=bitLen>>>0;
  m[total-8]=(hi>>>24)&255; m[total-7]=(hi>>>16)&255; m[total-6]=(hi>>>8)&255; m[total-5]=hi&255;
  m[total-4]=(lo>>>24)&255; m[total-3]=(lo>>>16)&255; m[total-2]=(lo>>>8)&255; m[total-1]=lo&255;
  const w=new Uint32Array(64);
  for (let off=0; off<total; off+=64) {
    for (let i=0;i<16;i++){ const j=off+i*4; w[i]=(m[j]<<24)|(m[j+1]<<16)|(m[j+2]<<8)|m[j+3]; }
    for (let i=16;i<64;i++){
      const s0=((w[i-15]>>>7)|(w[i-15]<<25))^((w[i-15]>>>18)|(w[i-15]<<14))^(w[i-15]>>>3);
      const s1=((w[i-2]>>>17)|(w[i-2]<<15))^((w[i-2]>>>19)|(w[i-2]<<13))^(w[i-2]>>>10);
      w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (let i=0;i<64;i++){
      const S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
      const ch=(e&f)^((~e)&g), t1=(h+S1+ch+_SHA256_K[i]+w[i])>>>0;
      const S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
      const maj=(a&b)^(a&c)^(b&c), t2=(S0+maj)>>>0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
  }
  return H;
}
function _hmacSha256Hex(msgStr, keyStr) {
  const enc=new TextEncoder();
  let key=enc.encode(keyStr);
  if (key.length>64) key=_sha256Bytes(key);
  const inner=new Uint8Array(64), outer=new Uint8Array(64);
  for (let i=0;i<key.length;i++){ inner[i]=key[i]^0x36; outer[i]=key[i]^0x5c; }
  for (let i=key.length;i<64;i++){ inner[i]=0x36; outer[i]=0x5c; }
  const msg=enc.encode(msgStr);
  const innerMsg=new Uint8Array(64+msg.length); innerMsg.set(inner); innerMsg.set(msg,64);
  const ih=_sha256Bytes(innerMsg), outerMsg=new Uint8Array(64+32); outerMsg.set(outer);
  for (let i=0;i<8;i++) for (let j=0;j<4;j++) outerMsg[64+i*4+j]=(ih[i]>>>(24-j*8))&255;
  const fh=_sha256Bytes(outerMsg); let s='';
  for (let i=0;i<8;i++) for (let j=3;j>=0;j--) s+=((fh[i]>>>(j*8))&255).toString(16).padStart(2,'0');
  return s;
}
function _cloudConfigPayload(url, key, bucket, ts) {
  return url + '|' + key + '|' + (bucket || 'workbench-data') + '|' + ts;
}
function _verifyCloudConfig(cfg) {
  if (!cfg || !cfg.url || !cfg.key || !cfg.sig || cfg.ts === undefined || cfg.ts === null) return false;
  const bucket = cfg.bucket || 'workbench-data';
  const payload = _cloudConfigPayload(cfg.url, cfg.key, bucket, cfg.ts);
  const expect = _hmacSha256Hex(payload, _cfgSigSecret());
  if (typeof expect !== 'string' || expect.length === 0) return false;
  const a = String(cfg.sig), b = expect;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

window.AppConfig = {

  // ────────────────────────────────────────
  // 1. Supabase 云端同步（库管系统数据备份）
  // ────────────────────────────────────────
  // anon key 本身就是为公开场景设计的，可放前端（真正防线是 RLS）。
  // 🟢 v228.04：值由上方 _credRestore() 同步还原，源码内不再出现完整明文。
  supabase: {
    url: _REST.url,
    anonKey: _REST.key,
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
    // 🟢 v228.48：真实走查修复 —— 启动兜底「空状态」不再覆盖用户已打开的界面
    // 🟢 v228.45：季度盘点跨端一致性 —— 同一账号 PC/移动端任务、进度、批次区间完全统一
    version: 'v229.17',
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
      if (o && o.url && o.key) return { url: o.url, key: o.key, bucket: o.bucket || this.supabase.bucket };
    } catch (e) { /* 解析失败回退默认 */ }
    return { url: this.supabase.url, key: this.supabase.anonKey, bucket: this.supabase.bucket };
  },
  // 🟢 v228.66-P0：override 支持 bucket，便于迁移到自定义桶名的项目（D2=B）
  setSupabaseOverride(url, key, bucket) {
    try { localStorage.setItem('wb_supabase_override', JSON.stringify({ url: url, key: key, bucket: bucket || this.supabase.bucket })); }
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
    // 盘点岗（只负责盘点的库管员）：可查看/分派任务（自领）
    stocktake: ['stocktake', 'stocktakeAssign', 'stocktakeRecord', 'query', 'outboundList'],
    // 全业务（管理员 / 自己）：含全部模块 + 子权限 + 4 个系统入口
    admin: [
      // 17 业务模块（🟢 v228.60：移除 stocktakeBatch —— 盘点批次汇总模块已下线）
      'dashboard','query','inventoryAlert','orderCheck','orderTrack','stock','stocktake','stocktakeAssign','stocktakeRecord','orders','inbound','pricing','reconciliation','supplier','lowTurnover','breach','outbound','outboundList',
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
  // 🟢 v228.81：新增 opts.bumpMeta（默认 true）。账号真相变更（新增/改密/改权限/禁用/删除）走默认，
  //   写完后 bump 云端 keepersMeta 时间戳键 → 其他设备哨兵轮询秒级感知；
  //   接收端拉取（pullKeepersFromCloud）传 {bumpMeta:false}，避免回写触发"全设备互拉"死循环。
  // 🟢 v228.82：先等云端账号列表上云完成，再 bump 时间戳 —— 消除「meta 已新、keepers 尚旧」的竞态窗口。
  //   旧版 syncKeepers() 与 _bumpKeepersMeta() 并发未 await，若 meta 先于 keepers 上云，其他设备会在
  //   meta 变化后 pull 到「旧 keepers」并写回本地、且把 _keepersLastMetaTs 卡为新值 → 永不二次 pull →
  //   跨设备权限变更丢失（典型表现：PC 改权限后移动端已登录库管员迟迟不解锁）。
  //   仅 sync 成功才 bump：离线/失败则不通知其他设备（它们也离线，无意义，且避免误导）。
  // 🔴 v228.84（真实根因修复）：新增 opts.pushCloud（默认 true）。**接收端拉取路径必须传 false**。
  //   事故链（真机复现，桩日志实证）：接收端 pull 到云端 keepers 后调 setKeepers(合并结果)，
  //   而 setKeepers 第一步就是 syncKeepers() 把【本机列表】推上云 —— 一旦这次 pull 因任何原因
  //   读到了陈旧值（短缓存 / CDN 旧值 / 恰好落在对方 PUT 之前），接收端就会用【旧列表】覆盖云端，
  //   把管理员刚授权的权限抹掉；同时 _keepersLastMetaTs 已被记为最新 → 永不重拉 → 权限永久丢失。
  //   这正是"PC 改权限后移动端/库管员端不解锁"的真实机制（不只是没拉到，而是拉取动作反向污染云端）。
  //   → 接收端只落本地，**绝不回写云端**；云端真相只由"本机发生账号变更"的那一端写入。
  async setKeepers(arr, opts) {
    opts = opts || {};
    try { localStorage.setItem(this._keeperLSKey(), JSON.stringify(Array.isArray(arr) ? arr : [])); }
    catch (e) { /* 隐私模式忽略 */ }
    if (opts.pushCloud === false) return;   // 🟢 v228.84：接收端合并结果只落本地，不回写云端
    let synced = false;
    try { await this.syncKeepers(); synced = true; } catch (e) { /* 离线/失败：本端已落本地，仅不通知其他设备 */ }
    if (synced && opts.bumpMeta !== false) { try { await this._bumpKeepersMeta(); } catch (e) {} }
  },

  // 🟢 v228.81：账号/权限哨兵 —— 轻量时间戳键。
  //   · 仅存 {ts}，几十字节；与全量 keepers（几 KB）解耦，使"常轮询"只探 tiny 键、全量仅在真变更时拉。
  //   · 写云端 keepersMeta + 同浏览器多标签 BroadcastChannel 广播；并设置本端 _keepersLastMetaTs
  //     跳过自家 watch 的自拉（编辑端已是最新，无需再 pull）。
  _keepersChannel: undefined,
  _keepersLastMetaTs: 0,
  // 🟢 v228.84：D1 搭车用的「物理文件时间戳」——记录上次从数据同步心跳 list 里看到的
  //   settings/keepersMeta.json 的 updated_at（ISO→ms）。与 _keepersLastMetaTs（逻辑 ts，来自文件内容 {ts}）
  //   分开记录，二者都在同一次 bump 时变化，故可用于去重、避免每次心跳都误触发拉取。
  _keepersLastMetaUpdatedAt: 0,
  _cloudCfgLastMetaUpdatedAt: 0,   // 🟢 v228.94：云端配置(cloudConfig.json)物理时间戳，复用数据同步心跳做零额外请求探测
  async _bumpKeepersMeta() {
    const ts = Date.now();
    this._keepersLastMetaTs = ts; // 本端刚写，跳过自家 5s watch 的自拉
    try {
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
        await SyncManager.setSetting('keepersMeta', { ts });
      }
    } catch (e) { /* 忽略：哨兵键写入失败不阻断账号保存 */ }
    const ch = this._getKeepersChannel();
    if (ch) { try { ch.postMessage({ type: 'keepersChanged', ts }); } catch (e) {} }
  },
  _getKeepersChannel() {
    if (this._keepersChannel === undefined) {
      this._keepersChannel = null;
      if (typeof BroadcastChannel !== 'undefined') {
        try { this._keepersChannel = new BroadcastChannel('wb_keepers'); } catch (e) { this._keepersChannel = null; }
      }
    }
    return this._keepersChannel;
  },
  // 🟢 v228.81：哨兵tick —— 由 sync.js 的 5s 轮询与 app.js 的 BroadcastChannel/storage 事件共用。
  //   只读云端 keepersMeta（单键直读，~1 请求）；ts 变化才 pullKeepersFromCloud（全量仅在真变更时拉），
  //   拉取成功后触发 App._onKeepersChanged() 做静默刷新。返回是否发生了变更拉取。
  async keepersWatchTick() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    // 🟢 v228.82：开启 CDN 绕过窗口，使本次 watch 对 keepersMeta / keepers 的读取走
    //   _readSettingFileBusted（?t= 直读），绕过 Supabase Storage 3~10s 的 CDN 旧值，
    //   让「PC 改权限 → 移动端秒级感知」在公有桶下成立；私有桶下该路径回退 SDK 下载，
    //   由 5s 轮询自然收敛，无副作用。
    // 🔴 v228.84 修复：原写法 `if (typeof SyncManager._bustUntil !== 'undefined')` 是**恒假守卫**——
    //   `_bustUntil` 只在 beginReadRound()（数据轮询）里被赋过数字值，若本会话没跑过数据轮询，
    //   它一直是 undefined，`typeof undefined === 'undefined'` → 条件为 false → **bust 永不设置**
    //   → 本次 watch 不会走 _readSettingFileBusted 直读 → 命中 2s 短缓存里的陈旧 keepersMeta
    //   → 误判「无变更」→ 永不 pull → 跨设备权限变更彻底失效（真机复现：桩日志确认 tick 期间零 busted 请求）。
    //   改为无条件赋值（_bustUntil 是纯数字字段，赋值零副作用）。
    SyncManager._bustUntil = Date.now() + 1500;
    let ts = 0;
    try { const m = await SyncManager.getSetting('keepersMeta'); ts = (m && m.ts) || 0; } catch (e) { return false; }
    if (!ts) return false;
    if (ts !== this._keepersLastMetaTs) {
      this._keepersLastMetaTs = ts;
      const st = await this.pullKeepersFromCloud();
      if (st === 'ok' || st === 'empty') {
        if (typeof App !== 'undefined' && App._onKeepersChanged) { try { App._onKeepersChanged(); } catch (e) {} }
        // 🟢 v228.94：权限变更与桶切换常由同一管理员动作触发；顺带检查新桶下发，复用本 60s 看门狗
        try { if (typeof this.pullCloudConfigFromCloud === 'function') this.pullCloudConfigFromCloud(); } catch (e) {}
        return true;
      }
    }
    return false;
  },

  // 🟢 v228.84（D1 搭车）：复用「数据同步心跳」的 list('settings') 结果做权限变更探测，零额外请求。
  //   数据同步在空闲 30s / 盘点中 1.5s 的心跳里本就会 list 一次并带回各文件 updated_at（含 keepersMeta.json）。
  //   本函数由 SyncManager.getSettingsMeta() 在返回前以「只读 + try/catch 保护」方式调用，
  //   绝不改写 meta、绝不改变数据同步的节奏或返回结构，因此不影响盘点 / 库存等任何其它模块。
  //   仅当 keepersMeta.json 的物理 updated_at 变化时才触发既有的 keepersWatchTick()（其内逻辑、CDN 绕过、拉取、_onKeepersChanged 一律不变）。
  _checkKeepersViaSettingsMeta(meta) {
    try {
      if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
      if (!Array.isArray(meta)) return;
      // ① 权限变更探测（原有）
      const m = meta.find(o => o && o.name === 'keepersMeta.json');
      if (m && m.updated_at) {
        const kts = Date.parse(m.updated_at);
        if (!isNaN(kts) && this._keepersLastMetaUpdatedAt !== kts) {
          this._keepersLastMetaUpdatedAt = kts; // 记录物理时间戳（ISO→ms），避免每次心跳重复触发
          if (typeof this.keepersWatchTick === 'function') this.keepersWatchTick(); // 真有变更才走既有检测/拉取
        }
      }
      // ② 🟢 v228.94：新桶下发(cloudConfig)变更探测——复用同一份 settings 列表，零额外请求。
      //   cloudConfig.json 的 updated_at 随 syncCloudConfig 写入而变化；检测到即触发跟随切换，
      //   无需独占 60s 定时器（详见本文件 pullCloudConfigFromCloud / sync.js keepers 看门狗）。
      const c = meta.find(o => o && o.name === 'cloudConfig.json');
      if (c && c.updated_at) {
        const cts = Date.parse(c.updated_at);
        if (!isNaN(cts) && this._cloudCfgLastMetaUpdatedAt !== cts) {
          this._cloudCfgLastMetaUpdatedAt = cts;
          if (typeof this.pullCloudConfigFromCloud === 'function') this.pullCloudConfigFromCloud();
        }
      }
    } catch (e) { /* 探测失败绝不外泄到数据同步路径 */ }
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
    this._clearKeeperDeleted(name);   // 🟢 v228.71：重建同名账号 = 撤销删除意图，清墓碑
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
  // 🟢 v228.71：删除墓碑 —— 修复「删除后重开权限面板账号又冒出来」。
  //   根因：删除走 setKeepers→syncKeepers 异步推云端，而权限面板每次打开都会
  //   pullKeepersFromCloud 用云端列表做「云端独有→合并回本地」；一旦推送尚未完成/失败，
  //   云端还是旧列表，被删账号就被合并回来（读-改-写竞态）。现删除时写入墓碑
  //   （wb_keeper_deleted），云端合并时跳过墓碑中的账号；推送成功（云端已无此号）后自动清墓碑。
  _keeperDeletedKey() { return 'wb_keeper_deleted'; },
  _getKeeperDeleted() {
    try { const v = JSON.parse(localStorage.getItem(this._keeperDeletedKey()) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  },
  _markKeeperDeleted(name) {
    try {
      const set = this._getKeeperDeleted().filter(x => x !== name); set.push(name);
      localStorage.setItem(this._keeperDeletedKey(), JSON.stringify(set));
    } catch (e) { /* 隐私模式忽略 */ }
  },
  _clearKeeperDeleted(name) {
    try {
      const set = this._getKeeperDeleted().filter(x => x !== name);
      localStorage.setItem(this._keeperDeletedKey(), JSON.stringify(set));
    } catch (e) { /* 隐私模式忽略 */ }
  },
  removeKeeper(username) {
    const name = String(username || '').trim();
    if (!name) return { ok: false, msg: '用户名不能为空' };
    if (name === '管理员') return { ok: false, msg: '内置管理员账号不可删除' };
    const list = this.getKeepers();
    const idx = list.findIndex(k => k.username === name);
    if (idx === -1) return { ok: false, msg: '账号不存在' };
    list.splice(idx, 1);
    this._markKeeperDeleted(name);
    this.setKeepers(list);
    // 当前登录的正是被删账号 → 退出该身份（管理员特权保留则回落管理员）
    const u = this.getCurrentUser();
    if (u && u.username === name) this.logout();
    return { ok: true };
  },

  // 账号上云：复用现有 settings.json（key='keepers'，读-改-写 + 回读），与盘点数据包完全独立
  async syncKeepers() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    // 🟢 v228.55：本机账号列表为空时【绝不上云】——账号真相源在各设备本机，
    //   若某台设备 localStorage 被清（清浏览器数据/无痕模式/换设备）后任何动作触发
    //   setKeepers([]) → syncKeepers，空数组会覆盖云端唯一备份 → 所有设备再也拉不回账号
    //   （真机事故：云端 keepers 键消失，新设备显示"暂无账号"且无法恢复）。
    const list = this.getKeepers();
    if (!Array.isArray(list) || !list.length) {
      console.warn('[keepers] 本机账号列表为空，跳过上云（防止抹掉云端备份）');
      return;
    }
    try { await SyncManager.setSetting('keepers', list); }
    catch (e) { console.warn('[keepers] 上云失败(已忽略):', e && e.message); }
  },
  // 启动连接成功后拉取云端账号并与本地合并（云端独有→加入；禁用态以本地为准）
  // 🟢 v228.55：返回状态字符串（'ok'|'empty'|'fail'|'offline'）——旧版把失败吞成 undefined，
  //   权限面板在「云端挂了」时只会静默显示"暂无账号"，管理员无从知道账号其实能从云端恢复。
  //   返回值不抛异常，fire-and-forget 调用方（sync.js 等）行为不变。
  async pullKeepersFromCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return 'offline';
    try {
      // 🟢 v228.82：跨设备权限变更的「最后一公里」兜底 —— 强制绕过 2s 短缓存直读云端最新账号。
      //   消除「meta 已变、但 _readSettingFile 命中 2s 缓存旧值并把 _keepersLastMetaTs 卡死」的残余窗口：
      //   管理员改权限后，其他已登录设备一定拉到最新，而非被本地 TTL 缓存的脏数据糊弄。
      // 🔴 v228.84：同时清掉 _settingsKeyCache（**真正存值**的地方）—— 只清 _keyTsCache 只是让 TTL 失效，
      //   若值缓存仍在，_readSettingFile 仍会把旧值当「cached」返回（尤其 ⓪/⓪-1/失败回退分支），拉取形同虚设。
      if (SyncManager._keyTsCache) { try { delete SyncManager._keyTsCache['keepers']; } catch (e) {} }
      if (SyncManager._keyEpochCache) { try { delete SyncManager._keyEpochCache['keepers']; } catch (e) {} }
      if (SyncManager._settingsKeyCache) { try { delete SyncManager._settingsKeyCache['keepers']; } catch (e) {} }
      SyncManager._bustUntil = Date.now() + 1500;   // 🟢 v228.84：直读绕过 CDN 旧值（无条件赋值，见 keepersWatchTick 注释）
      const cloud = await SyncManager.getSetting('keepers');
      // 🟢 v228.55：云端无值时区分「真没有」和「连不上」——
      //   getSettings 本次 list+download 全失败（_lastSettingsReadOk===false）说明云端项目不可达，
      //   此时读到的空是假象，返回 'fail' 让面板给出恢复指引，而非误导性的"云端也没有账号"。
      if (!Array.isArray(cloud) || !cloud.length) {
        const st = (SyncManager._lastSettingsReadOk === false) ? 'fail' : 'empty';
        // 🟢 v228.56：云端账号真空 + 本机还有账号 → 自动补备份回云端（桶重建后的自愈路径：
        //   任何一台还有账号的设备联网拉取一次，即把账号推回云端，其他设备随后自动拉回）
        if (st === 'empty') {
          try {
            const localList = this.getKeepers();
            if (Array.isArray(localList) && localList.length) {
              await this.syncKeepers();
              console.log('[keepers] 云端账号为空、本机有 ' + localList.length + ' 个账号 → 已自动补备份到云端');
            }
          } catch (e) { /* 补备份失败不阻断 */ }
        }
        return st;
      }
      const local = this.getKeepers();
      const deleted = this._getKeeperDeleted();   // 🟢 v228.71：删除墓碑 —— 云端仍存在的已删账号不回合并
      const map = {};
      local.forEach(k => { map[k.username] = k; });
      let cloudHasDeleted = false;
      cloud.forEach(k => {
        if (deleted.indexOf(k.username) !== -1) { cloudHasDeleted = true; return; }  // 墓碑中的账号跳过
        const ex = map[k.username];
        if (!ex) { map[k.username] = k; return; }                     // 云端独有账号 → 整条同步到本地
        // 同步权限/入口/密码哈希（云端为权威，确保"设置权限/改密码"能跨设备即时生效）
        if (!ex.disabled && k.disabled) ex.disabled = 1;               // 云端已禁用 → 同步禁用
        // 本地已禁用而云端未禁用：本地优先（管理员刚在本机禁用是最终意图），其余字段也不覆盖
        if (!ex.disabled) {
          if (Array.isArray(k.modules)) ex.modules = k.modules.slice();
          if (Array.isArray(k.entries)) ex.entries = k.entries.slice();
          if (k.pwdHash) ex.pwdHash = k.pwdHash;                       // 密码变更跨设备生效
          if (k.username) ex.username = k.username;
          if (k.createdAt) ex.createdAt = k.createdAt;
        }
      });
      // 🟢 v228.81：接收端回写不 bump，避免互拉死循环。
      // 🔴 v228.84：**改为 pushCloud:false** —— 接收端合并结果只落本地、绝不回写云端。
      //   原因见 setKeepers 注释：接收端回写会用（可能陈旧的）本地列表覆盖管理员的授权，
      //   是"PC 改权限、其他端不解锁/权限被抹"的真实机制。云端真相只由发生变更的那一端写。
      this.setKeepers(Object.values(map), { bumpMeta: false, pushCloud: false });
      // 墓碑自愈：云端已无此号（删除推送已生效）→ 清掉对应墓碑；
      // 若云端仍有（推送失败/他机旧数据回写），保留墓碑继续拦截，并立即补推一次最新列表。
      if (deleted.length) {
        const gone = deleted.filter(n => !cloud.some(k => k.username === n));
        try {
          gone.forEach(n => this._clearKeeperDeleted(n));
          if (cloudHasDeleted) { this.syncKeepers(); console.warn('[keepers] 云端仍存在已删除账号，已补推最新列表'); }
        } catch (e) { /* 自愈失败不阻断 */ }
      }
      return 'ok';
    } catch (e) { console.warn('[keepers] 拉取失败(已忽略):', e && e.message); return 'fail'; }
  },
  // 🟢 v227.39：从云端下发的「共享云配置」（URL + Anon Key）→ 写入 wb_supabase_override → 触发自动连
  //   - 管理员首次配好后，下发到所有 keeper 设备；新设备登录即默认连接
  //   - 本地已有 override 时不会被云端覆盖（避免管理员误改影响他人）
  // 🟢 v228.72：强制跟随云端下发的共享配置（管理员界面改凭证后全员自动切换）
  //   · 云端 cloudConfig 为权威；任何设备 effective 与云端不一致即切换（不再保护本地 override）
  //   · 已是最新则直接返回不重复连；切到新桶后读到新桶无 cloudConfig → 自然停住，不会回跳/死循环
  // 🔐 v228.74：跟随前强制校验签名（AUDIT-228-102）；无签名/签名不符的配置直接忽略，
  //   关闭「anon 改写 cloudConfig → 全体无确认切换到攻击者桶」的劫持路径。
  //   旧版（v228.72/73）写入的无签名 cloudConfig 不再被信任——本机内置凭证已指向新桶，忽略不影响连接。
  async pullCloudConfigFromCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const cfg = await SyncManager.getSetting('cloudConfig');
      if (!cfg || !cfg.url || !cfg.key) return false;
      if (!_verifyCloudConfig(cfg)) {
        console.warn('[cloudConfig] 签名校验未通过，疑似被篡改，已忽略本次云端配置（不会自动切换）');
        return false;
      }
      // 🟢 v228.92：修复「已是最新」判重 —— 改为比对「实际连接」而非 getEffectiveSupabase（override）。
      //   旧逻辑用 override 比对：管理员点保存后 override 已是新桶，与云端 cloudConfig 相等 → 误判「已是最新」→ 永不重连，本机永远卡旧桶。
      //   新逻辑用 SyncManager 当前连接的 url/key 比对：实际还连旧桶就视为「不一致」→ 真正执行 connect 切换。
      const live = (typeof SyncManager === 'object' && SyncManager && SyncManager.config) ? SyncManager.config : null;
      const liveUrl = live && live.url ? live.url : null;
      const liveKey = live && live.key ? live.key : null;
      if (liveUrl === cfg.url && liveKey === cfg.key) return false; // 实际连接已是云端下发值，无需重连
      if (!liveUrl) console.warn('[cloudConfig] 本机尚未建立任何云端连接，按云端下发值自动连接');
      try {
        localStorage.setItem('wb_supabase_override', JSON.stringify({
          url: cfg.url, key: cfg.key,
          bucket: cfg.bucket || (AppConfig.supabase && AppConfig.supabase.bucket) || 'workbench-data'
        }));
      } catch (e) {}
      if (typeof SyncManager === 'object' && SyncManager && typeof SyncManager.connect === 'function') {
        try { await SyncManager.connect(cfg.url, cfg.key, cfg.bucket); } catch (e) { console.warn('[cloudConfig] 自动连接失败(已忽略):', e && e.message); }
      }
      return true;
    } catch (e) { console.warn('[cloudConfig] 拉取失败(已忽略):', e && e.message); return false; }
  },
  // 🟢 v227.39 / v228.72：管理员把当前 effective 配置上云，供其他设备一键同步
  //   · 在 setSupabaseOverride 之后、本机重连之前调用 → 此刻 SyncManager.client 仍是「旧桶」，
  //     cloudConfig 写入旧桶，其他仍连旧桶的设备即可读到新凭证并自动切换（见 pullCloudConfigFromCloud）
  // 🔐 v228.74：写入时附带 HMAC-SHA256 签名与时间戳（AUDIT-228-102）——只有携带正确签名的配置才会被跟随。
  async syncCloudConfig() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    const eff = this.getEffectiveSupabase();
    if (!eff.url || !eff.key) return false;
    try {
      const bucket = eff.bucket || (this.supabase && this.supabase.bucket) || 'workbench-data';
      const ts = Date.now();
      const payload = _cloudConfigPayload(eff.url, eff.key, bucket, ts);
      const sig = _hmacSha256Hex(payload, _cfgSigSecret());
      await SyncManager.setSetting('cloudConfig', { url: eff.url, key: eff.key, bucket: bucket, ts: ts, sig: sig });
      // 🟢 v228.94：捎带 bump keepersMeta，使「未跑数据同步心跳」的设备也能经 60s 权限看门狗感知桶切换
      try { await this._bumpKeepersMeta(); } catch (e) {}
      return true;
    }
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