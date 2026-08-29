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
    // （h3 标题脱离文档流浮在白框上方，让 align-items:stretch 自然等高）
    version: 'v201',
    beaconAppkey: '0WEB06U85YBSLJNL',          // 腾讯 beacon 分析 SDK appkey（原硬编码于 index.html，外提至此）
    dataPath: '',                           // 无内置数据文件；需经「导入 Excel」上传或 Supabase 云端同步
    kpiAllLimit: 1000000,        // 🟢 O7：出库 KPI 统计时一次性取出的全量上限（M6 修复用）
    pages: {
      outboundListPageSize: 20   // 出库列表每页固定条数
    }
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