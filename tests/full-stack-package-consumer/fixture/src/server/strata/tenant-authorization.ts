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

/**
 * TEST-ONLY repository-read observation (docs/research/pre1-runtime-hardening.md, F6).
 *
 * A qualification request may carry one `x-fixture-read-observation` UUID. The fixture's Nitro
 * plugin opens a ledger for it when the request starts and, in Nitro's `beforeResponse` hook,
 * reports that ledger on the SAME response as `x-fixture-read-receipt` and closes it. Every
 * protected read made while serving that request is recorded in its ledger.
 *
 * The observation therefore never leaves the invocation (and so the isolate) that executed the
 * reads: it is valid when a distributed runtime serves consecutive requests from different
 * isolates. The previous design kept counters in module state and read them back with a second
 * request, which another Worker isolate answered with 0 (F6).
 *
 * The receipt carries the observation id, the read count and the resource ids that were read;
 * never tenant data, labels or markers. No ledger, no receipt: a response without one fails the
 * verifier instead of counting as "zero reads".
 */
export const READ_OBSERVATION_HEADER = "x-fixture-read-observation";
export const READ_RECEIPT_HEADER = "x-fixture-read-receipt";

const OBSERVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReadLedger {
  readonly id: string;
  readonly reads: string[];
  /** Another in-flight request in this isolate already owns the id: the receipt says so. */
  readonly conflict: boolean;
}

/**
 * One store per isolate (realm), not per module instance: Analog bundles this file twice, into the
 * Nitro server bundle (plugins, controllers) and into the Angular SSR renderer bundle. A
 * module-local Map would leave SSR reads in a second, never-reported ledger. `Symbol.for` resolves
 * to the same key in both copies; the store still never crosses an isolate, which is the point.
 */
const LEDGERS = Symbol.for("strata.fixture.protected-read-ledgers");
const openLedgers: Map<string, ReadLedger> = ((globalThis as Record<symbol, unknown>)[LEDGERS] ??=
  new Map<string, ReadLedger>()) as Map<string, ReadLedger>;

/** Opens the request's ledger; malformed or absent ids open none (and produce no receipt). */
export function openReadObservation(id: string | null | undefined): ReadLedger | undefined {
  if (!id || !OBSERVATION_ID.test(id)) return undefined;
  if (openLedgers.has(id)) return { id, reads: [], conflict: true };
  const ledger: ReadLedger = { id, reads: [], conflict: false };
  openLedgers.set(id, ledger);

  return ledger;
}

/** Closes the request's own ledger and formats its receipt. */
export function closeReadObservation(ledger: ReadLedger): string {
  if (openLedgers.get(ledger.id) === ledger) openLedgers.delete(ledger.id);

  return `${ledger.id};reads=${ledger.reads.length};resources=${ledger.reads.join(",")}${
    ledger.conflict ? ";conflict" : ""
  }`;
}

/** Releases a ledger whose response never reached `beforeResponse` (error paths). */
export function discardReadObservation(ledger: ReadLedger): void {
  if (openLedgers.get(ledger.id) === ledger) openLedgers.delete(ledger.id);
}

/**
 * Authorization runs before this read function is called. It takes the request's headers so every
 * caller hands over the request it serves: the read is recorded in that request's ledger without
 * the caller choosing whether to report it.
 */
export function readProtectedResource(id: string, request: { readonly headers: Headers }) {
  const tenant = tenantForResource[id];
  if (!tenant) return null;
  const observationId = request.headers.get(READ_OBSERVATION_HEADER);
  if (observationId) openLedgers.get(observationId)?.reads.push(id);
  return {
    tenant,
    label: tenant === "alpha" ? "Alpha private catalog" : "Beta private catalog",
    privateMarker: tenant === "alpha" ? "ALPHA_CONFIDENTIAL_71c1" : "BETA_CONFIDENTIAL_93d2",
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
