// mlir-opt demo page. Two panes (editable input, read-only output) driven by
// the in-process `mlir_opt_run` entry point. All the editor/highlighting/wasm
// plumbing lives in ./editor.js and is shared with the PDL lowering page.

import {
    makeEditor,
    applyHighlight,
    applyHighlightOf,
    showError,
    replaceDoc,
    clearEditor,
    loadMlir,
} from "./editor.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");
const runEl = $("run");
const inputErr = $("input-err");
const outputErr = $("output-err");

const log = (s) => {
    logEl.textContent += s + "\n";
    logEl.scrollTop = logEl.scrollHeight;
};

// ---------------------------------------------------------------------------
// Editors.

const INITIAL_INPUT = `func.func @demo(%a: i32) -> i32 {
  %c0 = arith.constant 0 : i32
  %0 = arith.addi %a, %c0 : i32
  %1 = arith.addi %a, %c0 : i32
  %2 = arith.addi %0, %1 : i32
  return %2 : i32
}
`;

const inputView = makeEditor({
    parent: $("input-editor"),
    doc: INITIAL_INPUT,
    editable: true,
    onChange: () => applyHighlight(inputView, inputErr),
});

const outputView = makeEditor({
    parent: $("output-editor"),
    doc: "",
    editable: false,
});

// ---------------------------------------------------------------------------
// Wasm load. If anything fails the editors stay usable as plain text boxes.

let mlirOptRun = () => null;

try {
    const mlir = await loadMlir({ onLog: log });
    mlirOptRun = mlir.mlirOptRun;
    statusEl.textContent = `Ready. mlir-opt.wasm: ${(mlir.byteLength / 1e6).toFixed(1)} MB.`;
    runEl.disabled = false;
    applyHighlight(inputView, inputErr);
} catch (e) {
    statusEl.textContent =
        `Failed to load mlir-opt.wasm (${e?.message ?? e}). ` +
        `Editors still work as plain text boxes.`;
    runEl.disabled = true;
}

// ---------------------------------------------------------------------------
// Run.

async function run() {
    runEl.disabled = true;
    logEl.textContent = "";
    clearEditor(outputView, outputErr);
    const t0 = performance.now();

    // Drive the pipeline in-process via `mlir_opt_run`. The user's args (e.g.
    // --mlir-print-debuginfo, --canonicalize) decide both the pass pipeline
    // and whether the printed output carries loc(...) annotations. Cross-pane
    // linking is sourced from the in-memory module's Locations, so it keeps
    // working regardless of the debug-info preference.
    const args = $("args").value;
    const parsed = mlirOptRun(inputView.state.doc.toString(), args);

    if (!parsed || !parsed.ok) {
        showError(outputErr, parsed?.err || "opt run failed");
    } else {
        replaceDoc(outputView, parsed.text);
        applyHighlightOf(outputView, outputErr, parsed, parsed.text);
    }
    log(`(${(performance.now() - t0).toFixed(0)} ms)`);
    runEl.disabled = false;
}

runEl.addEventListener("click", run);
