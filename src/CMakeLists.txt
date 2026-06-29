cmake_minimum_required(VERSION 3.22)
project(MlirOptWasm CXX)

find_package(LLVM REQUIRED CONFIG)
find_package(MLIR REQUIRED CONFIG)

list(APPEND CMAKE_MODULE_PATH "${MLIR_CMAKE_DIR}")
list(APPEND CMAKE_MODULE_PATH "${LLVM_CMAKE_DIR}")
include(LLVMConfig)
include(MLIRConfig)

include_directories(${LLVM_INCLUDE_DIRS} ${MLIR_INCLUDE_DIRS})

get_property(ALL_MLIR_LIBS GLOBAL PROPERTY MLIR_ALL_LIBS)

add_executable(mlir-opt mlir-opt.cpp highlight.cpp)
target_link_libraries(mlir-opt PUBLIC ${ALL_MLIR_LIBS} ${LLVM_AVAILABLE_LIBS})

# The match-to-cpp translation parses the arith dialect's ODS at runtime to
# emit concrete-typed matchers, so the `.td` closure must live in the wasm
# MEMFS. MLIR_ODS_DIR points at a staged tree of the needed `.td` files (set by
# the Nix build); `--embed-file <dir>@/ods` bakes them in at /ods, matching the
# include root and arith ODS path hardcoded in highlight.cpp.
if(NOT DEFINED MLIR_ODS_DIR)
  message(FATAL_ERROR "MLIR_ODS_DIR must point at the staged ODS .td tree")
endif()

# Emscripten link flags: produce an ES6 module that can be imported
# from a browser, with a growable heap big enough for real workloads.
set_target_properties(mlir-opt PROPERTIES
  SUFFIX ".mjs"
  LINK_FLAGS "-s ENVIRONMENT=web -s EXIT_RUNTIME=1 -s EXPORT_ES6=1 -s MODULARIZE=1 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB -s STACK_SIZE=5MB -s WASM_BIGINT=1 --embed-file ${MLIR_ODS_DIR}@/ods -s EXPORTED_FUNCTIONS=_main,_free,_malloc,_mlir_highlight,_mlir_opt_run,_mlir_translate_match_to_cpp -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,callMain,UTF8ToString"
)
