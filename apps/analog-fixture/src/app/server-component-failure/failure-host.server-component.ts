import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import { FailureIslandComponent } from "./failure-island.component";

/**
 * One Server Component host with three client boundaries. The failures page
 * renders three of them (`data-host` A, B, C): each is its own Strata
 * hydration transaction, so one host failing must leave the others hydrated.
 */
@ServerComponent()
@Component({
  selector: "failure-host",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FailureIslandComponent, StrataClientBoundary],
  template: `<section>
    <p data-ssr-text>Server rendered host</p>
    <failure-island
      data-island="1"
      [label]="'1'"
      [start]="0"
      [strataClient]="{ label: '1', start: 0 }"
    />
    <failure-island
      data-island="2"
      [label]="'2'"
      [start]="0"
      [strataClient]="{ label: '2', start: 0 }"
    />
    <failure-island
      data-island="3"
      [label]="'3'"
      [start]="0"
      [strataClient]="{ label: '3', start: 0 }"
    />
  </section>`,
})
export class FailureHostServerComponent {}
