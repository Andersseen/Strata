import { InjectionToken } from "@angular/core";
import type { StrataAnalogRequest } from "@strata/analog";

// Server-only: imported only by the Nitro plugin and the controller it
// registers. The production-build scan asserts the marker never reaches the
// client output.
export const STRATA_ANALOG_ANGULAR_DI_MARKER = "STRATA_ANALOG_ANGULAR_DI_MARKER";

/** The Strata request the current request injector was created for. */
export const STRATA_REQUEST = new InjectionToken<StrataAnalogRequest>("STRATA_REQUEST");

/** Which request injector resolved a controller: lets the harness tell injectors apart. */
export const REQUEST_INJECTOR_ID = new InjectionToken<number>("REQUEST_INJECTOR_ID");

let appServiceInstances = 0;
let requestScopeInstances = 0;

/**
 * Provided once, on the app-level injector: every request must observe the
 * same instance.
 *
 * Plain classes provided with `useFactory` — Nitro does not run the Angular
 * compiler over `src/server/**`, so `@Injectable()` metadata is not available.
 */
export class AppGreetingService {
  readonly instance = ++appServiceInstances;

  greet() {
    return "hello";
  }
}

/** Provided on each request injector: every request must observe its own instance. */
export class RequestScope {
  readonly instance = ++requestScopeInstances;

  constructor(readonly requestId: string) {}
}
