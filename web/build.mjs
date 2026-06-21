// Production build for the static site. Run from the web root (where the
// CodeMirror node_modules and the page sources live) with `esbuild` on PATH and
// MLIR_WASM_DIR pointing at the built wasm artifacts. Emits a self-contained,
// optimized bundle into ./dist:
//
//   - each page's JS (entry + editor + CodeMirror) is bundled, minified and
//     code-split into a shared chunk, with content-hashed filenames;
//   - styles.css is minified + content-hashed;
//   - the wasm loader/binary are copied in under content-hashed names;
//   - index.html / pdl.html are rewritten to reference the hashed assets;
//   - sw.js is stamped with the hashed wasm-bundle names + a cache version.
//
// Content hashing makes every asset safe to cache immutably: a changed file
// gets a new name, so updates are picked up without any cache-busting tricks.
// The only thing the service worker still caches is the multi-MB wasm bundle
// (see sw.js); the hashed names make that self-busting.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    readFileSync,
    writeFileSync,
    copyFileSync,
    mkdirSync,
    rmSync,
    readdirSync,
} from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const WASM_DIR = process.env.MLIR_WASM_DIR;
if (!WASM_DIR) throw new Error("MLIR_WASM_DIR is not set");

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. Bundle + minify the page JS. Code splitting factors the shared editor +
//    CodeMirror code into one chunk both pages import. The Emscripten loader is
//    kept external (copied in separately under a hashed name in step 3); its
//    URL string in the bundle is rewritten in step 4.
execFileSync(
    "esbuild",
    [
        "app.js",
        "pdl.js",
        "--bundle",
        "--minify",
        "--splitting",
        "--format=esm",
        "--platform=browser",
        "--entry-names=[name].[hash]",
        "--chunk-names=chunk.[hash]",
        "--external:./mlir-opt.mjs",
        `--outdir=${DIST}`,
        `--metafile=${DIST}/meta-js.json`,
    ],
    { stdio: "inherit" },
);

// 2. Minify + hash the stylesheet.
execFileSync(
    "esbuild",
    [
        "styles.css",
        "--bundle",
        "--minify",
        "--entry-names=[name].[hash]",
        `--outdir=${DIST}`,
        `--metafile=${DIST}/meta-css.json`,
    ],
    { stdio: "inherit" },
);

// Map an esbuild metafile back to the hashed output name for a given entry.
function outputFor(metaPath, entry) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    for (const [out, info] of Object.entries(meta.outputs)) {
        if (info.entryPoint === entry) return out.replace(`${DIST}/`, "");
    }
    throw new Error(`no bundled output for ${entry}`);
}
const appJs = outputFor(`${DIST}/meta-js.json`, "app.js");
const pdlJs = outputFor(`${DIST}/meta-js.json`, "pdl.js");
const cssOut = outputFor(`${DIST}/meta-css.json`, "styles.css");

// 3. Copy the wasm loader + binary in under content-hashed names.
const hash = (p) =>
    createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 8);
const mjsHash = hash(join(WASM_DIR, "mlir-opt.mjs"));
const wasmHash = hash(join(WASM_DIR, "mlir-opt.wasm"));
const mjsName = `mlir-opt.${mjsHash}.mjs`;
const wasmName = `mlir-opt.${wasmHash}.wasm`;
copyFileSync(join(WASM_DIR, "mlir-opt.mjs"), join(DIST, mjsName));
copyFileSync(join(WASM_DIR, "mlir-opt.wasm"), join(DIST, wasmName));

// 4. Point the bundled JS at the hashed wasm-bundle names. editor.js keeps the
//    Emscripten loader external and fetches the wasm by a literal relative URL,
//    so the un-hashed strings survive bundling/minification verbatim here. The
//    leading `./` is normalized with a regex because esbuild may rebase the
//    external import's path (e.g. to `../mlir-opt.mjs`) relative to the output
//    dir; every asset is served flat from the site root, so `./` is correct.
for (const f of readdirSync(DIST)) {
    if (!f.endsWith(".js")) continue;
    const p = join(DIST, f);
    const s = readFileSync(p, "utf8")
        .replace(/(?:\.\.?\/)+mlir-opt\.mjs/g, `./${mjsName}`)
        .replace(/(?:\.\.?\/)+mlir-opt\.wasm/g, `./${wasmName}`);
    writeFileSync(p, s);
}

// 5. Rewrite the HTML entry points to reference the hashed assets.
function writeHtml(file, srcScript, hashedScript) {
    const s = readFileSync(file, "utf8")
        .split("./styles.css")
        .join(`./${cssOut}`)
        .split(`./${srcScript}`)
        .join(`./${hashedScript}`);
    writeFileSync(join(DIST, file), s);
}
writeHtml("index.html", "app.js", appJs);
writeHtml("pdl.html", "pdl.js", pdlJs);

// 6. Stamp the service worker. The cache version is the wasm hash, so it only
//    changes when the wasm bundle does (a JS/HTML-only deploy leaves sw.js
//    byte-identical, so the SW never churns or re-downloads the binary).
const sw = readFileSync("sw.js", "utf8")
    .replaceAll("__MLIR_MJS_URL__", `./${mjsName}`)
    .replaceAll("__MLIR_WASM_URL__", `./${wasmName}`)
    .replaceAll("__BUILD_VERSION__", wasmHash);
writeFileSync(join(DIST, "sw.js"), sw);

// 7. Drop the metafiles; they're build-time only.
rmSync(`${DIST}/meta-js.json`);
rmSync(`${DIST}/meta-css.json`);

console.log(`built dist/: ${appJs}, ${pdlJs}, ${cssOut}, ${mjsName}, ${wasmName}`);
