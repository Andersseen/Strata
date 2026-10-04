import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { DeferServerChildComponent } from "./defer-server-child.component";

// Emitted only by this server component's implementation.
// Rendered only as its length, so the HTML never carries it.
const SERVER_PARENT_MARKER = "STRATA_DEFER_SERVER_PARENT_MARKER";

/**
 * Supported `@defer` composition (`pnpm test:server-component-defer`):
 * Server Component → ordinary server-owned child → `[strataClient]` islands
 * → Angular-owned `@defer` inside each island. No `@defer` in a server-owned
 * template.
 */
@ServerComponent()
@Component({
  selector: "defer-showcase",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DeferServerChildComponent],
  template: `<section [attr.data-evidence]="marker.length">
    <h1>Defer showcase</h1>
    <defer-server-child />
  </section>`,
})
export class DeferShowcaseServerComponent {
  protected readonly marker = SERVER_PARENT_MARKER;
}
