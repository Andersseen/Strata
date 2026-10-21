import { ChangeDetectionStrategy, Component } from "@angular/core";
import { StrataDocumentLink } from "@strata-sc/server-components/navigation";

import { DevBoundaryServerComponent } from "../server-component-dev/dev-boundary.server-component";
import { DevRootServerComponent } from "../server-component-dev/dev-root.server-component";

/**
 * The page of `pnpm test:server-component-dev`: the dev server's graph
 * regeneration and reload semantics (docs/research/server-component-dev-hmr.md).
 * The gate edits the files under `server-component-dev/` while `vite` runs and
 * restores them byte for byte.
 */
@Component({
  selector: "app-server-component-dev-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DevBoundaryServerComponent, DevRootServerComponent, StrataDocumentLink],
  template: `<main>
    <dev-root />
    <dev-boundary />
    <nav>
      <a
        data-dev-nav-product
        [strataDocumentLink]="['/server-component']"
        [queryParams]="{ from: 'dev' }"
        fragment="details"
        >Product route (document link)</a
      >
    </nav>
  </main>`,
})
export default class ServerComponentDevPage {}
