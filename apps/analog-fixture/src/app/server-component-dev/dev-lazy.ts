// Loaded through `import()` by the client island. The dev gate marks it
// server-only while Vite is running: the dynamic import must then fail.
export const DEV_LAZY_CANARY = "STRATA_DEV_LAZY_CANARY_C61F0A9D83E2";

export const devLazy = `lazy:${DEV_LAZY_CANARY.length}`;
