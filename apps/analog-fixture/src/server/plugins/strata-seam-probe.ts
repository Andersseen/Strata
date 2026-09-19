import { defineNitroPlugin } from "nitropack/runtime";

import { describeShape, recordSeamSnapshot } from "../strata/seam-probe";

// The plugin only *observes* the app Nitro passes in: it never registers
// routes, patches or wraps it.
export default defineNitroPlugin((nitroApp) => {
  recordSeamSnapshot({
    nitroAppKeys: Object.keys(nitroApp).sort(),
    h3App: describeShape(nitroApp.h3App),
    router: describeShape(nitroApp.router),
  });
});
