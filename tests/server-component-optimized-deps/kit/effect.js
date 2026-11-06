import "@strata-sc/server-components/server-only";
import { PRIVATE_IMPL } from "./internal/impl.js";

// Top-level work: a worker bundle keeps it, so an unguarded worker graph shows the markers.
globalThis.strataFixtureEffect = `STRATA_FIXTURE_SERVER_ONLY:${PRIVATE_IMPL}`;
