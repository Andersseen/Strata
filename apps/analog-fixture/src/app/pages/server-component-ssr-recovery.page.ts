import { ChangeDetectionStrategy, Component } from "@angular/core";

import { RecoveryServerComponent } from "../server-component-ssr-recovery/recovery.server-component";

/** Fixture route for the explicit expected-service recovery contract. */
@Component({
  selector: "app-server-component-ssr-recovery-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RecoveryServerComponent],
  template: `<main data-recovery-page>
    <h1>Server Component SSR recovery</h1>
    <server-component-ssr-recovery />
    <nav>
      <a href="/server-component-ssr-recovery">Healthy recovery</a>
      <a href="/server-component-ssr-recovery?mode=unavailable">Expected service failure</a>
    </nav>
  </main>`,
})
export default class ServerComponentSsrRecoveryPage {}
