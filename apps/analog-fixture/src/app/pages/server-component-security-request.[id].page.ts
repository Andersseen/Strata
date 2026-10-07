import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { SecurityRequestServerComponent } from "../server-component-security/security-request.server-component";
import { SECURITY_SCENARIO } from "../server-component-security/security-scenario";

/** Test-only: a request-varying PUBLIC value (route parameter id: a, b). */
@Component({
  selector: "app-server-component-security-request-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SecurityRequestServerComponent],
  providers: [
    {
      provide: SECURITY_SCENARIO,
      useFactory: () => inject(ActivatedRoute).snapshot.paramMap.get("id"),
    },
  ],
  template: `<main><security-request /></main>`,
})
export default class ServerComponentSecurityRequestPage {}
