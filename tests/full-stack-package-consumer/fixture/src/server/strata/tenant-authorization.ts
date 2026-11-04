/** Synthetic fixture credentials only. Never use these values outside qualification. */
export const TENANT_COOKIE = "strata-test-credential";
export const TENANT_CREDENTIALS = { alpha: "opaque-test-alpha", beta: "opaque-test-beta" } as const;
export type Tenant = keyof typeof TENANT_CREDENTIALS;

export type Principal = { readonly tenant: Tenant };

/** Resolves exactly one fixture cookie; identity headers, URL and owner are ignored. */
export function resolveTenant(headers: Headers): Principal | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  let credential: string | undefined;
  for (const field of raw.split(";")) {
    const [rawName, ...valueParts] = field.trim().split("=");
    if (!rawName || valueParts.length === 0) return null;
    if (rawName !== TENANT_COOKIE) continue;
    if (credential !== undefined) return null;
    credential = valueParts.join("=");
  }
  if (!credential || !/^[a-z-]+$/.test(credential)) return null;
  for (const tenant of ["alpha", "beta"] as const) {
    if (credential === TENANT_CREDENTIALS[tenant]) return { tenant };
  }
  return null;
}

export function requestedTenant(value: string): Tenant | null {
  return value === "alpha" || value === "beta" ? value : null;
}

const tenantForResource: Readonly<Record<string, Tenant>> = {
  "alpha-product": "alpha",
  "beta-product": "beta",
};

const protectedReads = new Map<string, number>();

/** Test-only per-request read count; values contain no tenant or resource identity. */
export function takeProtectedReads(observationId: string): number {
  const reads = protectedReads.get(observationId) ?? 0;
  protectedReads.delete(observationId);

  return reads;
}

/** Authorization runs before this read function is called. */
export function readProtectedResource(id: string, observationId?: string) {
  const tenant = tenantForResource[id];
  if (!tenant) return null;
  if (observationId) {
    protectedReads.set(observationId, (protectedReads.get(observationId) ?? 0) + 1);
  }
  return {
    tenant,
    label: tenant === "alpha" ? "Alpha private catalog" : "Beta private catalog",
    privateMarker: tenant === "alpha" ? "ALPHA_CONFIDENTIAL_71c1" : "BETA_CONFIDENTIAL_93d2",
    readCount: 1,
  } as const;
}

export function authorize(
  principal: Principal | null,
  owner: Tenant | null,
): 401 | 403 | 200 | 404 {
  if (!owner) return 404;
  if (!principal) return 401;
  return principal.tenant === owner ? 200 : 403;
}
