import "@strata-sc/server-components/server-only";

import { Injectable, inject } from "@angular/core";
import { RESPONSE as ANALOG_RESPONSE } from "@analogjs/router/tokens";
import type { ServerResponse } from "@analogjs/router/tokens";

import { AUTHORIZATION_CONTEXT } from "./authorization-context";
import type { AuthorizationTenant } from "./authorization-contract";
import { AuthorizationRepository } from "./authorization.repository";
import { AuthorizationReadTrace, REQUESTED_RESOURCE_TENANT } from "./authorization-resource";

const isTenant = (value: string | null): value is AuthorizationTenant =>
  value === "alpha" || value === "beta";

export type AuthorizationResult =
  | { readonly kind: "loading" }
  | {
      readonly kind: "authorized";
      readonly tenant: AuthorizationTenant;
      readonly publicLabel: string;
      readonly readTenant: AuthorizationTenant | null;
    }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "not-found" };

/** Fixture-only policy: authenticate the principal, then authorize the named resource. */
@Injectable()
export class AuthorizationService {
  private readonly context = inject(AUTHORIZATION_CONTEXT);
  private readonly requestedTenant = inject(REQUESTED_RESOURCE_TENANT, { optional: true });
  private readonly response = inject(ANALOG_RESPONSE, { optional: true }) as ServerResponse | null;
  private readonly repository = inject(AuthorizationRepository);
  private readonly trace = inject(AuthorizationReadTrace);

  async read(): Promise<AuthorizationResult> {
    const tenant = this.requestedTenant;
    if (!isTenant(tenant)) {
      this.markResponse(404);

      return { kind: "not-found" };
    }

    if (!this.context.principal) {
      this.markResponse(401);

      return { kind: "unauthenticated" };
    }

    if (this.context.principal.tenant !== tenant) {
      this.markResponse(403);

      return { kind: "forbidden" };
    }

    // Keep authorized renders open briefly so the gate observes real overlap. The repository
    // read remains after both authentication and object-ownership authorization.
    await new Promise((resolve) => setTimeout(resolve, 75));
    const resource = this.repository.read(tenant);
    this.markResponse(200);

    // The private value is intentionally consumed only to prove the repository record was read.
    if (!resource.privateCanary.startsWith("STRATA_AUTH_PRIVATE_")) {
      throw new Error("Synthetic authorization repository integrity failure");
    }

    return {
      kind: "authorized",
      tenant: resource.tenant,
      publicLabel: resource.publicLabel,
      readTenant: this.trace.lastRead,
    };
  }

  private markResponse(status: number): void {
    const response = this.response;
    if (!response || response.headersSent) return;

    response.statusCode = status;
    response.setHeader("cache-control", "no-store");
  }
}
