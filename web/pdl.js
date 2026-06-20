// PDL → pdl_interp lowering view. Demonstrates the two lowering flows from the
// `pdl` dialect to the executable `pdl_interp` dialect side by side:
//
//   direct:  convert-pdl-to-pdl-interp
//   match:   convert-pdl-to-match → match-combine-matchers
//                                 → convert-match-to-pdl-interp
//
// Every step is a separate in-process `mlir_opt_run` invocation; the output of
// one match-flow step is fed as input to the next. All editor/highlighting/wasm
// plumbing is shared with the mlir-opt demo via ./editor.js.

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
const statusEl = $("status");
const runEl = $("run");
const inputErr = $("input-err");

// Two patterns that differ only in op name and constant value, so
// `match-combine-matchers` has something meaningful to merge: it factors the
// shared prefix and emits a single `switch_op_name` decision tree.
const INITIAL_INPUT = `// Two similar patterns: x + 0 -> x and x * 1 -> x.
// The match flow combines their matchers; the direct flow keeps them separate.
pdl.pattern @addZero : benefit(1) {
  %t = pdl.type
  %a = pdl.operand : %t
  %c0 = pdl.attribute = 0 : i32
  %constOp = pdl.operation "arith.constant" {"value" = %c0} -> (%t : !pdl.type)
  %const = pdl.result 0 of %constOp
  %addOp = pdl.operation "arith.addi" (%a, %const : !pdl.value, !pdl.value) -> (%t : !pdl.type)
  pdl.rewrite %addOp {
    pdl.replace %addOp with (%a : !pdl.value)
  }
}

pdl.pattern @mulOne : benefit(1) {
  %t = pdl.type
  %a = pdl.operand : %t
  %c1 = pdl.attribute = 1 : i32
  %constOp = pdl.operation "arith.constant" {"value" = %c1} -> (%t : !pdl.type)
  %const = pdl.result 0 of %constOp
  %mulOp = pdl.operation "arith.muli" (%a, %const : !pdl.value, !pdl.value) -> (%t : !pdl.type)
  pdl.rewrite %mulOp {
    pdl.replace %mulOp with (%a : !pdl.value)
  }
}
`;

const inputView = makeEditor({
    parent: $("input-editor"),
    doc: INITIAL_INPUT,
    editable: true,
    onChange: () => applyHighlight(inputView, inputErr),
});

// Each output stage: a read-only editor plus its error element. Order is the
// order they're produced, so clearing/feeding downstream is straightforward.
const STAGES = [
    { id: "direct" },
    { id: "match1" },
    { id: "match2" },
    { id: "match3" },
];
for (const st of STAGES) {
    st.view = makeEditor({
        parent: $(`${st.id}-out`),
        doc: "",
        editable: false,
    });
    st.errEl = $(`${st.id}-err`);
    st.el = $(`${st.id}-out`).closest(".stage");
}
const stage = Object.fromEntries(STAGES.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Folding the two intermediate match stages. When both are collapsed the lane
// is short enough to compare its pdl_interp result directly against the direct
// lane's, so we align the two result panes top-to-top.

const flowsEl = document.querySelector(".flows");

// Push the higher result pane down so both pdl_interp results start at the same
// y — but only when both intermediate match stages are folded; otherwise leave
// the natural (taller) layout alone.
function syncResultAlignment() {
    stage.direct.el.style.marginTop = "";
    stage.match3.el.style.marginTop = "";
    const bothFolded =
        stage.match1.el.classList.contains("folded") &&
        stage.match2.el.classList.contains("folded");
    if (!bothFolded) return;
    const flowsTop = flowsEl.getBoundingClientRect().top;
    const dTop = stage.direct.el.getBoundingClientRect().top - flowsTop;
    const mTop = stage.match3.el.getBoundingClientRect().top - flowsTop;
    const diff = Math.round(mTop - dTop);
    if (diff > 0) stage.direct.el.style.marginTop = `${diff}px`;
    else if (diff < 0) stage.match3.el.style.marginTop = `${-diff}px`;
}

for (const id of ["match1", "match2"]) {
    const h3 = stage[id].el.querySelector("h3");
    h3.addEventListener("click", () => {
        stage[id].el.classList.toggle("folded");
        syncResultAlignment();
    });
}

// Editor heights change on re-run and on resize; keep the alignment in step.
window.addEventListener("resize", syncResultAlignment);

let mlirOptRun = () => null;

// Show a pass result in a stage. Returns the output text on success so the
// caller can feed it to the next match-flow step, or null on failure.
function setStage(st, res) {
    if (!res || !res.ok) {
        clearEditor(st.view, st.errEl);
        showError(st.errEl, res?.err || "pass failed");
        return null;
    }
    replaceDoc(st.view, res.text);
    applyHighlightOf(st.view, st.errEl, res, res.text);
    return res.text;
}

function run() {
    if (runEl.disabled) return;
    runEl.disabled = true;
    try {
        const input = inputView.state.doc.toString();
        applyHighlight(inputView, inputErr);

        // Start from a clean slate so a failure mid-chain doesn't leave stale
        // downstream output on screen.
        for (const st of STAGES) clearEditor(st.view, st.errEl);

        // Direct flow: a single pass.
        setStage(stage.direct, mlirOptRun(input, "--convert-pdl-to-pdl-interp"));

        // Match flow: three chained passes, each fed the previous output.
        const m1 = setStage(
            stage.match1,
            mlirOptRun(input, "--convert-pdl-to-match"),
        );
        if (m1 == null) return;
        const m2 = setStage(
            stage.match2,
            mlirOptRun(m1, "--match-combine-matchers"),
        );
        if (m2 == null) return;
        setStage(stage.match3, mlirOptRun(m2, "--convert-match-to-pdl-interp"));
    } finally {
        runEl.disabled = false;
        syncResultAlignment();
    }
}

// ---------------------------------------------------------------------------
// Wasm load. If anything fails the editors stay usable as plain text boxes.

try {
    const mlir = await loadMlir({ onLog: (s) => console.log(s) });
    mlirOptRun = mlir.mlirOptRun;
    statusEl.textContent = `Ready. mlir-opt.wasm: ${(mlir.byteLength / 1e6).toFixed(1)} MB.`;
    runEl.disabled = false;
    applyHighlight(inputView, inputErr);
    run(); // populate the diagram immediately with the default patterns
} catch (e) {
    statusEl.textContent =
        `Failed to load mlir-opt.wasm (${e?.message ?? e}). ` +
        `Editors still work as plain text boxes.`;
    runEl.disabled = true;
}

runEl.addEventListener("click", run);
