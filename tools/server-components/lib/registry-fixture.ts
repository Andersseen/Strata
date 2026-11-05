import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./harness.ts";

const registryV1Fixtures = join(
  repoRoot,
  "tests",
  "server-component-package-consumer",
  "registry-v1",
  "src",
  "app",
  "product",
);

/**
 * Adapts a copy of the shared packed-consumer fixture to the contract of a PUBLISHED artifact,
 * for every gate that installs `@strata-sc/server-components` from the registry
 * (`test:server-component-registry-consumer`, `test:server-components:deployed-cloudflare`).
 *
 * The published artifact may be an older release, so its consumer stays on the flat protocol-v1
 * page its verifier checks; the packed-package gate qualifies the candidate's structured-props
 * and package-island fixture. The installed-island Server Component and page need the private
 * test library, which no registry gate installs. Kept in one place: the Cloudflare registry gate
 * copied the fixture without this adaptation from 2026-10-21 on and could not build
 * (docs/research/m3-m4-contract-stabilization.md).
 */
export function adaptFixtureForPublishedArtifact(consumerDir: string): void {
  const app = join(consumerDir, "src", "app");

  for (const [source, destination] of [
    ["add-to-cart.component.fixture", "product/add-to-cart.component.ts"],
    ["product-details.server-component.fixture", "product/product-details.server-component.ts"],
    // The candidate's app config uses `provideSkewRecovery`, which an older artifact lacks.
    ["../app.config.ts.fixture", "app.config.ts"],
  ] as const)
    cpSync(join(registryV1Fixtures, source), join(app, destination));

  for (const extra of ["product/stock-panel.server-component.ts", "pages/mixed.page.ts"])
    rmSync(join(app, extra), { force: true });
}
