{
  description = "Build mlir-opt as a WebAssembly module via Emscripten.";

  # Inputs are pinned in flake.lock. Bump `ref` here to upgrade LLVM/MLIR.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    llvm-project = {
      url = "github:jumerckx/llvm-project?ref=jm/pdl_constr_cpp";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, llvm-project }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        llvmVersion = "21.1.0";

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
          src = ./src;

          nativeBuildInputs = with pkgs; [ cmake ninja emscripten ];

          configurePhase = ''
            runHook preConfigure
            ${emSetupCache}

            # Stage the arith dialect's ODS `.td` closure so it can be embedded
            # into the wasm MEMFS (--embed-file in CMakeLists). The match-to-cpp
            # translation parses ArithOps.td at runtime to emit concrete-typed
            # matchers. ArithOps.td pulls in mlir/IR and mlir/Interfaces, so we
            # stage those three subtrees (structure preserved); no other
            # dialect's ODS is included, matching the "arith only" intent.
            odsDir=$PWD/ods-staging
            odsSrc=${mlir-wasm-sysroot}/include
            # install -D recreates the parent dirs writable (the Nix store
            # sources are read-only, so a plain `cp --parents` can't).
            for f in $(cd $odsSrc && find mlir/IR mlir/Interfaces mlir/Dialect/Arith -name '*.td'); do
              install -D -m644 "$odsSrc/$f" "$odsDir/$f"
            done

            emcmake cmake -G Ninja -S . -B build \
              -DCMAKE_BUILD_TYPE=Release \
              -DLLVM_DIR=${mlir-wasm-sysroot}/lib/cmake/llvm \
              -DMLIR_DIR=${mlir-wasm-sysroot}/lib/cmake/mlir \
              -DMLIR_ODS_DIR=$odsDir
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
        # Build the optimized static site. esbuild bundles + minifies each
        # page's JS (entry + editor + the @codemirror packages) into a
        # code-split, content-hashed file; styles.css and the wasm bundle get
        # hashed names too; and web/build.mjs rewrites the HTML + service worker
        # to reference them. The result in $out is what gets uploaded to GitHub
        # Pages, or served locally by pointing a static file server at `result/`.
        #
        # buildNpmPackage gives us the @codemirror node_modules (src is the
        # ./web/codemirror package: a package.json + lockfile + a small
        # re-export entry; no upstream CodeMirror source is checked in). The rest
        # of the page sources are copied in alongside it so esbuild can resolve
        # `@codemirror/*` from ./node_modules; the bundler itself is Nix-provided
        # (pkgs.esbuild), so it stays out of the lockfile.
        site = pkgs.buildNpmPackage {
          pname = "mlir-opt-wasm-site";
          version = "1.0.0";
          src = ./web/codemirror;

          npmDepsHash = "sha256-y0Ddhop9QxFN1TWdpl1d6R6CIIUylF3sZsFWnk9tYnM=";

          dontNpmBuild = true;
          nativeBuildInputs = [ pkgs.esbuild pkgs.nodejs ];

          # web/build.mjs reads this to hash + copy the wasm artifacts in.
          MLIR_WASM_DIR = mlir-opt-wasm;

          buildPhase = ''
            runHook preBuild
            # The unpacked src root holds the codemirror package.json + the
            # installed node_modules. Bring the page sources in beside them and
            # expose the CodeMirror re-export entry as ./codemirror.js (what
            # editor.js imports).
            cp ${./web}/*.js ${./web}/*.mjs ${./web}/*.html ${./web}/*.css .
            cp entry.js codemirror.js
            node build.mjs
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r dist/. $out/
            runHook postInstall
          '';
        };

        devShell = pkgs.mkShell {
          # `npm install` inside web/codemirror/ to regenerate
          # package-lock.json whenever the dep versions in package.json change;
          # `node web/build.mjs` (with esbuild on PATH) to build the site.
          buildInputs = [ pkgs.nodejs pkgs.esbuild ];
        };
      in {
        packages = {
          default = site;
          inherit llvm-native-tblgens mlir-wasm-sysroot mlir-opt-wasm site;
        };
        devShells.default = devShell;
      });
}
