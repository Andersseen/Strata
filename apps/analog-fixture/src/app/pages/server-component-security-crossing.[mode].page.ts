import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { SecurityCrossingServerComponent } from "../server-component-security/security-crossing.server-component";
import { SECURITY_SCENARIO } from "../server-component-security/security-scenario";

/** Test-only: an unsupported value crosses [strataClient] (route parameter mode: repository, nested). */
@Component({
  selector: "app-server-component-security-crossing-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SecurityCrossingServerComponent],
  providers: [
    {
      provide: SECURITY_SCENARIO,
      useFactory: () => inject(ActivatedRoute).snapshot.paramMap.get("mode"),
    },
  ],
  template: `<main><security-crossing /></main>`,
})
export default class ServerComponentSecurityCrossingPage {}
