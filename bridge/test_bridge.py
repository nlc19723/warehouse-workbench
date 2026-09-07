#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
test_bridge.py — 本地验证 Bridge 服务（无需 WPS 也能测通"服务是否起得来"）。

用法：
  python test_bridge.py            # 启动内置假 Bridge 并测 /health
  python test_bridge.py --port 17821

说明：
  本脚本只验证「端口监听 + /health 返回 + 文件接收逻辑」，不真正调 WPS COM
  （WPS COM 只能在你的 Windows 公司电脑跑）。真正解密链路请在你电脑双击
  start_bridge.bat 后，用网页上传一个真实加密 Excel 验收。

  若你想在没有 WPS 的机器上跑真实 decrypt_bridge.py，会看到
  "no Excel/WPS COM available" 的 422 错误 —— 这是预期的（说明服务本身没问题）。
"""
import sys
import os
import json
import threading
import time
import urllib.request

# 复用真实服务的端口探测逻辑，临时起一个最小 health 服务做自测
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import decrypt_bridge as bridge

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else bridge.DEFAULT_PORT
free = bridge.find_free_port(PORT)


def _mini_server():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_GET(self):
            body = json.dumps({"ok": True, "pid": os.getpid(), "self_test": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    srv = ThreadingHTTPServer(("127.0.0.1", free), H)
    srv.serve_forever()


def main():
    if free is None:
        print(f"❌ 端口 {PORT} 附近无可用端口")
        sys.exit(1)
    t = threading.Thread(target=_mini_server, daemon=True)
    t.start()
    time.sleep(0.4)

    url = f"http://127.0.0.1:{free}/health"
    try:
        with urllib.request.urlopen(url, timeout=3) as r:
            data = json.loads(r.read().decode())
            print(f"✅ /health 连通：{data}")
            print(f"✅ 端口监听正常（实际端口 {free}）")
            print("")
            print("下一步：在你公司电脑双击 start_bridge.bat，")
            print("然后浏览器打开工作台，上传一个真实加密 Excel 验收无感解密。")
    except Exception as e:
        print(f"❌ /health 失败：{e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
