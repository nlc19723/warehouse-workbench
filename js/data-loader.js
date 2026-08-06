// ============================================
// Excel 数据导入 - 使用 SheetJS
// ============================================

const DataLoader = {
  filePath: 'data/库管系统.xlsx',

  // 各工作表的精确表头行号（从0开始）
  sheetHeaderRows: {
    '供应商管理': 1,
    '采购订单列表': 1,
    '供货2023.9.1-新入库': 1,
    '中心库房现存量': 1,
    '库存预警数量': 2,
    '订货': 2,
    '供应商价格': 1,
    '低周转材料': 2,
    '违约台账': 2,
    '对账功能': 2,
    '订单跟踪列表': 0,  // 复杂结构，单独处理
    '材料分类': 0,
    '仪表盘': 0,
    '统计数据': 0
  },

  // 参与云端同步的数据表（meta 是元数据表，单独处理）
  TABLES: ['suppliers', 'orders', 'inbound', 'stock', 'inventoryAlerts', 'orderChecks', 'pricing', 'lowTurnover', 'breach', 'materialClass', 'monthlyStats'],

  // 主入口：检查并导入数据（本地优先，云端异步）
  async init() {
    // 1) 本地已有数据 → 立即显示，后台静默尝试云端同步
    const imported = await DataStore.isDataImported();
    if (imported) {
      console.log('本地数据已存在，直接使用');
      // 后台尝试从云端拉取更新（不阻塞页面）
      this._syncFromCloudInBackground();
      return true;
    }

    // 2) 无本地数据，尝试从云端拉取（8 秒超时）
    try {
      if (typeof SyncManager !== 'undefined') SyncManager.init();
    } catch (e) { /* ignore */ }

    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
      try {
        const bundle = await this._pullWithTimeout(8000);
        if (bundle && bundle.tables) {
          showLoading('正在从云端同步最新数据...');
          await this.loadBundleFromCloud(bundle);
          hideLoading();
          console.log('已从云端同步数据');
          return true;
        }
      } catch (e) {
        console.warn('云端拉取失败:', e.message || e);
      }
    }

    // 3) 都没有，读取内置 Excel
    return await this.importFromExcel();
  },

  // 后台静默从云端拉取更新（不阻塞页面）
  async _syncFromCloudInBackground() {
    try {
      if (typeof SyncManager !== 'undefined') SyncManager.init();
    } catch (e) { return; }
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return;
    try {
      const bundle = await this._pullWithTimeout(8000);
      if (bundle && bundle.tables && bundle.savedAt) {
        const localTime = await DataStore.getImportTime();
        if (!localTime || bundle.savedAt > localTime) {
          console.log('云端有更新，自动同步中...');
          await this.loadBundleFromCloud(bundle);
          console.log('云端数据已更新，刷新视图');
          if (typeof App !== 'undefined' && App.currentModule) {
            App.go(App.currentModule);
          }
        }
      }
    } catch (e) {
      console.warn('后台同步失败:', e.message || e);
    }
  },

  // 带超时的云端拉取（防止网络请求卡死整个初始化）
  _pullWithTimeout(ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.warn('云端拉取超时(' + ms + 'ms)，回退本地');
        resolve(null); // 超时返回 null，走本地回退
      }, ms);
      SyncManager.pullData().then(result => {
        clearTimeout(timer);
        resolve(result);
      }).catch(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  },

  // 分批写入辅助函数 - 避免 IndexedDB 事务超时
  async bulkAddSafe(table, rows, batchSize = 200) {
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      await table.bulkAdd(batch);
    }
  },

  // 从云端 bundle 还原数据（清空后批量写入），使分享链接自动拿到最新数据
  async loadBundleFromCloud(bundle) {
    if (!bundle || !bundle.tables) return false;
    await DataStore.clearAll();
    await new Promise(r => setTimeout(r, 300));

    const tables = bundle.tables || {};
    for (const name of this.TABLES) {
      const rows = Array.isArray(tables[name]) ? tables[name] : [];
      if (rows.length) {
        try {
          await this.bulkAddSafe(db[name], rows);
          console.log(`云端数据还原 ${name}: ${rows.length} 条`);
        } catch (e) {
          console.error(`还原 ${name} 失败:`, e);
        }
      }
    }
    await DataStore.markDataImported();
    return true;
  },

  // 打包全量数据并推送到云端（覆盖式），导入/重新导入后自动调用
  async pushAllToCloud() {
    if (typeof SyncManager === 'undefined' || !SyncManager.isOnline) return false;
    try {
      const tables = {};
      for (const name of this.TABLES) {
        tables[name] = await db[name].toArray();
      }
      const bundle = {
        version: DB_VERSION,
        savedAt: new Date().toISOString(),
        tables
      };
      const ok = await SyncManager.pushData(bundle);
      if (ok) console.log('已推送到云端，分享链接将自动更新');
      return ok;
    } catch (e) {
      console.error('打包推送失败:', e);
      return false;
    }
  },

  // 从 Excel 文件导入数据（首次启动，读取内置文件）
  async importFromExcel() {
    showLoading('正在读取 Excel 数据...');
    try {
      const response = await fetch(this.filePath);
      if (!response.ok) throw new Error('无法读取 Excel 文件');
      const arrayBuffer = await response.arrayBuffer();
      return await this.importFromArrayBuffer(arrayBuffer, '首次导入');
    } catch (err) {
      console.error('数据导入失败:', err);
      hideLoading();
      alert('数据导入失败: ' + err.message);
      return false;
    }
  },

  // 核心导入逻辑：解析 arrayBuffer 并写入数据库
  async importFromArrayBuffer(arrayBuffer, label = '导入') {
    showLoading('正在解析数据...');
    let workbook;
    try {
      workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    } catch (err) {
      throw new Error('文件解析失败，请确认是有效的 .xlsx / .xls 文件');
    }

    // 清空旧数据（等待事务完成）
    await DataStore.clearAll();
    await new Promise(r => setTimeout(r, 300));

    // 逐个导入工作表 - 每个独立 try-catch，失败不阻塞后续
    const tasks = [
      { name: '供应商', fn: () => this.loadSuppliers(workbook) },
      { name: '订单', fn: () => this.loadOrders(workbook) },
      { name: '入库', fn: () => this.loadInbound(workbook) },
      { name: '库存', fn: () => this.loadStock(workbook) },
      { name: '库存预警', fn: () => this.loadInventoryAlerts(workbook) },
      { name: '订货', fn: () => this.loadOrderChecks(workbook) },
      { name: '价格', fn: () => this.loadPricing(workbook) },
      { name: '低周转', fn: () => this.loadLowTurnover(workbook) },
      { name: '违约', fn: () => this.loadBreach(workbook) }
    ];

    for (const task of tasks) {
      try {
        showLoading(`正在导入${task.name}数据...`);
        await task.fn();
      } catch (err) {
        console.error(`${task.name}数据${label}失败:`, err);
        // 继续导入其他数据，不中断整体流程
      }
    }

    await DataStore.markDataImported();

    // 导入成功后推送云端（若已连接），分享链接将自动更新
    if (typeof SyncManager !== 'undefined' && SyncManager.isOnline) {
      try {
        await this.pushAllToCloud();
      } catch (e) {
        console.warn('云端推送失败（本地数据已导入）:', e);
      }
    }

    hideLoading();
    return true;
  },

  // 重新导入数据：支持上传 .xlsx / .xls 文件，或重新导入内置数据
  reimport() {
    // 若已有模态框打开则先关闭
    const modalOverlay = document.getElementById('modalOverlay');
    if (modalOverlay) modalOverlay.classList.remove('show');

    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    if (!modalBody || !modalTitle) return;

    modalTitle.textContent = '重新导入数据';
    modalBody.innerHTML = `
      <div style="max-width:420px;">
        <p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px;line-height:1.6;">
          支持 <b>.xlsx</b>、<b>.xls</b> 与 <b>.xlsm</b> 格式。可上传新的数据文件覆盖当前数据，或重新导入系统内置的数据。
        </p>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:12px;color:var(--text-secondary);margin-bottom:8px;">上传 Excel 文件（.xlsx / .xls / .xlsm）</label>
          <div class="file-input-wrapper">
            <input type="file" id="reimportFile" accept=".xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.ms-excel.sheet.macroEnabled.12"
              onchange="document.getElementById('reimportFileName').textContent=this.files[0]?this.files[0].name:'未选择文件'">
            <label for="reimportFile" class="file-input-label">📁 选择文件</label>
            <span id="reimportFileName" class="file-input-name">未选择文件</span>
          </div>
        </div>
        <div class="btn-group" style="border-top:none;margin-top:16px;padding-top:0;">
          <button onclick="document.getElementById('modalOverlay').classList.remove('show')" class="btn-secondary">取消</button>
          <button onclick="DataLoader.reimportFromDefault()" class="btn-secondary">🔄 重新导入内置数据</button>
          <button onclick="DataLoader.reimportFromFile()" class="btn-primary">📤 上传并导入</button>
        </div>
      </div>
    `;
    modalOverlay.classList.add('show');
  },

  // 从上传的文件导入
  async reimportFromFile() {
    const fileInput = document.getElementById('reimportFile');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
      alert('请先选择一个 .xlsx、.xls 或 .xlsm 文件');
      return;
    }
    const file = fileInput.files[0];
    const name = (file.name || '').toLowerCase();
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.xlsm')) {
      alert('仅支持 .xlsx、.xls 或 .xlsm 格式的文件');
      return;
    }
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ok = await this.importFromArrayBuffer(arrayBuffer, '文件导入');
      if (ok) {
        document.getElementById('modalOverlay').classList.remove('show');
        alert('数据导入成功！');
        // 刷新当前视图
        if (typeof App !== 'undefined' && App.currentModule) {
          App.go(App.currentModule);
        }
      }
    } catch (err) {
      console.error('文件导入失败:', err);
      hideLoading();
      alert('导入失败: ' + err.message);
    }
  },

  // 重新导入内置 Excel
  async reimportFromDefault() {
    try {
      const ok = await this.importFromExcel();
      if (ok) {
        document.getElementById('modalOverlay').classList.remove('show');
        alert('内置数据已重新导入！');
        if (typeof App !== 'undefined' && App.currentModule) {
          App.go(App.currentModule);
        }
      }
    } catch (err) {
      console.error('内置数据导入失败:', err);
      hideLoading();
      alert('导入失败: ' + err.message);
    }
  },

  // 解析工作表为对象数组（精确指定表头行）
  parseSheet(workbook, sheetName, headerRow = 1) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      console.warn(`工作表 ${sheetName} 不存在`);
      return [];
    }

    const json = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (json.length <= headerRow + 1) return [];

    const headers = json[headerRow].map(h => String(h || '').trim().replace(/\n/g, ''));
    const rows = [];

    for (let i = headerRow + 1; i < json.length; i++) {
      const row = json[i];
      if (!row || row.every(cell => cell === '' || cell === null || cell === undefined)) continue;

      const obj = {};
      headers.forEach((h, idx) => {
        if (h) {
          let val = row[idx];
          // 处理日期
          if (val instanceof Date) {
            obj[h] = val.toISOString().split('T')[0];
          } else {
            obj[h] = val;
          }
        }
      });

      // 只保留有有效数据的行
      const hasData = Object.values(obj).some(v => v !== '' && v !== null && v !== undefined);
      if (hasData) rows.push(obj);
    }

    return rows;
  },

  // 1. 供应商管理 (headerRow=1)
  async loadSuppliers(workbook) {
    showLoading('正在导入供应商数据...');
    const rows = this.parseSheet(workbook, '供应商管理', 1);
    const clean = rows.map(r => ({
      类型: r['类型'] || '',
      供应商: r['供应商'] || '',
      第一年度生效时间: this.parseDate(r['第一年度生效时间']),
      第二年度生效时间: this.parseDate(r['第二年度生效时间']),
      第三年度生效时间: this.parseDate(r['第三年度生效时间']),
      签订次数: this.parseNum(r['签订次数']),
      合同年限: this.parseNum(r['合同年限']),
      年度合同到期时间: this.parseDate(r['年度合同到期时间']),
      年度合同剩余时间: this.parseNum(r['年度合同剩余时间']),
      最终到期时间: this.parseDate(r['最终到期时间']),
      年度合同金额: this.parseNum(r['年度合同金额']),
      年度已供入库金额: this.parseNum(r['年度合同生效时间至2026-7-31已供入库金额'] || r['年度已供入库金额']),
      年度已供入库金额占比: this.parseNum(r['年度已供入库金额占比']),
      合同: r['合同'] || '',
      生产厂址: r['生产厂址'] || '',
      地址: r['地址'] || '',
      招采部门: r['招采部门'] || '',
      询价反馈时间: this.parseDate(r['询价反馈时间']),
      未入库金额: this.parseNum(r['未入库金额'])
    })).filter(r => r.供应商);

    await this.bulkAddSafe(db.suppliers, clean);
    console.log(`供应商数据导入完成: ${clean.length} 条`);
  },

  // 2. 采购订单列表 (headerRow=1)
  async loadOrders(workbook) {
    showLoading('正在导入订单数据...');
    const rows = this.parseSheet(workbook, '采购订单列表', 1);
    const clean = rows.map(r => ({
      序号: this.parseNum(r['序号']),
      订单编号: r['订单编号'] ? String(r['订单编号']) : '',
      日期: this.parseDate(r['日期']),
      项目名称: r['项目名称'] || '',
      供应商: r['供应商'] || '',
      存货编号: r['存货编号'] ? String(r['存货编号']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      数量: this.parseNum(r['数量']),
      未入库量: this.parseNum(r['未入库量']),
      累计入库数量: this.parseNum(r['累计入库数量']),
      原币含税单价: this.parseNum(r['原币含税单价']),
      原币价税合计: this.parseNum(r['原币价税合计']),
      项目大类名称: r['项目大类名称'] || '',
      制单人: r['制单人'] || '',
      行关闭人: r['行关闭人'] || '',
      审批状态: r['审批状态'] || '',
      来源订单号: r['来源订单号'] ? String(r['来源订单号']) : '',
      审核人: r['审核人'] || '',
      已下单时间: (r['已下单时间'] && r['已下单时间'] !== '0') ? this.parseDate(r['已下单时间']) : '',
      未入总金额: this.parseNum(r['未入总金额'])
    })).filter(r => r.订单编号);

    await this.bulkAddSafe(db.orders, clean);
    console.log(`订单数据导入完成: ${clean.length} 条`);
  },

  // 3. 入库列表 (headerRow=1)
  async loadInbound(workbook) {
    showLoading('正在导入入库数据...');
    const rows = this.parseSheet(workbook, '供货2023.9.1-新入库', 1);
    const clean = rows.map(r => ({
      序号: this.parseNum(r['序号']),
      表体订单号: r['表体订单号'] ? String(r['表体订单号']) : '',
      仓库: r['仓库'] || '',
      入库日期: this.parseDate(r['入库日期']),
      审核人: r['审核人'] || '',
      项目名称: r['项目名称'] || '',
      入库单号: r['入库单号'] ? String(r['入库单号']) : '',
      供应商: r['供应商'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      数量: this.parseNum(r['数量']),
      累计出库数量: this.parseNum(r['累计出库数量']),
      原币含税单价: this.parseNum(r['原币含税单价']),
      原币价税合计: this.parseNum(r['原币价税合计']),
      原币金额: this.parseNum(r['原币金额']),
      原币税额: this.parseNum(r['原币税额']),
      税率: this.parseNum(r['税率']),
      实际到货日期: this.parseDate(r['实际到货日期'])
    })).filter(r => r.入库单号 || r.存货名称);

    await this.bulkAddSafe(db.inbound, clean);
    console.log(`入库数据导入完成: ${clean.length} 条`);
  },

  // 4. 现存量 (headerRow=1)
  async loadStock(workbook) {
    showLoading('正在导入库存数据...');
    const rows = this.parseSheet(workbook, '中心库房现存量', 1);
    const clean = rows.map(r => ({
      仓库名称: r['仓库名称'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      现存数量: this.parseNum(r['现存数量']),
      数据更新时间: this.parseDate(r['数据更新时间']) || '2026-08-03'
    })).filter(r => r.存货编码 || r.存货名称);

    await this.bulkAddSafe(db.stock, clean);
    console.log(`库存数据导入完成: ${clean.length} 条`);
  },

  // 5. 库存预警 (headerRow=4)
  async loadInventoryAlerts(workbook) {
    showLoading('正在导入库存预警数据...');
    const rows = this.parseSheet(workbook, '库存预警数量', 4);
    const clean = rows.map(r => {
      const 现存量 = this.parseNum(r['2026-08-03现存量']);
      const 最低库存预警 = this.parseNum(r['最低库存预警']);
      const 在途订单 = this.parseNum(r['在途订单']);
      // 自动判定是否需补货：现存量低于最低库存预警
      let 是否需补货 = '';
      if (最低库存预警 > 0 && 现存量 < 最低库存预警) {
        是否需补货 = '是';
      } else if (r['是否需补货']) {
        是否需补货 = r['是否需补货'];
      }
      return {
        序号: this.parseNum(r['序号']),
        仓库名称: r['仓库名称'] || '',
        存货编码: r['存货编码'] ? String(r['存货编码']) : '',
        存货名称: r['存货名称'] || '',
        规格型号: r['规格型号'] ? String(r['规格型号']) : '',
        近一年月均入库量: this.parseNum(r['近一年月均入库量']),
        最低库存预警,
        最高库存: this.parseNum(r['最高库存']),
        现存量,
        是否需补货,
        在途订单,
        所上或库房: String(r['所上或库房'] || ''),
        工程项目: String(r['工程项目'] || ''),
        分类: r['分类'] || '',
        涉及订单号: r['涉及订单号'] ? String(r['涉及订单号']) : ''
      };
    }).filter(r => r.存货编码 || r.存货名称);

    await this.bulkAddSafe(db.inventoryAlerts, clean);
    console.log(`库存预警数据导入完成: ${clean.length} 条`);
  },

  // 6. 订货核对 (headerRow=2)
  async loadOrderChecks(workbook) {
    showLoading('正在导入订货数据...');
    const rows = this.parseSheet(workbook, '订货', 2);
    const clean = rows.map(r => ({
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      主计量: r['主计量'] || '',
      数量: this.parseNum(r['数量']),
      现存量: this.parseNum(r['2026-08-03现存量'] || r['现存量']),
      在途订单: this.parseNum(r['在途订单']),
      所上或库房: String(r['所上或库房'] || ''),
      工程项目: String(r['工程项目'] || ''),
      分类: r['分类'] || '',
      低周转: r['低周转'] || ''
    })).filter(r => r.存货编码 || r.存货名称);

    await this.bulkAddSafe(db.orderChecks, clean);
    console.log(`订货数据导入完成: ${clean.length} 条`);
  },

  // 7. 供应商价格 (headerRow=1)
  async loadPricing(workbook) {
    showLoading('正在导入价格数据...');
    const rows = this.parseSheet(workbook, '供应商价格', 1);
    const clean = rows.map(r => ({
      序号: this.parseNum(r['序号']),
      选择: r['选择'] || '',
      价格标识: r['价格标识'] || '',
      供应商: r['供应商'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      主计量: r['主计量'] || '',
      生效日期: this.parseDate(r['生效日期']),
      失效日期: this.parseDate(r['失效日期']),
      币种: r['币种'] || '',
      含税单价: this.parseNum(r['含税单价']),
      税率: this.parseNum(r['税率']),
      单价: this.parseNum(r['单价']),
      类型: r['类型'] || ''
    })).filter(r => r.供应商 && r.存货名称);

    await this.bulkAddSafe(db.pricing, clean);
    console.log(`价格数据导入完成: ${clean.length} 条`);
  },

  // 8. 低周转材料 (headerRow=2)
  async loadLowTurnover(workbook) {
    showLoading('正在导入低周转数据...');
    const rows = this.parseSheet(workbook, '低周转材料', 2);
    const clean = rows.map(r => ({
      仓库名称: r['仓库名称'] || '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      现存数量: this.parseNum(r['现存数量']),
      暂无法使用量: this.parseNum(r['暂无法使用量'])
    })).filter(r => r.存货编码 || r.存货名称);

    await this.bulkAddSafe(db.lowTurnover, clean);
    console.log(`低周转数据导入完成: ${clean.length} 条`);
  },

  // 9. 违约台账 (headerRow=2)
  async loadBreach(workbook) {
    showLoading('正在导入违约数据...');
    const rows = this.parseSheet(workbook, '违约台账', 2);
    const clean = rows.map(r => ({
      公司名称: r['公司名称'] || '',
      涉及订单号: r['涉及订单号'] ? String(r['涉及订单号']) : '',
      存货编码: r['存货编码'] ? String(r['存货编码']) : '',
      存货名称: r['存货名称'] || '',
      规格型号: r['规格型号'] ? String(r['规格型号']) : '',
      单价: this.parseNum(r['单价']),
      数量: this.parseNum(r['数量']),
      到货时间: this.parseDate(r['到货时间']),
      延迟天数: this.parseNum(r['延迟天数']),
      扣款金额: this.parseNum(r['扣款金额']),
      备注: r['备注'] || ''
    })).filter(r => r.公司名称);

    await this.bulkAddSafe(db.breach, clean);
    console.log(`违约数据导入完成: ${clean.length} 条`);
  },

  // 工具方法：解析数值
  parseNum(val) {
    if (val === '' || val === null || val === undefined) return 0;
    if (typeof val === 'number') return val;
    const parsed = parseFloat(String(val).replace(/,/g, ''));
    return isNaN(parsed) ? 0 : parsed;
  },

  // 工具方法：解析日期
  parseDate(val) {
    if (!val) return '';
    if (val instanceof Date) {
      return val.toISOString().split('T')[0];
    }
    const str = String(val).trim();
    if (!str) return '';
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
    return str;
  }
};

// 加载遮罩工具函数
function showLoading(text) {
  const overlay = document.getElementById('loadingOverlay');
  const textEl = document.getElementById('loadingText');
  if (overlay) overlay.style.display = 'flex';
  if (textEl) textEl.textContent = text || '加载中...';
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.style.display = 'none';
}