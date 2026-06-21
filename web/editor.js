// Shared MLIR editor + highlighting infrastructure used by every page in the
// playground (the mlir-opt demo and the PDL lowering view). The text editors
// are CodeMirror 6 instances; styling is driven from the wasm-side
// `mlir_highlight` parser via Decoration.mark.
//
// Everything page-specific (which editors exist, the pass pipeline to run, the
// surrounding DOM) lives in the per-page module that imports from here.

// Register the service worker (./sw.js) so the site caches its assets and works
// offline. Both pages import this module, so registering here covers them both.
// `updateViaCache: "none"` keeps the browser from serving a stale sw.js from
// its HTTP cache, so a new build's SW is always detected. Best-effort: if the
// browser has no SW support the page still works, just without caching.
//
// On a local origin we do the opposite. The SW only caches the wasm bundle now
// (see sw.js), but during development you rebuild and reload constantly — a
// cached wasm then shadows a freshly rebuilt one, so your changes don't show
// up. Detect localhost (and the file:// protocol) and, instead of registering,
// unregister any SW and drop every cache a previous visit installed, so local
// testing always serves the files on disk. (This takes effect on the *next*
// load, since the already-running SW still controls the current one — clear the
// site's data once to bootstrap if you're stuck.)
const isLocalOrigin =
    location.protocol === "file:" ||
    /^(localhost|127\.0\.0\.1|\[::1\]|::1|.*\.local|)$/.test(location.hostname);
if ("serviceWorker" in navigator) {
    if (isLocalOrigin) {
        navigator.serviceWorker
            .getRegistrations()
            .then((regs) => regs.forEach((r) => r.unregister()))
            .catch(() => {});
        if (self.caches) {
            caches
                .keys()
                .then((keys) => keys.forEach((k) => caches.delete(k)))
                .catch(() => {});
        }
    } else {
        navigator.serviceWorker
            .register("./sw.js", { updateViaCache: "none" })
            .catch(() => {});
    }
}

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
// Note: CodeMirror's active-line highlight (highlightActiveLine /
// highlightActiveLineGutter) is intentionally omitted — we don't want the
// current line emphasised.
const basicSetup = [
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
];

export function showError(errEl, message) {
    if (!errEl) return;
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

// MLIR `//` line comments are dropped by the lexer, so they never show up in
// the parser's span list. Scan the text directly for them here, skipping over
// string literals so a `//` inside a quoted string isn't mistaken for one.
// Offsets are CodeMirror char indices (no byte→char mapping needed).
function findCommentRanges(text) {
    const ranges = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
        const c = text[i];
        if (c === '"') {
            i++;
            while (i < n) {
                if (text[i] === "\\") {
                    i += 2;
                    continue;
                }
                if (text[i] === '"') {
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (c === "/" && text[i + 1] === "/") {
            const start = i;
            while (i < n && text[i] !== "\n") i++;
            ranges.push({ s: start, e: i, k: "comment", i: null, loc: null });
            continue;
        }
        i++;
    }
    return ranges;
}

function buildDecorations(text, parsed, activated) {
    if (!parsed || !parsed.ok || !parsed.spans) return Decoration.none;
    const byteToChar = buildByteToChar(text);
    const charLen = text.length;
    const at = (b) =>
        b <= 0 ? 0 : b >= byteToChar.length ? charLen : byteToChar[b];

    const decos = parsed.spans
        .map((sp) => ({
            s: at(sp.s),
            e: at(sp.e),
            k: sp.k,
            i: sp.i,
            loc: sp.loc,
        }))
        .concat(findCommentRanges(text))
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
            // The lightness lives in CSS so the colour can adapt to the system
            // theme; here we only hand over the hue.
            attrs.style = `--val-hue: ${hue.toFixed(0)}`;
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

// Bound after the wasm highlighter is initialised by loadMlir(); until then
// it's a no-op so the editors stay usable as plain text boxes.
let highlight = () => null;

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

// Apply an already-computed parse result to a view. Pages that run their own
// pass pipeline (e.g. the PDL view) call this with the spans returned by
// `mlir_opt_run`; the editable input pane re-highlights via applyHighlight().
export function applyHighlightOf(view, errEl, parsed, text) {
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

export function applyHighlight(view, errEl) {
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

// Replace a (read-only) view's document with new text.
export function replaceDoc(view, text) {
    view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
    });
}

// Clear a view: empty document, no decorations, no error.
export function clearEditor(view, errEl) {
    replaceDoc(view, "");
    view.dispatch({
        effects: [
            setHighlights.of(Decoration.none),
            setOpLines.of(Decoration.none),
        ],
    });
    showError(errEl, null);
}

// ---------------------------------------------------------------------------
// Cross-pane op linking. Clicking an op in any editor toggles a shared
// activation keyed by that op's source-location set; every op in every pane
// that shares at least one key gets a whole-line background in a colour
// derived from the activation. Many-to-one and one-to-many fall out naturally
// because each op may carry multiple location keys (FusedLoc) and each
// activation may carry multiple keys. Locations are carried through the pass
// pipeline, so this links an input op to its lowered descendants too.

// Module-level state shared by every editor on the page.
const linkActivations = new Map(); // signature -> { keys: string[], hue: number }
let nextLinkHueIdx = 0;
const linkedViews = []; // views participating in linking

function nextLinkHue() {
    return (nextLinkHueIdx++ * 137.508) % 360;
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
            effects: setOpLines.of(
                buildOpLineDecorations(view, s.text, s.parsed),
            ),
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
            dom.querySelectorAll(".vhl").forEach((n) =>
                n.classList.remove("vhl"),
            );
        }
        if (vid != null) {
            dom.querySelectorAll(`[data-vid="${vid}"]`).forEach((n) =>
                n.classList.add("vhl"),
            );
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

export function makeEditor({ parent, doc, editable, onChange }) {
    const extensions = [
        basicSetup,
        indentUnit.of("  "),
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

// ---------------------------------------------------------------------------
// Wasm load. Resolves to the in-process entry points; if anything throws the
// caller is expected to leave the editors usable as plain text boxes. Also
// binds the module-level `highlight` used by applyHighlight().

export async function loadMlir({ onLog } = {}) {
    const log = onLog || (() => {});

    // These two relative URLs are rewritten to the content-hashed asset names
    // by the build (web/build.mjs); the literals here are what it matches on.
    // Hashed names mean the browser (and the SW, see ./sw.js) can cache the
    // multi-MB wasm immutably and never serve a stale copy across rebuilds.
    const { default: MlirOpt } = await import("./mlir-opt.mjs");
    const res = await fetch("./mlir-opt.wasm");
    if (!res.ok) throw new Error(`fetch mlir-opt.wasm: HTTP ${res.status}`);
    const wasmBytes = await res.arrayBuffer();
    const wasmModule = await WebAssembly.compile(wasmBytes);

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
    const mlirOptRun = (text, args) =>
        callJson("mlir_opt_run", [text, args]);
    // `mlir-translate --match-to-cpp`: combined matchers → generated C++.
    const mlirTranslateMatchToCpp = (text) =>
        callJson("mlir_translate_match_to_cpp", [text]);

    return {
        highlight,
        mlirOptRun,
        mlirTranslateMatchToCpp,
        byteLength: wasmBytes.byteLength,
    };
}
