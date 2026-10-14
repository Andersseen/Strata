import { InjectionToken, Injectable } from "@angular/core";

import type { AuthorizationTenant } from "./authorization-contract";

/** The route names an untrusted resource; it never names the authenticated principal. */
export const REQUESTED_RESOURCE_TENANT = new InjectionToken<string | null>(
  "STRATA_REQUESTED_RESOURCE_TENANT",
);

/** Request-local test evidence, not application authorization state. */
@Injectable()
export class AuthorizationReadTrace {
  private readonly reads: AuthorizationTenant[] = [];

  record(tenant: AuthorizationTenant): void {
    this.reads.push(tenant);
  }

  get lastRead(): AuthorizationTenant | null {
    return this.reads.at(-1) ?? null;
  }
}
