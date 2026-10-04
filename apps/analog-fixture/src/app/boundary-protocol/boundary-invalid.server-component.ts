import { ChangeDetectionStrategy, Component } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import type { ClientBoundaryProps } from "@strata-sc/server-components";

import { BoundaryCounterComponent } from "./boundary-counter.component";

/**
 * Negative fixture: a cast smuggles a Date past `ClientBoundaryProps`. The
 * boundary's runtime validation must fail SSR of this route instead of
 * dropping or coercing the value.
 */
@ServerComponent()
@Component({
  selector: "boundary-invalid",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoundaryCounterComponent, StrataClientBoundary],
  template: `<boundary-counter [start]="0" [strataClient]="props" />`,
})
export class BoundaryInvalidServerComponent {
  protected readonly props = { start: 0, createdAt: new Date(0) } as unknown as ClientBoundaryProps;
}
