/**
 * `import "@strata-sc/server-components/server-only";` asserts, at build
 * time, that the importing module must never enter a browser graph. The
 * `@strata-sc/server-components/vite` plugin finds the assertion in source and
 * fails the client build if a marked module (or a barrel re-exporting one)
 * is reached. This entry is intentionally empty: there is nothing to run and
 * nothing to register, in Node SSR and in workerd alike. Experimental, not
 * public API.
 */
export {};
