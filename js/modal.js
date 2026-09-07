/* =========================================================================
 * 🟢 v200：工作台主题弹窗（替换浏览器原生 alert / confirm / prompt）
 * 复用现有 .modal-overlay / .modal 样式（冰川蓝玻璃主题），保证与工作台 UI 一致。
 * 用法：
 *   WBModal.alert('提示文案', { title: '提示', type: 'info' })   // 单按钮
 *   WBModal.confirm('确定要删除吗？', { title: '确认' })            // 双按钮，返回 Promise<boolean>
 *   WBModal.choice('请选择', { title:'账号', buttons:[{text:'取消',value:null},{text:'',value:'x',primary:true}] }) // 多按钮，返回 Promise<value>
 *   WBModal.choiceList('请选择', { title:'账号', items:[{text:'A',value:'a'},{text:'B',value:'b'},{text:'当前',value:'c',disabled:true}] }) // 列表选择，返回 Promise<value>（适合 >2 选项）
 *   WBModal.notify('保存成功', 'success')                          // 右下角吐司，2.5s 自动消失
 * 行为细节：
 *   - 任意弹窗打开期间，其他弹窗（旧的）被强制关闭，避免叠加
 *   - ESC 键 = 默认按钮（alert 关闭 / confirm 点确认 / prompt 提交）
 *   - 点击遮罩 = 默认按钮（alert/confirm 同 ESC；prompt 视为取消）
 *   - alert 不阻塞 JS（异步），但 confirm/prompt 返回 Promise，可在 async 函数中 await
 *   - notify 不阻塞、可叠加，自动清理
 *   - 自动按 type 配图标与强调色（info/success/warn/error）
 * ========================================================================= */
(function () {
  'use strict';

  const TYPE_META = {
    info:    { icon: 'ℹ️', accent: '#4a7ce8', title: '提示' },
    success: { icon: '✅', accent: '#10b981', title: '成功' },
    warn:    { icon: '⚠️', accent: '#f59e0b', title: '注意' },
    error:   { icon: '❌', accent: '#ef4444', title: '错误' },
    question:{ icon: '❓', accent: '#4a7ce8', title: '确认' }
  };

  // 单一容器，所有弹窗都挂在这一个遮罩下
  let root = null;
  let openDialogEl = null;        // 当前弹窗的 .modal 元素（用于强制关闭上一个）
  let openResolve = null;          // confirm/prompt 的 resolve
  let openKeyHandler = null;
  let openOverlayHandler = null;
  let openPrevActive = null;       // 打开前 document.activeElement，用于关闭后归还焦点
  // 🟢 队列：原生 alert 是「阻塞」的，连续调用时用户能逐条看到。
  //    换成异步弹窗后，若不做队列，第二次调用会直接顶掉第一次 —— 用户会漏看提示。
  //    这里让后续弹窗排队，等前一个关闭后自动显示下一条。
  const queue = [];

  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'modal-overlay';
    root.id = 'wbModalRoot';
    root.style.zIndex = '5000';   // 压在工作台所有弹层之上
    document.body.appendChild(root);
    // 全局关闭：点遮罩或 ESC
    root.addEventListener('click', (e) => {
      if (e.target === root && openOverlayHandler) openOverlayHandler();
    });
    return root;
  }

  function buildDialog({ title, body, buttons, accent }) {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    // 🟢 v227.49：去掉 inline width:'auto'（会覆盖 CSS 的 .modal{width:min(440px,...)}），
    //   让 CSS 主导宽度，单/双按钮弹窗均 ≈440px（移动端仍自适应 100vw-24px）。
    wrap.style.borderTop = `3px solid ${accent}`;

    // header
    const header = document.createElement('div');
    header.className = 'modal-header';
    const tEl = document.createElement('span');
    tEl.className = 'modal-title';
    tEl.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', () => closeDialog(null));
    header.appendChild(tEl);
    header.appendChild(closeBtn);

    // body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'modal-body';
    // 🟢 v227.45：弹窗 body 内边距收紧，更紧凑适合移动端
    bodyEl.style.padding = '16px 18px';
    bodyEl.style.fontSize = '13.5px';
    bodyEl.style.lineHeight = '1.6';
    bodyEl.style.color = 'var(--text-main)';
    if (typeof body === 'string') {
      bodyEl.textContent = body;
    } else if (body instanceof HTMLElement) {
      bodyEl.appendChild(body);
    }

    // footer
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    footer.style.padding = '12px 16px 14px';
    footer.style.display = 'flex';
    footer.style.gap = '8px';
    footer.style.justifyContent = 'flex-end';
    footer.style.borderTop = '1px solid var(--panel-border)';
    // 🟢 v227.45：多于 1 个按钮时让按钮均分宽度，移动端不溢出
    if (buttons.length > 1) {
      footer.style.flexWrap = 'wrap';
    }
    buttons.forEach((b, i) => {
      const btn = document.createElement('button');
      btn.className = b.primary ? 'btn--primary' : 'btn--ghost';
      btn.textContent = b.text;
      // 🟢 v227.54：统一按钮系统（.btn）。基础盒模型由 CSS !important 兜底，
      // 这里仅保留历史内联兜底（被 .btn 覆盖），不再手动设尺寸/圆角/字体。
      btn.style.flex = '1';
      btn.style.borderRadius = '10px';
      btn.style.fontFamily = "'PingFang SC','Microsoft YaHei','黑体',sans-serif";
      if (buttons.length === 1) {
        btn.style.minWidth = '120px';
      } else {
        btn.style.flex = '1 1 0';
        btn.style.minWidth = '0';
      }
      btn.addEventListener('click', () => closeDialog(b.value));
      footer.appendChild(btn);
    });

    wrap.appendChild(header);
    wrap.appendChild(bodyEl);
    wrap.appendChild(footer);
    return { wrap, bodyEl, defaultBtn: footer.children[footer.children.length - 1] };
  }

  function open(opts) {
    // 🟢 已有弹窗在显示 → 排队，等它关闭后自动接着显示（避免连续提示被互相顶掉）
    if (openDialogEl) {
      queue.push(opts);
      return;
    }

    const meta = TYPE_META[opts.type] || TYPE_META.info;
    const title = opts.title || meta.title;
    const accent = meta.accent;

    const r = ensureRoot();
    const { wrap, bodyEl, defaultBtn } = buildDialog({
      title,
      body: opts.body || opts.message || '',
      buttons: opts.buttons || [{ text: '确定', value: true, primary: true }],
      accent
    });
    // 清空旧内容，塞新弹窗
    r.innerHTML = '';
    r.appendChild(wrap);
    openDialogEl = wrap;
    openResolve = opts.resolve || null;
    openPrevActive = document.activeElement;

    // 🟢 v208 AUDIT-103：键盘语义按「按钮角色」取，而不是按下标取。
    //   confirm/prompt 的按钮序固定为 [取消, 确定]：
    //     · 旧逻辑 Enter 取 buttons[0] → 回车 = 取消（高频误触）
    //     · 旧逻辑 Esc   取最后一个    → Esc  = 确定（危险操作按 Esc 直接执行！）
    //   现统一：Enter = primary 按钮（确定）；Esc = 非 primary 按钮（取消）。
    //   alert 只有一个 primary 按钮，两种按键都返回 true，行为保持不变。
    openKeyHandler = (e) => {
      const btns = (opts.buttons && opts.buttons.length) ? opts.buttons : [{ value: true, primary: true }];
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const cancelBtn = btns.find(b => !b.primary) || btns[0];
        closeDialog(cancelBtn.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const okBtn = btns.find(b => b.primary) || btns[btns.length - 1];
        closeDialog(okBtn.value);
      }
    };
    document.addEventListener('keydown', openKeyHandler, true);

    // 触发显示
    requestAnimationFrame(() => r.classList.add('show'));

    // 默认聚焦
    setTimeout(() => {
      const input = bodyEl.querySelector('input, textarea');
      if (input) { input.focus(); input.select?.(); }
      else if (defaultBtn) defaultBtn.focus();
    }, 60);
  }

  function closeDialog(value, silent) {
    if (!openDialogEl && !silent) return;
    const r = root;
    if (r) r.classList.remove('show');

    if (openKeyHandler) {
      document.removeEventListener('keydown', openKeyHandler, true);
      openKeyHandler = null;
    }
    if (openResolve) {
      try { openResolve(value); } catch (_) {}
      openResolve = null;
    }
    openDialogEl = null;
    // 归还焦点
    if (openPrevActive && openPrevActive.focus) {
      try { openPrevActive.focus(); } catch (_) {}
    }
    openPrevActive = null;

    // 🟢 队列里还有排队的弹窗 → 下一个事件循环显示它（等本轮关闭动画/状态清理完成）
    if (queue.length) {
      const next = queue.shift();
      setTimeout(() => open(next), 30);
    }
  }

  // ===== 公开 API =====
  function alert(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      open({
        type: opts.type || 'info',
        title: opts.title,
        body: opts.body || message,
        buttons: [{ text: opts.okText || '确定', value: true, primary: true }],
        resolve: (v) => { resolve(v === true); }
      });
    });
  }

  function confirm(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      open({
        type: 'question',
        title: opts.title || '确认',
        body: opts.body || message,
        buttons: [
          { text: opts.cancelText || '取消', value: false, primary: false },
          { text: opts.okText || '确定', value: true, primary: true }
        ],
        resolve: (v) => { resolve(v === true); }
      });
    });
  }

  // 🟢 v227.46：列表选择弹窗 —— body 是 HTMLElement（内含若干列表项），
  //   footer 只放「取消」按钮。列表项 click → 关闭弹窗并 resolve(item.value)。
  //   与 choice 的区别：choice 强制每个候选都做成 footer 按钮，不适合选项多的场景。
  function choiceList(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      let resolved = false;
      const items = Array.isArray(opts.items) ? opts.items : [];
      const list = document.createElement('div');
      list.className = 'modal-list';
      list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:50vh;overflow-y:auto;';
      items.forEach((it, i) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'modal-list-item';
        row.dataset.value = String(it.value);
        row.dataset.index = String(i);
        if (it.disabled) {
          row.disabled = true;
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 12px;border:1px solid var(--panel-border);border-radius:8px;background:var(--panel-bg);color:var(--text-secondary);font-size:13.5px;cursor:not-allowed;opacity:0.85;';
        } else {
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 12px;border:1px solid var(--panel-border);border-radius:8px;background:var(--panel-bg);color:var(--text-main);font-size:13.5px;cursor:pointer;text-align:left;transition:all 0.15s;';
          row.addEventListener('mouseenter', () => { row.style.background = 'rgba(122,156,165,0.10)'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'var(--panel-bg)'; });
        }
        const label = document.createElement('span');
        label.textContent = it.text;
        row.appendChild(label);
        if (it.hint) {
          const hint = document.createElement('span');
          hint.style.cssText = 'font-size:11.5px;color:var(--text-secondary);margin-left:8px;';
          hint.textContent = it.hint;
          row.appendChild(hint);
        }
        row.addEventListener('click', () => {
          if (resolved) return;
          resolved = true;
          resolve(it.value);
          closeDialog(null);
        });
        list.appendChild(row);
      });
      const box = document.createElement('div');
      box.style.cssText = 'text-align:left;line-height:1.6;';
      if (message) {
        if (message instanceof HTMLElement) {
          // 调用方传入的描述节点（已含样式）—— 整体插入
          box.appendChild(message);
        } else {
          const intro = document.createElement('div');
          intro.style.cssText = 'font-size:13px;color:var(--text-secondary);margin-bottom:10px;';
          intro.textContent = String(message);
          box.appendChild(intro);
        }
      }
      box.appendChild(list);
      open({
        type: opts.type || 'question',
        title: opts.title || '请选择',
        body: box,
        buttons: [{ text: opts.cancelText || '取消', value: null, primary: false }],
        resolve: (v) => { if (!resolved) { resolved = true; resolve(null); } }
      });
    });
  }

  function prompt(message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      const msg = document.createElement('div');
      msg.textContent = message;
      msg.style.marginBottom = '10px';
      const input = document.createElement('input');
      input.type = opts.type || 'text';
      input.value = opts.default || '';
      input.placeholder = opts.placeholder || '';
      input.style.width = '100%';
      input.style.height = '34px';
      input.style.padding = '0 12px';
      input.style.border = '1px solid var(--card-border)';
      input.style.borderRadius = '8px';
      input.style.fontSize = '13px';
      input.style.background = 'var(--card-bg, #fff)';
      input.style.color = 'var(--text-main)';
      input.style.boxSizing = 'border-box';
      wrap.appendChild(msg);
      wrap.appendChild(input);

      let submitValue = null;
      open({
        title: opts.title || '请输入',
        body: wrap,
        buttons: [
          { text: opts.cancelText || '取消', value: null, primary: false },
          { text: opts.okText || '确定', value: '__submit__', primary: true }
        ],
        resolve: (v) => {
          if (v === '__submit__') submitValue = input.value;
          else submitValue = null;
          resolve(submitValue);
        }
      });
    });
  }

  // 🟢 v227.43：多选项弹窗（2~3 个自定义按钮，返回被点击按钮的 value）
  //   例：WBModal.choice('是否退出？', { title:'退出登录', buttons:[
  //        { text:'取消', value:null }, { text:'切换账号', value:'switch' }, { text:'确认退出', value:'logout', primary:true }
  //      ]}).then(v => { ... })
  function choice(message, opts) {
    opts = opts || {};
    const buttons = (opts.buttons && opts.buttons.length)
      ? opts.buttons
      : [{ text: '取消', value: null, primary: false }];
    return new Promise((resolve) => {
      open({
        type: opts.type || 'question',
        title: opts.title || '请选择',
        body: opts.body || message,
        buttons: buttons,
        resolve: (v) => { resolve(v === undefined ? null : v); }
      });
    });
  }

  // 吐司：右下角，自动消失
  function notify(message, type, ms) {
    type = type || 'info';
    ms = ms || 2500;
    const meta = TYPE_META[type] || TYPE_META.info;
    let host = document.getElementById('wbToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'wbToastHost';
      host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:5500;display:flex;flex-direction:column;gap:10px;align-items:flex-end;pointer-events:none;';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.style.cssText = [
      'background:var(--panel-bg)',
      'backdrop-filter:var(--glass-blur)',
      '-webkit-backdrop-filter:var(--glass-blur)',
      'border:1px solid var(--panel-border)',
      'border-left:3px solid ' + meta.accent,
      'border-radius:10px',
      'padding:10px 14px',
      'font-size:13px',
      'color:var(--text-main)',
      'box-shadow:0 6px 20px rgba(0,0,0,0.10)',
      'min-width:160px',
      'max-width:360px',
      'pointer-events:auto',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'transform:translateX(120%)',
      'transition:transform .25s ease',
      'cursor:pointer'
    ].join(';');
    t.innerHTML = '<span style="font-size:15px;">' + meta.icon + '</span><span></span>';
    t.querySelector('span:last-child').textContent = message;
    host.appendChild(t);
    requestAnimationFrame(() => { t.style.transform = 'translateX(0)'; });
    const dismiss = () => {
      t.style.transform = 'translateX(120%)';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 280);
    };
    t.addEventListener('click', dismiss);
    setTimeout(dismiss, ms);
  }

  window.WBModal = { alert, confirm, prompt, choice, choiceList, notify, close: () => closeDialog(null) };
})();
