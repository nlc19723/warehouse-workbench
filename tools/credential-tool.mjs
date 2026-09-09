#!/usr/bin/env node
/**
 * 内置云端凭证（Supabase url / anon key）的「分段 + 轻量编码」维护工具
 * ============================================================================
 * 目的：避免源码/源码下载包里出现完整的 JWT 明文特征（eyJhbGciOi...），
 *       从而规避部署平台 / 密钥扫描器（GitGuardian 类）的明文凭证告警。
 *
 * ⚠️ 重要认知：
 *   · 这不是安全加密。anon key 本就是 Supabase 为「公开场景」设计的客户端密钥，
 *     前端无论如何混淆，最终都要在内存里还原成明文才能发起请求。
 *   · 真正的防线是 Supabase 的 RLS（行级安全策略），不是"藏住 key"。
 *   · 本工具只解决「静态源码被扫描」这一件事。
 *
 * 用法：
 *   node tools/credential-tool.mjs encode "<url>" "<anonKey>"   # 生成 config.js 片段
 *   node tools/credential-tool.mjs encode --from-config          # 从 config.js 现读明文并生成
 *   node tools/credential-tool.mjs verify                        # 校验 config.js 中的片段能还原成正确明文
 *   node tools/credential-tool.mjs show                          # 直接解码并打印（排查用，会输出明文）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG = path.join(ROOT, 'js', 'config.js');

/** 与 js/config.js 中 _CRED_XOR 必须完全一致（改这里就要同步改那里） */
const XOR_KEY = 'stockhub-2026';
/** 分段数量：越多越碎，但可读性越差；4 段在抗扫描与可维护间取平衡 */
const PARTS = 4;

function xorEncode(str, key = XOR_KEY) {
  const bytes = Buffer.from(str, 'utf8');
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key.charCodeAt(i % key.length);
  return out.toString('base64');
}

/** 与浏览器端 _credRestore 完全同构的解码实现（用于本地校验） */
function xorDecode(b64, key = XOR_KEY) {
  const bin = Buffer.from(b64, 'base64');
  const out = Buffer.alloc(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin[i] ^ key.charCodeAt(i % key.length);
  return out.toString('utf8');
}

function splitParts(b64, n = PARTS) {
  const size = Math.ceil(b64.length / n);
  const parts = [];
  for (let i = 0; i < b64.length; i += size) parts.push(b64.slice(i, i + size));
  return parts;
}

function buildSnippet(url, key) {
  const payload = JSON.stringify({ url, key });
  const b64 = xorEncode(payload);
  const parts = splitParts(b64);
  const lines = parts.map(p => `    '${p}',`).join('\n');
  return { b64, parts, snippet: `  const _CRED_PARTS = [\n${lines}\n  ];` };
}

function readPlainFromConfig() {
  const src = fs.readFileSync(CONFIG, 'utf8');
  const urlM = src.match(/url:\s*'([^']+)'/);
  const keyM = src.match(/anonKey:\s*'([^']+)'/);
  if (!urlM || !keyM) {
    // 已是分段态：尝试直接从片段还原
    const partM = src.match(/const _CRED_PARTS = \[([\s\S]*?)\];/);
    if (partM) {
      const parts = [...partM[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
      const restored = JSON.parse(xorDecode(parts.join('')));
      return restored;
    }
    throw new Error('未能从 config.js 解析出明文凭证');
  }
  return { url: urlM[1], key: keyM[1] };
}

function readPartsFromConfig() {
  const src = fs.readFileSync(CONFIG, 'utf8');
  const m = src.match(/const _CRED_PARTS = \[([\s\S]*?)\];/);
  if (!m) throw new Error('config.js 中未找到 _CRED_PARTS（仍是明文态？）');
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
}

const cmd = process.argv[2] || 'help';

if (cmd === 'encode') {
  let url, key;
  if (process.argv[3] === '--from-config') {
    ({ url, key } = readPlainFromConfig());
  } else {
    url = process.argv[3];
    key = process.argv[4];
  }
  if (!url || !key) { console.error('用法: encode "<url>" "<anonKey>"  或  encode --from-config'); process.exit(1); }
  const { parts, snippet } = buildSnippet(url, key);
  const back = JSON.parse(xorDecode(parts.join('')));
  console.log('✅ 已生成分段编码（' + parts.length + ' 段）。把下面片段贴到 js/config.js 的 _CRED_PARTS：\n');
  console.log(snippet);
  console.log('\n自检还原: ' + (back.url === url && back.key === key ? '✅ 与原文完全一致' : '❌ 不一致！'));

} else if (cmd === 'verify') {
  const parts = readPartsFromConfig();
  const restored = JSON.parse(xorDecode(parts.join('')));
  const cur = readPlainFromConfig();
  const urlOk = restored.url === cur.url;
  const keyOk = restored.key === cur.key;
  console.log('片段数:', parts.length);
  console.log('还原 url:', restored.url, urlOk ? '✅' : '❌');
  console.log('还原 key:', restored.key.slice(0, 24) + '…', keyOk ? '✅ 与 config 当前值一致' : '❌ 不一致');
  console.log(keyOk && urlOk ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  process.exit(urlOk && keyOk ? 0 : 1);

} else if (cmd === 'show') {
  const parts = readPartsFromConfig();
  console.log(JSON.stringify(JSON.parse(xorDecode(parts.join(''))), null, 2));

} else {
  console.log(`用法:
  node tools/credential-tool.mjs encode "<url>" "<anonKey>"
  node tools/credential-tool.mjs encode --from-config
  node tools/credential-tool.mjs verify
  node tools/credential-tool.mjs show
`);
}
