import {
  ChangeDetectionStrategy,
  Component,
  PendingTasks,
  REQUEST_CONTEXT,
  inject,
  signal,
} from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { RequestContextChildServerComponent } from "./request-context-child.server-component";
import { RequestContextFixtureService } from "./request-context.service";
import type { RequestContextFixtureValue } from "./request-context-types";

@ServerComponent()
@Component({
  selector: "request-context-parent",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RequestContextChildServerComponent],
  providers: [RequestContextFixtureService],
  template: `<p data-request-context-parent>{{ parentId }}</p>
    <p data-request-context-service>{{ serviceValue() }}</p>
    <request-context-child />`,
})
export class RequestContextParentServerComponent {
  private readonly context = inject(REQUEST_CONTEXT, {
    optional: true,
  }) as RequestContextFixtureValue | null;
  private readonly service = inject(RequestContextFixtureService);
  protected readonly parentId = this.context?.id ?? "missing";
  protected readonly serviceValue = signal("pending");

  constructor() {
    void inject(PendingTasks).run(async () => {
      this.serviceValue.set(await this.service.observe());
    });
  }
}
