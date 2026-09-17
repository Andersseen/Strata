const preexisting = Symbol("preexisting-metadata-symbol");
Object.defineProperty(Symbol, "metadata", {
  configurable: true,
  value: preexisting,
});

const { Controller } = await import("@strata/core");

const currentMetadata = Symbol.metadata as symbol | undefined;

if (currentMetadata !== preexisting) {
  console.log("SYMBOL_PRESERVED false");
  process.exit(1);
}

console.log("SYMBOL_PRESERVED true");
console.log("CONTROLLER_TYPE", typeof Controller);
