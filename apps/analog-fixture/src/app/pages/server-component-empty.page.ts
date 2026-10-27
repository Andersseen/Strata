import { ChangeDetectionStrategy, Component } from "@angular/core";

import { EmptyServerComponent } from "../server-component-empty/empty.server-component";

@Component({
  selector: "app-server-component-empty-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyServerComponent],
  template: "<main><strata-empty-host /></main>",
})
export default class ServerComponentEmptyPage {}
