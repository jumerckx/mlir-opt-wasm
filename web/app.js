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

// Separate field for whole-line backgrounds used by the cross-pane op linker.
// Kept apart from the mark-decoration field above because line decorations
// need to be added in line-start order, which the highlighter spans aren't.
const setOpLines = StateEffect.define();
const opLineField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setOpLines)) return e.value;
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
    .map((sp) => ({ s: at(sp.s), e: at(sp.e), k: sp.k, i: sp.i, loc: sp.loc }))
    .filter((d) => d.e > d.s && d.s < charLen)
    .sort((a, b) => a.s - b.s || a.e - b.e);

  const builder = new RangeSetBuilder();
  let lastEnd = 0;
  for (const d of decos) {
    if (d.s < lastEnd) continue; // skip overlapping spans
    const attrs = {};
    if (d.i != null) attrs["data-vid"] = String(d.i);
    if (d.k === "op" && d.loc && d.loc.length) {
      // Serialise as a |-separated list; data attributes carry strings only
      // and this stays cheap to split on click.
      attrs["data-loc"] = d.loc.join("|");
    }
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
let mlirOptRun = () => null;

// Per-view state. `activated` tracks SSA-value vids the user clicked (for
// per-value colouring); `text`/`parsed` cache the last successful parse so
// click handlers can rebuild decorations without re-running wasm.
const viewState = new WeakMap();
function stateFor(view) {
  let s = viewState.get(view);
  if (!s) {
    s = { activated: new Set(), text: "", parsed: null };
    viewState.set(view, s);
  }
  return s;
}

function applyHighlightOf(view, errEl, parsed, text) {
  const s = stateFor(view);
  s.text = text;
  s.parsed = parsed;
  if (parsed && !parsed.ok) {
    view.dispatch({
      effects: [
        setHighlights.of(Decoration.none),
        setOpLines.of(Decoration.none),
      ],
    });
    showError(errEl, parsed.err || "parse failed");
    return;
  }
  view.dispatch({
    effects: [
      setHighlights.of(buildDecorations(text, parsed, s.activated)),
      setOpLines.of(buildOpLineDecorations(view, text, parsed)),
    ],
  });
  showError(errEl, null);
}

function applyHighlight(view, errEl) {
  const text = view.state.doc.toString();
  applyHighlightOf(view, errEl, highlight(text), text);
}

function refreshDecorations(view) {
  const s = stateFor(view);
  if (!s.parsed || !s.parsed.ok) return;
  view.dispatch({
    effects: [
      setHighlights.of(buildDecorations(s.text, s.parsed, s.activated)),
      setOpLines.of(buildOpLineDecorations(view, s.text, s.parsed)),
    ],
  });
}

// ---------------------------------------------------------------------------
// Cross-pane op linking. Clicking an op in either editor toggles a shared
// activation keyed by that op's source-location set; every op in either pane
// that shares at least one key gets a whole-line background in a colour
// derived from the activation. Many-to-one and one-to-many fall out naturally
// because each op may carry multiple location keys (FusedLoc) and each
// activation may carry multiple keys.

// Module-level state shared by both editors.
const linkActivations = new Map(); // signature -> { keys: string[], hue: number }
let nextLinkHueIdx = 0;
const linkedViews = []; // views participating in linking

function nextLinkHue() {
  return ((nextLinkHueIdx++) * 137.508) % 360;
}

// For a given op-span (kind === "op" with non-empty loc), pick a colour by
// scanning every active activation. We return the colour of the *first*
// activation whose key set overlaps; multi-colour overlap is rare and not
// worth the visual noise of a gradient.
function colorForLocs(locs) {
  for (const { keys, hue } of linkActivations.values()) {
    for (const k of locs) {
      if (keys.includes(k)) return hue;
    }
  }
  return null;
}

function buildOpLineDecorations(view, text, parsed) {
  if (!parsed || !parsed.ok || !parsed.spans) return Decoration.none;
  if (linkActivations.size === 0) return Decoration.none;

  const byteToChar = buildByteToChar(text);
  const charLen = text.length;
  const at = (b) =>
    b <= 0 ? 0 : b >= byteToChar.length ? charLen : byteToChar[b];

  // Map lineStart → hue. First op on a line wins if multiple ops share
  // the line (rare, but possible with terse IR).
  const byLine = new Map();
  for (const sp of parsed.spans) {
    if (sp.k !== "op" || !sp.loc || sp.loc.length === 0) continue;
    const hue = colorForLocs(sp.loc);
    if (hue == null) continue;
    const ch = at(sp.s);
    if (ch >= charLen) continue;
    const line = view.state.doc.lineAt(ch);
    if (!byLine.has(line.from)) byLine.set(line.from, hue);
  }

  if (byLine.size === 0) return Decoration.none;
  const sorted = [...byLine.entries()].sort((a, b) => a[0] - b[0]);
  const builder = new RangeSetBuilder();
  for (const [from, hue] of sorted) {
    builder.add(
      from,
      from,
      Decoration.line({
        attributes: {
          style: `background-color: hsla(${hue.toFixed(0)}, 70%, 55%, 0.18)`,
        },
      }),
    );
  }
  return builder.finish();
}

function refreshAllOpLines() {
  for (const view of linkedViews) {
    const s = stateFor(view);
    if (!s.parsed || !s.parsed.ok) continue;
    view.dispatch({
      effects: setOpLines.of(buildOpLineDecorations(view, s.text, s.parsed)),
    });
  }
}

function toggleLocLink(locs) {
  if (!locs || locs.length === 0) return;
  const sig = [...locs].sort().join("|");
  if (linkActivations.has(sig)) linkActivations.delete(sig);
  else linkActivations.set(sig, { keys: [...locs], hue: nextLinkHue() });
  refreshAllOpLines();
}

// ---------------------------------------------------------------------------
// Hover: highlight every span sharing a data-vid with the one under the
// pointer. Lives directly on the editor's contentDOM so CodeMirror's own
// re-rendering doesn't trip it up.

function wireInteractions(view) {
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
  // Click handling: an op-name click toggles cross-pane line linking; a
  // value click toggles a persistent per-value colour. Op linking takes
  // priority when the click happened on a span that carries both (it
  // shouldn't in practice — op names and SSA values are disjoint).
  dom.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    const tloc = e.target.closest("[data-loc]");
    if (tloc) {
      const locs = tloc.dataset.loc.split("|").filter(Boolean);
      toggleLocLink(locs);
      return;
    }
    const tvid = e.target.closest("[data-vid]");
    if (!tvid) return;
    const vid = tvid.dataset.vid;
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
    opLineField,
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
  wireInteractions(view);
  linkedViews.push(view);
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

// Cache-bust the wasm artifacts every page load. Nix store mtimes are all
// 1970-01-01 so browsers happily serve stale mjs/wasm from disk cache across
// rebuilds, which would silently keep an older `_mlir_highlight*` export
// surface alive. A query-string suffix forces a fresh fetch.
const cacheBust = `?v=${Date.now()}`;

try {
  const { default: MlirOpt } = await import("./mlir-opt.mjs" + cacheBust);
  const res = await fetch("./mlir-opt.wasm" + cacheBust);
  if (!res.ok) throw new Error(`fetch mlir-opt.wasm: HTTP ${res.status}`);
  const wasmBytes = await res.arrayBuffer();
  wasmModule = await WebAssembly.compile(wasmBytes);

  // Single persistent module instance: never calls _main, so the runtime
  // stays alive and the exported C functions can be re-entered as often as
  // we like. The runner itself is also an exported function (`mlir_opt_run`)
  // that drives parse + pass pipeline + print in-process — no callMain.
  const hlMod = await MlirOpt({
    noInitialRun: true,
    print: log,
    printErr: log,
    instantiateWasm(imports, callback) {
      WebAssembly.instantiate(wasmModule, imports).then((inst) =>
        callback(inst),
      );
    },
  });

  const callJson = (sym, args) => {
    try {
      const ptr = hlMod.ccall(
        sym,
        "number",
        args.map(() => "string"),
        args,
      );
      if (!ptr) return { ok: false, err: `${sym} returned null` };
      try {
        return JSON.parse(hlMod.UTF8ToString(ptr));
      } finally {
        hlMod._free(ptr);
      }
    } catch (e) {
      return { ok: false, err: `${sym} threw: ` + (e?.message ?? e) };
    }
  };

  highlight = (text) => callJson("mlir_highlight", [text]);
  mlirOptRun = (text, args) => callJson("mlir_opt_run", [text, args]);

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

function clearOutput() {
  replaceOutputDoc("");
  outputView.dispatch({
    effects: [
      setHighlights.of(Decoration.none),
      setOpLines.of(Decoration.none),
    ],
  });
  showError(outputErr, null);
}

async function run() {
  runEl.disabled = true;
  logEl.textContent = "";
  clearOutput();
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
    replaceOutputDoc(parsed.text);
    applyHighlightOf(outputView, outputErr, parsed, parsed.text);
  }
  log(`(${(performance.now() - t0).toFixed(0)} ms)`);
  runEl.disabled = false;
}

runEl.addEventListener("click", run);
