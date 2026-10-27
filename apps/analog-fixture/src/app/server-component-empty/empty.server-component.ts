import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

@ServerComponent()
@Component({
  selector: "strata-empty-host",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: "<p>Empty client boundary host</p>",
})
export class EmptyServerComponent {}
