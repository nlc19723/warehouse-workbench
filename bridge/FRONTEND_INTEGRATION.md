# 工作台前端对接示意（解密 Bridge · 第二轮）

> 本文件是**对接参考**，不是直接可并入的代码。待确认「导入 Excel 入口」所在文件后，
> 再把它改成正式补丁并入 `js/`。本机 Bridge 服务本身（`decrypt_bridge.py` + `start_bridge.bat`）
> 已可独立运行验收。

## 一、交互流程

```
用户选加密 .xlsx
  → fetch GET http://127.0.0.1:17821/health   （约 800ms 超时）
      ├─ 活（ok=true）
      │     → fetch POST /decrypt（multipart，字段名 file = 选中的加密文件）
      │     → 拿到明文 xlsx blob
      │     → 直接喂给现有「导入解析」流程（无感）
      └─ 不活（连接失败 / 超时 / ok=false）
            → 弹提示：「本机未运行解密助手，请先双击 start_bridge.bat」
            → 附「下载 Bridge 套件」按钮（下载 bridge.zip）
```

## 二、核心代码骨架（可直接套进导入入口）

```javascript
const BRIDGE_BASE = 'http://127.0.0.1:17821';

// 探测本机 Bridge 是否存活（跨设备/未运行都会走到 reject）
async function bridgeAlive() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 800);
  try {
    const r = await fetch(BRIDGE_BASE + '/health', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    return !!j.ok;
  } catch (e) {
    clearTimeout(t);
    return false;
  }
}

// 调 Bridge 解密，返回明文 File（失败抛错）
async function bridgeDecrypt(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(BRIDGE_BASE + '/decrypt', { method: 'POST', body: fd });
  if (!r.ok) {
    let msg = '解密失败';
    try { msg = (await r.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  const blob = await r.blob();
  const outName = (file.name || 'sheet.xlsx').replace(/\.xlsx?$/i, '') + '_extracted.xlsx';
  return new File([blob], outName, { type: blob.type });
}

// 在「选文件 → 导入」的入口里包裹一层：
async function onPickExcel(file) {
  // 仅对 xlsx/xls/xlsm 走 Bridge 探测
  if (!/\.(xlsx|xls|xlsm)$/i.test(file.name)) return feedImportDirectly(file);

  const alive = await bridgeAlive();
  if (!alive) {
    if (confirm('本机未运行解密助手，无法自动解密加密 Excel。\n\n是否下载并运行 Bridge 启动套件？')) {
      // 触发下载 bridge.zip（由发布流程把 bridge/ 打成 zip 放到站点可下载路径）
      window.location.href = 'bridge/bridge.zip';
    }
    return;  // 不阻塞：用户可选择手动先解密
  }
  try {
    const plain = await bridgeDecrypt(file);
    feedImportDirectly(plain);   // ← 进入现有导入解析流程
  } catch (e) {
    alert('自动解密失败：' + e.message + '\n请确认本机 WPS 能正常打开该文件，或手动解密后重试。');
  }
}
```

## 三、需要你确认的点（决定正式补丁怎么写）

1. **导入 Excel 的入口在哪个文件/函数？** 现有导入走的是「出库列表导入」还是独立「数据导入」模块？
   确认后我把 `onPickExcel` 包进对应 `change`/`drop` 监听。
2. **现有「导入解析」入口函数名是什么？** 上面 `feedImportDirectly(file)` 需要替换成真实函数
   （通常是把 File → 读 arraybuffer → 解析行 → 落库那一段）。
3. **bridge.zip 放哪下载？** 我建议发布时把 `bridge/` 目录打成 `bridge/bridge.zip` 并放站点根，
   前端 `window.location.href='bridge/bridge.zip'` 直接下载。

## 四、验收口径

- 公司电脑双击 bat → 浏览器上传加密 xlsx → 无感导入（用户不感知解密过程）
- 其他设备 / Bridge 没开 → 弹提示 + 下载入口，不报错崩溃
- 解密失败（WPS 卡弹窗 / 文件损坏）→ 提示具体原因，原文件不丢
