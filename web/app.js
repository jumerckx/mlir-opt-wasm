import MlirOpt from "./mlir-opt.mjs";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");
const runEl = $("run");

const log = (s) => {
  logEl.textContent += s + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};

// ---------------------------------------------------------------------------
// DOM wiring -- do this *synchronously* before touching any wasm, so the
// textarea text is always visible (its color is transparent; the overlay <pre>
// is what the user sees). If wasm load fails for any reason, the editor still
// works as a plain text box.

const inputTa = $("input");
const inputHl = $("input-hl");
const inputErr = $("input-err");
const outputHl = $("output-hl");
const outputErr = $("output-err");

const ESC_RE = /[&<>]/g;
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escapeHtml = (s) => s.replace(ESC_RE, (c) => ESC_MAP[c]);

// Render plain text into the overlay, preserving whitespace. Adds a trailing
// space when the text ends with a newline so the <pre> doesn't collapse it.
function renderPlain(targetEl, text) {
  targetEl.textContent = text.endsWith("\n") ? text + " " : text;
}

function showError(errEl, message) {
  if (message) {
    errEl.textContent = message;
    errEl.classList.add("shown");
  } else {
    errEl.textContent = "";
    errEl.classList.remove("shown");
  }
}

function syncInputScroll() {
  inputHl.scrollTop = inputTa.scrollTop;
  inputHl.scrollLeft = inputTa.scrollLeft;
}

// Highlighter binding -- initially a no-op. Replaced once the wasm module is
// instantiated. The signature is: (text) => parsed-json-or-null. A return of
// null means "not available; fall back to plain text".
let highlight = () => null;

function updateInputHighlight() {
  const text = inputTa.value;
  const parsed = highlight(text);
  if (!parsed) {
    renderPlain(inputHl, text);
    showError(inputErr, null);
    return;
  }
  renderHighlighted(inputHl, text, parsed);
  showError(inputErr, parsed.ok ? null : parsed.err);
}

let inputDebounce = null;
inputTa.addEventListener("input", () => {
  // Always update the overlay synchronously so the textarea text stays
  // visible even while we wait to re-parse.
  renderPlain(inputHl, inputTa.value);
  clearTimeout(inputDebounce);
  inputDebounce = setTimeout(updateInputHighlight, 250);
  syncInputScroll();
});
inputTa.addEventListener("scroll", syncInputScroll);
window.addEventListener("resize", syncInputScroll);

// Initial paint -- happens immediately, before any wasm load.
renderPlain(inputHl, inputTa.value);
wireValueHover(inputHl);
wireValueHover(outputHl);

// ---------------------------------------------------------------------------
// Highlight rendering.

// SMLoc offsets from the parser are byte offsets into a UTF-8 encoding of the
// text, but we render JS UTF-16 strings. Build a lookup from byte index to
// char index. Most MLIR is pure ASCII, so this is usually 1:1.
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

function styleFor(kind, id) {
  if ((kind === "val-def" || kind === "val-use") && id != null) {
    const hue = (id * 137.508) % 360;
    return ` style="color: hsl(${hue.toFixed(0)}, 65%, 48%)"`;
  }
  return "";
}

function renderHighlighted(targetEl, text, parsed) {
  if (!parsed.ok || !parsed.spans) {
    renderPlain(targetEl, text);
    return;
  }
  const spans = parsed.spans.slice().sort((a, b) => a.s - b.s || a.e - b.e);
  const byteToChar = buildByteToChar(text);
  const charLen = text.length;
  const at = (byteOff) => {
    if (byteOff <= 0) return 0;
    if (byteOff >= byteToChar.length) return charLen;
    return byteToChar[byteOff];
  };

  let html = "";
  let cursor = 0;
  for (const sp of spans) {
    const s = at(sp.s);
    const e = at(sp.e);
    if (e <= cursor || s >= charLen) continue;
    if (s > cursor) html += escapeHtml(text.slice(cursor, s));
    const clampedStart = Math.max(s, cursor);
    const segment = text.slice(clampedStart, Math.min(e, charLen));
    const dataAttr = sp.i != null ? ` data-vid="${sp.i}"` : "";
    html += `<span class="tk-${sp.k}"${dataAttr}${styleFor(sp.k, sp.i)}>${escapeHtml(segment)}</span>`;
    cursor = Math.max(cursor, e);
  }
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  if (text.endsWith("\n")) html += " ";
  targetEl.innerHTML = html;
}

function wireValueHover(el) {
  let lastVid = null;
  el.addEventListener("mousemove", (e) => {
    const t = e.target.closest("[data-vid]");
    const vid = t ? t.dataset.vid : null;
    if (vid === lastVid) return;
    if (lastVid != null) {
      el.querySelectorAll(".vhl").forEach((n) => n.classList.remove("vhl"));
    }
    if (vid != null) {
      el.querySelectorAll(`[data-vid="${vid}"]`).forEach((n) =>
        n.classList.add("vhl"),
      );
    }
    lastVid = vid;
  });
  el.addEventListener("mouseleave", () => {
    el.querySelectorAll(".vhl").forEach((n) => n.classList.remove("vhl"));
    lastVid = null;
  });
}

// ---------------------------------------------------------------------------
// Wasm load. If this fails, the editor stays usable as a plain text box.

let wasmModule = null;
let runnerInstantiate = null;

try {
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
  updateInputHighlight();
} catch (e) {
  statusEl.textContent =
    `Failed to load mlir-opt.wasm (${e?.message ?? e}). ` +
    `Editor still works as a plain text box.`;
  runEl.disabled = true;
}

// ---------------------------------------------------------------------------
// Output pane / Run.

function setOutput(text) {
  if (!text) {
    renderPlain(outputHl, "");
    showError(outputErr, null);
    return;
  }
  const parsed = highlight(text);
  if (!parsed) {
    renderPlain(outputHl, text);
    showError(outputErr, null);
    return;
  }
  renderHighlighted(outputHl, text, parsed);
  showError(outputErr, parsed.ok ? null : parsed.err);
}

async function run() {
  if (!runnerInstantiate) return;
  runEl.disabled = true;
  logEl.textContent = "";
  renderPlain(outputHl, "");
  showError(outputErr, null);
  const t0 = performance.now();

  const mod = await runnerInstantiate();

  mod.FS.writeFile("/input.mlir", inputTa.value);

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
