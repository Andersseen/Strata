import "@strata-sc/server-components/server-only";

import { ChangeDetectionStrategy, Component, computed, inject, input } from "@angular/core";
import { REQUEST_CONTEXT } from "@angular/core";
import { RESPONSE } from "@analogjs/router/tokens";
import type { ServerResponse } from "@analogjs/router/tokens";
import { ServerComponent, StrataClientBoundary } from "@strata-sc/server-components";

import {
  authorize,
  readProtectedResource,
  requestedTenant,
  resolveTenant,
} from "../../server/strata/tenant-authorization";
import { ProtectedTenantIsland } from "./protected-tenant-island.component";

interface ProtectedContext {
  readonly headers: Headers;
}

@ServerComponent()
@Component({
  selector: "protected-tenant-document",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProtectedTenantIsland, StrataClientBoundary],
  template: `@if (result(); as result) {
    @if (result.status === 200) {
      <main
        id="protected-result"
        [attr.data-tenant]="result.tenant"
        [attr.data-protected-reads]="result.reads"
      >
        <h1>{{ result.label }}</h1>
        <protected-tenant-island
          [tenant]="result.tenant"
          [strataClient]="{ tenant: result.tenant }"
        />
      </main>
    } @else {
      <main id="protected-denied" data-protected-reads="0">{{ result.message }}</main>
    }
  }`,
})
export class ProtectedTenantServerComponent {
  private readonly context = inject(REQUEST_CONTEXT, { optional: true }) as ProtectedContext | null;
  private readonly response = inject(RESPONSE, { optional: true }) as ServerResponse | null;
  readonly tenant = input.required<string>();
  protected readonly result = computed(() => {
    const owner = requestedTenant(this.tenant());
    const principal = this.context ? resolveTenant(this.context.headers) : null;
    const status = authorize(principal, owner);
    this.response?.setHeader("cache-control", "no-store");
    this.response && (this.response.statusCode = status);
    if (status === 404) return { status, message: "Resource not found" };
    if (status === 401) return { status, message: "Authentication required" };
    if (status === 403) return { status, message: "Access denied" };
    const resource = readProtectedResource(`${owner}-product`);
    return {
      status: 200,
      tenant: resource!.tenant,
      label: resource!.label,
      reads: resource!.readCount,
    };
  });
}
