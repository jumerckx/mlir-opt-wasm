{
  description = "Build mlir-opt as a WebAssembly module via Emscripten.";

  # Inputs are pinned in flake.lock. Bump `ref` here to upgrade LLVM/MLIR.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    llvm-project = {
      url = "github:llvm/llvm-project?ref=llvmorg-21.1.0";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, llvm-project }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        llvmVersion = "21.1.0";

        # Minimal mlir-opt driver: register every upstream dialect & pass.
        templateCpp = pkgs.writeText "mlir-opt-template.cpp" ''
          #include "mlir/IR/Dialect.h"
          #include "mlir/InitAllDialects.h"
          #include "mlir/InitAllPasses.h"
          #include "mlir/Tools/mlir-opt/MlirOptMain.h"

          int main(int argc, char **argv) {
            mlir::registerAllPasses();
            mlir::DialectRegistry registry;
            mlir::registerAllDialects(registry);
            return mlir::asMainReturnCode(
              mlir::MlirOptMain(argc, argv, "mlir-opt (wasm)\n", registry));
          }
        '';

        templateCMake = pkgs.writeText "CMakeLists.txt" ''
          cmake_minimum_required(VERSION 3.22)
          project(MlirOptWasm CXX)

          find_package(LLVM REQUIRED CONFIG)
          find_package(MLIR REQUIRED CONFIG)

          list(APPEND CMAKE_MODULE_PATH "''${MLIR_CMAKE_DIR}")
          list(APPEND CMAKE_MODULE_PATH "''${LLVM_CMAKE_DIR}")
          include(LLVMConfig)
          include(MLIRConfig)

          include_directories(''${LLVM_INCLUDE_DIRS} ''${MLIR_INCLUDE_DIRS})

          get_property(ALL_MLIR_LIBS GLOBAL PROPERTY MLIR_ALL_LIBS)

          add_executable(mlir-opt mlir-opt-template.cpp)
          target_link_libraries(mlir-opt PUBLIC ''${ALL_MLIR_LIBS} ''${LLVM_AVAILABLE_LIBS})

          # Emscripten link flags: produce an ES6 module that can be imported
          # from a browser, with a growable heap big enough for real workloads.
          set_target_properties(mlir-opt PROPERTIES
            SUFFIX ".mjs"
            LINK_FLAGS "-s ENVIRONMENT=web -s EXIT_RUNTIME=1 -s EXPORT_ES6=1 -s MODULARIZE=1 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB -s STACK_SIZE=5MB -s WASM_BIGINT=1 -s EXPORTED_FUNCTIONS=_main,_free,_malloc -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,FS,callMain"
          )
        '';

        # Emscripten in nixpkgs ships a read-only cache; emcc wants to populate
        # one at build time. Copy it into $TMPDIR and point EM_CACHE there.
        emSetupCache = ''
          export EM_CACHE=$TMPDIR/.emcache
          mkdir -p $EM_CACHE
          if [ -d ${pkgs.emscripten}/share/emscripten/cache ]; then
            cp -rL ${pkgs.emscripten}/share/emscripten/cache/. $EM_CACHE/
          fi
          chmod -R u+w $EM_CACHE
        '';

        # --- Stage 1 ----------------------------------------------------------
        # Native tblgen tools. MLIR's CMake invokes these on the host during
        # cross-compilation, so we must build them for the build platform
        # before we can target wasm.
        llvm-native-tblgens = pkgs.stdenv.mkDerivation {
          pname = "llvm-mlir-native-tblgens";
          version = llvmVersion;
          src = llvm-project;

          nativeBuildInputs = with pkgs; [ cmake ninja python3 ];

          configurePhase = ''
            runHook preConfigure
            cmake -G Ninja -S llvm -B build \
              -DCMAKE_BUILD_TYPE=Release \
              -DLLVM_TARGETS_TO_BUILD=WebAssembly \
              -DLLVM_ENABLE_PROJECTS="mlir" \
              -DLLVM_INCLUDE_TESTS=OFF \
              -DLLVM_INCLUDE_EXAMPLES=OFF \
              -DLLVM_INCLUDE_BENCHMARKS=OFF
            runHook postConfigure
          '';

          buildPhase = ''
            runHook preBuild
            cmake --build build --target llvm-tblgen mlir-tblgen mlir-linalg-ods-yaml-gen
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/bin
            install -m755 build/bin/llvm-tblgen $out/bin/
            install -m755 build/bin/mlir-tblgen $out/bin/
            install -m755 build/bin/mlir-linalg-ods-yaml-gen $out/bin/
            runHook postInstall
          '';
        };

        # --- Stage 2 ----------------------------------------------------------
        # Cross-compile MLIR (and the bits of LLVM it needs) to wasm and
        # `make install` the static libraries, headers, and CMake configs into
        # $out. We don't build any of LLVM's own tools here -- just the libs.
        mlir-wasm-sysroot = pkgs.stdenv.mkDerivation {
          pname = "mlir-wasm-sysroot";
          version = llvmVersion;
          src = llvm-project;

          nativeBuildInputs = [
            pkgs.cmake
            pkgs.ninja
            pkgs.python3
            pkgs.emscripten
            llvm-native-tblgens
          ];

          configurePhase = ''
            runHook preConfigure
            ${emSetupCache}
            emcmake cmake -G Ninja -S llvm -B build \
              -DCMAKE_INSTALL_PREFIX=$out \
              -DCMAKE_BUILD_TYPE=Release \
              -DLLVM_TARGETS_TO_BUILD=WebAssembly \
              -DLLVM_ENABLE_PROJECTS="mlir" \
              -DLLVM_ENABLE_DUMP=OFF \
              -DLLVM_ENABLE_ASSERTIONS=OFF \
              -DLLVM_ENABLE_BACKTRACES=OFF \
              -DLLVM_ENABLE_THREADS=OFF \
              -DLLVM_ENABLE_ZLIB=OFF \
              -DLLVM_ENABLE_ZSTD=OFF \
              -DLLVM_ENABLE_TERMINFO=OFF \
              -DLLVM_ENABLE_LIBXML2=OFF \
              -DLLVM_BUILD_TOOLS=OFF \
              -DLLVM_BUILD_LLVM_DYLIB=OFF \
              -DLLVM_INCLUDE_TESTS=OFF \
              -DLLVM_INCLUDE_EXAMPLES=OFF \
              -DLLVM_INCLUDE_BENCHMARKS=OFF \
              -DLLVM_INCLUDE_UTILS=OFF \
              -DLLVM_PARALLEL_LINK_JOBS=2 \
              -DLLVM_TABLEGEN=${llvm-native-tblgens}/bin/llvm-tblgen \
              -DMLIR_TABLEGEN=${llvm-native-tblgens}/bin/mlir-tblgen \
              -DMLIR_LINALG_ODS_YAML_GEN=${llvm-native-tblgens}/bin/mlir-linalg-ods-yaml-gen
            runHook postConfigure
          '';

          buildPhase = ''
            runHook preBuild
            cmake --build build --target install
            runHook postBuild
          '';

          dontInstall = true;
        };

        # --- Stage 3 ----------------------------------------------------------
        # Compile the tiny driver against the installed wasm sysroot. Output is
        # `mlir-opt.mjs` (ES module loader) + `mlir-opt.wasm` (the binary).
        mlir-opt-wasm = pkgs.stdenv.mkDerivation {
          pname = "mlir-opt-wasm";
          version = llvmVersion;
          dontUnpack = true;

          nativeBuildInputs = with pkgs; [ cmake ninja emscripten ];

          configurePhase = ''
            runHook preConfigure
            ${emSetupCache}
            mkdir -p src && cd src
            cp ${templateCpp} mlir-opt-template.cpp
            cp ${templateCMake} CMakeLists.txt
            emcmake cmake -G Ninja -S . -B build \
              -DCMAKE_BUILD_TYPE=Release \
              -DLLVM_DIR=${mlir-wasm-sysroot}/lib/cmake/llvm \
              -DMLIR_DIR=${mlir-wasm-sysroot}/lib/cmake/mlir
            runHook postConfigure
          '';

          buildPhase = ''
            runHook preBuild
            cmake --build build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp build/mlir-opt.mjs $out/
            cp build/mlir-opt.wasm $out/
            runHook postInstall
          '';
        };

        # --- Stage 4 ----------------------------------------------------------
        # Assemble the static site: HTML + JS from ./web/ plus the wasm
        # artifacts, all at the root of $out. This is what gets uploaded to
        # GitHub Pages, and what you serve locally via `python3 web/serve.py
        # result/`.
        site = pkgs.runCommand "mlir-opt-wasm-site" { } ''
          mkdir -p $out
          cp ${./web/index.html} $out/index.html
          cp ${./web/app.js}     $out/app.js
          cp ${mlir-opt-wasm}/mlir-opt.mjs  $out/mlir-opt.mjs
          cp ${mlir-opt-wasm}/mlir-opt.wasm $out/mlir-opt.wasm
          chmod -R u+w $out
        '';
      in {
        packages = {
          default = site;
          inherit llvm-native-tblgens mlir-wasm-sysroot mlir-opt-wasm site;
        };
      });
}
