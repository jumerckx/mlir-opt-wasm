import MlirOpt from "./mlir-opt.mjs";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const statusEl = $("status");
const runEl = $("run");

const log = (s) => {
  logEl.textContent += s + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};

// Compile the wasm once on page load and reuse it. EXIT_RUNTIME=1 means each
// Emscripten Module instance is single-shot (atexit handlers fire after main
// returns), but the underlying WebAssembly.Module is fine to instantiate
// repeatedly -- which saves a multi-second recompile on every click.
const wasmBytes = await fetch("./mlir-opt.wasm").then((r) => {
  if (!r.ok) throw new Error(`fetch mlir-opt.wasm: ${r.status}`);
  return r.arrayBuffer();
});
const wasmModule = await WebAssembly.compile(wasmBytes);

statusEl.textContent = `Ready. mlir-opt.wasm: ${(wasmBytes.byteLength / 1e6).toFixed(1)} MB.`;
runEl.disabled = false;

async function run() {
  runEl.disabled = true;
  $("output").value = "";
  logEl.textContent = "";
  const t0 = performance.now();

  const mod = await MlirOpt({
    noInitialRun: true,
    print: log,
    printErr: log,
    instantiateWasm(imports, callback) {
      WebAssembly.instantiate(wasmModule, imports).then((inst) => callback(inst));
    },
  });

  mod.FS.writeFile("/input.mlir", $("input").value);

  const args = $("args").value.split(/\s+/).filter(Boolean);
  let rc = "?";
  try {
    rc = mod.callMain([...args, "/input.mlir", "-o", "/output.mlir"]);
  } catch (e) {
    log("[exception] " + (e?.message ?? e));
  }

  try {
    $("output").value = mod.FS.readFile("/output.mlir", { encoding: "utf8" });
  } catch (e) {
    log("[no output file] " + (e?.message ?? e));
  }

  log(`exit=${rc} (${(performance.now() - t0).toFixed(0)} ms)`);
  runEl.disabled = false;
}

runEl.addEventListener("click", run);
