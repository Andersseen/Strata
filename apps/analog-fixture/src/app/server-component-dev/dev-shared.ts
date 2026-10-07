// A synthetic canary, not a secret. Public at first: the dev gate
// (`pnpm test:server-component-dev`) proves a browser receives it, then marks
// this module server-only while Vite is running and proves no new browser
// realm receives it.
export const DEV_SHARED_CANARY = "STRATA_DEV_SHARED_CANARY_5B2C9E71D4A8";

export function devShared(): string {
  return `shared:${DEV_SHARED_CANARY.length}`;
}
