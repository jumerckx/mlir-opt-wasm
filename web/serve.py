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

http.server.test(
    HandlerClass=http.server.SimpleHTTPRequestHandler,
    port=8000,
    bind="127.0.0.1",
)
