const preexisting = Symbol("preexisting-metadata-symbol");
Symbol.metadata = preexisting;

const { Controller } = await import("@strata/core");

if (Symbol.metadata !== preexisting) {
  console.log("SYMBOL_PRESERVED false");
  process.exit(1);
}

console.log("SYMBOL_PRESERVED true");
console.log("CONTROLLER_TYPE", typeof Controller);
