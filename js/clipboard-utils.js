// ============================================
// 剪贴板工具（全局单例）— 库存预警批量复制等模块共用
// 优先 navigator.clipboard；非安全上下文/旧 WebView 回退 textarea + execCommand
// ============================================
const ClipboardUtils = {
  /**
   * 复制文本到剪贴板
   * @param {string} text
   * @returns {Promise<boolean>} 是否成功
   */
  async copy(text) {
    if (text == null || text === '') return false;
    const str = String(text);

    // 1) 现代异步剪贴板（需 HTTPS / localhost 且用户手势）
    try {
      if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(str);
        return true;
      }
    } catch (e) { /* 落到回退路径 */ }

    // 2) 回退：临时 textarea + execCommand('copy')（兼容 PWA 非安全上下文 / 旧 WebView）
    let ta = null;   // 🟢 v229.98（AUDIT-229-98-07①）：提到 try 外，finally 才能清理它
    try {
      ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      return ok;
    } catch (e) {
      return false;
    } finally {
      // 🟢 v229.98（AUDIT-229-98-07①）：execCommand 抛异常时 try 内的 removeChild 不会执行，
      //   临时 textarea 永久残留在 body 里（不可见但会参与 DOM/选区）。移入 finally 保证一定清理。
      try { if (ta.parentNode) ta.parentNode.removeChild(ta); } catch (_) { /* 已移除则忽略 */ }
    }
  },

  /**
   * 把二维数组（首行为表头）转 TSV 文本
   * 制表符/换行/引号自动加引号转义，避免粘贴错位
   */
  toTSV(matrix) {
    if (!Array.isArray(matrix) || !matrix.length) return '';
    return matrix.map(row => (Array.isArray(row) ? row : [row]).map(c => {
      let s = (c == null ? '' : String(c));
      if (s.includes('\t') || s.includes('\n') || s.includes('"')) {
        s = '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join('\t')).join('\r\n');
  }
};
// 显式挂到 window，便于跨模块/自动化直接引用
window.ClipboardUtils = ClipboardUtils;
