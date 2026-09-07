#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
decrypt_bridge.py — 本机解密 Bridge 服务（WarehouseWorkbench 配套）

职责：
  - 常驻公司电脑本地（双击 start_bridge.bat 启动，cmd 窗口常驻），
    监听 127.0.0.1:<PORT>（默认 17821，端口被占自动 +1 探测下一个可用端口）。
  - 工作台网页上传加密 Excel 时，前端先 GET /health 探活，
    再 POST /decrypt 把加密文件交给我，我调同目录的 dump_one.py
    （用本机 WPS COM + 你的登录态免密打开）另存为无密码 xlsx 回传。

设计约束（来自《加密 Excel 自动解密_Bridge 方案存档》）：
  - dump_one.py 一字不改，仅以子进程 CLI 方式调用。
  - 不依赖任何第三方 web 框架，仅用标准库 http.server（你 Python 3.8 已自带）。
  - 解密能力锁在本机，凭据不出域。

调用 dump_one.py：
  python dump_one.py <加密文件路径>
  退出码：0=成功  1=打开/读取失败  2=参数错/文件不存在
  输出：<源文件同目录>/dump_out/<原名>_extracted.xlsx
"""
import sys
import os
import json
import shutil
import subprocess
import tempfile
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ============ 配置（如需改端口，改这里或启动时 --port，或设环境变量 BRIDGE_PORT）============
DEFAULT_PORT = int(os.environ.get("BRIDGE_PORT", "17821"))
HERE = os.path.dirname(os.path.abspath(__file__))
DUMP_SCRIPT = os.path.join(HERE, "dump_one.py")
PYTHON = sys.executable  # 用当前解释器，确保与 dump_one.py 的 pywin32/openpyxl 同环境
ALLOWED_EXT = {".xlsx", ".xls", ".xlsm"}  # 与 dump_one.py 支持的类型一致


def log(msg):
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def find_free_port(start):
    """从 start 起探测第一个可用端口（解决『17821 是否被占』的顾虑）。"""
    import socket
    for p in range(start, start + 100):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", p))
            s.close()
            return p
        except OSError:
            continue
    return None


def run_dump(src_path):
    """
    调用 dump_one.py 解密单个文件。
    返回 (ok, out_path_or_error)。
    输出约定：<源同目录>/dump_out/<原名>_extracted.xlsx
    """
    if not os.path.exists(DUMP_SCRIPT):
        return False, f"dump_one.py 未找到：{DUMP_SCRIPT}"
    if not os.path.exists(src_path):
        return False, f"源文件不存在：{src_path}"

    out_dir = os.path.join(os.path.dirname(src_path), "dump_out")
    base = os.path.splitext(os.path.basename(src_path))[0]
    expected = os.path.join(out_dir, base + "_extracted.xlsx")

    try:
        proc = subprocess.run(
            [PYTHON, DUMP_SCRIPT, src_path],
            capture_output=True, text=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        return False, "解密超时（>300s），请检查 WPS 是否卡在弹窗"
    except Exception as e:
        return False, f"调用 dump_one.py 异常：{e}"

    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-500:]
        return False, f"dump_one.py 退出码 {proc.returncode}：{tail}"

    if not os.path.exists(expected):
        # 以防 dump_one.py 改了输出命名（理论不会），回退扫描 dump_out 最新 xlsx
        if os.path.isdir(out_dir):
            xs = [f for f in os.listdir(out_dir) if f.endswith(".xlsx")]
            if xs:
                xs.sort(key=lambda f: os.path.getmtime(os.path.join(out_dir, f)), reverse=True)
                expected = os.path.join(out_dir, xs[0])
        if not os.path.exists(expected):
            return False, f"解密完成但未找到输出文件（期望 {expected}）"
    return True, expected


class Handler(BaseHTTPRequestHandler):
    # 安静日志（避免每个请求刷屏），仅关键事件打 log()
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, code, obj, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path, filename):
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type",
                         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition",
                         f'attachment; filename="{filename}"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/health", "/"):
            self._send_json(200, {"ok": True, "pid": os.getpid(),
                                   "dump": os.path.exists(DUMP_SCRIPT),
                                   "ts": datetime.datetime.now().isoformat()})
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/decrypt":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        # 仅接受本机来源（Bridge 不对外暴露）
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self._send_json(403, {"ok": False, "error": "only localhost"})
            return

        length = int(self.headers.get("Content-Length", 0))
        ctype = self.headers.get("Content-Type", "")

        tmp = tempfile.mkdtemp(prefix="bridge_")
        src_path = None
        try:
            if "multipart/form-data" in ctype:
                # 解析 multipart（标准库没有好用的 parser，手写一个最小实现）
                boundary = "--" + ctype.split("boundary=")[-1].strip().strip('"')
                raw = self.rfile.read(length)
                src_path = self._parse_multipart(raw, boundary, tmp)
            else:
                # 裸 body（application/octet-stream / 任意）直接存为上传名
                raw = self.rfile.read(length)
                fn = self.headers.get("X-Filename") or "upload.xlsx"
                src_path = os.path.join(tmp, os.path.basename(fn))
                with open(src_path, "wb") as f:
                    f.write(raw)

            if not src_path or not os.path.exists(src_path):
                self._send_json(400, {"ok": False, "error": "未收到文件"})
                return

            ext = os.path.splitext(src_path)[1].lower()
            if ext not in ALLOWED_EXT:
                self._send_json(400, {"ok": False,
                    "error": f"不支持的文件类型 {ext}，仅支持 {sorted(ALLOWED_EXT)}"})
                return

            log(f"收到解密请求：{os.path.basename(src_path)}")
            ok, result = run_dump(src_path)
            if not ok:
                log(f"解密失败：{result}")
                self._send_json(422, {"ok": False, "error": result})
                return

            out_name = os.path.basename(result)
            log(f"解密成功：{out_name}")
            self._send_file(result, out_name)
        except Exception as e:
            log(f"处理异常：{e}")
            self._send_json(500, {"ok": False, "error": str(e)})
        finally:
            # 清理临时上传目录（dump_out 在源同目录，保留给用户）
            try:
                if src_path and os.path.dirname(src_path) == tmp:
                    shutil.rmtree(tmp, ignore_errors=True)
            except Exception:
                pass

    def _parse_multipart(self, raw, boundary, tmp):
        """最小 multipart 解析（二进制安全）：取含 filename 的部件，返回保存路径。

        `boundary` 由调用方传入，已是完整分隔串（含前导 "--"，即 "--<boundary>"）。
        按该分隔字节精确切分，取头部含 filename 的片段；
        body = 该片段在首个 \\r\\n\\r\\n 之后的全部内容，再去掉结尾紧跟边界的 CRLF。
        """
        import re
        marker = boundary if isinstance(boundary, bytes) else boundary.encode()
        seps = [m.start() for m in re.finditer(re.escape(marker), raw)]
        for i in range(len(seps) - 1):
            seg = raw[seps[i]:seps[i + 1]]
            if b"filename=" not in seg:
                continue
            m = re.search(rb'filename="([^"]*)"', seg)
            if not m:
                continue
            fn = m.group(1).decode("utf-8", "ignore")
            hdr_end = seg.find(b"\r\n\r\n")
            if hdr_end < 0:
                continue
            body = seg[hdr_end + 4:]
            # 去掉结尾 CRLF（boundary 之前的分隔 CRLF）
            if body.endswith(b"\r\n"):
                body = body[:-2]
            elif body.endswith(b"\n"):
                body = body[:-1]
            dst = os.path.join(tmp, os.path.basename(fn) or "upload.xlsx")
            with open(dst, "wb") as f:
                f.write(body)
            return dst
        return None


def main():
    port = DEFAULT_PORT
    if "--port" in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index("--port") + 1])
        except Exception:
            pass

    free = find_free_port(port)
    if free is None:
        log("❌ 在 17821~18820 范围内未找到可用端口，请手动指定 --port")
        sys.exit(1)
    if free != port:
        log(f"⚠️ 默认端口 {port} 被占用，已自动改用 {free}（如需固定，请改 start_bridge.bat 的 --port 参数）")

    if not os.path.exists(DUMP_SCRIPT):
        log(f"❌ 同目录未找到 dump_one.py：{DUMP_SCRIPT}")
        sys.exit(1)

    server = ThreadingHTTPServer(("127.0.0.1", free), Handler)
    log(f"✅ 解密 Bridge 已启动：http://127.0.0.1:{free}")
    log(f"   存放 dump_one.py 的目录：{HERE}")
    log(f"   按 Ctrl+C 停止服务")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("服务已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
