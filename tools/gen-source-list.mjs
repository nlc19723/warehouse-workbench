#!/usr/bin/env node
// ============================================
// 权威源码清单生成器 🟢 v227.98
// 用法：node tools/gen-source-list.mjs
// 产出：SOURCE_FILES.json（与「源码下载」交付包完全一致的文件清单）
// 规则：全部代码 + 两份文档 + 全部图标/登录背景 + 部署元文件，其余剔除。
//   index.html 的 buildPackageList() 优先读本清单；每次发版/改文件后重新运行本脚本。
// ============================================
import { readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

// 扫描目录（与 index.html SCAN_ROOTS 对齐，另含 assets/login-bg 功能性资源）
// 🟢 v228.19：移除 'releases' —— releases/ 是「发布产物目录」（短期/第三方发布器产物、
//   审查报告、双视口验证截图等），除运行时必需的 app-manifest.json 外一律不进源码下载包。
//   此前 SCAN_DIRS 含 releases 而 index.html 的回退扫描把它列进 SKIP_DIRS，
//   两边不一致：权威清单反而比回退清单多打包了一堆审查产物。现已对齐。
const SCAN_DIRS = ['js', 'lib', 'css', 'icons', 'docs', 'assets/login-bg'];
// 根目录散文件
const ROOT_FILES = ['index.html', 'manifest.json', 'service-worker.js', 'SOURCE_FILES.json'];
// releases/ 中唯一必需项：版本清单（运行时 SyncManager / 新版本检测会读取）
// 🟢 v228.19：审查报告（全局代码审查报告_v*.md）与验证截图（audit-v*.png、audit-*.png）
//   属流程产物，与 index.html ROOT_FILES 的处理保持一致 —— 不打包。
const RELEASE_FILES = ['releases/app-manifest.json'];
// 🟢 v228.22：流程产物黑名单 —— 走查 / 审查 / 验证类产物一律不进源码下载包。
//   与上方 SCAN_DIRS 的目录扫描配合：扫描结果先并入 list，再由本表从 list 中剔除。
//   （docs/ 目录本身要保留 —— 里面还有运行时参考文档「全局代码审查标准.md」「storage-policies.md」，
//     故这里按文件名特征精确剔除报告，而不是把整个 docs/ 排除。）
const EXCLUDE_FILE_RE = [
  /^docs\/体验走查报告.*\.md$/,          // 体验走查报告
  /^docs\/(全局)?(代码)?审查报告.*\.md$/, // 代码审查报告
];
const EXCLUDE_DIRS = ['tools/ux-review'];  // 走查截图与采集数据目录（整棵子树）
// 工具脚本（tools 在 SKIP_DIRS 内，需显式列入，确保「源码下载」包含凭证编码工具）
const TOOL_FILES = ['tools/credential-tool.mjs', 'tools/gen-source-list.mjs', 'tools/gen-critical-css.mjs'];
// 点文件（CDN 可能 403，index.html 有内嵌兜底，仍列入清单保证常规托管可下载）
const DOT_FILES = ['.gitignore', '.gitlab-ci.yml', '.nojekyll', '.github/workflows/deploy.yml'];
// 根目录必备文档（不被"根级 .md 垃圾过滤"误剔）
const REQUIRED_DOCS = ['docs/全局代码审查标准.md', '修复与发布纪律_v227.92.md', 'SECURITY.md'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'tools', 'scripts']);

function walk(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs).sort()) {
    if (name.startsWith('.')) continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...walk(rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

const list = new Set();
for (const d of SCAN_DIRS) walk(d).forEach(f => list.add(f));
ROOT_FILES.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });
RELEASE_FILES.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });
DOT_FILES.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });
REQUIRED_DOCS.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });
TOOL_FILES.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });

const files = [...list]
  .filter(f => !EXCLUDE_FILE_RE.some(re => re.test(f)))
  .filter(f => !EXCLUDE_DIRS.some(d => f === d || f.startsWith(d + '/')))
  .sort();
writeFileSync(join(ROOT, 'SOURCE_FILES.json'), JSON.stringify(files, null, 2) + '\n');
console.log(`✅ SOURCE_FILES.json 已生成：${files.length} 个文件`);
for (const f of files) console.log('  ' + f);
