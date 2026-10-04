import { ChangeDetectionStrategy, Component } from "@angular/core";

import { DeferShowcaseServerComponent } from "../defer/defer-showcase.server-component";

/** Server Components + Angular `@defer` inside client islands. */
@Component({
  selector: "app-server-component-defer-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DeferShowcaseServerComponent],
  template: `<main><defer-showcase /></main>`,
})
export default class ServerComponentDeferPage {}
