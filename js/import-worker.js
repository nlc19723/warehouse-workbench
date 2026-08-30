// ============================================
// 🟢 AUDIT-308：XLSX 解析 Web Worker
//   把最重的 XLSX.read（大文件 10~60s）搬到 Worker，避免阻塞主线程导致界面"无响应"。
//   职责仅限「文件 -> workbook」解析；下游的中和公式注入 / 表头探测 / 写库 仍在主线程执行，
//   保证导入结果与原版完全一致。
// ⚠️ 本文件只应通过 new Worker() 加载，切勿作为普通 <script> 引入
//   （否则 self===window，会覆盖页面 window.onmessage 并在主线程调用 importScripts 抛错）。
// ============================================
self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== 'parse') return;
  try {
    if (typeof XLSX === 'undefined') {
      if (!msg.xlsxUrl) throw new Error('缺少 XLSX 组件地址');
      importScripts(msg.xlsxUrl);
    }
    // 与旧版主线程解析保持完全一致的参数
    var wb = XLSX.read(msg.arrayBuffer, { type: 'array', cellDates: true });
    self.postMessage({ type: 'result', workbook: wb });
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: (err && err.message) ? err.message : String(err)
    });
  }
};
