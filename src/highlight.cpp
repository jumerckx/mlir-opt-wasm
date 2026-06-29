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
#include "mlir/Support/FileUtilities.h"
#include "mlir/Support/Timing.h"
#include "mlir/TableGen/Operator.h"
#include "mlir/Target/MatchToCpp/MatchToCpp.h"
#include "mlir/Target/MatchToCpp/OpInfoRegistry.h"

#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/SmallString.h"
#include "llvm/ADT/SmallVector.h"
#include "llvm/ADT/StringRef.h"
#include "llvm/ADT/Twine.h"
#include "llvm/Support/CommandLine.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/VirtualFileSystem.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/TableGen/Parser.h"
#include "llvm/TableGen/Record.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <memory>
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

// Process-wide command-line option registry for the runner, constructed once.
// Real mlir-opt does not enumerate printing/timing flags itself: it registers
// them as llvm::cl::opt globals (registerAsmPrinterCLOptions et al.) and reads
// them back via a default-constructed OpPrintingFlags() and
// applyPassManagerCLOptions(). We mirror that here so the playground tracks
// mlir-opt's full flag surface (--mlir-print-op-generic, --mlir-timing,
// --mlir-print-local-scope, --mlir-elide-elementsattrs-if-larger, …) for free.
//
// cl::opt objects register into a global table keyed by name, so re-creating
// any of them asserts — hence a single lazily-constructed instance. The
// PassPipelineCLParser must be built after registerAllPasses() (done by
// getHighlightContext) so it sees every pass as a `--passname` flag.
struct RunnerCLOptions {
  // Parses the pass pipeline: positional `--pass-pipeline=...` plus an
  // individual `--passname` flag per registered pass (e.g. --canonicalize).
  PassPipelineCLParser passPipeline{"", "Compiler passes to run"};

  RunnerCLOptions() {
    registerAsmPrinterCLOptions();
    registerMLIRContextCLOptions();
    registerPassManagerCLOptions();
    registerDefaultTimingManagerCLOptions();
  }
};

RunnerCLOptions &getRunnerCLOptions() {
  static RunnerCLOptions *opts = new RunnerCLOptions();
  return *opts;
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

// Location in the wasm MEMFS of the arith dialect's ODS `.td` tree. CMake bakes
// it in with emscripten's `--embed-file` (see src/CMakeLists.txt); the include
// root holds the transitive `.td` closure ArithOps.td pulls from mlir/IR and
// mlir/Interfaces. Only the arith dialect's ops are registered below, so they
// get concrete-typed (`dyn_cast`) matchers while every other op falls back to
// the generic `Operation *` emission.
constexpr const char *kOdsIncludeDir = "/ods";
constexpr const char *kArithOdsFile = "/ods/mlir/Dialect/Arith/IR/ArithOps.td";

// Statically fixed flat operand/result count for a list of ODS groups, or -1
// when any group is variadic or the matching segment-size trait is present.
// Mirrors fixedFlatCount() in mlir-match-to-cpp.cpp.
template <typename RangeT>
int fixedFlatCount(RangeT &&groups, int count, bool attrSizedSegments) {
  if (attrSizedSegments)
    return -1;
  for (const auto &group : groups)
    if (group.isVariableLength())
      return -1;
  return count;
}

// Parse the arith ODS via TableGen and record the static structure the
// match-to-cpp emitter needs for each op, exactly as the standalone
// mlir-match-to-cpp tool does in buildRegistry(). Built once and cached; a
// parse failure leaves the registry empty, which degrades to generic output.
const match::OpInfoRegistry &getArithOpInfoRegistry() {
  static match::OpInfoRegistry *registry = []() {
    auto *reg = new match::OpInfoRegistry();

    std::string errorMessage;
    std::unique_ptr<llvm::MemoryBuffer> buffer =
        openInputFile(kArithOdsFile, &errorMessage);
    if (!buffer) {
      llvm::errs() << "match-to-cpp: " << errorMessage << "\n";
      return reg;
    }

    llvm::SourceMgr tdSrcMgr;
    tdSrcMgr.AddNewSourceBuffer(std::move(buffer), llvm::SMLoc());
    tdSrcMgr.setIncludeDirs({std::string(kOdsIncludeDir)});
    tdSrcMgr.setVirtualFileSystem(llvm::vfs::getRealFileSystem());

    llvm::RecordKeeper records;
    if (llvm::TableGenParseFile(tdSrcMgr, records)) {
      llvm::errs() << "match-to-cpp: failed to parse arith ODS\n";
      return reg;
    }

    for (const llvm::Record *def : records.getAllDerivedDefinitions("Op")) {
      tblgen::Operator op(def);

      bool attrSizedOperands =
          op.getTrait("::mlir::OpTrait::AttrSizedOperandSegments");
      bool attrSizedResults =
          op.getTrait("::mlir::OpTrait::AttrSizedResultSegments");

      match::OpInfo info;
      // Spell the class fully-qualified from the global namespace; some
      // dialects already prefix their cppNamespace with "::".
      std::string qualClass = op.getQualCppClassName();
      if (!llvm::StringRef(qualClass).starts_with("::"))
        qualClass = "::" + qualClass;
      info.cppClassName = std::move(qualClass);
      info.numOperandGroups = op.getNumOperands();
      info.numResultGroups = op.getNumResults();
      info.attrSizedOperandSegments = attrSizedOperands;
      info.attrSizedResultSegments = attrSizedResults;
      info.fixedNumOperands = fixedFlatCount(
          op.getOperands(), op.getNumOperands(), attrSizedOperands);
      info.fixedNumResults =
          fixedFlatCount(op.getResults(), op.getNumResults(), attrSizedResults);

      reg->insert(op.getOperationName(), std::move(info));
    }
    return reg;
  }();
  return *registry;
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

// Drive a single in-process mlir-opt invocation: parse `argsCStr` through the
// same llvm::cl machinery mlir-opt uses, parse the input, run the pass
// pipeline, print the resulting Module honouring the parsed printing flags
// (--mlir-print-op-generic, --mlir-print-debuginfo, --mlir-print-local-scope,
// …), and return JSON containing the output text plus highlight spans for it.
// --mlir-timing emits its report to stderr, which the page shows in its log.
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

  MLIRContext &ctx = getHighlightContext(); // also registers all passes
  RunnerCLOptions &clOpts = getRunnerCLOptions();

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

  // ---- Parse the argument string through LLVM's command-line machinery,
  // exactly as mlir-opt does at startup. This populates the registered
  // asm-printer / pass-manager / timing cl::opt globals, which the default
  // OpPrintingFlags(), applyPassManagerCLOptions() and the timing manager
  // read back below. The options are process-global and persist across calls,
  // so reset their occurrences before re-parsing.
  std::vector<std::string> tokens;
  tokenizeArgs(argsCStr, tokens);
  std::vector<const char *> argv;
  argv.reserve(tokens.size() + 1);
  argv.push_back("mlir-opt");
  for (const auto &t : tokens)
    argv.push_back(t.c_str());

  llvm::cl::ResetAllOptionOccurrences();
  std::string clErr;
  llvm::raw_string_ostream clErrStream(clErr);
  if (!llvm::cl::ParseCommandLineOptions(static_cast<int>(argv.size()),
                                         argv.data(), /*Overview=*/"",
                                         &clErrStream)) {
    clErrStream.flush();
    return makeError(clErr);
  }

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

  // ---- Timing manager (drives --mlir-timing). Its report is emitted to
  // stderr when `tm` is destroyed at function exit; the page routes stderr
  // into its log pane. When --mlir-timing is absent the manager is disabled
  // and prints nothing.
  DefaultTimingManager tm;
  applyDefaultTimingManagerCLOptions(tm);
  TimingScope timing = tm.getRootScope();

  // ---- Build and run the pass pipeline parsed from the cl options.
  {
    PassManager pm(&ctx);
    if (failed(applyPassManagerCLOptions(pm)))
      return makeError("failed to apply pass-manager options");
    pm.enableTiming(timing);
    if (failed(clOpts.passPipeline.addToPipeline(
            pm, [&](const llvm::Twine &msg) {
              errStream << msg << '\n';
              return failure();
            }))) {
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

  // ---- Print module honouring the parsed printing flags. A default
  // OpPrintingFlags() reads them from the cl options parsed above.
  std::string outputText;
  {
    llvm::raw_string_ostream os(outputText);
    module->print(os, OpPrintingFlags());
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

// Translate `match` matchers to C++ `RewritePattern` source, mirroring what
// the `mlir-match-to-cpp` tool does on the command line. The input is the
// combined-matchers IR (output of `match-combine-matchers`); the output is the
// generated C++ rather than further MLIR, so there are no highlight spans —
// just the source text. The arith dialect's ODS is supplied (see
// getArithOpInfoRegistry), so arith ops emit concrete-typed (`dyn_cast`)
// matchers while other ops use the generic `Operation *` emission. Returns JSON
// {ok:true,text:...} or {ok:false,err:...}.
extern "C" char *mlir_translate_match_to_cpp(const char *input) {
  if (!input) input = "";

  MLIRContext &ctx = getHighlightContext();

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

  std::string cppText;
  {
    llvm::raw_string_ostream os(cppText);
    if (failed(match::translateToCpp(module->getOperation(), os,
                                     getArithOpInfoRegistry()))) {
      os.flush();
      errStream.flush();
      return makeError("match-to-cpp translation failed");
    }
  }
  errStream.flush();

  std::string out;
  llvm::raw_string_ostream os(out);
  os << "{\"ok\":true,\"text\":";
  emitJsonString(os, cppText);
  if (!errBuf.empty()) {
    os << ",\"warn\":";
    emitJsonString(os, errBuf);
  }
  os << "}";
  os.flush();
  return toHeapString(out);
}
