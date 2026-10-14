export type AuthorizationTenant = "alpha" | "beta";

/** Fixture-only opaque credentials; these are synthetic test values, not secrets. */
export const AUTHORIZATION_COOKIE_NAME = "__strata_test_credential";
export const AUTHORIZATION_CREDENTIALS: Readonly<Record<AuthorizationTenant, string>> = {
  alpha: "strata-test-credential-alpha-7E4D2A91",
  beta: "strata-test-credential-beta-3B8F6C20",
};

/** Private repository values that must stay on the server. */
export const PRIVATE_RESOURCE_CANARIES: Readonly<Record<AuthorizationTenant, string>> = {
  alpha: "STRATA_AUTH_PRIVATE_ALPHA_91C4E7B2",
  beta: "STRATA_AUTH_PRIVATE_BETA_6A2D8F14",
};

export const PUBLIC_RESOURCE_LABELS: Readonly<Record<AuthorizationTenant, string>> = {
  alpha: "Alpha resource is available",
  beta: "Beta resource is available",
};
