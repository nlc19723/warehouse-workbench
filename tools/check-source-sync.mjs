#!/usr/bin/env node
// ============================================
// 源码下载同步检查器 🟢 v229.78
// 用法：node tools/check-source-sync.mjs
// 检查四项：
//   ① SOURCE_FILES.json 是否为最新（重新生成后对比，发现漂移）
//   ② 清单内文件是否都真实存在（避免打包 404）
//   ③ index.html / 各页面引用的 js 是否都已收录（避免「下载的包跑不起来」）
//   ④ index.html 内置兜底清单 FILES_TO_PACKAGE 与权威清单的差异
// ============================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const LIST_PATH = join(ROOT, 'SOURCE_FILES.json');
const problems = [];
const info = [];

// ① 时效性：备份 → 重新生成 → 对比
const before = readFileSync(LIST_PATH, 'utf8');
execSync('node tools/gen-source-list.mjs', { cwd: ROOT, stdio: 'pipe' });
const after = readFileSync(LIST_PATH, 'utf8');
const drift = before.trim() !== after.trim();
if (drift) {
  const a = new Set(JSON.parse(before)), b = new Set(JSON.parse(after));
  const added = [...b].filter(x => !a.has(x)), removed = [...a].filter(x => !b.has(x));
  problems.push(`清单存在漂移（已自动重新生成）：新增 [${added.join(', ')}]｜移除 [${removed.join(', ')}]`);
  info.push('✅ 已自动重跑 gen-source-list.mjs 并同步');
} else {
  info.push('✅ SOURCE_FILES.json 已是最新（无漂移）');
}
writeFileSync(LIST_PATH, after);

const list = new Set(JSON.parse(after));
info.push(`清单文件数：${list.size}`);

// ② 清单内文件是否真实存在
const missing = [...list].filter(f => !existsSync(join(ROOT, f)));
if (missing.length) problems.push(`清单内 ${missing.length} 个文件实际不存在（打包会 404）：${missing.slice(0, 10).join('、')}`);
else info.push('✅ 清单内文件全部真实存在');

// ③ index.html 引用的脚本是否都已收录
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const refs = new Set();
for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="((?!http|https|\/\/)[^"]+)"/g)) {
  const p = m[1].split('?')[0];
  if (p && !p.startsWith('data:')) refs.add(p);
}
const notInList = [...refs].filter(p => !list.has(p) && !p.startsWith('releases/'));
if (notInList.length) problems.push(`index.html 引用了 ${notInList.length} 个未收录资源：${notInList.slice(0, 12).join('、')}`);
else info.push(`✅ index.html 引用的 ${refs.size} 个资源全部已收录`);

// ④ 内置兜底清单 FILES_TO_PACKAGE 与权威清单差异
const mFall = html.match(/var FILES_TO_PACKAGE = \[([\s\S]*?)\];/);
if (!mFall) {
  problems.push('未找到 index.html 内置兜底清单 FILES_TO_PACKAGE');
} else {
  const fallback = new Set(
    [...mFall[1].matchAll(/'([^']+)'/g)].map(x => x[1]).filter(x => !x.startsWith('//'))
  );
  const lack = [...refs].filter(p => /^js\//.test(p) && !fallback.has(p));
  if (lack.length) problems.push(`内置兜底清单缺少 ${lack.length} 个已引用脚本：${lack.join('、')}`);
  else info.push(`✅ 内置兜底清单已覆盖全部 js 引用（${fallback.size} 项）`);
  const ghost = [...fallback].filter(f => !existsSync(join(ROOT, f)));
  if (ghost.length) problems.push(`内置兜底清单含 ${ghost.length} 个不存在文件：${ghost.join('、')}`);
  else info.push('✅ 内置兜底清单无失效路径');
}

console.log('════════ 源码下载同步检查 ════════');
info.forEach(s => console.log('  ' + s));
if (problems.length) {
  console.log('\n⚠️ 发现问题：');
  problems.forEach(s => console.log('  ✗ ' + s));
  process.exit(1);
}
console.log('\n✅ 全部同步，无需处理');
