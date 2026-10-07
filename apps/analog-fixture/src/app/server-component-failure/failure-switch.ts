import { isPlatformBrowser } from "@angular/common";
import type { Injector } from "@angular/core";
import { PLATFORM_ID } from "@angular/core";

/**
 * Fixture-only failure injection for `pnpm test:server-component-failures`.
 * A browser test sets `globalThis.__STRATA_FAILURE__` before scripts run to
 * pick which island fails and at which point of its life; unset everywhere
 * else, including SSR. Keys are `<host>:<island>` (the `data-host` of the
 * enclosing `<failure-host>` and the island's own `data-island`).
 *
 * - `create`: the island's constructor throws (Angular `createComponent`)
 * - `input`:  the island's `start` input transform throws (`setInput`)
 * - `click`:  the island's click handler throws (after hydration succeeded)
 */
export interface FailureSwitch {
  readonly create?: string;
  readonly input?: string;
  readonly click?: string;
}

export interface FailureProbe {
  /** Islands whose constructor completed / that were destroyed, by island key. */
  readonly constructed: Record<string, number>;
  readonly destroyed: Record<string, number>;
}

type Scope = { __STRATA_FAILURE__?: FailureSwitch; __STRATA_FAILURE_PROBE__?: FailureProbe };

export const failureSwitch = (): FailureSwitch => (globalThis as Scope).__STRATA_FAILURE__ ?? {};

export function islandKey(element: Element): string {
  const host = element.closest("failure-host")?.getAttribute("data-host") ?? "?";

  return `${host}:${element.getAttribute("data-island") ?? "?"}`;
}

/** The lifecycle counters the runner reads; browser only, nothing in the package writes them. */
export function failureProbe(injector: Injector): FailureProbe | null {
  if (!isPlatformBrowser(injector.get(PLATFORM_ID))) return null;

  const scope = globalThis as Scope;

  return (scope.__STRATA_FAILURE_PROBE__ ??= { constructed: {}, destroyed: {} });
}
