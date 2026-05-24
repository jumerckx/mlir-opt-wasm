// Background-parse MLIR text with AsmParserState attached and emit a JSON
// description of the source ranges of operations, SSA values, blocks, symbols
// and aliases. The web frontend consumes this to render semantic highlighting.

#include "mlir/AsmParser/AsmParser.h"
#include "mlir/AsmParser/AsmParserState.h"
#include "mlir/IR/AsmState.h"
#include "mlir/IR/Block.h"
#include "mlir/IR/Diagnostics.h"
#include "mlir/IR/DialectRegistry.h"
#include "mlir/IR/MLIRContext.h"
#include "mlir/InitAllDialects.h"

#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
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

} // namespace

extern "C" char *mlir_highlight(const char *input) {
  if (!input) input = "";

  MLIRContext &ctx = getHighlightContext();

  auto buffer = llvm::MemoryBuffer::getMemBufferCopy(input, "input.mlir");
  const char *bufStart = buffer->getBufferStart();
  size_t bufLen = buffer->getBufferSize();

  llvm::SourceMgr sourceMgr;
  sourceMgr.AddNewSourceBuffer(std::move(buffer), llvm::SMLoc());

  // Capture all diagnostics into a string so we can ship them back to JS.
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

  auto offsetOf = [&](llvm::SMLoc loc) -> size_t {
    if (!loc.isValid()) return 0;
    const char *p = loc.getPointer();
    if (p < bufStart || p > bufStart + bufLen) return 0;
    return static_cast<size_t>(p - bufStart);
  };

  if (failed(parseResult)) {
    os << "{\"ok\":false,\"err\":";
    emitJsonString(os, errBuf);
    os << "}";
    os.flush();
  } else {
    os << "{\"ok\":true";
    if (!errBuf.empty()) {
      os << ",\"warn\":";
      emitJsonString(os, errBuf);
    }
    os << ",\"spans\":[";

    bool firstSpan = true;
    int nextId = 0;
    auto span = [&](llvm::SMRange r, llvm::StringRef kind, int id = -1) {
      if (!r.isValid()) return;
      size_t s = offsetOf(r.Start);
      size_t e = offsetOf(r.End);
      if (e <= s) return;
      if (!firstSpan) os << ',';
      firstSpan = false;
      os << "{\"s\":" << s << ",\"e\":" << e << ",\"k\":\"" << kind << "\"";
      if (id >= 0) os << ",\"i\":" << id;
      os << "}";
    };

    // Operations: bold name, coloured result groups, symbol uses.
    for (const auto &opDef : state.getOpDefs()) {
      span(opDef.loc, "op");
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

    os << "]}";
    os.flush();
  }

  // Hand a freshly-allocated, null-terminated buffer back to JS. The JS side
  // is expected to `_free()` it after reading.
  char *result = static_cast<char *>(std::malloc(out.size() + 1));
  std::memcpy(result, out.data(), out.size());
  result[out.size()] = '\0';
  return result;
}
