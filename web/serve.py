#!/usr/bin/env python3
# Tiny static server with the right MIME types for .mjs and .wasm.
#
# Usage:
#   nix build .#site
#   python3 web/serve.py result/
#
# Then open http://localhost:8000/.

import http.server
import mimetypes
import os
import sys

mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")

if len(sys.argv) > 1:
    os.chdir(sys.argv[1])

http.server.test(
    HandlerClass=http.server.SimpleHTTPRequestHandler,
    port=8000,
    bind="127.0.0.1",
)
