// MLIR demo editor. The text editors are CodeMirror 6 instances; we drive
// styling from the wasm-side `mlir_highlight` parser via Decoration.mark.

// All CodeMirror symbols come from the locally bundled ESM file produced by
// the `codemirror-bundle` Nix derivation. Single module instance, no CDN.
import {
  EditorState,
  StateField,
  StateEffect,
  RangeSetBuilder,
  EditorView,
  Decoration,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  history,
  defaultKeymap,
  historyKeymap,
  indentWithTab,
  indentUnit,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "./codemirror.js";

// A compact "basic setup" assembled from the four sub-packages we already
// pull in. Avoids the `codemirror` umbrella, which would drag autocomplete /
// search / lint in and make the dep graph harder to dedupe.
const basicSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  bracketMatching(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
];

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

function showError(errEl, message) {
  if (message) {
    errEl.textContent = message;
    errEl.classList.add("shown");
  } else {
    errEl.textContent = "";
    errEl.classList.remove("shown");
  }
}

// ---------------------------------------------------------------------------
// Highlight pipeline.

// SMLoc offsets from the parser are byte offsets into a UTF-8 encoding of the
// text, but our editor talks UTF-16. Build a byte → char index map. Most MLIR
// is ASCII so this is normally 1:1.
function buildByteToChar(text) {
  const map = new Array(text.length + 1);
  let bi = 0;
  for (let ci = 0; ci < text.length; ci++) {
    const code = text.charCodeAt(ci);
    let bytes;
    if (code < 0x80) bytes = 1;
    else if (code < 0x800) bytes = 2;
    else if ((code & 0xfc00) === 0xd800) {
      bytes = 4;
      ci++; // skip the low surrogate
    } else bytes = 3;
    for (let b = 0; b < bytes; b++) map[bi + b] = ci;
    bi += bytes;
  }
  map[bi] = text.length;
  return map;
}

// CodeMirror plumbing for "swap the current decoration set". Decorations
// already in the field are remapped through document changes automatically,
// so a stale set still tracks the right text positions until we replace it.
const setHighlights = StateEffect.define();
const highlightField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHighlights)) return e.value;
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function buildDecorations(text, parsed, activated) {
  if (!parsed || !parsed.ok || !parsed.spans) return Decoration.none;
  const byteToChar = buildByteToChar(text);
  const charLen = text.length;
  const at = (b) =>
    b <= 0 ? 0 : b >= byteToChar.length ? charLen : byteToChar[b];

  const decos = parsed.spans
    .map((sp) => ({ s: at(sp.s), e: at(sp.e), k: sp.k, i: sp.i }))
    .filter((d) => d.e > d.s && d.s < charLen)
    .sort((a, b) => a.s - b.s || a.e - b.e);

  const builder = new RangeSetBuilder();
  let lastEnd = 0;
  for (const d of decos) {
    if (d.s < lastEnd) continue; // skip overlapping spans
    const attrs = {};
    if (d.i != null) attrs["data-vid"] = String(d.i);
    if (
      (d.k === "val-def" || d.k === "val-use") &&
      d.i != null &&
      activated &&
      activated.has(String(d.i))
    ) {
      const hue = (d.i * 137.508) % 360;
      attrs.style = `color: hsl(${hue.toFixed(0)}, 65%, 48%)`;
    }
    builder.add(
      d.s,
      d.e,
      Decoration.mark({ class: `tk-${d.k}`, attributes: attrs }),
    );
    lastEnd = d.e;
  }
  return builder.finish();
}

// Bound after the wasm highlighter is initialised; until then it's a no-op so
// the editors stay usable as plain text boxes.
let highlight = () => null;

// Per-view click state: which value ids the user has activated (clicked) and
// a cache of the last parse so a click can rebuild decorations without
// re-running the wasm highlighter.
const viewState = new WeakMap();
function stateFor(view) {
  let s = viewState.get(view);
  if (!s) {
    s = { activated: new Set(), text: "", parsed: null };
    viewState.set(view, s);
  }
  return s;
}

function applyHighlight(view, errEl) {
  const text = view.state.doc.toString();
  const parsed = highlight(text);
  const s = stateFor(view);
  s.text = text;
  s.parsed = parsed;
  if (parsed && !parsed.ok) {
    view.dispatch({ effects: setHighlights.of(Decoration.none) });
    showError(errEl, parsed.err || "parse failed");
    return;
  }
  view.dispatch({
    effects: setHighlights.of(buildDecorations(text, parsed, s.activated)),
  });
  showError(errEl, null);
}

function refreshDecorations(view) {
  const s = stateFor(view);
  if (!s.parsed || !s.parsed.ok) return;
  view.dispatch({
    effects: setHighlights.of(buildDecorations(s.text, s.parsed, s.activated)),
  });
}

// ---------------------------------------------------------------------------
// Hover: highlight every span sharing a data-vid with the one under the
// pointer. Lives directly on the editor's contentDOM so CodeMirror's own
// re-rendering doesn't trip it up.

function wireValueHover(view) {
  let lastVid = null;
  const dom = view.contentDOM;
  dom.addEventListener("mousemove", (e) => {
    const t = e.target.closest("[data-vid]");
    const vid = t ? t.dataset.vid : null;
    if (vid === lastVid) return;
    if (lastVid != null) {
      dom.querySelectorAll(".vhl").forEach((n) => n.classList.remove("vhl"));
    }
    if (vid != null) {
      dom
        .querySelectorAll(`[data-vid="${vid}"]`)
        .forEach((n) => n.classList.add("vhl"));
    }
    lastVid = vid;
  });
  dom.addEventListener("mouseleave", () => {
    dom.querySelectorAll(".vhl").forEach((n) => n.classList.remove("vhl"));
    lastVid = null;
  });
  // Click a value to toggle its persistent color. Cursor positioning still
  // happens; we just rebuild decorations with the updated activated set.
  dom.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    const t = e.target.closest("[data-vid]");
    if (!t) return;
    const vid = t.dataset.vid;
    const s = stateFor(view);
    if (s.activated.has(vid)) s.activated.delete(vid);
    else s.activated.add(vid);
    refreshDecorations(view);
  });
}

// ---------------------------------------------------------------------------
// Editor construction.

const INITIAL_INPUT = `func.func @demo(%a: i32) -> i32 {
  %c0 = arith.constant 0 : i32
  %0 = arith.addi %a, %c0 : i32
  %1 = arith.addi %a, %c0 : i32
  %2 = arith.addi %0, %1 : i32
  return %2 : i32
}
`;

function makeEditor({ parent, doc, editable, onChange }) {
  const extensions = [
    basicSetup,
    indentUnit.of("  "),
    EditorView.lineWrapping,
    highlightField,
  ];
  if (editable) {
    extensions.push(keymap.of([indentWithTab]));
  } else {
    extensions.push(EditorState.readOnly.of(true));
  }
  if (onChange) {
    let debounce = null;
    extensions.push(
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        clearTimeout(debounce);
        debounce = setTimeout(onChange, 250);
      }),
    );
  }
  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  });
  wireValueHover(view);
  return view;
}

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

let wasmModule = null;
let runnerInstantiate = null;

try {
  const { default: MlirOpt } = await import("./mlir-opt.mjs");
  const res = await fetch("./mlir-opt.wasm");
  if (!res.ok) throw new Error(`fetch mlir-opt.wasm: HTTP ${res.status}`);
  const wasmBytes = await res.arrayBuffer();
  wasmModule = await WebAssembly.compile(wasmBytes);

  runnerInstantiate = () =>
    MlirOpt({
      noInitialRun: true,
      print: log,
      printErr: log,
      instantiateWasm(imports, callback) {
        WebAssembly.instantiate(wasmModule, imports).then((inst) =>
          callback(inst),
        );
      },
    });

  // Persistent highlighter instance: never calls _main, so the runtime stays
  // alive and `_mlir_highlight` can be re-entered as often as we like.
  const hlMod = await MlirOpt({
    noInitialRun: true,
    print: () => {},
    printErr: () => {},
    instantiateWasm(imports, callback) {
      WebAssembly.instantiate(wasmModule, imports).then((inst) =>
        callback(inst),
      );
    },
  });

  highlight = (text) => {
    try {
      const ptr = hlMod.ccall("mlir_highlight", "number", ["string"], [text]);
      if (!ptr) return { ok: false, err: "highlighter returned null" };
      try {
        return JSON.parse(hlMod.UTF8ToString(ptr));
      } finally {
        hlMod._free(ptr);
      }
    } catch (e) {
      return { ok: false, err: "highlighter threw: " + (e?.message ?? e) };
    }
  };

  statusEl.textContent = `Ready. mlir-opt.wasm: ${(wasmBytes.byteLength / 1e6).toFixed(1)} MB.`;
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

function replaceOutputDoc(text) {
  outputView.dispatch({
    changes: { from: 0, to: outputView.state.doc.length, insert: text },
  });
}

function setOutput(text) {
  replaceOutputDoc(text || "");
  if (!text) {
    outputView.dispatch({ effects: setHighlights.of(Decoration.none) });
    showError(outputErr, null);
    return;
  }
  applyHighlight(outputView, outputErr);
}

async function run() {
  if (!runnerInstantiate) return;
  runEl.disabled = true;
  logEl.textContent = "";
  setOutput("");
  const t0 = performance.now();

  const mod = await runnerInstantiate();
  mod.FS.writeFile("/input.mlir", inputView.state.doc.toString());

  const args = $("args").value.split(/\s+/).filter(Boolean);
  let rc = "?";
  try {
    rc = mod.callMain([...args, "/input.mlir", "-o", "/output.mlir"]);
  } catch (e) {
    log("[exception] " + (e?.message ?? e));
  }

  let outText = "";
  try {
    outText = mod.FS.readFile("/output.mlir", { encoding: "utf8" });
  } catch (e) {
    log("[no output file] " + (e?.message ?? e));
  }

  setOutput(outText);
  log(`exit=${rc} (${(performance.now() - t0).toFixed(0)} ms)`);
  runEl.disabled = false;
}

runEl.addEventListener("click", run);
