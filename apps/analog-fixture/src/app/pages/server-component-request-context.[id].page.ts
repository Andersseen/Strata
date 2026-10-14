import { ChangeDetectionStrategy, Component } from "@angular/core";

import { RequestContextIslandComponent } from "../server-component-request-context/request-context-island.component";
import { RequestContextParentServerComponent } from "../server-component-request-context/request-context-parent.server-component";

@Component({
  selector: "app-server-component-request-context-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RequestContextParentServerComponent, RequestContextIslandComponent],
  template: `<main><request-context-parent /><request-context-island /></main>`,
})
export default class ServerComponentRequestContextPage {}
