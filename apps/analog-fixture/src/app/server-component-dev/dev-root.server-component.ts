import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { DevChildComponent } from "./dev-child.component";
import { DevIslandComponent } from "./dev-island.component";
import { readDevRepository } from "./dev-repository";

/**
 * The dev gate's Server Component (`pnpm test:server-component-dev`): a visible
 * server message, an ordinary server-owned child with a server-owned
 * `templateUrl` grandchild, a server-only repository, and one client island.
 */
@ServerComponent()
@Component({
  selector: "dev-root",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DevChildComponent, DevIslandComponent, StrataClientBoundary],
  template: `<section data-dev-root [attr.data-dev-repository]="repository">
    <h2 data-dev-message>Server message A</h2>
    <dev-child />
    <dev-island [strataClient]="{}" />
  </section>`,
})
export class DevRootServerComponent {
  protected readonly repository = readDevRepository();
}
