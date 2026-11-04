import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { ProtectedTenantServerComponent } from "../products/protected.server-component";

@Component({
  selector: "app-protected-tenant-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProtectedTenantServerComponent],
  template: `<protected-tenant-document [tenant]="tenant" />`,
})
export default class ProtectedTenantPage {
  protected readonly tenant = inject(ActivatedRoute).snapshot.paramMap.get("tenant") ?? "";
}
