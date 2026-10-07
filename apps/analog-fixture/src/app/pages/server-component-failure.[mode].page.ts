import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { FailureScenarioServerComponent } from "../server-component-failure/failure-scenario.server-component";
import { FAILURE_SCENARIO, FailureService } from "../server-component-failure/failure-scenario";

/**
 * Test-only: the Server Component failure route (`:mode`). The page has its
 * own markup around the Server Component, to observe what survives its failure.
 */
@Component({
  selector: "app-server-component-failure-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FailureScenarioServerComponent],
  providers: [
    {
      provide: FAILURE_SCENARIO,
      useFactory: () => inject(ActivatedRoute).snapshot.paramMap.get("mode"),
    },
    {
      provide: FailureService,
      useFactory: () => {
        if (inject(FAILURE_SCENARIO) === "service") throw new Error("Synthetic service failure");

        return new FailureService();
      },
    },
  ],
  template: `<main data-failure-page>
    <h1>Failure scenario</h1>
    <failure-scenario />
    <p data-failure-sibling>Page sibling</p>
    <a href="/server-component-failures">Healthy origin</a>
  </main>`,
})
export default class ServerComponentFailurePage {}
