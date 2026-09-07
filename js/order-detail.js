// ============================================
// 订单档案（detail）模块 —— 重建实现
// 数据来源：DataStore.getOrders({keyword: 订单编号}) 精确匹配 + 关联入库行（按订单编号/来源订单号）
// 复用：DetailCommon.section / backBar / fmt，TableUtils.link（实体互链）
// ============================================================

// 🟢 v195：单元格日期兜底——把"Excel 数字序列号"和 Date 对象都规范成 YYYY-MM-DD。
//   已入库的旧数据「实际到货日期」可能是 46151 这类序列号；这里渲染时统一转换。
function renderDateCell(v) {
  if (v == null || v === '') return '-';
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`;
  }
  if (typeof v === 'number' && v >= 20000 && v <= 80000 && Number.isFinite(v)) {
    const d = new Date(Math.round((v - EXCEL_EPOCH_DAYS) * DAY_MS));
    if (!isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
  }
  return String(v);
}

window.OrderDetailModule = {
  _rt: undefined,
  async render(token) {
    if (token !== undefined) this._rt = token;
    const content = document.getElementById('contentArea');
    if (!content) return;

    const pe = App.pendingEntity;
    const no = pe && pe.type === 'order' ? pe.key : '';
    if (!no) {
      content.innerHTML = `<div class="empty-state" style="padding:56px 20px;text-align:center;">
        <div class="empty-icon">📋</div>
        <div style="font-size:15px;margin-top:10px;color:var(--text-secondary);">未指定订单编号</div>
        <button class="btn--ghost" onclick="App.back()">← 返回</button></div>`;
      return;
    }

      showLoading('正在加载订单档案...');
    try {
      const res = await DataStore.getOrders({ keyword: no }, 1, 'all');
      if (token !== undefined && token !== App._goToken) return;
      const rows = res.items || [];
      // keyword 为包含匹配，这里精确保留完全相等的订单编号
      const matched = rows.filter(o => String(o.订单编号) === String(no));
      const main = matched[0] || rows[0] || {};

      // 🟢 v118：先算"关联完整订单"明细行（用于基础信息汇总）
      const orderRowsAll = await DataStore.getRows('orders');
      if (token !== undefined && token !== App._goToken) return;
      const fullOrderRows = orderRowsAll.filter(o => String(o.订单编号) === String(no));
      // 数量/未入库量/累计入库数量/原币价税合计 → 按多行明细 SUM
      const sumQty       = fullOrderRows.reduce((s, r) => s + (Number(r.数量)        || 0), 0);
      const sumUninbound = fullOrderRows.reduce((s, r) => s + (Number(r.未入库量)    || 0), 0);
      const sumInbounded = fullOrderRows.reduce((s, r) => s + (Number(r.累计入库数量)|| 0), 0);
      const sumTotal     = fullOrderRows.reduce((s, r) => s + (Number(r.原币价税合计) || 0), 0);

      const base = [
        { label: '订单编号', field: '订单编号' },
        { label: '日期', field: '日期' },
        { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
        { label: '项目名称', field: '项目名称' },
        // 🟢 v118：删除「存货名称」「规格型号」（订单档案是单订单汇总，存货物料在下方"关联完整订单"明细表中查看）
        // 🟢 v118：数量/未入库量/累计入库数量/原币价税合计 → 改为"关联完整订单"多行明细 SUM
        { label: '数量', render: () => sumQty.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
        { label: '未入库量', render: () => sumUninbound.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
        { label: '累计入库数量', render: () => sumInbounded.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
        { label: '原币价税合计', render: () => sumTotal.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) },
        { label: '原币含税单价', field: '原币含税单价' },
        { label: '审批状态', field: '审批状态' },
        { label: '来源订单号', field: '来源订单号' }
      ];
      const baseSection = `<div class="detail-section"><h3>订单信息</h3>
        <div class="detail-grid">${base.map(c => `<div class="detail-kv"><span class="k">${c.label}</span><span class="v">${c.render ? c.render(main) : esc(DetailCommon.fmt(main[c.field]))}</span></div>`).join('')}</div></div>`;

      // 🟢 v120：关联完整订单 — 展示当前订单的所有明细行（同一订单编号下多行合并）
      // 🟢 v118：订单表「存货」键为 存货编号（不是 存货编码）
      // 🟢 v120：列名与主模块（订单列表）统一：数量→订单量、未入库量→未入库订单量、含税单价+含税金额、状态
      const fullOrderCols = [
        { label: '行号', render: (_r, _i, idx) => idx + 1 },
        { label: '存货编码', render: r => TableUtils.link('stock', r.存货编号 || '', r.存货编号 || '') },
        { label: '存货名称', render: r => `<strong>${esc(r.存货名称 || '')}</strong>` },
        { label: '规格型号', field: '规格型号' },
        { label: '订单量', field: '数量' },
        { label: '未入库订单量', field: '未入库量' },
        { label: '累计入库数量', field: '累计入库数量' },
        { label: '含税单价', field: '原币含税单价' },
        { label: '含税金额', field: '原币价税合计' },
        { label: '供应商', field: '供应商', render: r => TableUtils.link('supplier', r.供应商, r.供应商) },
        { label: '状态', field: '审批状态' }
      ];
      const fullOrderSection = fullOrderRows.length
        ? `<div class="detail-section"><h3>关联完整订单 <span class="count">(${fullOrderRows.length})</span></h3>
            <div class="table-wrapper"><table class="data-table"><thead><tr>${fullOrderCols.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${fullOrderRows.map((r, idx) => `<tr>${fullOrderCols.map(c => `<td>${c.render ? c.render(r, idx, idx) : esc(DetailCommon.fmt(r[c.field]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`
        : `<div class="detail-section"><h3>关联完整订单 <span class="count">(0)</span></h3><div class="empty-state" style="padding:14px;"><div class="empty-icon">📭</div><div class="empty-text">该订单暂无可展示明细</div></div></div>`;

      // 关联入库：按 表体订单号（=订单编号）或 来源订单号 关联
      const inboundAll = await DataStore.getRows('inbound');
      if (token !== undefined && token !== App._goToken) return;
      const inboundRows = inboundAll.filter(i =>
        (i.表体订单号 != null && String(i.表体订单号) === String(no)) ||
        (i.来源订单号 != null && String(i.来源订单号) === String(no)));
      // 🟢 v117：明细表新增"存货编码"列，存货名称/规格型号绑定存货编码
      // 🟢 v120：列名与主模块（入库列表）统一：日期→入库日期、数量→入库量、新增含税单价、原币价税合计→含税金额
      const inboundCols = [
        { label: '入库单号', field: '入库单号' },
        { label: '入库日期', field: '入库日期' },
        { label: '存货编码', render: r => TableUtils.link('stock', r.存货编码 || '', r.存货编码 || '') },
        { label: '存货名称', render: r => `<strong>${esc(r.存货名称 || '')}</strong>` },
        { label: '规格型号', field: '规格型号' },
        { label: '入库量', field: '数量' },
        { label: '含税单价', field: '原币含税单价' },
        { label: '含税金额', field: '原币价税合计' },
        { label: '实际到货日期', field: '实际到货日期', render: r => esc(renderDateCell(r['实际到货日期'])) }
      ];

      content.innerHTML = DetailCommon.backBar() +
        `<h2 style="margin:6px 0 18px;font-size:20px;">📋 订单档案 · ${esc(no)}</h2>` +
        baseSection +
        fullOrderSection +
        DetailCommon.section('入库明细', inboundRows, inboundCols, 50);

      // 若该订单存在"是否需补货"关联存货，给出跳转入口（打通模块）
      if (main.存货名称) {
        const codeMap = (typeof DataLoader !== 'undefined' && DataLoader.getStockNameSpecCodeMap) ? await DataLoader.getStockNameSpecCodeMap().catch(() => null) : null;
        const stockKey = (codeMap && main.存货名称) ? codeMap.get((main.存货名称 + '|' + (main.规格型号 || '')).replace(/\s+/g, '')) : null;
        if (token !== undefined && token !== App._goToken) return;
        if (stockKey) {
          const bar = document.createElement('div');
          bar.style.cssText = 'margin-top:14px;';
          bar.innerHTML = `<button class="btn--ghost" onclick="App.openEntity('stock','${escAttr(String(stockKey))}')">📦 查看关联存货档案（${esc(main.存货名称)}）</button>`;
          content.appendChild(bar);
        }
      }
    } catch (e) {
      console.error('[OrderDetailModule]', e);
      content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败: ${esc(e.message || e)}</div></div>`;
    } finally {
      hideLoading();
    }
  }
};
