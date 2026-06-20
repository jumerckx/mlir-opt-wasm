// Service worker: precache the whole site (HTML, JS, CodeMirror bundle, and the
// mlir-opt.mjs/.wasm pair) so the playground loads instantly on repeat visits
// and works fully offline. Without this the multi-MB wasm bundle was refetched
// on every page load.
//
// VERSION is stamped by the Nix `site` derivation with a content hash of all
// assets (see flake.nix). Any rebuild that changes an asset changes this file,
// the browser notices the new bytes, installs a new SW, and the activate step
// below deletes the previous version's cache. That is what makes aggressive
// caching safe across rebuilds — no Date.now() cache-busting required.
const VERSION = "__BUILD_VERSION__";
const CACHE = `mlir-opt-${VERSION}`;

// Paths are relative to the SW's scope (the directory it is served from), which
// matches how the pages reference these same files.
const ASSETS = [
    "./",
    "./index.html",
    "./pdl.html",
    "./styles.css",
    "./app.js",
    "./pdl.js",
    "./editor.js",
    "./codemirror.js",
    "./mlir-opt.mjs",
    "./mlir-opt.wasm",
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches
            .open(CACHE)
            .then((c) => c.addAll(ASSETS))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((k) => k !== CACHE)
                        .map((k) => caches.delete(k)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

// Cache-first for same-origin GETs: serve from the cache when present (offline
// + no redownload), otherwise hit the network and stash the response so it is
// available next time. Cross-origin and non-GET requests fall through to the
// network untouched.
self.addEventListener("fetch", (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (req.method !== "GET" || url.origin !== self.location.origin) return;

    e.respondWith(
        caches.match(req).then(
            (hit) =>
                hit ||
                fetch(req).then((res) => {
                    if (res.ok) {
                        const copy = res.clone();
                        caches.open(CACHE).then((c) => c.put(req, copy));
                    }
                    return res;
                }),
        ),
    );
});
