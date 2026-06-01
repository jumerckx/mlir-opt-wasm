// Background-parse MLIR text with AsmParserState attached and emit a JSON
// description of the source ranges of operations, SSA values, blocks, symbols
// and aliases. The web frontend consumes this to render semantic highlighting.

#include "mlir/AsmParser/AsmParser.h"
#include "mlir/AsmParser/AsmParserState.h"
#include "mlir/IR/AsmState.h"
#include "mlir/IR/Block.h"
#include "mlir/IR/BuiltinAttributes.h"
#include "mlir/IR/BuiltinOps.h"
#include "mlir/IR/Diagnostics.h"
#include "mlir/IR/DialectRegistry.h"
#include "mlir/IR/Location.h"
#include "mlir/IR/MLIRContext.h"
#include "mlir/IR/Operation.h"
#include "mlir/IR/OperationSupport.h"
#include "mlir/IR/OwningOpRef.h"
#include "mlir/InitAllDialects.h"
#include "mlir/InitAllPasses.h"
#include "mlir/Parser/Parser.h"
#include "mlir/Pass/PassManager.h"
#include "mlir/Pass/PassRegistry.h"

#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

using namespace mlir;

namespace {

// One context per wasm module instance, lazily initialised on first call.
// Passes are registered too so the same context can drive `mlir_opt_run`.
MLIRContext &getHighlightContext() {
  static MLIRContext *ctx = []() {
    registerAllPasses();
    DialectRegistry registry;
    registerAllDialects(registry);
    auto *c = new MLIRContext(registry);
    c->loadAllAvailableDialects();
    c->allowUnregisteredDialects(true);
    c->printOpOnDiagnostic(false);
    c->printStackTraceOnDiagnostic(false);
    return c;
  }();
  return *ctx;
}

void emitJsonString(llvm::raw_ostream &os, llvm::StringRef s) {
  os << '"';
  for (char c : s) {
    switch (c) {
    case '"':  os << "\\\""; break;
    case '\\': os << "\\\\"; break;
    case '\n': os << "\\n"; break;
    case '\r': os << "\\r"; break;
    case '\t': os << "\\t"; break;
    case '\b': os << "\\b"; break;
    case '\f': os << "\\f"; break;
    default:
      if (static_cast<unsigned char>(c) < 0x20) {
        char buf[8];
        std::snprintf(buf, sizeof(buf), "\\u%04x",
                      static_cast<unsigned>(static_cast<unsigned char>(c)));
        os << buf;
      } else {
        os << c;
      }
    }
  }
  os << '"';
}

// Recursively collect every FileLineColLoc reachable from `loc` and emit it as
// a "line:col" string. We drop the filename: in this demo there's only one
// source file, and the input pane uses a different buffer identifier from the
// runner pane ("input.mlir" vs "/input.mlir"), so comparing by file would
// spuriously fail to link the two.
void collectLocKeys(Location loc,
                    llvm::SmallVectorImpl<std::string> &out) {
  std::function<void(Location)> rec = [&](Location l) {
    if (auto fl = dyn_cast<FileLineColLoc>(l)) {
      llvm::SmallString<32> buf;
      llvm::raw_svector_ostream(buf) << fl.getLine() << ':' << fl.getColumn();
      out.emplace_back(buf.str());
    } else if (auto fused = dyn_cast<FusedLoc>(l)) {
      for (Location sub : fused.getLocations())
        rec(sub);
    } else if (auto name = dyn_cast<NameLoc>(l)) {
      rec(name.getChildLoc());
    } else if (auto call = dyn_cast<CallSiteLoc>(l)) {
      rec(call.getCallee());
    }
    // UnknownLoc / OpaqueLoc contribute nothing.
  };
  rec(loc);
}

// Emit the JSON span list for a parsed file. `opLoc` maps each parsed
// Operation to the Location we want to expose to the frontend — usually
// op->getLoc(), but for the runner output we substitute the locations
// captured from the pre-strip parse so the user sees clean text yet we
// still know the original mapping.
void emitSpans(llvm::raw_ostream &os, const AsmParserState &state,
               const char *bufStart, size_t bufLen,
               llvm::function_ref<Location(Operation *)> opLoc) {
  auto offsetOf = [&](llvm::SMLoc loc) -> size_t {
    if (!loc.isValid()) return 0;
    const char *p = loc.getPointer();
    if (p < bufStart || p > bufStart + bufLen) return 0;
    return static_cast<size_t>(p - bufStart);
  };

  bool firstSpan = true;
  int nextId = 0;
  auto sep = [&]() {
    if (!firstSpan) os << ',';
    firstSpan = false;
  };
  auto span = [&](llvm::SMRange r, llvm::StringRef kind, int id = -1) {
    if (!r.isValid()) return;
    size_t s = offsetOf(r.Start);
    size_t e = offsetOf(r.End);
    if (e <= s) return;
    sep();
    os << "{\"s\":" << s << ",\"e\":" << e << ",\"k\":\"" << kind << "\"";
    if (id >= 0) os << ",\"i\":" << id;
    os << "}";
  };

  for (const auto &opDef : state.getOpDefs()) {
    // The op-name span carries the loc keys so the JS side can wire up
    // cross-pane line linking on click.
    if (opDef.loc.isValid()) {
      size_t s = offsetOf(opDef.loc.Start);
      size_t e = offsetOf(opDef.loc.End);
      if (e > s) {
        sep();
        os << "{\"s\":" << s << ",\"e\":" << e << ",\"k\":\"op\"";
        llvm::SmallVector<std::string, 2> keys;
        collectLocKeys(opLoc(opDef.op), keys);
        if (!keys.empty()) {
          os << ",\"loc\":[";
          for (size_t i = 0; i < keys.size(); ++i) {
            if (i) os << ',';
            emitJsonString(os, keys[i]);
          }
          os << "]";
        }
        os << "}";
      }
    }
    for (const auto &rg : opDef.resultGroups) {
      int id = nextId++;
      span(rg.definition.loc, "val-def", id);
      for (const auto &use : rg.definition.uses)
        span(use, "val-use", id);
    }
    for (const auto &use : opDef.symbolUses)
      span(use, "sym-use");
  }

  // Blocks: the block label and its predecessor/successor references, plus
  // every block argument as its own SSA value.
  for (const auto &blockDef : state.getBlockDefs()) {
    int blockId = nextId++;
    span(blockDef.definition.loc, "blk-def", blockId);
    for (const auto &use : blockDef.definition.uses)
      span(use, "blk-use", blockId);
    for (const auto &arg : blockDef.arguments) {
      int id = nextId++;
      span(arg.loc, "val-def", id);
      for (const auto &use : arg.uses)
        span(use, "val-use", id);
    }
  }

  for (const auto &alias : state.getAttributeAliasDefs()) {
    int id = nextId++;
    span(alias.definition.loc, "attr-alias-def", id);
    for (const auto &use : alias.definition.uses)
      span(use, "attr-alias-use", id);
  }

  for (const auto &alias : state.getTypeAliasDefs()) {
    int id = nextId++;
    span(alias.definition.loc, "type-alias-def", id);
    for (const auto &use : alias.definition.uses)
      span(use, "type-alias-use", id);
  }
}

char *toHeapString(const std::string &s) {
  char *result = static_cast<char *>(std::malloc(s.size() + 1));
  std::memcpy(result, s.data(), s.size());
  result[s.size()] = '\0';
  return result;
}

} // namespace

extern "C" char *mlir_highlight(const char *input) {
  if (!input) input = "";

  MLIRContext &ctx = getHighlightContext();

  auto buffer = llvm::MemoryBuffer::getMemBufferCopy(input, "input.mlir");
  const char *bufStart = buffer->getBufferStart();
  size_t bufLen = buffer->getBufferSize();

  llvm::SourceMgr sourceMgr;
  sourceMgr.AddNewSourceBuffer(std::move(buffer), llvm::SMLoc());

  std::string errBuf;
  llvm::raw_string_ostream errStream(errBuf);
  SourceMgrDiagnosticHandler diagHandler(sourceMgr, &ctx, errStream);

  Block block;
  AsmParserState state;
  ParserConfig config(&ctx, /*verifyAfterParse=*/false);

  LogicalResult parseResult =
      parseAsmSourceFile(sourceMgr, &block, config, &state);
  errStream.flush();

  std::string out;
  llvm::raw_string_ostream os(out);

  if (failed(parseResult)) {
    os << "{\"ok\":false,\"err\":";
    emitJsonString(os, errBuf);
    os << "}";
  } else {
    os << "{\"ok\":true";
    if (!errBuf.empty()) {
      os << ",\"warn\":";
      emitJsonString(os, errBuf);
    }
    os << ",\"spans\":[";
    emitSpans(os, state, bufStart, bufLen,
              [](Operation *op) { return op->getLoc(); });
    os << "]}";
  }
  os.flush();
  return toHeapString(out);
}

// Tokenize a whitespace-separated argument string.
static void tokenizeArgs(llvm::StringRef args,
                         std::vector<std::string> &out) {
  size_t i = 0;
  while (i < args.size()) {
    while (i < args.size() &&
           std::isspace(static_cast<unsigned char>(args[i])))
      ++i;
    if (i >= args.size()) break;
    size_t start = i;
    while (i < args.size() &&
           !std::isspace(static_cast<unsigned char>(args[i])))
      ++i;
    out.emplace_back(args.slice(start, i).str());
  }
}

// Strip leading "--" or "-" from a flag.
static llvm::StringRef stripDashes(llvm::StringRef s) {
  if (s.starts_with("--")) return s.drop_front(2);
  if (s.starts_with("-")) return s.drop_front(1);
  return s;
}

// Drive a single in-process mlir-opt invocation: parse the input, run the
// pass pipeline parsed from `argsCStr`, print the resulting Module honouring
// the user's `--mlir-print-debuginfo` preference, and return JSON containing
// the output text plus highlight spans for it.
//
// Cross-pane linking is sourced from the in-memory Module's per-op
// Locations — which were attached at input-parse time and carried through
// the pass pipeline — so it keeps working even when the displayed text has
// no `loc(...)` annotations. The output text is reparsed once (with
// AsmParserState) to obtain source ranges; ops are mapped to the captured
// locations by walking the pre-print and post-reparse IRs in parallel.
extern "C" char *mlir_opt_run(const char *input, const char *argsCStr) {
  if (!input) input = "";
  if (!argsCStr) argsCStr = "";

  MLIRContext &ctx = getHighlightContext();

  // ---- Args parsing.
  bool printDebugInfo = false;
  std::vector<std::string> tokens;
  tokenizeArgs(argsCStr, tokens);

  llvm::SmallVector<std::string, 4> passSpecs;
  std::string explicitPipeline;
  for (const auto &tok : tokens) {
    llvm::StringRef t(tok);
    if (t == "--mlir-print-debuginfo" || t == "-mlir-print-debuginfo") {
      printDebugInfo = true;
      continue;
    }
    llvm::StringRef stripped = stripDashes(t);
    if (stripped.consume_front("pass-pipeline=")) {
      explicitPipeline = stripped.str();
      continue;
    }
    if (stripped.empty()) continue;
    passSpecs.emplace_back(stripped.str());
  }

  std::string pipelineStr = explicitPipeline;
  if (pipelineStr.empty()) {
    for (size_t i = 0; i < passSpecs.size(); ++i) {
      if (i) pipelineStr += ',';
      pipelineStr += passSpecs[i];
    }
  }

  std::string errBuf;
  llvm::raw_string_ostream errStream(errBuf);

  auto makeError = [&](llvm::StringRef msg) -> char * {
    std::string out;
    llvm::raw_string_ostream os(out);
    os << "{\"ok\":false,\"err\":";
    std::string combined;
    if (!msg.empty()) combined = msg.str();
    if (!errBuf.empty()) {
      if (!combined.empty()) combined += '\n';
      combined += errBuf;
    }
    emitJsonString(os, combined);
    os << "}";
    os.flush();
    return toHeapString(out);
  };

  // ---- Parse input as a ModuleOp (implicit module wrapping kicks in if the
  // input is bare top-level ops).
  auto inputBuf = llvm::MemoryBuffer::getMemBufferCopy(input, "input.mlir");
  llvm::SourceMgr srcMgr;
  srcMgr.AddNewSourceBuffer(std::move(inputBuf), llvm::SMLoc());
  SourceMgrDiagnosticHandler diagHandler(srcMgr, &ctx, errStream);

  ParserConfig parserConfig(&ctx, /*verifyAfterParse=*/true);
  OwningOpRef<ModuleOp> module =
      parseSourceFile<ModuleOp>(srcMgr, parserConfig);
  errStream.flush();
  if (!module)
    return makeError("parse failed");

  // ---- Build and run the pass pipeline.
  if (!pipelineStr.empty()) {
    PassManager pm(&ctx);
    if (failed(parsePassPipeline(pipelineStr, pm, errStream))) {
      errStream.flush();
      return makeError("pass pipeline parse failed");
    }
    if (failed(pm.run(*module))) {
      errStream.flush();
      return makeError("pass pipeline failed");
    }
  }
  errStream.flush();

  // ---- Capture per-op locations from the in-memory module in walk order.
  llvm::SmallVector<Location, 32> opLocs;
  module->walk([&](Operation *op) { opLocs.push_back(op->getLoc()); });

  // ---- Print module with the user's debug-info preference.
  std::string outputText;
  {
    llvm::raw_string_ostream os(outputText);
    OpPrintingFlags flags;
    if (printDebugInfo) flags.enableDebugInfo();
    module->print(os, flags);
    os << '\n';
  }

  // ---- Reparse output with AsmParserState to get source ranges.
  auto outBuf =
      llvm::MemoryBuffer::getMemBufferCopy(outputText, "output.mlir");
  const char *bufStart = outBuf->getBufferStart();
  size_t bufLen = outBuf->getBufferSize();
  llvm::SourceMgr outSrcMgr;
  outSrcMgr.AddNewSourceBuffer(std::move(outBuf), llvm::SMLoc());

  std::string errBuf2;
  llvm::raw_string_ostream errStream2(errBuf2);
  SourceMgrDiagnosticHandler diagHandler2(outSrcMgr, &ctx, errStream2);

  Block outBlock;
  AsmParserState state;
  ParserConfig outParserConfig(&ctx, /*verifyAfterParse=*/false);
  LogicalResult outParse =
      parseAsmSourceFile(outSrcMgr, &outBlock, outParserConfig, &state);
  errStream2.flush();

  std::string out;
  llvm::raw_string_ostream os(out);

  if (failed(outParse)) {
    // Shouldn't happen — we just printed valid IR — but degrade gracefully.
    os << "{\"ok\":true,\"text\":";
    emitJsonString(os, outputText);
    os << ",\"spans\":[]";
    if (!errBuf2.empty()) {
      os << ",\"warn\":";
      emitJsonString(os, errBuf2);
    }
    os << "}";
    os.flush();
    return toHeapString(out);
  }

  // Map reparsed ops back to the captured locations by parallel walk order.
  // Both walks are deterministic over identical IR structure (the second
  // came from printing the first), so indices line up.
  llvm::DenseMap<Operation *, Location> locMap;
  {
    size_t idx = 0;
    for (Operation &top : outBlock) {
      top.walk([&](Operation *op) {
        if (idx < opLocs.size())
          locMap.try_emplace(op, opLocs[idx]);
        ++idx;
      });
    }
  }

  os << "{\"ok\":true,\"text\":";
  emitJsonString(os, outputText);
  os << ",\"spans\":[";
  emitSpans(os, state, bufStart, bufLen, [&](Operation *op) -> Location {
    auto it = locMap.find(op);
    return it == locMap.end() ? Location(op->getLoc()) : it->second;
  });
  os << "]";
  if (!errBuf2.empty()) {
    os << ",\"warn\":";
    emitJsonString(os, errBuf2);
  }
  os << "}";
  os.flush();
  return toHeapString(out);
}
