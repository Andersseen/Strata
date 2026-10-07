import { InjectionToken } from "@angular/core";

/**
 * Test-only: which server failure a `/server-component-failure/:mode` route
 * produces, taken from its route parameter by the page that provides it. A
 * plain Angular token, not a Strata API.
 */
export const FAILURE_SCENARIO = new InjectionToken<string | null>("FAILURE_SCENARIO");

export const FAILURE_SCENARIOS = [
  "none",
  "constructor",
  "service",
  "template",
  "instance",
  "nested",
  "nan",
] as const;
export type FailureScenarioMode = (typeof FAILURE_SCENARIOS)[number];

/** A class instance a cast smuggles across `[strataClient]` (the "repository" shape). */
export class FailureRepository {
  readonly rows = ["synthetic"];
}

/** An injected service whose construction fails in the `service` scenario. */
export class FailureService {
  readonly ready = true;
}
