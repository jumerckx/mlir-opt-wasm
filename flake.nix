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

        # --- CodeMirror bundle ------------------------------------------------
        # Pull the four @codemirror sub-packages we need via npm, then bundle
        # them through esbuild into a single ESM file. Hosting the result next
        # to the wasm gives the page zero runtime CDN dependencies and avoids
        # the multi-instance-of-@codemirror/state Facet/instanceof pitfalls.
        #
        # The build inputs (./web/codemirror/) are just a package.json + a
        # small re-export entry; no upstream CodeMirror source is checked in.
        codemirror-bundle = pkgs.buildNpmPackage {
          pname = "mlir-opt-codemirror-bundle";
          version = "1.0.0";
          src = ./web/codemirror;

          npmDepsHash = "sha256-y0Ddhop9QxFN1TWdpl1d6R6CIIUylF3sZsFWnk9tYnM=";

          dontNpmBuild = true;
          nativeBuildInputs = [ pkgs.esbuild ];

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            esbuild entry.js \
              --bundle \
              --format=esm \
              --target=es2020 \
              --outfile=$out/codemirror.js
            runHook postInstall
          '';
        };

        # --- Stage 4 ----------------------------------------------------------
        # Assemble the static site: HTML + JS from ./web/ plus the wasm
        # artifacts and the CodeMirror bundle, all at the root of $out. This is
        # what gets uploaded to GitHub Pages, and what you serve locally by
        # pointing any static file server at the built `result/` directory.
        site = pkgs.runCommand "mlir-opt-wasm-site" { } ''
          mkdir -p $out
          cp ${./web/index.html}              $out/index.html
          cp ${./web/pdl.html}                $out/pdl.html
          cp ${./web/styles.css}              $out/styles.css
          cp ${./web/app.js}                  $out/app.js
          cp ${./web/pdl.js}                  $out/pdl.js
          cp ${./web/editor.js}               $out/editor.js
          cp ${codemirror-bundle}/codemirror.js $out/codemirror.js
          cp ${mlir-opt-wasm}/mlir-opt.mjs    $out/mlir-opt.mjs
          cp ${mlir-opt-wasm}/mlir-opt.wasm   $out/mlir-opt.wasm
          cp ${./web/sw.js}                   $out/sw.js
          chmod -R u+w $out

          # Stamp the service worker with a content hash of every asset. Any
          # rebuild that changes an asset changes this hash, hence sw.js itself,
          # which is how the browser learns to install a fresh cache and purge
          # the old one (see web/sw.js). Replaces the old Date.now() cache-bust.
          ver=$(cat $out/index.html $out/pdl.html $out/styles.css \
                    $out/app.js $out/pdl.js $out/editor.js \
                    $out/codemirror.js $out/mlir-opt.mjs $out/mlir-opt.wasm \
                | sha256sum | cut -c1-16)
          substituteInPlace $out/sw.js --replace-fail __BUILD_VERSION__ "$ver"
        '';

        devShell = pkgs.mkShell {
          # `npm install` inside web/codemirror/ to regenerate
          # package-lock.json whenever the dep versions in package.json change.
          buildInputs = [ pkgs.nodejs pkgs.esbuild ];
        };
      in {
        packages = {
          default = site;
          inherit llvm-native-tblgens mlir-wasm-sysroot mlir-opt-wasm
                  codemirror-bundle site;
        };
        devShells.default = devShell;
      });
}
