#!/usr/bin/env python3
"""Local-only bridge from the Altana SDK to the host SOCKS proxy.

The SDK's Node 18 fetch implementation does not honor the host proxy settings.
This server forwards only JSON-RPC POST requests to the fixed Altana testnet
relay through the explicitly configured local SOCKS endpoint.
"""

from __future__ import annotations

import argparse
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


UPSTREAMS = {
    "altana": "https://testnet-relay.altana.network/",
    "bnb-rpc": "https://bsc-testnet-rpc.publicnode.com/",
}
MAX_BODY_BYTES = 1_048_576


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "AgoraAltanaRelay/1.0"

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path not in ("", "/"):
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.send_error(400, "invalid content length")
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_error(413, "request body outside allowed range")
            return

        body = self.rfile.read(length)
        command = [
            "curl",
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--max-time",
            "75",
            "--retry",
            "3",
            "--retry-all-errors",
            "--retry-delay",
            "1",
            "--header",
            "content-type: application/json",
            "--data-binary",
            "@-",
            self.server.upstream,  # type: ignore[attr-defined]
        ]
        if self.server.socks_proxy:  # type: ignore[attr-defined]
            command[1:1] = ["--socks5-hostname", self.server.socks_proxy]  # type: ignore[attr-defined]
        result = subprocess.run(
            command,
            input=body,
            capture_output=True,
            check=False,
            timeout=80,
        )
        if result.returncode != 0:
            self.send_error(502, "Altana relay upstream unavailable")
            return

        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(result.stdout)))
        self.end_headers()
        self.wfile.write(result.stdout)

    def log_message(self, _format: str, *_args: object) -> None:
        # JSON-RPC payloads may contain signatures; keep the bridge silent.
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--socks-proxy", default="127.0.0.1:1082")
    parser.add_argument("--direct", action="store_true", help="Use the host's direct curl network path")
    parser.add_argument("--target", choices=UPSTREAMS, default="altana")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), RelayHandler)
    server.socks_proxy = None if args.direct else args.socks_proxy  # type: ignore[attr-defined]
    server.upstream = UPSTREAMS[args.target]  # type: ignore[attr-defined]
    print(
        f"JSON-RPC bridge ({args.target}) listening on http://127.0.0.1:{args.port}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
