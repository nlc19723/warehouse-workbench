#!/usr/bin/env node
// ============================================
// 关键 CSS（Critical CSS）生成器 🟢 v228.09 性能优化 P0-2
// 用法：node tools/gen-critical-css.mjs
// 产出：把「首屏必需样式」内联进 index.html 的 CRITICAL_CSS 标记块，
//       使 css/style.css 可以改为非阻塞加载（211KB 不再 render-blocking）。
// 规则：只内联「loading 遮罩出现前」必需的样式——
//       :root 变量 / 暗色变量 / reset / html,body / body / loading 遮罩全套。
//       其余（滚动条、侧栏、表格…）随全量 CSS 异步加载，遮罩期间已加载完成。
// ⚠️ 每次修改 css/style.css 的变量或 loading 样式后，必须重跑本脚本，
//    否则内联副本会过期（与 SOURCE_FILES.json 同类纪律）。
// ============================================
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const CSS_PATH = ROOT + 'css/style.css';
const HTML_PATH = ROOT + 'index.html';
const START = '<!-- CRITICAL_CSS_START -->';
const END = '<!-- CRITICAL_CSS_END -->';

const lines = readFileSync(CSS_PATH, 'utf8').split('\n');

// 从 startRe 命中的行开始，按大括号配平提取整块
function extractBlock(startRe, label) {
  const s = lines.findIndex(l => startRe.test(l));
  if (s < 0) throw new Error(`未找到块: ${label}`);
  let depth = 0;
  const out = [];
  for (let j = s; j < lines.length; j++) {
    const line = lines[j];
    out.push(line);
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0) break;
  }
  return out.join('\n');
}

// 从 startRe 提取到 endRe 所在块结束（用于 loading 遮罩这一整段连续规则）
function extractRange(startRe, endRe, label) {
  const s = lines.findIndex(l => startRe.test(l));
  if (s < 0) throw new Error(`未找到区间起点: ${label}`);
  let depth = 0, done = false, seenEnd = false;
  const out = [];
  for (let j = s; j < lines.length && !done; j++) {
    const line = lines[j];
    out.push(line);
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (endRe.test(line)) seenEnd = true;
    // 终点规则可能跨多行（如 .loading-fluid-base{...} 占两行），故「见过终点后等括号配平」才结束
    if (seenEnd && depth === 0) done = true;
  }
  if (!done) throw new Error(`未找到区间终点: ${label}`);
  return out.join('\n');
}

const parts = [
  extractBlock(/^:root\{/, ':root 变量'),
  extractBlock(/^\[data-theme="dark"\]\{/, '暗色模式变量'),
  extractBlock(/^\*\{\s*margin:\s*0;\s*padding:\s*0;\s*box-sizing:\s*border-box;\s*\}/, '全局 reset'),
  extractBlock(/^html, body\{/, 'html, body'),
  extractBlock(/^body\{/, 'body'),
  extractRange(/^\.loading-overlay\{/, /^\.loading-fluid-base\{/, 'loading 遮罩')
];

const critical = parts.join('\n\n');
const block = `${START}\n<style>\n/* 关键 CSS：首屏内联，由 tools/gen-critical-css.mjs 从 css/style.css 自动生成，请勿手改 */\n${critical}\n</style>\n${END}`;

let html = readFileSync(HTML_PATH, 'utf8');
if (html.includes(START) && html.includes(END)) {
  html = html.replace(new RegExp(START + '[\\s\\S]*?' + END), block);
} else {
  const m = html.match(/[ \t]*<link rel="stylesheet" href="css\/style\.css[^>]*>/);
  if (!m) throw new Error('未找到 css/style.css 的 link 标签');
  const idx = m.index;
  html = html.slice(0, idx) + block + '\n  ' + html.slice(idx);
}
writeFileSync(HTML_PATH, html);
console.log(`✅ 关键 CSS 已注入 index.html：${(critical.length / 1024).toFixed(1)} KB（全量 style.css ${(readFileSync(CSS_PATH).length / 1024).toFixed(1)} KB）`);
