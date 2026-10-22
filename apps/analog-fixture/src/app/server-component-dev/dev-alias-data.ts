// A synthetic canary, not a secret. Public at first: the dev gate
// (`pnpm test:server-component-dev`) marks this module server-only while Vite is
// running, reaches it through an aliased re-export, and proves no browser
// realm receives it until the assertion is removed again.
export const DEV_ALIAS_CANARY = "STRATA_DEV_ALIAS_CANARY_E41A7C0B96D2";
export const aliasedValue = "alias-ok";
