import { defineRouteMeta } from "@analogjs/router";
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import {
  StrataDocumentLink,
  strataDocumentNavigationGuard,
} from "@strata-sc/server-components/navigation";

import { AuthorizationServerComponent } from "../server-component-authorization/authorization.server-component";
import { REQUESTED_RESOURCE_TENANT } from "../server-component-authorization/authorization-resource";

// A protected Server Component route is only ever reached by document navigation, so the server
// authorizes every visit; the guard keeps a Router activation from bypassing that request.
export const routeMeta = defineRouteMeta({
  canActivate: [strataDocumentNavigationGuard],
});

/** Fixture-only protected resource route; the route tenant is an untrusted object identifier. */
@Component({
  selector: "app-server-component-authorized-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthorizationServerComponent, StrataDocumentLink],
  providers: [
    {
      provide: REQUESTED_RESOURCE_TENANT,
      useFactory: () => inject(ActivatedRoute).snapshot.paramMap.get("tenant"),
    },
  ],
  template: `<main data-authorization-page>
    <h1>Protected Server Component resource</h1>
    <server-component-authorized />
    <nav>
      <a [strataDocumentLink]="['/server-component-authorized', 'alpha']">Alpha resource</a>
      <a [strataDocumentLink]="['/server-component-authorized', 'beta']">Beta resource</a>
    </nav>
  </main>`,
})
export default class ServerComponentAuthorizedPage {}
