import { H3, HTTPError } from "h3";

// SPEC-002 minimal H3-only reproduction: imports only the public H3 root entry
// (no Strata package), instantiates an app, registers a native GET and uses
// HTTPError.isError, exactly enough to separate an H3 declaration problem
// from a Strata declaration problem. This file is a typecheck-only artifact:
// the matrix runner never executes it, only `tsc --noEmit`s it per case.
const app = new H3();

app.get("/native", () => ({ native: true }));

const candidate: unknown = new Error("probe");

console.log("IS_ERROR", HTTPError.isError(candidate));
