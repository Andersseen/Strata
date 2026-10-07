import { ChangeDetectionStrategy, Component, PendingTasks, inject, signal } from "@angular/core";
import { ServerComponent } from "@strata-sc/server-components";

import { SecurityRepository } from "./security-repository";
import { SECURITY_SCENARIO } from "./security-scenario";

const LABELS: Readonly<Record<string, string>> = { a: "PUBLIC_A", b: "PUBLIC_B" };
/** Keeps each render open so that overlapping requests genuinely interleave. */
const HOLD_MS = 250;

/**
 * Test-only: renders a request-varying PUBLIC value (the route's `:id`), after
 * an asynchronous hold, next to a server-only verification. Used to observe
 * that overlapping requests do not see each other's value.
 */
@ServerComponent()
@Component({
  selector: "security-request",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-request>{{ label() }}</p>
    <p data-verification>Internal verification: {{ verification }}</p>`,
})
export class SecurityRequestServerComponent {
  private readonly id = inject(SECURITY_SCENARIO) ?? "";

  protected readonly label = signal("pending");
  protected readonly verification = inject(SecurityRepository).verifyInternalConfiguration()
    ? "ready"
    : "not ready";

  constructor() {
    void inject(PendingTasks).run(async () => {
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
      this.label.set(LABELS[this.id] ?? "unknown");
    });
  }
}
