import "@strata-sc/server-components/server-only";

import { Injectable, inject } from "@angular/core";

import { PRIVATE_RESOURCE_CANARIES, PUBLIC_RESOURCE_LABELS } from "./authorization-contract";
import type { AuthorizationTenant } from "./authorization-contract";
import { AuthorizationReadTrace } from "./authorization-resource";

export interface ProtectedResourceRecord {
  readonly tenant: AuthorizationTenant;
  readonly publicLabel: string;
  readonly privateCanary: string;
}

/** Fixture stand-in for a repository that owns protected tenant records. */
@Injectable()
export class AuthorizationRepository {
  private readonly trace = inject(AuthorizationReadTrace);

  read(tenant: AuthorizationTenant): ProtectedResourceRecord {
    // This trace is request-local and makes the authorization-before-read rule observable.
    this.trace.record(tenant);

    return {
      tenant,
      publicLabel: PUBLIC_RESOURCE_LABELS[tenant],
      privateCanary: PRIVATE_RESOURCE_CANARIES[tenant],
    };
  }
}
