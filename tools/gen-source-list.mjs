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
const SCAN_DIRS = ['js', 'lib', 'css', 'icons', 'docs', 'assets/login-bg', 'releases'];
// 根目录散文件
const ROOT_FILES = ['index.html', 'manifest.json', 'service-worker.js', 'SOURCE_FILES.json'];
// 工具脚本（tools 在 SKIP_DIRS 内，需显式列入，确保「源码下载」包含凭证编码工具）
const TOOL_FILES = ['tools/credential-tool.mjs', 'tools/gen-source-list.mjs'];
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
DOT_FILES.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });
REQUIRED_DOCS.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });
TOOL_FILES.forEach(f => { if (existsSync(join(ROOT, f))) list.add(f); });

const files = [...list].sort();
writeFileSync(join(ROOT, 'SOURCE_FILES.json'), JSON.stringify(files, null, 2) + '\n');
console.log(`✅ SOURCE_FILES.json 已生成：${files.length} 个文件`);
for (const f of files) console.log('  ' + f);
