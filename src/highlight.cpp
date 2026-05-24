// Background-parse MLIR text with AsmParserState attached and emit a JSON
// description of the source ranges of operations, SSA values, blocks, symbols
// and aliases. The web frontend consumes this to render semantic highlighting.

#include "mlir/AsmParser/AsmParser.h"
#include "mlir/AsmParser/AsmParserState.h"
#include "mlir/IR/AsmState.h"
#include "mlir/IR/Block.h"
#include "mlir/IR/BuiltinAttributes.h"
#include "mlir/IR/Diagnostics.h"
#include "mlir/IR/DialectRegistry.h"
#include "mlir/IR/Location.h"
#include "mlir/IR/MLIRContext.h"
#include "mlir/IR/Operation.h"
#include "mlir/IR/OperationSupport.h"
#include "mlir/InitAllDialects.h"

#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <string>

using namespace mlir;

namespace {

// One context per wasm module instance, lazily initialised on first call.
MLIRContext &getHighlightContext() {
  static MLIRContext *ctx = []() {
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

// Same as `mlir_highlight`, but tailored for the mlir-opt runner output: the
// caller passes text that contains `loc(...)` debug annotations, we parse it
// to capture every op's source location, then re-print *without* debug info
// so the user never sees the annotations. The returned JSON includes the
// stripped text under "text" and spans that index into it.
extern "C" char *mlir_highlight_clean(const char *input) {
  if (!input) input = "";

  MLIRContext &ctx = getHighlightContext();

  // ---- Parse #1: original (with debug info), to capture locations.
  auto buffer1 = llvm::MemoryBuffer::getMemBufferCopy(input, "withdbg.mlir");
  llvm::SourceMgr sourceMgr1;
  sourceMgr1.AddNewSourceBuffer(std::move(buffer1), llvm::SMLoc());

  std::string errBuf;
  llvm::raw_string_ostream errStream(errBuf);
  SourceMgrDiagnosticHandler diagHandler(sourceMgr1, &ctx, errStream);

  Block block1;
  ParserConfig config(&ctx, /*verifyAfterParse=*/false);
  LogicalResult parseResult1 = parseAsmSourceFile(sourceMgr1, &block1, config);
  errStream.flush();

  std::string out;
  llvm::raw_string_ostream os(out);

  if (failed(parseResult1)) {
    os << "{\"ok\":false,\"err\":";
    emitJsonString(os, errBuf);
    os << "}";
    os.flush();
    return toHeapString(out);
  }

  // Capture per-op locations in walk order.
  llvm::SmallVector<Location, 32> opLocs;
  for (Operation &top : block1)
    top.walk([&](Operation *op) { opLocs.push_back(op->getLoc()); });

  // ---- Re-print without debug info.
  std::string cleanText;
  {
    llvm::raw_string_ostream cs(cleanText);
    OpPrintingFlags flags;
    flags.enableDebugInfo(false);
    for (Operation &top : block1) {
      top.print(cs, flags);
      cs << '\n';
    }
  }

  // ---- Parse #2: clean text, with AsmParserState attached for spans.
  auto buffer2 =
      llvm::MemoryBuffer::getMemBufferCopy(cleanText, "clean.mlir");
  const char *bufStart = buffer2->getBufferStart();
  size_t bufLen = buffer2->getBufferSize();

  llvm::SourceMgr sourceMgr2;
  sourceMgr2.AddNewSourceBuffer(std::move(buffer2), llvm::SMLoc());

  // Diagnostics from the second parse should be unreachable (we just printed
  // valid IR), but capture them defensively.
  std::string errBuf2;
  llvm::raw_string_ostream errStream2(errBuf2);
  SourceMgrDiagnosticHandler diagHandler2(sourceMgr2, &ctx, errStream2);

  Block block2;
  AsmParserState state2;
  LogicalResult parseResult2 =
      parseAsmSourceFile(sourceMgr2, &block2, config, &state2);
  errStream2.flush();

  if (failed(parseResult2)) {
    // Fall back: hand the user the (now-clean) text and an empty span list.
    os << "{\"ok\":true,\"text\":";
    emitJsonString(os, cleanText);
    os << ",\"spans\":[]";
    if (!errBuf2.empty()) {
      os << ",\"warn\":";
      emitJsonString(os, errBuf2);
    }
    os << "}";
    os.flush();
    return toHeapString(out);
  }

  // Build Operation* → captured-Location map by walking block2 in the same
  // order we walked block1. Both walks visit ops deterministically and the
  // structure is identical (round-trip through print/parse), so indices line
  // up. If they ever don't, we fall through to op->getLoc() which is
  // UnknownLoc for clean parses — harmless, just no linking for those ops.
  llvm::DenseMap<Operation *, Location> locMap;
  {
    size_t idx = 0;
    for (Operation &top : block2) {
      top.walk([&](Operation *op) {
        if (idx < opLocs.size())
          locMap.try_emplace(op, opLocs[idx]);
        ++idx;
      });
    }
  }

  os << "{\"ok\":true,\"text\":";
  emitJsonString(os, cleanText);
  os << ",\"spans\":[";
  emitSpans(os, state2, bufStart, bufLen, [&](Operation *op) -> Location {
    auto it = locMap.find(op);
    return it == locMap.end() ? Location(op->getLoc()) : it->second;
  });
  os << "]}";
  os.flush();
  return toHeapString(out);
}
