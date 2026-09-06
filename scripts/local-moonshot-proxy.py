"""Loopback-only curl bridge for the local Node TLS connectivity issue."""
import json
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        size = int(self.headers.get("content-length", "0"))
        if not 0 < size <= 1_048_576:
            self.send_error(413)
            return
        authorization = self.headers.get("authorization", "")
        if not authorization.startswith("Bearer "):
            self.send_error(401)
            return
        body = self.rfile.read(size).decode("utf-8")
        # Credentials and task content travel on stdin, never argv or logs.
        config = "\n".join([
            'url = "https://api.moonshot.cn/v1/chat/completions"',
            "header = " + json.dumps("Authorization: " + authorization),
            'header = "Content-Type: application/json"',
            "data = " + json.dumps(body, ensure_ascii=False),
        ])
        try:
            result = subprocess.run(
                ["curl", "-sS", "--max-time", "300", "--config", "-", "--write-out", "\n%{http_code}"],
                input=config.encode(), capture_output=True, timeout=310,
            )
            if result.returncode:
                self.send_error(502, "Model upstream connection failed")
                return
            payload, status = result.stdout.rsplit(b"\n", 1)
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            self.send_error(502, "Model upstream unavailable")

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    print("Local Moonshot bridge listening on 127.0.0.1:8768", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8768), Handler).serve_forever()
