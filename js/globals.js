// ============================================
// 🟢 AUDIT-606：统一全局对象暴露
//   原代码「双重暴露不一致」：TablePrefs/TableUtils/DetailCommon/DataLoader 等挂了 window，
//   而 App/db/DataStore/SyncManager/15 个 *Module 只挂 const（仅赖经典脚本作用域共享），
//   → 一旦加 type="module" 即全线失效（架构级技术债）。
//   此处把所有顶层单例显式挂到 window，暴露口径统一：
//     · 不影响当前任何功能与显示（仅追加 window 引用，原脚本作用域绑定不变）；
//     · 为后续可选的模块化迁移提供明确、一致、可预期的出口。
// ⚠️ 本文件必须放在所有模块脚本之后加载（index.html 中位于 app.js 之后），
//    依赖上层 const 已声明。已被 window 暴露过的对象重复赋值无害。
// ============================================
window.App = App;
window.db = db;
window.DataStore = DataStore;
window.SyncManager = SyncManager;

window.BreachModule = BreachModule;
window.DashboardModule = DashboardModule;
window.InboundModule = InboundModule;
window.InventoryAlertModule = InventoryAlertModule;
window.LowTurnoverModule = LowTurnoverModule;
window.OrderCheckModule = OrderCheckModule;
window.OrdersModule = OrdersModule;
window.OrderTrackModule = OrderTrackModule;
window.OutboundModule = OutboundModule;
window.OutboundListModule = OutboundListModule;
window.PricingModule = PricingModule;
window.QueryModule = QueryModule;
window.ReconciliationModule = ReconciliationModule;
window.StockModule = StockModule;
window.SupplierModule = SupplierModule;
window.Toast = Toast;

// 已挂 window 的对象（重复赋值无害，集中在此作为公共 API 清单）
window.DataLoader = DataLoader;
window.TableUtils = TableUtils;
window.TablePrefs = TablePrefs;
window.TableStickyOverlay = TableStickyOverlay;
window.DetailCommon = DetailCommon;
window.ColorTheme = ColorTheme;
window.AppConfig = AppConfig;
window.WBModal = WBModal;
window.QR = QR;
window.QRScan = QRScan;
window.EntityLinks = EntityLinks;
window.SearchSelect = SearchSelect;
window.OrderDetailModule = OrderDetailModule;
window.StockDetailModule = StockDetailModule;
window.SupplierDetailModule = SupplierDetailModule;
window.esc = window.esc;
window.escAttr = window.escAttr;

// 🟢 AUDIT-004：兜底捕获未处理的 Promise 异常 / 运行时错误，避免「静默失败」被吞掉。
//   背景：全仓大量写/同步/导入路径的 await 无就近 catch（审计约 513 处），异常被静默 reject 后
//   UI 可能误报「成功」或显示陈旧数据。此处统一在 console 留痕，使静默失败至少可见（便于排查），
//   不主动弹 Toast——避免对既有 fire-and-forget 调用造成干扰性 UX 抖动。具体写路径（如 db.clearAll）
//   仍额外包 try/catch 向上抛出，交由调用方决定提示与回滚。
window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev && ev.reason;
  console.error('[未捕获 Promise 异常]', reason && (reason.stack || reason.message || reason));
});
window.addEventListener('error', (ev) => {
  if (ev && ev.message) {
    console.error('[运行时错误]', ev.message, ev.filename ? '(' + ev.filename + ':' + ev.lineno + ')' : '');
  }
});
