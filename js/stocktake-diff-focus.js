/**
 * 🟢 v229.77：盘点「差异核对」聚焦视图 —— 独立模块，零侵入挂载。
 *
 * 定位：季度盘点轮次收口（含补盘冻结）/ 日常盘点落库后，对【全批次汇总的差异】做复盘聚焦。
 *       只读 + 备注编辑；不改动盘点表、不改动任务、不改动任何既有状态。
 *
 * 数据来源（单一事实源）：DataStore.getStocktakeRecords() 按 sheetId 过滤 差异量 ≠ 0。
 * 备注（唯一真相源）：记录表 r.备注 —— 与盘点表 commit、记录列表编辑同一字段，
 *       修改走 DataStore.updateStocktakeRecord + SyncManager.syncStocktake，保存即同步。
 *
 * 设计纪律：
 *   ① 所有取数/写数均 try-catch，任何异常只提示、不抛出、不影响主流程。
 *   ② overlay 关闭时移除自身 DOM 与全局监听，不残留。
 *   ③ 样式随开关注入 <style id="st-df-style">，关闭时移除 —— 不触碰 style.css。
 *
 * window.StocktakeDiffFocus
 *   .isReady(sheetId)  → Promise<boolean>  入口门禁（季度需轮次收口；日常需已落库）
 *   .open(sheetId)     → Promise<void>     打开聚焦视图
 *   .close()           → void
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const fmt = n => {
    const v = parseFloat(n);
    if (!Number.isFinite(v)) return '0';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  };

  /* ─────────────────── 样式（开关注入，关闭移除） ─────────────────── */
  const CSS = `
.st-df-mask{position:fixed;inset:0;z-index:1200;background:rgba(15,23,42,.46);backdrop-filter:blur(3px);
  display:flex;align-items:center;justify-content:center;padding:18px;animation:stdfFade .22s ease}
@keyframes stdfFade{from{opacity:0}to{opacity:1}}
.st-df-panel{width:min(1140px,100%);max-height:94vh;overflow:auto;background:var(--bg-card,#fff);
  border-radius:20px;box-shadow:0 24px 60px rgba(15,23,42,.28);display:flex;flex-direction:column;animation:stdfUp .26s cubic-bezier(.22,1,.36,1)}
@keyframes stdfUp{from{opacity:0;transform:translateY(18px) scale(.985)}to{opacity:1;transform:none}}
.st-df-head{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--border-color,#e5e7eb);position:sticky;top:0;background:var(--bg-card,#fff);z-index:2}
.st-df-title{font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px}
.st-df-sub{font-size:12px;color:var(--text-sub,#6b7280)}
.st-df-close{margin-left:auto;border:none;background:var(--bg-input,#f3f4f6);color:var(--text-main,#111827);
  width:30px;height:30px;border-radius:9px;cursor:pointer;font-size:15px;line-height:1}
.st-df-stage{display:grid;grid-template-columns:340px 1fr;gap:16px;padding:16px 20px}
@media (max-width:980px){.st-df-stage{grid-template-columns:1fr}}
.st-df-ring{background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:18px;
  padding:18px 14px 14px;display:flex;flex-direction:column;align-items:center;position:relative;overflow:hidden}
.st-df-ring::before{content:'';position:absolute;left:50%;top:46%;width:330px;height:330px;transform:translate(-50%,-50%);
  background:radial-gradient(circle,color-mix(in srgb,var(--primary,#5B9BD5) 8%,transparent),transparent 62%);pointer-events:none}
.st-df-svg{width:290px;height:290px;user-select:none}
.st-df-seg{fill:none;stroke:color-mix(in srgb,var(--text-main,#111827) 13%,transparent);stroke-width:9;stroke-linecap:butt;cursor:pointer;
  transition:stroke-width .28s cubic-bezier(.22,1,.36,1),opacity .28s ease,filter .28s ease}
.st-df-seg:hover{stroke:color-mix(in srgb,var(--text-main,#111827) 26%,transparent)}
.st-df-seg.neg{stroke:var(--diff-neg,#D2545A)} .st-df-seg.pos{stroke:var(--primary,#5B9BD5)}
.st-df-seg.zero{stroke:color-mix(in srgb,var(--text-main,#111827) 30%,transparent)}
.st-df-seg.done{stroke:color-mix(in srgb,var(--accent-mint,#6DBF9F) 45%,transparent);stroke-width:6}
.st-df-seg.cur{stroke-width:13}
.st-df-seg.cur.neg{filter:drop-shadow(0 0 6px color-mix(in srgb,var(--diff-neg,#D2545A) 45%,transparent))}
.st-df-seg.cur.pos{filter:drop-shadow(0 0 6px color-mix(in srgb,var(--primary,#5B9BD5) 45%,transparent))}
.st-df-seg.cur.done{stroke:color-mix(in srgb,var(--accent-mint,#6DBF9F) 72%,transparent);stroke-width:9}
.st-df-seg.tick{stroke-width:2.4;stroke-linecap:round} .st-df-seg.tick.done{stroke-width:1.8} .st-df-seg.tick.cur{stroke-width:3.4}
.st-df-seg.dim{opacity:.1}
.st-df-deco{fill:none;stroke:color-mix(in srgb,var(--text-main,#111827) 12%,transparent);stroke-width:1;
  stroke-dasharray:.35 2.15;stroke-linecap:round;transform-box:fill-box;transform-origin:center;animation:stdfDial 90s linear infinite}
@keyframes stdfDial{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.st-df-deco{animation:none}}
.st-df-center{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;width:200px}
.st-df-prog{font-size:11.5px;color:var(--text-sub,#6b7280);letter-spacing:1px}
.st-df-num{font-size:44px;font-weight:900;line-height:1.05;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.st-df-num.neg{color:var(--diff-neg,#D2545A)} .st-df-num.pos{color:var(--primary,#5B9BD5)} .st-df-num.zero{color:var(--accent-mint,#6DBF9F)}
.st-df-tag{font-size:11.5px;color:var(--text-sub,#6b7280);margin-top:3px}
.st-df-name{font-size:12.5px;font-weight:600;margin-top:6px;color:var(--text-main,#111827);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-df-legend{display:flex;flex-wrap:wrap;gap:8px 12px;margin-top:12px;font-size:11px;color:var(--text-sub,#6b7280)}
.st-df-legend i{display:inline-block;width:14px;height:5px;border-radius:3px;margin-right:5px;vertical-align:1px}
.st-df-legend i.neg{background:var(--diff-neg,#D2545A)} .st-df-legend i.pos{background:var(--primary,#5B9BD5)}
.st-df-legend i.done{background:color-mix(in srgb,var(--accent-mint,#6DBF9F) 60%,transparent)}
.st-df-chips{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;justify-content:center}
.st-df-chip{font-size:11px;font-weight:600;padding:4px 10px;border-radius:999px;cursor:pointer;background:transparent;
  border:1px solid var(--border-color,#e5e7eb);color:var(--text-sub,#6b7280);transition:all .2s ease}
.st-df-chip b{font-variant-numeric:tabular-nums}
.st-df-chip.on{border-color:var(--primary,#5B9BD5);color:var(--primary,#5B9BD5);background:color-mix(in srgb,var(--primary,#5B9BD5) 12%,transparent)}
.st-df-chip.on.f-neg{border-color:var(--diff-neg,#D2545A);color:var(--diff-neg,#D2545A);background:color-mix(in srgb,var(--diff-neg,#D2545A) 12%,transparent)}
.st-df-detail{background:var(--bg-card,#fff);border:1px solid var(--border-color,#e5e7eb);border-radius:18px;padding:18px 20px;position:relative;overflow:hidden}
.st-df-detail::before{content:'';position:absolute;left:24px;right:24px;top:0;height:3px;border-radius:0 0 3px 3px;
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--primary,#5B9BD5) 50%,transparent),transparent)}
.st-df-badges{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.st-df-badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:.4px;
  background:var(--bg-input,#f3f4f6);color:var(--text-sub,#6b7280)}
.st-df-badge.eng{background:color-mix(in srgb,var(--diff-neg,#D2545A) 14%,transparent);color:var(--diff-neg,#D2545A)}
.st-df-badge.p1{background:var(--diff-neg,#D2545A);color:#fff}
.st-df-badge.p2{background:var(--warn,#C98A2D);color:#fff}
.st-df-mname{font-size:19px;font-weight:800;margin-top:10px}
.st-df-mcode{font-size:12px;color:var(--text-sub,#6b7280);margin-top:3px;font-variant-numeric:tabular-nums}
.st-df-qty{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;background:var(--bg-input,#f3f4f6);
  border-radius:14px;padding:14px 18px;margin-top:12px}
.st-df-ql{font-size:11px;color:var(--text-sub,#6b7280);margin-bottom:3px}
.st-df-qv{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums}
.st-df-qv.book{color:var(--text-sub,#6b7280)} .st-df-qv.real{color:var(--primary,#5B9BD5)}
.st-df-arrow{color:var(--text-sub,#6b7280);font-size:18px}
.st-df-delta{margin-top:10px;font-size:12px;font-weight:700}
.st-df-delta.neg{color:var(--diff-neg,#D2545A)} .st-df-delta.pos{color:var(--primary,#5B9BD5)}
.st-df-adv{margin-top:14px;border:1px solid var(--border-color,#e5e7eb);border-radius:14px;padding:12px 14px}
.st-df-advh{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:800;margin-bottom:8px}
.st-df-advh i{width:22px;height:22px;border-radius:8px;background:var(--accent-mint,#6DBF9F);color:#fff;display:flex;
  align-items:center;justify-content:center;font-style:normal;font-size:12px;flex:none}
.st-df-basis{font-size:11px;color:var(--text-sub,#6b7280);font-weight:600;margin-left:auto}
.st-df-adv ol{margin:0;padding-left:18px;font-size:12.5px;line-height:1.75;color:var(--text-main,#111827)}
.st-df-adv ol li{margin-bottom:3px}
.st-df-acts{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
.st-df-act{font-size:11.5px;padding:5px 11px;border-radius:999px;border:1px solid var(--border-color,#e5e7eb);
  background:transparent;color:var(--text-sub,#6b7280);cursor:pointer}
.st-df-act:hover{border-color:var(--primary,#5B9BD5);color:var(--primary,#5B9BD5)}
.st-df-note{margin-top:14px}
.st-df-nlabel{font-size:11.5px;color:var(--text-sub,#6b7280);font-weight:600;display:flex;align-items:center;gap:8px}
.st-df-saved{font-size:11px;color:var(--accent-mint,#6DBF9F);opacity:0;transition:opacity .2s ease}
.st-df-saved.show{opacity:1}
.st-df-note textarea{width:100%;margin-top:6px;min-height:62px;resize:vertical;font:inherit;font-size:12.5px;
  padding:9px 11px;border-radius:11px;border:1px solid var(--border-color,#e5e7eb);background:var(--bg-card,#fff);
  color:var(--text-main,#111827);line-height:1.6}
.st-df-note textarea:focus{outline:none;border-color:var(--primary,#5B9BD5)}
.st-df-foot{display:flex;align-items:center;gap:9px;padding:12px 20px;border-top:1px solid var(--border-color,#e5e7eb);flex-wrap:wrap;
  position:sticky;bottom:0;background:var(--bg-card,#fff);z-index:3;border-radius:0 0 20px 20px}
.st-df-progress{font-size:12.5px;color:var(--text-sub,#6b7280);margin-right:auto}
.st-df-btn{border:none;border-radius:11px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.st-df-btn.ghost{background:var(--bg-input,#f3f4f6);color:var(--text-main,#111827)}
.st-df-btn.ok{background:var(--accent-mint,#6DBF9F);color:#fff}
.st-df-btn:disabled{opacity:.45;cursor:not-allowed}
.st-df-empty{padding:40px 20px;text-align:center;color:var(--text-sub,#6b7280);font-size:13px}
`;

  /* ─────────────────── 模块状态 ─────────────────── */
  let mask = null, cur = 0, fkey = 'all', ITEMS = [], segs = [], doneSet = new Set(), tickGeom = null;
  let _keydown = null, _saveTimer = null, _sheetId = '';

  function injectStyle() {
    if (document.getElementById('st-df-style')) return;
    const s = document.createElement('style');
    s.id = 'st-df-style'; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function dropStyle() { const s = document.getElementById('st-df-style'); if (s) s.remove(); }

  /* ─────────────────── 数据 ─────────────────── */
  async function diffRecords(sheetId) {
    let recs = [];
    try { recs = await DataStore.getStocktakeRecords(); } catch (e) { recs = []; }
    return (recs || []).filter(r =>
      r && !r.voided && String(r.sheetId || '') === String(sheetId) &&
      r.差异量 != null && num(r.差异量) !== 0 && r.unfilled !== 1 && r.盘点数量 != null
    );
  }

  /** 差异笔数（按存货编码去重后），供入口徽标显示 */
  async function count(sheetId) {
    try {
      const recs = await diffRecords(sheetId);
      return new Set(recs.map(r => String(r.存货编码 || ''))).size;
    } catch (e) { return 0; }
  }

  /** 入口门禁：季度需轮次收口（补盘已冻结）；日常需已落库且有差异 */
  async function isReady(sheetId) {
    try {
      if (!sheetId) return false;
      const recs = await diffRecords(sheetId);
      if (!recs.length) return false;
      const isDaily = recs.some(r => String(r.sheetType || '') === 'daily' || String(r.盘点类别 || '') === '日常');
      if (isDaily) return true;
      if (typeof StocktakeModule !== 'undefined' && typeof StocktakeModule.isQuarterRoundClosed === 'function')
        return !!StocktakeModule.isQuarterRoundClosed(sheetId);
      return false;
    } catch (e) { console.warn('[diff-focus] isReady 失败(已忽略):', e && e.message); return false; }
  }

  /** 库存派生快照（分类/月均/类型）—— 取不到则降级，不影响主流程 */
  async function alertMap() {
    const m = new Map();
    try {
      if (typeof InventoryAlertModule !== 'undefined' && typeof InventoryAlertModule.buildDerivedAlerts === 'function') {
        const alerts = await InventoryAlertModule.buildDerivedAlerts();
        (alerts || []).forEach(a => { if (a && a.存货编码) m.set(String(a.存货编码).trim(), a); });
      }
    } catch (e) { console.warn('[diff-focus] 库存派生快照获取失败(已忽略):', e && e.message); }
    return m;
  }

  /* ─────────────────── 打开 ─────────────────── */
  async function open(sheetId) {
    try {
      if (mask) close();
      _sheetId = String(sheetId || '');
      const recs = await diffRecords(_sheetId);
      if (!recs.length) { toast('该盘点号暂无差异项，无需核对'); return; }

      /* 同一编码可能被多人/补盘多次记录 → 取最新实盘（countedAt/updatedAt 更晚者） */
      const byCode = new Map();
      recs.forEach(r => {
        const code = String(r.存货编码 || '');
        const prev = byCode.get(code);
        const t = String(r.countedAt || r.updatedAt || r.createdAt || '');
        if (!prev || t > String(prev.countedAt || prev.updatedAt || prev.createdAt || '')) byCode.set(code, r);
      });

      const amap = await alertMap();
      ITEMS = Array.from(byCode.values()).map(r => ({
        id: r.id, code: r.存货编码 || '', name: r.存货名称 || '', spec: r.规格型号 || '',
        book: num(r.现存量), real: num(r.盘点数量), diff: Math.round(num(r.差异量) * 100) / 100,
        counter: r.盘点人 || '', note: r.备注 || '',
        cls: (amap.get(String(r.存货编码 || '').trim()) || {}).分类 || '',
        k: num((amap.get(String(r.存货编码 || '').trim()) || {})['近一年月均入库量']),
        type: (amap.get(String(r.存货编码 || '').trim()) || {}).类型 || '',
        batchNo: r.batchNo || '', sheetType: r.sheetType || ''
      }));
      /* 差异量大的排前面（盘点复盘习惯：先抓大头） */
      ITEMS.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

      cur = 0; fkey = 'all'; doneSet = new Set(); segs = [];
      injectStyle();
      buildShell();
      buildRing();
      render();
    } catch (e) {
      console.warn('[diff-focus] 打开失败(已忽略):', e && e.message);
      toast('差异核对打开失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  function buildShell() {
    const daily = ITEMS.some(it => it.sheetType === 'daily');
    const batchTxt = ITEMS[0] && ITEMS[0].batchNo ? ('盘点号 ' + ITEMS[0].batchNo) : (daily ? '日常盘点' : '季度盘点');
    mask = document.createElement('div');
    mask.className = 'st-df-mask';
    mask.id = 'stDfMask';
    mask.innerHTML = `
      <div class="st-df-panel" role="dialog" aria-modal="true" aria-label="差异核对">
        <div class="st-df-head">
          <div class="st-df-title">🧭 差异核对</div>
          <div class="st-df-sub">${esc(batchTxt)} · 共 ${ITEMS.length} 笔差异 · 按差异量从大到小排列</div>
          <button class="st-df-close" id="stDfClose" title="关闭（Esc）">✕</button>
        </div>
        <div class="st-df-stage">
          <section class="st-df-ring">
            <svg class="st-df-svg" id="stDfSvg" viewBox="0 0 300 300" role="img" aria-label="差异核对进度环">
              <circle class="st-df-deco" cx="150" cy="150" r="99" pathLength="100"/>
              <g id="stDfSegGroup" transform="rotate(-90 150 150)"></g>
            </svg>
            <div class="st-df-center">
              <div class="st-df-prog" id="stDfProg"></div>
              <div class="st-df-num" id="stDfNum"></div>
              <div class="st-df-tag" id="stDfTag"></div>
              <div class="st-df-name" id="stDfName"></div>
            </div>
            <div class="st-df-legend">
              <span><i class="neg"></i>盘亏</span><span><i class="pos"></i>盘盈</span><span><i class="done"></i>已核对</span>
            </div>
            <div class="st-df-chips" id="stDfChips"></div>
          </section>
          <section class="st-df-detail" id="stDfDetail"></section>
        </div>
        <div class="st-df-foot">
          <div class="st-df-progress" id="stDfProgress"></div>
          <button class="st-df-btn ghost" id="stDfPrev">← 上一笔</button>
          <button class="st-df-btn ok" id="stDfOk">✓ 确认核对（Enter）</button>
          <button class="st-df-btn ghost" id="stDfUndo">↩ 撤销</button>
          <button class="st-df-btn ghost" id="stDfNext">下一笔 →</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    mask.querySelector('#stDfClose').addEventListener('click', close);
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    mask.querySelector('#stDfPrev').addEventListener('click', () => nav(-1));
    mask.querySelector('#stDfNext').addEventListener('click', () => nav(1));
    mask.querySelector('#stDfOk').addEventListener('click', confirmCur);
    mask.querySelector('#stDfUndo').addEventListener('click', undo);

    _keydown = e => {
      if (!mask) return;
      if (e.key === 'Escape') { close(); return; }
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;   /* 输入中不抢按键 */
      if (e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); confirmCur(); }
    };
    document.addEventListener('keydown', _keydown);
  }

  /* ─────────────────── 环（≤28 分段弧 / >28 雷达刻度） ─────────────────── */
  function buildRing() {
    const g = mask.querySelector('#stDfSegGroup');
    if (!g) return;
    g.innerHTML = '';
    const N = ITEMS.length, R = 118, tickMode = N > 28;
    segs = []; tickGeom = null;
    ITEMS.forEach((it, i) => {
      const d = num(it.diff);
      const state = d < 0 ? 'neg' : d > 0 ? 'pos' : 'zero';
      let el;
      if (tickMode) {
        const ang = -Math.PI / 2 + i * 2 * Math.PI / N;
        const cos = Math.cos(ang), sin = Math.sin(ang);
        el = document.createElementNS(NS, 'line');
        el.setAttribute('x1', 150 + 112 * cos); el.setAttribute('y1', 150 + 112 * sin);
        el.setAttribute('x2', 150 + 127 * cos); el.setAttribute('y2', 150 + 127 * sin);
      } else {
        const SEG = 100 / N, GAP = 2.2;
        el = document.createElementNS(NS, 'circle');
        el.setAttribute('cx', 150); el.setAttribute('cy', 150); el.setAttribute('r', R);
        el.setAttribute('pathLength', 100);
        el.setAttribute('stroke-dasharray', (SEG - GAP) + ' ' + (100 - SEG + GAP));
        el.setAttribute('stroke-dashoffset', -(i * SEG + GAP / 2));
      }
      el.setAttribute('class', 'st-df-seg ' + (tickMode ? 'tick ' : '') + state);
      el.addEventListener('click', () => { cur = i; render(); });
      g.appendChild(el);
      segs.push(el);
    });
    if (tickMode) {
      tickGeom = segs.map((_, i) => {
        const ang = -Math.PI / 2 + i * 2 * Math.PI / N;
        return { cos: Math.cos(ang), sin: Math.sin(ang) };
      });
    }
  }
  function tickLayout(i, curOn) {
    if (!tickGeom) return;
    const { cos, sin } = tickGeom[i];
    const r1 = curOn ? 105 : 112;
    segs[i].setAttribute('x1', 150 + r1 * cos); segs[i].setAttribute('y1', 150 + r1 * sin);
    segs[i].setAttribute('x2', 150 + 127 * cos); segs[i].setAttribute('y2', 150 + 127 * sin);
  }
  function match(i) {
    const d = num(ITEMS[i].diff);
    if (fkey === 'neg') return d < 0;
    if (fkey === 'pos') return d > 0;
    if (fkey === 'undone') return !doneSet.has(i);
    return true;
  }

  /* ─────────────────── 渲染 ─────────────────── */
  function render() {
    if (!mask) return;
    const it = ITEMS[cur];
    if (!it) return;
    const adv = (typeof StocktakeAdvisor !== 'undefined')
      ? StocktakeAdvisor.advise(ITEMS, cur) : { diff: it.diff, tips: [], acts: [] };
    const prio = (typeof StocktakeAdvisor !== 'undefined') ? StocktakeAdvisor.priority(it) : 'P3';
    const diff = num(it.diff);

    segs.forEach((s, i) => {
      const isCur = i === cur, isDone = doneSet.has(i);
      s.classList.toggle('cur', isCur); s.classList.toggle('done', isDone);
      s.classList.toggle('dim', !match(i));
      if (tickGeom) tickLayout(i, isCur && !isDone);
    });

    const q = id => mask.querySelector('#' + id);
    q('stDfProg').textContent = '第 ' + (cur + 1) + ' / ' + ITEMS.length + ' 笔';
    const numEl = q('stDfNum');
    numEl.className = 'st-df-num ' + (diff < 0 ? 'neg' : diff > 0 ? 'pos' : 'zero');
    numEl.textContent = (diff > 0 ? '+' : '') + fmt(diff);
    q('stDfTag').textContent = diff < 0 ? '盘亏 · 实物少于账面' : diff > 0 ? '盘盈 · 实物多于账面' : '账实相符';
    q('stDfName').textContent = (it.name || '') + ' ' + (it.spec || '');

    const cls = it.cls || '';
    const clsKey = cls === 'A工程类' || cls === 'C工程类' ? 'eng' : '';
    q('stDfDetail').innerHTML = `
      <div class="st-df-badges">
        ${cls ? `<span class="st-df-badge ${clsKey}">${esc(cls)}</span>` : ''}
        ${it.type ? `<span class="st-df-badge">${esc(it.type)}</span>` : ''}
        <span class="st-df-badge ${prio.toLowerCase()}">优先级 ${prio}</span>
        ${it.counter ? `<span class="st-df-badge">盘点人 ${esc(it.counter)}</span>` : ''}
      </div>
      <div class="st-df-mname">${esc(it.name)} ${esc(it.spec)}</div>
      <div class="st-df-mcode">编码 ${esc(it.code)}</div>
      <div class="st-df-qty">
        <div><div class="st-df-ql">账面现存量</div><div class="st-df-qv book">${fmt(it.book)}</div></div>
        <div class="st-df-arrow">→</div>
        <div><div class="st-df-ql">实盘数量</div><div class="st-df-qv real">${fmt(it.real)}</div></div>
      </div>
      <div class="st-df-delta ${diff < 0 ? 'neg' : 'pos'}">差异 ${diff > 0 ? '+' : ''}${fmt(diff)} · 占账面 ${it.book > 0 ? (Math.min(100, Math.abs(diff) / it.book * 100).toFixed(1)) : '—'}%</div>
      <div class="st-df-adv">
        <div class="st-df-advh"><i>🧭</i>参谋建议
          <span class="st-df-basis">${esc(cls || '—')}${it.k ? ' · 月均入库 ' + fmt(it.k) : ''}</span>
        </div>
        <ol>${adv.tips.map(t => '<li>' + t.t + '</li>').join('') || '<li>账实相符，可直接通过</li>'}</ol>
        <div class="st-df-acts">
          ${adv.acts.map(([label]) => `<button class="st-df-act">${esc(label)}</button>`).join('')}
          <button class="st-df-act" data-note="1">建议记入备注</button>
        </div>
      </div>
      <div class="st-df-note">
        <div class="st-df-nlabel">盘点备注（修改即同步保存至盘点记录）<span class="st-df-saved" id="stDfSaved">✓ 已保存</span></div>
        <textarea id="stDfNote" placeholder="填写核对结论 / 差异原因…">${esc(it.note || '')}</textarea>
      </div>`;

    /* 动作 chip：正式版可直达对应模块，此处仅提示（不改动任何既有流程） */
    q('stDfDetail').querySelectorAll('.st-df-act').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.note) {
          const ta = q('stDfNote');
          const head = adv.tips.length ? adv.tips[0].t.replace(/<[^>]+>/g, '') : '';
          ta.value = (ta.value ? ta.value.replace(/\s*$/, '') + '；' : '') + head;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          toast('参谋建议已追加至备注');
        } else {
          toast('（正式版将直达「' + btn.textContent + '」查询）');
        }
      });
    });

    /* 备注：失焦/防抖保存 → 记录表同一字段 */
    const ta = q('stDfNote');
    ta.addEventListener('input', () => {
      ITEMS[cur].note = ta.value;
      clearTimeout(_saveTimer);
      _saveTimer = setTimeout(() => saveNote(false), 900);
    });
    ta.addEventListener('change', () => saveNote(true));

    q('stDfProgress').textContent = '已核对 ' + doneSet.size + ' / ' + ITEMS.length + ' 笔 · ← → 切换 · Enter 确认 · Esc 关闭';
    renderChips();
  }

  function renderChips() {
    const box = mask.querySelector('#stDfChips');
    if (!box) return;
    const cnt = k => ITEMS.reduce((s, it, i) => {
      const d = num(it.diff);
      return s + ((k === 'neg' ? d < 0 : k === 'pos' ? d > 0 : k === 'undone' ? !doneSet.has(i) : true) ? 1 : 0);
    }, 0);
    box.innerHTML = [['all', '全部'], ['neg', '盘亏'], ['pos', '盘盈'], ['undone', '未核对']]
      .map(([k, t]) => `<button class="st-df-chip ${k === fkey ? 'on ' : ''}${k === 'neg' ? 'f-neg' : ''}" data-f="${k}">${t} <b>${cnt(k)}</b></button>`)
      .join('');
    box.querySelectorAll('.st-df-chip').forEach(c => c.addEventListener('click', () => {
      fkey = c.dataset.f;
      if (!match(cur)) { const f = ITEMS.findIndex((_, i) => match(i)); if (f > -1) cur = f; }
      render();
    }));
  }

  /* ─────────────────── 备注保存（单一事实源） ─────────────────── */
  async function saveNote(showTip) {
    if (!mask) return;
    const ta = mask.querySelector('#stDfNote');
    const it = ITEMS[cur];
    if (!ta || !it || !it.id) return;
    const val = ta.value;
    try {
      await DataStore.updateStocktakeRecord(it.id, { 备注: val });
      /* 云端同步：与盘点提交同一条链路；失败仅提示，本地已落库 */
      if (typeof SyncManager !== 'undefined' && SyncManager.isOnline && typeof SyncManager.syncStocktake === 'function') {
        try {
          const recs = await DataStore.getStocktakeRecords();
          const rec = (recs || []).find(r => r.id === it.id);
          if (rec) {
            const res = await SyncManager.syncStocktake([rec], {
              sheetId: _sheetId, sheetType: it.sheetType || '', status: 'closed',
              updatedAt: new Date().toISOString()
            });
            if (!(res && res.ok)) { toast('已存本地，云端同步将在后台重试'); return; }
          }
        } catch (e) { console.warn('[diff-focus] 云端同步失败(已忽略):', e && e.message); }
      }
      const tag = mask.querySelector('#stDfSaved');
      if (tag) { tag.classList.add('show'); setTimeout(() => tag.classList.remove('show'), 1500); }
      if (showTip) toast('备注已同步保存至盘点记录');
    } catch (e) {
      console.warn('[diff-focus] 备注保存失败(已忽略):', e && e.message);
      toast('备注保存失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  /* ─────────────────── 交互 ─────────────────── */
  function nav(d) {
    let j = cur, hit = false;
    for (let s = 0; s < ITEMS.length; s++) {
      j = (j + d + ITEMS.length) % ITEMS.length;
      if (match(j)) { hit = true; break; }
    }
    if (hit) cur = j;
    render();
  }
  function confirmCur() {
    if (!ITEMS[cur]) return;
    if (!doneSet.has(cur)) {
      doneSet.add(cur);
      toast('已标记核对：' + (ITEMS[cur].name || '') + ' ' + (ITEMS[cur].spec || ''));
    }
    const next = ITEMS.findIndex((_, i) => !doneSet.has(i) && match(i));
    if (next === -1) { cur = 0; toast('当前筛选范围内已全部核对'); } else cur = next;
    render();
  }
  function undo() {
    if (!doneSet.size) return;
    const last = Array.from(doneSet).pop();
    doneSet.delete(last); cur = last; render();
  }
  function close() {
    try {
      clearTimeout(_saveTimer);
      if (mask && mask.querySelector('#stDfNote')) saveNote(false);
      if (_keydown) { document.removeEventListener('keydown', _keydown); _keydown = null; }
      if (mask) { mask.remove(); mask = null; }
      dropStyle();
      ITEMS = []; segs = []; tickGeom = null; doneSet = new Set(); cur = 0; fkey = 'all'; _sheetId = '';
    } catch (e) { console.warn('[diff-focus] 关闭异常(已忽略):', e && e.message); }
  }

  function toast(msg) {
    try { if (typeof showToast === 'function') showToast(msg); } catch (e) { /* 忽略 */ }
  }

  global.StocktakeDiffFocus = { isReady, count, open, close };
})(typeof window !== 'undefined' ? window : this);
