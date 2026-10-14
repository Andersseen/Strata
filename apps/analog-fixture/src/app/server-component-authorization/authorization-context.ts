import "@strata-sc/server-components/server-only";

import { InjectionToken } from "@angular/core";
import type { ServerRequest } from "@analogjs/router/tokens";

import { AUTHORIZATION_COOKIE_NAME, AUTHORIZATION_CREDENTIALS } from "./authorization-contract";
import type { AuthorizationTenant } from "./authorization-contract";

export type AuthorizationCredentialState = "missing" | "valid" | "invalid";

export interface AuthorizationPrincipal {
  readonly tenant: AuthorizationTenant;
}

export interface AuthorizationContext {
  readonly credentialState: AuthorizationCredentialState;
  readonly principal: AuthorizationPrincipal | null;
}

export const AUTHORIZATION_CONTEXT = new InjectionToken<AuthorizationContext>(
  "STRATA_AUTHORIZATION_CONTEXT",
);

const principalForCredential = (credential: string): AuthorizationPrincipal | null => {
  for (const [tenant, expected] of Object.entries(AUTHORIZATION_CREDENTIALS) as Array<
    [AuthorizationTenant, string]
  >) {
    if (credential === expected) return { tenant };
  }

  return null;
};

/**
 * Resolves the fixture's trusted principal from one opaque cookie only.
 * Route, query and arbitrary header values are deliberately not consulted.
 */
export function resolveAuthorizationContext(request: ServerRequest): AuthorizationContext {
  const rawCookie = request.headers.cookie;
  if (rawCookie === undefined) {
    return { credentialState: "missing", principal: null };
  }
  if (Array.isArray(rawCookie)) {
    return { credentialState: "invalid", principal: null };
  }

  let credential: string | undefined;
  for (const part of rawCookie.split(";")) {
    const pair = part.trim();
    if (!pair) continue;

    const separator = pair.indexOf("=");
    if (separator <= 0) return { credentialState: "invalid", principal: null };

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name !== AUTHORIZATION_COOKIE_NAME) continue;
    if (credential !== undefined || value.length === 0) {
      return { credentialState: "invalid", principal: null };
    }
    credential = value;
  }

  if (credential === undefined) return { credentialState: "missing", principal: null };

  const principal = principalForCredential(credential);
  return principal
    ? { credentialState: "valid", principal }
    : { credentialState: "invalid", principal: null };
}
