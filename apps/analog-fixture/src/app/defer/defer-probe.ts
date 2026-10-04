import { isPlatformBrowser } from "@angular/common";
import { PLATFORM_ID, inject } from "@angular/core";

export type DeferProbeKey = "panel" | "interactionWidget" | "viewportWidget";

/**
 * Fixture-only evidence for `pnpm test:server-component-defer`: how many
 * instances of each defer fixture component the browser constructed, as
 * `window.__STRATA_DEFER_PROBE__`. Nothing in the app reads it. Does nothing
 * during SSR. Call from a constructor (injection context). Not public API.
 */
export function countDeferProbe(key: DeferProbeKey): void {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return;

  const scope = globalThis as { __STRATA_DEFER_PROBE__?: Partial<Record<DeferProbeKey, number>> };
  const probe = (scope.__STRATA_DEFER_PROBE__ ??= {});

  probe[key] = (probe[key] ?? 0) + 1;
}
