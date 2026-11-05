import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { ProtectedTenantIsland } from "./protected-tenant-island.component";
import { RENDER_FAILURE_CANARY } from "./render-failure-dependency";

/** A client boundary whose props are not serializable: Strata refuses the boundary during SSR. */
@ServerComponent()
@Component({
  selector: "render-failure-boundary",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProtectedTenantIsland, StrataClientBoundary],
  template: `<p id="partial-before">Rendered before the boundary</p>
    <protected-tenant-island tenant="alpha" [strataClient]="{ tenant: unserializable }" />`,
})
export class RenderFailureBoundary {
  protected readonly unserializable = () => RENDER_FAILURE_CANARY;
}
