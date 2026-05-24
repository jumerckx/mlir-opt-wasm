#!/usr/bin/env python3
# Tiny static server with the right MIME types for .mjs and .wasm.
#
# Usage:
#   nix build .#site
#   python3 web/serve.py          # defaults to ./result if present
#   python3 web/serve.py result/  # or pass an explicit directory
#
# Then open http://localhost:8000/.

import http.server
import mimetypes
import os
import sys

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

target = sys.argv[1] if len(sys.argv) > 1 else (
    "result" if os.path.isdir("result") else None
)
if target is None:
    sys.exit(
        "no directory given and ./result not found — run `nix build` first, "
        "or pass an explicit path"
    )
print(f"serving {os.path.abspath(target)}", file=sys.stderr)
os.chdir(target)


# Nix store mtimes are all 1970-01-01, so the default SimpleHTTPRequestHandler
# returns 304 Not Modified for every request after the first page load — even
# across rebuilds, the browser keeps serving the old mjs/wasm. Force a fresh
# fetch every time by adding no-cache response headers and ignoring any
# If-Modified-Since / If-None-Match the browser sends from an old cache entry.
class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def parse_request(self):
        ok = super().parse_request()
        if ok:
            for h in ("If-Modified-Since", "If-None-Match"):
                if h in self.headers:
                    del self.headers[h]
        return ok

    def send_response(self, *args, **kwargs):
        super().send_response(*args, **kwargs)
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

    def send_header(self, key, value):
        if key.lower() == "last-modified":
            return
        super().send_header(key, value)


http.server.test(
    HandlerClass=NoCacheHandler,
    port=8000,
    bind="127.0.0.1",
)
