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

# Emscripten link flags: produce an ES6 module that can be imported
# from a browser, with a growable heap big enough for real workloads.
set_target_properties(mlir-opt PROPERTIES
  SUFFIX ".mjs"
  LINK_FLAGS "-s ENVIRONMENT=web -s EXIT_RUNTIME=1 -s EXPORT_ES6=1 -s MODULARIZE=1 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB -s STACK_SIZE=5MB -s WASM_BIGINT=1 -s EXPORTED_FUNCTIONS=_main,_free,_malloc,_mlir_highlight,_mlir_highlight_clean -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,callMain,UTF8ToString"
)
