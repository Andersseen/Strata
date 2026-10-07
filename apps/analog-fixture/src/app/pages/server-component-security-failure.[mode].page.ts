import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { SecurityFailureServerComponent } from "../server-component-security/security-failure.server-component";
import { SECURITY_SCENARIO } from "../server-component-security/security-scenario";

/** Test-only: the secret-bearing production error (route parameter mode: plain, cause, aggregate). */
@Component({
  selector: "app-server-component-security-failure-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SecurityFailureServerComponent],
  providers: [
    {
      provide: SECURITY_SCENARIO,
      useFactory: () => inject(ActivatedRoute).snapshot.paramMap.get("mode"),
    },
  ],
  template: `<main><security-failure /></main>`,
})
export default class ServerComponentSecurityFailurePage {}
