import { ChangeDetectionStrategy, Component, inject, REQUEST_CONTEXT } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import type { RequestContextFixtureValue } from "./request-context-types";

@ServerComponent()
@Component({
  selector: "request-context-child",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-request-context-child>{{ id }}</p>`,
})
export class RequestContextChildServerComponent {
  private readonly context = inject(REQUEST_CONTEXT, {
    optional: true,
  }) as RequestContextFixtureValue | null;
  protected readonly id = this.context?.id ?? "missing";
}
