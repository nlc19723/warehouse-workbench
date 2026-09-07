# 解密 Bridge 部署说明（WarehouseWorkbench 配套）

本机解密服务，让你在公司电脑浏览器上传**公司加密 Excel** 时，工作台自动调本机 WPS 免密解密、无感导入，省去手动另存明文。

> 原理：加密依赖本机 WPS + 你的域登录态，浏览器/云端都没法解，所以必须一个**常驻你公司电脑本地**的小服务（Bridge）来调 WPS。凭据不出本机。

---

## 一、文件清单

```
bridge/
├── decrypt_bridge.py     ← Bridge 服务（纯标准库，无需额外 pip）
├── dump_one.py           ← 已有解密脚本（一字不改，Bridge 以子进程调用）
├── start_bridge.bat      ← 双击启动（Windows）
├── test_bridge.py        ← 本地自测 /health 是否通（可选）
└── README.md             ← 本文件
```

## 二、前提条件（你已确认）

- Windows + 已装 **WPS**（COM 探测会命中 `KET.Application`）
- **Python 3.8+**（脚本用 `python` 或 `py` 启动）
- 已装 `pywin32` + `openpyxl`（`pip show pywin32 openpyxl` 能看到即 OK）

## 三、启动（就一步）

1. 把整个 `bridge/` 目录拷到你公司电脑任意位置（**必须 dump_one.py 和 decrypt_bridge.py 同目录**）。
2. **双击 `start_bridge.bat`**。
3. 看到 `✅ 解密 Bridge 已启动：http://127.0.0.1:17821` 即成功。
   - 若提示 `17821 被占用，已自动改用 18xxx` 属正常，记下实际端口即可（或改 bat 里的 `--port` 固定）。
4. 窗口常驻，不要关。要停就按 `Ctrl+C` 或点窗口 X。

## 四、验证

启动后，浏览器/PowerShell 访问：

```
http://127.0.0.1:17821/health
```

返回 `{"ok": true, ...}` 即活。也可双击式运行：`python test_bridge.py`（只测端口+health，不调 WPS）。

## 五、工作台怎么用（前端对接上线后）

1. 工作台导入入口选一个**加密 .xlsx**。
2. 网页自动 `GET /health` 探活：
   - **活** → 自动 `POST /decrypt` 拿明文 → 直接进入原导入流程（你无感）。
   - **不活**（Bridge 没开 / 其他设备）→ 弹提示「请先双击 start_bridge.bat」，并附下载入口。
3. 解密失败（如 WPS 卡弹窗、文件损坏）→ 提示具体原因，不静默丢文件。

## 六、端口冲突怎么办

默认 `17821`。被占用时 Bridge 会**自动 +1 探测下一个可用端口**并打日志，无需你处理。
若想固定端口：编辑 `start_bridge.bat` 末尾 `decrypt_bridge.py --port 17821` 改成你要的端口。

## 七、跨设备说明

在家里 / 其他电脑打开工作台时，本机没有 Bridge（也没 WPS 凭据）→ 自动降级为「提示运行解密助手」，不报错。功能无损，只是那台机器上需要手动先在本机解密。

## 八、排错

| 现象 | 原因 | 处理 |
|------|------|------|
| bat 一闪而过 | 没装 Python / 不在 PATH | 装 Python 3.8+ 并勾选"Add to PATH" |
| `未找到 dump_one.py` | 两者不同目录 | 确保 dump_one.py 和 decrypt_bridge.py 同目录 |
| /health 返回但解密 422 | WPS 未装 / COM 异常 | 确认 WPS 能正常打开该加密文件 |
| `no Excel/WPS COM available` | 没 WPS 或 COM 被禁用 | 安装/修复 WPS |
