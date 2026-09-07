# 加密 Excel 自动解密（本机 Bridge）方案 · 存档

> 状态：**可行性已论证完毕，待周一落地开发**。仓库：仓库工作台（WarehouseWorkbench）。
> 需求：上传公司加密 Excel 时，由工作台自动调用解密脚本复制出明文，再导入更新数据，省去手动解密步骤。

---

## 一、现有解密脚本画像（dump_one.py）

| 维度 | 结论 |
|---|---|
| 核心依赖 | `pywin32`(`win32com`) 调用本机 **WPS 表格 COM**（`Excel.Application` → 探测失败降级 `KET.Application`/`ET.Application`） |
| 解密原理 | **不是脚本解的密**。本机 WPS 能用当前用户凭据/域登录态直接打开加密文件，脚本借道 `Workbooks.Open` → `SaveAs(51)` 另存为无密码 xlsx |
| 输出 | 源文件同目录 `dump_out/<原名>_extracted.xlsx`（无密码纯 xlsx） |
| 保留内容 | 值、合并单元格、3 种边框、对齐+自动换行；**不保留**公式/条件格式/图表/宏/数据验证 |
| 后端选型 | fast path（COM SaveAs + openpyxl 批量复制）+ fallback（COM 逐格读再写，兼容 DLP 二次加密） |

---

## 二、可行性分级（基于"上传即解密"诉求）

| 能力 | 能否成立 | 原因 |
|---|---|---|
| 纯前端（浏览器 JS）解密 | ❌ | 浏览器无 COM / 无域凭据；`msoffcrypto`-WASM 需密码，而本场景免密（凭据型），故不通 |
| 远端后端服务（云/内网服务器） | ❌ 不推荐 | 解密依赖本机 WPS + 你的登录态，服务器拿不到；且合规/审计风险高 |
| **本机 Bridge 服务（公司电脑常驻）** | ✅ **唯一可行** | 脚本本体不变，Bridge 在你公司电脑本地调 WPS COM，凭据不出本机 |

---

## 三、落地方案（方案 B · 本机 Bridge）

**Bridge 服务（Python，约 60-80 行，监听 `localhost:17821`）**
```
POST /decrypt   收加密 .xlsx → 存临时目录 → 调 dump_one.py → 回传明文 xlsx
GET  /health    {"ok": true}（工作台探测 Bridge 是否在）
```

**工作台前端对接（上传 Excel 导入入口改造）**
```
用户选加密文件
  → fetch GET /health 探本机 Bridge
      ├─ 在  → POST /decrypt 拿明文 → 直接进现有导入流程（无感）
      └─ 不在 → 降级提示「请先运行解密助手」，提供 bat 一键启动 Bridge
```

**部署**
- `dump_one.py` + Bridge + `start_bridge.bat` 同目录；
- 开机启动项 / Windows 服务常驻，或用时双击 bat（cmd 常驻，与现在体验一致）。

---

## 四、待周一确认的要点（来自你上一轮答复）

| 项 | 现状 |
|---|---|
| 公司电脑 vs 用工作台电脑 | 同一台（网页部署，你在公司电脑浏览器打开） |
| WPS COM 具体 ProgID | 脚本自动探测 `Excel/KET/ET`，实际走 WPS（`KET.Application`） |
| 能否跑脚本 | 可运行（已验证）；dump_one.py 需 Python + pywin32 + openpyxl |
| Bridge 常驻接受度 | 待确认：开机自启常驻 / 用时双击 bat |

所需 Python 环境请届时确认 `python --version`（脚本依赖 pywin32 + openpyxl）。

---

## 五、结论

- **唯一可行路径 = 本机 Bridge 服务**（解密能力锁在公司电脑本地，凭据不出域）。
- `dump_one.py` **一字不改**，Bridge 仅将其从"手动双击"升级为"被服务调用"。
- 跨设备（其它电脑/在家）自动降级为「提示手动跑 bat」，不报错。

> 下一步（周一）：确认 Python 环境与部署形态后，产出 **Bridge 服务代码 + 工作台前端对接代码 + 部署说明**。
