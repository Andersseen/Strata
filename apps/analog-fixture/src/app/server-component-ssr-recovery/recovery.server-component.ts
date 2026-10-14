import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { RecoveryRepository } from "./recovery.repository";
import { RecoveryService } from "./recovery.service";

/**
 * Fixture-only example of local recovery from an expected server repository
 * failure. Unexpected errors are deliberately still allowed to reach Angular.
 */
@ServerComponent()
@Component({
  selector: "server-component-ssr-recovery",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@switch (result.kind) {
    @case ("success") {
      <section data-recovery-state="success">
        <h2>Inventory loaded</h2>
        <p data-recovery-source="repository">{{ result.itemCount }} items available.</p>
      </section>
    }
    @case ("expected-failure") {
      <section data-recovery-state="expected-failure" role="status">
        <h2>Inventory temporarily unavailable</h2>
        <p>Please try again later.</p>
      </section>
    }
    @default {
      <section data-recovery-state="invalid-context" role="alert">
        <h2>We could not load this request</h2>
        <p>Please refresh and try again.</p>
      </section>
    }
  }`,
  providers: [RecoveryRepository, RecoveryService],
})
export class RecoveryServerComponent {
  protected readonly result = inject(RecoveryService).read();
}
