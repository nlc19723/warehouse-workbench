// ============================================
// 🟢 AUDIT-308：XLSX 解析 Web Worker
//   把最重的 XLSX.read（大文件 10~60s）搬到 Worker，避免阻塞主线程导致界面"无响应"。
//   职责仅限「文件 -> workbook」解析；下游的中和公式注入 / 表头探测 / 写库 仍在主线程执行，
//   保证导入结果与原版完全一致。
// ⚠️ 本文件只应通过 new Worker() 加载，切勿作为普通 <script> 引入
//   （否则 self===window，会覆盖页面 window.onmessage 并在主线程调用 importScripts 抛错）。
// ============================================

// 🟢 v229.46 AUDIT-F4：原型污染清洗 + 体积护栏（与主线程解析保持一致）
var MAX_XLSX_BYTES = 50 * 1024 * 1024;
function sanitizeWorkbook(wb) {
  if (!wb || typeof wb !== 'object') return wb;
  var stack = [wb], seen = 0;
  while (stack.length) {
    var o = stack.pop();
    if (!o || typeof o !== 'object' || seen++ > 300000) continue;
    try {
      ['__proto__', 'constructor', 'prototype'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(o, k)) delete o[k];
      });
    } catch (e) { /* 某些宿主对象不可删，忽略 */ }
    for (var p in o) {
      if (Object.prototype.hasOwnProperty.call(o, p)) {
        var v = o[p];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return wb;
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== 'parse') return;
  try {
    // 🟢 v229.46 AUDIT-F4：体积护栏（ReDoS / DoS 缓解）
    if (msg.arrayBuffer && msg.arrayBuffer.byteLength > MAX_XLSX_BYTES) {
      throw new Error('文件过大（>50MB），已拒绝解析以防拒绝服务');
    }
    if (typeof XLSX === 'undefined') {
      if (!msg.xlsxUrl) throw new Error('缺少 XLSX 组件地址');
      importScripts(msg.xlsxUrl);
    }
    // 与旧版主线程解析保持完全一致的参数
    var wb = sanitizeWorkbook(XLSX.read(msg.arrayBuffer, { type: 'array', cellDates: true }));
    self.postMessage({ type: 'result', workbook: wb });
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: (err && err.message) ? err.message : String(err)
    });
  }
};
