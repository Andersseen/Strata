import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";
import type { ClientBoundaryProps } from "@strata-sc/server-components";

import { FailureIslandComponent } from "./failure-island.component";
import { FAILURE_SCENARIO, FailureRepository, FailureService } from "./failure-scenario";

const unsupported = (start: unknown): ClientBoundaryProps =>
  ({ label: "1", start }) as unknown as ClientBoundaryProps;

/**
 * Test-only: a Server Component that fails in the way its route's `:mode`
 * says. `none` renders normally (the control). `constructor`, `service` and
 * `template` fail Angular's server render; `instance`, `nested` and `nan` fail
 * the `[strataClient]` serialization. Every message is synthetic and neutral.
 */
@ServerComponent()
@Component({
  selector: "failure-scenario",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FailureIslandComponent, StrataClientBoundary],
  template: `<section data-failure-component>
    <p data-failure-ssr>Scenario rendered</p>
    <failure-island data-island="1" [label]="'1'" [start]="0" [strataClient]="props" />
    <p data-failure-tail>{{ tail() }}</p>
  </section>`,
})
export class FailureScenarioServerComponent {
  private readonly scenario = inject(FAILURE_SCENARIO);

  protected readonly service = inject(FailureService);
  protected readonly props: ClientBoundaryProps = this.propsFor();

  constructor() {
    if (this.scenario === "constructor") throw new Error("Synthetic constructor failure");
  }

  protected tail(): string {
    if (this.scenario === "template") throw new Error("Synthetic template failure");

    return "tail rendered";
  }

  private propsFor(): ClientBoundaryProps {
    switch (this.scenario) {
      case "instance":
        return unsupported(new FailureRepository());
      case "nested":
        return unsupported({ rows: 1 });
      case "nan":
        return unsupported(Number.NaN);
      default:
        return { label: "1", start: 0 };
    }
  }
}
