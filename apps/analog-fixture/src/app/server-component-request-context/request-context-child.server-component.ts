import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  REQUEST_CONTEXT,
} from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import type { RequestContextFixtureValue } from "./request-context-types";
import { RequestContextFixtureService } from "./request-context.service";

@ServerComponent()
@Component({
  selector: "request-context-child",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-request-context-child>{{ id }}</p>
    <p data-request-context-service-instance>{{ sameService() ? "shared" : "different" }}</p>`,
})
export class RequestContextChildServerComponent {
  private readonly context = inject(REQUEST_CONTEXT, {
    optional: true,
  }) as RequestContextFixtureValue | null;
  private readonly service = inject(RequestContextFixtureService);
  readonly parentService = input<RequestContextFixtureService | null>(null);
  protected readonly id = this.context?.id ?? "missing";
  protected readonly sameService = computed(() => this.service === this.parentService());
}
