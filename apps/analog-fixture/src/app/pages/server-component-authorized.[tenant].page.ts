import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { AuthorizationServerComponent } from "../server-component-authorization/authorization.server-component";
import { REQUESTED_RESOURCE_TENANT } from "../server-component-authorization/authorization-resource";

/** Fixture-only protected resource route; the route tenant is an untrusted object identifier. */
@Component({
  selector: "app-server-component-authorized-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthorizationServerComponent],
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
      <a href="/server-component-authorized/alpha">Alpha resource</a>
      <a href="/server-component-authorized/beta">Beta resource</a>
    </nav>
  </main>`,
})
export default class ServerComponentAuthorizedPage {}
