import { InjectionToken } from "@angular/core";

/**
 * Test-only: which variant a security route renders, taken from its route
 * parameter by the page that provides it. A plain Angular token, not a Strata
 * request API: Strata has no request context for Server Components.
 */
export const SECURITY_SCENARIO = new InjectionToken<string | null>("SECURITY_SCENARIO");
