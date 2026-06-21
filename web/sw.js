// Service worker: cache ONLY the wasm bundle — the Emscripten loader
// (mlir-opt.mjs) and the multi-MB binary (mlir-opt.wasm) — so that pair isn't
// refetched on every visit. Everything else (HTML, CSS, JS, the CodeMirror
// bundle) is left entirely to the network / the browser's normal HTTP cache,
// so site updates show up on the next load instead of being shadowed by a
// stale precache. This is the deliberate trade: aggressive caching only where
// it pays off (the big binary), normal freshness everywhere else.
//
// The asset names and VERSION are stamped by web/build.mjs at build time. The
// names are content-hashed, so they change exactly when the wasm bundle does: a
// JS/HTML-only deploy leaves this file byte-identical, the SW doesn't update,
// and nothing triggers a needless 62MB re-download. When the wasm does change,
// the new names install a new SW and `activate` drops the old cache so the
// fresh binary is fetched.
const VERSION = "__BUILD_VERSION__";
const CACHE = `mlir-opt-wasm-${VERSION}`;

// The loader and binary are generated together and must stay in lockstep, so
// they share one versioned cache and are precached as a unit. Stamped with the
// content-hashed filenames by the build.
const WASM_ASSETS = ["__MLIR_MJS_URL__", "__MLIR_WASM_URL__"];

// Only the wasm bundle is served from the cache. The site's bundled scripts are
// `.js`, so matching the `.mjs` loader and `.wasm` binary by extension is both
// hash-agnostic and can't catch anything else.
function isWasmAsset(url) {
    return url.pathname.endsWith(".wasm") || url.pathname.endsWith(".mjs");
}

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches
            .open(CACHE)
            .then((c) => c.addAll(WASM_ASSETS))
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

// Cache-first, but ONLY for the wasm bundle. Every other request is left
// untouched (no respondWith), so the browser handles it from the network /
// HTTP cache as usual and site updates are never shadowed by the SW.
self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin || !isWasmAsset(url)) return;

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
