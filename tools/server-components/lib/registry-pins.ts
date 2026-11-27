import { TUPLE_PACKAGES } from "../../release/lib/registry-tuple.ts";
import type { VersionTuple } from "../../release/lib/registry-tuple.ts";

/**
 * The version an installed registry artifact must pin for each Strata package: the SELECTED tuple's,
 * never this checkout's manifests. The checkout moved to 1.0.0-rc.0 when the RC was published, while
 * a 0.x arm of the upgrade/rollback qualification still installs analog 0.13.0 pinning core 0.2.2.
 */
export const tuplePin =
  (tuple: VersionTuple) =>
  (name: string): string | undefined =>
    (TUPLE_PACKAGES as readonly string[]).includes(name)
      ? tuple[name as (typeof TUPLE_PACKAGES)[number]]
      : undefined;
