/**
 * sync-boot-worker-inline.mjs —— 把 js/boot-canvas-worker.js 全文注入 index.html 的
 * <script type="text/plain" id="bootWorkerSrc"> 块，保证两者字节级一致。
 *
 * 为什么必须用脚本而非手改：
 *   内联块里含 WORDMARK_D —— 设计稿矢量路径数据（单行约 37KB），
 *   人工编辑极易破坏字形且无法目视校验。任何对 worker 的改动都必须经此脚本同步。
 *
 * 用法：node tools/sync-boot-worker-inline.mjs [--check]
 *   --check 只校验不写入，退出码 0=一致 1=不一致（可挂 CI / 发版前检查）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'js/boot-canvas-worker.js');
const HTML = resolve(ROOT, 'index.html');

const OPEN = '<script type="text/plain" id="bootWorkerSrc">';
const CLOSE = '</script>';

const checkOnly = process.argv.includes('--check');

const workerSrc = readFileSync(SRC, 'utf8');
const html = readFileSync(HTML, 'utf8');

const openIdx = html.indexOf(OPEN);
if (openIdx < 0) {
  console.error('✗ index.html 未找到内联块起始标记：' + OPEN);
  process.exit(2);
}
const bodyStart = openIdx + OPEN.length;
const closeIdx = html.indexOf('\n' + CLOSE, bodyStart);
if (closeIdx < 0) {
  console.error('✗ index.html 未找到内联块结束标记');
  process.exit(2);
}
const oldBody = html.slice(bodyStart, closeIdx);

// 归一化：磁盘文件末尾换行不应进入内联块（内联块是 text/plain，尾部多一个换行无害，
// 但保持严格一致以便 --check 长期可用）
const newBody = workerSrc.replace(/\n$/, '');

if (oldBody === newBody) {
  console.log('✓ 内联块与 js/boot-canvas-worker.js 已字节级一致（' + newBody.length + ' 字节）');
  process.exit(0);
}

if (checkOnly) {
  console.error('✗ 内联块与磁盘文件不一致：');
  console.error('    index.html 内联 ' + oldBody.length + ' 字节');
  console.error('    磁盘文件     ' + newBody.length + ' 字节');
  console.error('  请运行：node tools/sync-boot-worker-inline.mjs');
  process.exit(1);
}

const next = html.slice(0, bodyStart) + newBody + html.slice(closeIdx);
writeFileSync(HTML, next, 'utf8');
console.log('✓ 已同步内联块：' + oldBody.length + ' → ' + newBody.length + ' 字节');