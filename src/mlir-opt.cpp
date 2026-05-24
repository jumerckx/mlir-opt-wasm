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
